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
