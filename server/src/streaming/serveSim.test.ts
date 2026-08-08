import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { basePathFromStreamUrl, portFromDetach, ServeSimBackend } from "./serveSim.ts";

describe("basePathFromStreamUrl", () => {
  it("derives /helper/<udid> from a detach streamUrl", () => {
    assert.equal(
      basePathFromStreamUrl("http://127.0.0.1:3160/helper/ABC-123/stream.mjpeg"),
      "/helper/ABC-123",
    );
    assert.equal(basePathFromStreamUrl("http://127.0.0.1:3160/stream.mjpeg"), "");
    assert.equal(basePathFromStreamUrl("http://h/helper/x/stream.avcc"), "/helper/x");
  });
});

describe("ServeSimBackend.attach (detach flow)", () => {
  it("runs `serve-sim --detach`, parses the reported URLs, and exposes the /helper base", async () => {
    const calls: string[][] = [];
    const backend = new ServeSimBackend({
      portRange: [3100, 3110],
      detachImpl: async (_bin, args) => {
        calls.push(args);
        const udid = args[args.length - 1]!;
        const port = args[args.indexOf("-p") + 1]!;
        return JSON.stringify({
          url: `http://127.0.0.1:${port}`,
          streamUrl: `http://127.0.0.1:${port}/helper/${udid}/stream.mjpeg`,
          wsUrl: `ws://127.0.0.1:${port}/helper/${udid}/ws`,
          port: Number(port),
          device: udid,
        });
      },
      killImpl: async (_bin, args) => {
        calls.push(args);
      },
      fetchImpl: (async () => new Response(new Uint8Array(8192))) as unknown as typeof fetch,
    });

    const stream = await backend.attach({ platform: "ios", udid: "UDID-9" });
    assert.match(stream.helperBasePath, /^\/helper\/UDID-9$/);
    assert.ok(calls.some((a) => a[0] === "--detach" && a.includes("UDID-9")));
    assert.equal(await stream.waitForFirstFrame(2000), true);

    await stream.detach();
    assert.ok(calls.some((a) => a[0] === "-k" && a[1] === "UDID-9"));
  });
});

describe("ServeSimBackend — surviving helpers", () => {
  const detachOk = async (_bin: string, args: string[]): Promise<string> => {
    const udid = args[args.length - 1]!;
    const port = args[args.indexOf("-p") + 1]!;
    return JSON.stringify({
      url: `http://127.0.0.1:${port}`,
      streamUrl: `http://127.0.0.1:${port}/helper/${udid}/stream.mjpeg`,
      wsUrl: `ws://127.0.0.1:${port}/helper/${udid}/ws`,
      port: Number(port),
      device: udid,
    });
  };

  it("never allocates a port a stale helper is still listening on", async () => {
    // The in-memory map is empty in a fresh process, but detached helpers from the previous
    // one are still alive. Allocating over one adopts a daemon bound to a simulator that no
    // longer exists — it answers, and serves that dead sim's last frame forever.
    const backend = new ServeSimBackend({
      portRange: [3100, 3102],
      detachImpl: detachOk,
      killImpl: async () => {},
      listenersImpl: async (port) => (port === 3100 ? [85527] : []),
      killPidImpl: () => {},
    });
    const stream = await backend.attach({ platform: "ios", udid: "NEW-UDID" } as never);
    assert.ok(stream.origin.endsWith(":3101"), `expected the occupied 3100 to be skipped, got ${stream.origin}`);
  });

  it("reapOrphans kills what `serve-sim -k` left behind", async () => {
    // `serve-sim -k` is a request, not a guarantee: a detached daemon that ignores it outlives
    // the server and gets adopted by the next one.
    const alive = new Set([3100, 3102]);
    const killed: number[] = [];
    const backend = new ServeSimBackend({
      portRange: [3100, 3102],
      detachImpl: detachOk,
      killImpl: async () => {}, // pretends to work, changes nothing — the real-world failure
      listenersImpl: async (port) => (alive.has(port) ? [9000 + port] : []),
      killPidImpl: (pid) => killed.push(pid),
    });
    await backend.reapOrphans();
    assert.deepEqual(killed.sort(), [12100, 12102], "every surviving listener in the range must be signalled");
  });

  it("spares a helper a live preview holds, and still kills the rest", async () => {
    // The sweep runs after the port is bound (deliberately — that ordering is what makes a
    // second `deckhand serve` die on EADDRINUSE before deleting the running server's
    // devices), so a start_preview can be mid-attach. `serve-sim -k` with NO udid kills
    // every helper on the machine, including the one just spawned.
    const killArgs: string[][] = [];
    const killedPids: number[] = [];
    const backend = new ServeSimBackend({
      portRange: [3100, 3102],
      detachImpl: async (_bin, args) => JSON.stringify({ streamUrl: `http://127.0.0.1:${args[2]}/helper/LIVE/stream.mjpeg` }),
      killImpl: async (_bin, args) => void killArgs.push([...args]),
      // 3100 free at attach time, so the live helper lands there; 3101 holds a survivor
      // from a previous process, which is what the sweep exists for.
      listenersImpl: async (port) => (port === 3101 ? [9101] : []),
      killPidImpl: (pid) => killedPids.push(pid),
    });
    const stream = await backend.attach({ platform: "ios", udid: "LIVE" } as never);
    const livePort = Number(new URL(stream.origin).port);

    await backend.reapOrphans(new Set(["LIVE"]));

    assert.ok(
      !killArgs.some((a) => a.length === 1 && a[0] === "-k"),
      "the blanket `serve-sim -k` takes the live helper with it — name the dead ones instead",
    );
    assert.equal(livePort, 3100, "fixture sanity: the live helper holds a port inside the swept range");
    assert.deepEqual(killedPids, [9101], "the survivor goes; the live helper's port is not signalled");

    // Sparing must not forget it: the record is what stops the next attach reallocating
    // that port and adopting a daemon bound to a simulator that is already gone.
    const again = await backend.attach({ platform: "ios", udid: "LIVE" } as never);
    assert.equal(again.origin, stream.origin, "the spared helper is still remembered after the sweep");
  });

  it("spares a helper attached DURING the `serve-sim -k` kills", async () => {
    // `keep` is a snapshot the engine took BEFORE this call, and the per-udid kills below it
    // are awaits — so a start_preview can attach after the snapshot and before the port
    // sweep. Its udid is in neither `keep` nor the condemned list, and both the kill loop and
    // the port sweep have to re-read `this.helpers` to see it. Getting this wrong SIGKILLs a
    // preview that just came up, on a port we then still believe is free.
    //
    // This case covers an attach landing in the KILL loop only — the three below cover the
    // later windows: the port sweep's own awaits, an attach still in flight, and a re-attach
    // of a condemned udid. This name reads as covering all four and does not; it is kept
    // because `.claude/rules/streaming.md` cites it verbatim, and the siblings say which
    // window each one holds. The sweep passed THIS one while still killing anything that
    // attached a step later.
    const listening = new Map<number, number[]>();
    const killArgs: string[][] = [];
    const killedPids: number[] = [];
    let attachedMidSweep: string | undefined;
    const backend: ServeSimBackend = new ServeSimBackend({
      portRange: [3100, 3102],
      detachImpl: async (_bin, args) => {
        const port = args[args.indexOf("-p") + 1]!;
        return JSON.stringify({ port: Number(port), streamUrl: `http://127.0.0.1:${port}/helper/${args[args.length - 1]}/stream.mjpeg` });
      },
      killImpl: async (_bin, args) => {
        killArgs.push([...args]);
        if (args[1] !== "DEAD") return;
        // The start_preview lands here: mid-sweep, after the keep-set was taken.
        const s = await backend.attach({ platform: "ios", udid: "NEW" });
        attachedMidSweep = new URL(s.origin).port;
        listening.set(Number(attachedMidSweep), [9102]); // its daemon is now up
      },
      listenersImpl: async (port) => listening.get(port) ?? [],
      killPidImpl: (pid) => killedPids.push(pid),
    });

    const live = await backend.attach({ platform: "ios", udid: "LIVE" });
    await backend.attach({ platform: "ios", udid: "DEAD" });
    listening.set(3101, [9101]); // DEAD's daemon ignores `-k`, which is what the port sweep is for

    await backend.reapOrphans(new Set(["LIVE"]));

    assert.equal(attachedMidSweep, "3102", "fixture sanity: the mid-sweep attach took a port inside the swept range");
    assert.ok(!killArgs.some((a) => a[1] === "NEW"), `the mid-sweep attach must not be named to \`serve-sim -k\`: ${JSON.stringify(killArgs)}`);
    assert.deepEqual(killedPids, [9101], "only DEAD's surviving daemon is signalled — not the helper that attached mid-sweep");
    const again = await backend.attach({ platform: "ios", udid: "NEW" });
    assert.equal(again.origin, `http://127.0.0.1:3102`, "and it is still remembered, so the next attach does not reallocate its port");
    assert.equal(new URL(live.origin).port, "3100", "fixture sanity: the kept helper is inside the range too");
  });

  it("spares a helper attached DURING the port sweep", async () => {
    // The port sweep awaits one `lsof` per port across the whole range, and `attach` is not
    // serialised against it: `allocatePort` picks any port nothing holds, so an attach landing
    // in one of those awaits takes a port that was free when the sweep started. A spared-port
    // set computed once, before the loop, cannot contain it — and the sweep then SIGKILLs a
    // daemon that is seconds from serving a preview, which reports `ready` with a dead stream.
    const listening = new Map<number, number[]>();
    const killedPids: number[] = [];
    let fired = false;
    let sweeping = false;
    let attachedMidSweep: string | undefined;
    const backend: ServeSimBackend = new ServeSimBackend({
      portRange: [3100, 3102],
      detachImpl: async (_bin, args) => {
        const port = args[args.indexOf("-p") + 1]!;
        return JSON.stringify({ port: Number(port), streamUrl: `http://127.0.0.1:${port}/helper/${args[args.length - 1]}/stream.mjpeg` });
      },
      killImpl: async () => {},
      listenersImpl: async (port) => {
        // The start_preview lands HERE: inside the sweep's own lsof await, after any set of
        // spared ports could have been computed. `fired` keeps the attach's own port scan
        // from re-entering this branch.
        if (sweeping && port === 3102 && !fired) {
          fired = true;
          const s = await backend.attach({ platform: "ios", udid: "NEW" });
          attachedMidSweep = new URL(s.origin).port;
          listening.set(Number(attachedMidSweep), [9102]); // its daemon is now up and listening
        }
        return listening.get(port) ?? [];
      },
      killPidImpl: (pid) => killedPids.push(pid),
    });

    await backend.attach({ platform: "ios", udid: "LIVE" });
    await backend.attach({ platform: "ios", udid: "DEAD" });
    listening.set(3101, [9101]); // DEAD's daemon ignores `-k` — that is what the port sweep is for

    sweeping = true; // only now may the fixture's attach fire: the window under test is the sweep's
    await backend.reapOrphans(new Set(["LIVE"]));

    assert.equal(attachedMidSweep, "3102", "fixture sanity: the mid-sweep attach took a port inside the swept range");
    assert.deepEqual(killedPids, [9101], "only DEAD's surviving daemon is signalled — not the helper that attached mid-sweep");
    const again = await backend.attach({ platform: "ios", udid: "NEW" });
    assert.equal(again.origin, "http://127.0.0.1:3102", "and it is still remembered, so the next attach does not reallocate its port");
  });

  it("spares a port an in-flight attach has already claimed", async () => {
    // An attach binds its port DURING `serve-sim --detach`, before `this.helpers` records the
    // helper. Re-reading the map is not enough on its own for that instant: the listener is
    // real and nothing in the map claims it. The claim is staked at allocation instead.
    const listening = new Map<number, number[]>();
    const killedPids: number[] = [];
    let releaseDetach: (() => void) | undefined;
    let fired = false;
    let sweeping = false;
    let inFlight: Promise<unknown> | undefined;
    const backend: ServeSimBackend = new ServeSimBackend({
      portRange: [3100, 3102],
      detachImpl: async (_bin, args) => {
        const port = Number(args[args.indexOf("-p") + 1]!);
        const udid = args[args.length - 1]!;
        if (udid === "NEW") {
          // The daemon binds the port, then the CLI reports it — the window this covers.
          listening.set(port, [9102]);
          await new Promise<void>((r) => (releaseDetach = r));
        }
        return JSON.stringify({ port, streamUrl: `http://127.0.0.1:${port}/helper/${udid}/stream.mjpeg` });
      },
      killImpl: async () => {},
      listenersImpl: async (port) => {
        if (sweeping && port === 3102 && !fired) {
          fired = true;
          inFlight = backend.attach({ platform: "ios", udid: "NEW" });
          // Let it run as far as its own detach await, where it holds the port and no helper
          // record exists yet.
          await new Promise((r) => setTimeout(r, 0));
        }
        return listening.get(port) ?? [];
      },
      killPidImpl: (pid) => killedPids.push(pid),
    });

    await backend.attach({ platform: "ios", udid: "LIVE" });
    await backend.attach({ platform: "ios", udid: "DEAD" });
    listening.set(3101, [9101]);

    sweeping = true; // only now may the fixture's attach fire: the window under test is the sweep's
    await backend.reapOrphans(new Set(["LIVE"]));
    releaseDetach?.();
    const s = (await inFlight) as { origin: string };

    assert.equal(new URL(s.origin).port, "3102", "fixture sanity: the in-flight attach claimed a port inside the swept range");
    assert.deepEqual(killedPids, [9101], "the daemon an unfinished attach had just bound must survive the sweep");
  });

  it("never hands two concurrent attaches the same port", async () => {
    // `usedPorts` folds `pendingPorts` into its answer BEFORE the per-port `lsof`
    // loop, and every one of those probes is an await. An attach sitting in that
    // loop therefore answers from a snapshot taken before the sibling attach
    // running beside it staked its claim — and `allocatePort` returns the LOWEST
    // free port, so the two do not merely collide sometimes, they collide every
    // time. The second daemon gets EADDRINUSE (or adopts the first's port) and
    // the engine fails that device.
    //
    // Same shape as `isSpared`, which this branch moved to AFTER its await: the
    // sweep side was fixed, the allocator side kept reading the snapshot.
    let second: Promise<{ origin: string }> | undefined;
    // The flag is set BEFORE the call: `attach` runs synchronously as far as its
    // own first probe, which lands back in here, so assigning `second` afterwards
    // guards nothing and recurses until the stack goes.
    let startedSecond = false;
    const backend: ServeSimBackend = new ServeSimBackend({
      portRange: [3100, 3102],
      detachImpl: async (_bin, args) => {
        const port = Number(args[args.indexOf("-p") + 1]!);
        const udid = args[args.length - 1]!;
        // The claim has to outlive the sibling's probe loop, which is what
        // `pendingPorts` exists to cover; a detach that returned instantly would
        // instead be caught by re-reading `this.helpers`.
        await new Promise((r) => setTimeout(r, 20));
        return JSON.stringify({ port, streamUrl: `http://127.0.0.1:${port}/helper/${udid}/stream.mjpeg` });
      },
      killImpl: async () => {},
      listenersImpl: async () => {
        // The FIRST probe of the first attach starts the second one, which then
        // runs its own probe loop interleaved with this one — a plain
        // `Promise.all` of two attaches on one engine group.
        if (!startedSecond) {
          startedSecond = true;
          second = backend.attach({ platform: "ios", udid: "B" }) as Promise<{ origin: string }>;
        }
        await new Promise((r) => setTimeout(r, 0));
        return [];
      },
      killPidImpl: () => {},
    });

    const a = await backend.attach({ platform: "ios", udid: "A" });
    const b = await second!;
    assert.notEqual(
      new URL(a.origin).port,
      new URL(b.origin).port,
      `two attaches racing through usedPorts() took the same port (${a.origin})`,
    );
  });

  it("never blanket-kills while an attach already holds a port", async () => {
    // The blanket `serve-sim -k` kills every helper on the machine, so it is taken only when
    // we know of no helper at all. `this.helpers` is not the whole of what we know: an attach
    // inside `serve-sim --detach` has claimed its port and has no record yet, and the boot
    // sweep runs after the port is bound, so that is exactly the state a start_preview racing
    // the sweep is in. `pendingPorts` is a READ of a helper we know about, not a prediction
    // about one — the blanket kill has to consult it too.
    const killArgs: string[][] = [];
    let releaseDetach: (() => void) | undefined;
    const backend = new ServeSimBackend({
      portRange: [3100, 3102],
      detachImpl: async (_bin, args) => {
        const port = Number(args[args.indexOf("-p") + 1]!);
        const udid = args[args.length - 1]!;
        // The daemon binds the port here; the CLI has not reported it yet.
        await new Promise<void>((r) => (releaseDetach = r));
        return JSON.stringify({ port, streamUrl: `http://127.0.0.1:${port}/helper/${udid}/stream.mjpeg` });
      },
      killImpl: async (_bin, args) => {
        killArgs.push(args);
      },
      listenersImpl: async () => [],
      killPidImpl: () => {},
    });

    const inFlight = backend.attach({ platform: "ios", udid: "NEW" });
    // One macrotask drains every microtask before it, so the attach is parked inside
    // detachImpl: port claimed, `this.helpers` still empty.
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(releaseDetach, "fixture sanity: the attach is parked inside `serve-sim --detach`");

    await backend.reapOrphans();

    assert.deepEqual(
      killArgs.filter((a) => a.length === 1 && a[0] === "-k"),
      [],
      "the blanket `-k` killed the daemon an unfinished attach had just spawned",
    );
    releaseDetach!();
    await inFlight;
  });

  it("forgets only the condemned RECORD, not whatever now sits under its udid", async () => {
    // The condemned list is fixed before the kills, but the deletion happens after them — and
    // a re-attach of a condemned udid during those awaits puts a DIFFERENT record under the
    // same key. Deleting by key alone forgot a live helper, which then had its port swept.
    const listening = new Map<number, number[]>([[3101, [9101]]]);
    const killedPids: number[] = [];
    let reattached = false;
    const backend: ServeSimBackend = new ServeSimBackend({
      portRange: [3100, 3102],
      detachImpl: async (_bin, args) => {
        const port = Number(args[args.indexOf("-p") + 1]!);
        return JSON.stringify({ port, streamUrl: `http://127.0.0.1:${port}/helper/${args[args.length - 1]}/stream.mjpeg` });
      },
      killImpl: async (_bin, args) => {
        if (args[1] !== "DEAD" || reattached) return;
        reattached = true;
        // `-k` worked: DEAD's daemon is gone. The same udid is then re-attached mid-sweep and
        // gets a NEW helper record — a different object under the same key, so identity is the
        // only thing that tells it from the one the sweep condemned. (It lands back on the
        // port `-k` just freed, and a live daemon on it is precisely what must not be killed.)
        listening.delete(3101);
        const s = await backend.attach({ platform: "ios", udid: "DEAD" });
        listening.set(Number(new URL(s.origin).port), [9102]);
      },
      listenersImpl: async (port) => listening.get(port) ?? [],
      killPidImpl: (pid) => killedPids.push(pid),
    });

    await backend.attach({ platform: "ios", udid: "LIVE" });
    await backend.attach({ platform: "ios", udid: "DEAD" });
    listening.set(3101, [9101]);

    await backend.reapOrphans(new Set(["LIVE"]));

    assert.ok(reattached, "fixture sanity: the re-attach ran inside the kill loop");
    assert.deepEqual(killedPids, [], "the re-attached helper is still ours, so nothing in the range is signalled");
    const again = await backend.attach({ platform: "ios", udid: "DEAD" });
    assert.equal(again.origin, "http://127.0.0.1:3101", "and the record survives, so the next attach reuses it");
  });

  it("a pid that dies between the scan and the signal is not an error", async () => {
    const backend = new ServeSimBackend({
      portRange: [3100, 3100],
      detachImpl: detachOk,
      killImpl: async () => {},
      listenersImpl: async () => [4242],
      killPidImpl: () => {
        throw new Error("ESRCH");
      },
    });
    await backend.reapOrphans(); // must not throw — the process is gone, which is the goal
  });
});

describe("portFromDetach", () => {
  it("believes the reported port over the one we asked for", () => {
    // `-p` is a request. A detached daemon outlives the server that spawned it,
    // so when one already exists for this device serve-sim ignores `-p` and
    // returns the running helper — on ITS port.
    assert.equal(portFromDetach({ port: 3100, streamUrl: "http://127.0.0.1:3100/helper/x/stream.mjpeg" }, 3177), 3100);
  });

  it("falls back to the stream URL, then to the requested port", () => {
    assert.equal(portFromDetach({ streamUrl: "http://127.0.0.1:3105/helper/x/stream.mjpeg" }, 3177), 3105);
    assert.equal(portFromDetach({ streamUrl: "not a url" }, 3177), 3177);
    assert.equal(portFromDetach({}, 3177), 3177);
    assert.equal(portFromDetach({ port: 0 }, 3177), 3177, "a nonsense port is not an answer");
  });
});

describe("ServeSimBackend.attach — surviving helpers", () => {
  /** A serve-sim that already has a helper for `busyUdid` on `busyPort`, and ignores -p for it. */
  const detachAdopting = (busyUdid: string, busyPort: number) => async (_bin: string, args: string[]) => {
    const udid = args[args.length - 1]!;
    const asked = Number(args[args.indexOf("-p") + 1]);
    const port = udid === busyUdid ? busyPort : asked;
    return JSON.stringify({
      url: `http://127.0.0.1:${port}`,
      streamUrl: `http://127.0.0.1:${port}/helper/${udid}/stream.mjpeg`,
      wsUrl: `ws://127.0.0.1:${port}/helper/${udid}/ws`,
      port,
      device: udid,
    });
  };

  it("points at the helper serve-sim actually returned, not the port it asked for", async () => {
    // The real failure: the requested port was free (the orphan held a different
    // one), so allocation succeeded, attach "succeeded", and every probe went to
    // a port nothing served — surfacing 20s later as "no first frame", with no
    // helper in `ps` to explain it.
    const backend = new ServeSimBackend({
      portRange: [3100, 3110],
      detachImpl: detachAdopting("UDID-OLD", 3101),
      killImpl: async () => {},
      listenersImpl: async () => [],
      fetchImpl: (async () => new Response(new Uint8Array(8192))) as unknown as typeof fetch,
    });
    const stream = await backend.attach({ platform: "ios", udid: "UDID-OLD" });
    assert.equal(stream.origin, "http://127.0.0.1:3101");
  });

  it("respawns when a remembered helper's port has gone quiet", async () => {
    // A helper can die at any time — crash, external kill, someone's `serve-sim -k`.
    // Trusting the record made attach() succeed against nothing.
    const spawns: string[] = [];
    let alive = true;
    // The fake has to stay self-consistent: exactly the port the helper landed on
    // answers. Claiming a listener on every port starves allocation (usedPorts
    // scans the range); claiming one on a fixed port makes the helper look dead
    // as soon as it lands somewhere else.
    let helperPort = 0;
    const backend = new ServeSimBackend({
      portRange: [3100, 3110],
      detachImpl: async (bin, args) => {
        spawns.push(args[args.length - 1]!);
        const out = await detachAdopting("none", 0)(bin, args);
        helperPort = (JSON.parse(out) as { port: number }).port;
        return out;
      },
      killImpl: async () => {},
      listenersImpl: async (port) => (alive && port === helperPort ? [4242] : []),
      fetchImpl: (async () => new Response(new Uint8Array(8192))) as unknown as typeof fetch,
    });

    await backend.attach({ platform: "ios", udid: "UDID-1" });
    assert.equal(spawns.length, 1);
    await backend.attach({ platform: "ios", udid: "UDID-1" });
    assert.equal(spawns.length, 1, "a live helper is reused, not respawned");

    alive = false; // the helper died out from under us
    await backend.attach({ platform: "ios", udid: "UDID-1" });
    assert.equal(spawns.length, 2, "a dead helper is replaced instead of trusted");
  });
});
