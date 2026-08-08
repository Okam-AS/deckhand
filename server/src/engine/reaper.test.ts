import { fakeSimctl, fakeAndroid } from "../test-support/fakes.ts";
import { execFile, spawn } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Reaper, makeKiller, orphanSims, orphanAvds, SIM_PREFIX, POOL_SIM_PREFIX, POOL_AVD_PREFIX, type ReaperDeps } from "./reaper.ts";
import { AVD_PREFIX } from "../devices/android.ts";
import type { SimDevice } from "../devices/ios.ts";

const sims: SimDevice[] = [
  { udid: "AAA", name: "deckhand-pv1-ios-0", state: "Booted" },
  { udid: "BBB", name: "deckhand-pv2-ios-0", state: "Shutdown" },
  { udid: "CCC", name: "iPhone 16 Pro", state: "Shutdown" }, // the developer's own
];
const avds = ["deckhand_pv1_android_0", "deckhand_pv2_android_1", "Pixel_9_API_36"];

describe("orphan selection", () => {
  it("only ever touches deckhand-owned devices", () => {
    assert.deepEqual(
      orphanSims(sims).map((s) => s.udid),
      ["AAA", "BBB"],
    );
    assert.deepEqual(orphanAvds(avds), ["deckhand_pv1_android_0", "deckhand_pv2_android_1"]);
  });

  it("spares devices belonging to a live preview", () => {
    assert.deepEqual(
      orphanSims(sims, new Set(["AAA"])).map((s) => s.udid),
      ["BBB"],
    );
    assert.deepEqual(orphanAvds(avds, new Set(["deckhand_pv1_android_0"])), ["deckhand_pv2_android_1"]);
  });

  it("names pooled devices INSIDE the general prefix, or nothing reaps them", () => {
    // Not a tautology about two string constants: three places select deckhand's
    // devices by the GENERAL prefix and rely on the pooled one being a prefix of it —
    // `orphanAvds` above (the only route by which a pooled AVD is reaped at all),
    // `Reaper.reap`'s simulator pass, and `sweepDeviceRecorders`' ownership gate 2 in
    // streaming/androidAdb.ts. AVD_PREFIX was hoisted into devices/android.ts while
    // POOL_AVD_PREFIX stayed here, so a rename on either side now drops pooled devices
    // out of every sweep silently — nothing else in the suite reads both.
    assert.ok(POOL_AVD_PREFIX.startsWith(AVD_PREFIX), `${POOL_AVD_PREFIX} must start with ${AVD_PREFIX}`);
    assert.ok(POOL_SIM_PREFIX.startsWith(SIM_PREFIX), `${POOL_SIM_PREFIX} must start with ${SIM_PREFIX}`);
  });
});

function makeReaper(overrides: Partial<ReaperDeps> = {}) {
  const calls: string[] = [];
  const deps: ReaperDeps = {
    simctl: fakeSimctl({
      listDevices: async () => sims,
      shutdown: async (u: string) => void calls.push(`sim shutdown ${u}`),
      delete: async (u: string) => void calls.push(`sim delete ${u}`),
    }),
    android: fakeAndroid({
      listAvds: async () => avds,
      attachedSerials: async () => [],
      deleteAvd: async (n: string) => void calls.push(`avd delete ${n}`),
    }),
    kill: async (pattern: string) => {
      calls.push(`kill ${pattern}`);
      return true; // confirmed gone; "it survived the kill" has its own test
    },
    ...overrides,
  };
  return { reaper: new Reaper(deps), calls };
}

describe("Reaper.reap", () => {
  it("kills the helper, then shuts down and deletes every orphaned device", async () => {
    const { reaper, calls } = makeReaper();
    const report = await reaper.reap();

    assert.deepEqual(report.sims, ["AAA", "BBB"]);
    assert.deepEqual(report.avds, ["deckhand_pv1_android_0", "deckhand_pv2_android_1"]);
    // The serve-sim helper dies before its simulator disappears underneath it.
    assert.deepEqual(calls.slice(0, 3), ["kill serve-sim[^/]*[[:space:]]AAA([[:space:]]|$)", "sim shutdown AAA", "sim delete AAA"]);
    // Emulators are killed by their -avd argument (console ports collide across
    // orphans, so `adb emu kill` cannot be trusted to reach the right one).
    // Anchored so a sibling pool slot (`…_2`) isn't killed along with it.
    assert.ok(calls.includes("kill avd deckhand_pv1_android_0([[:space:]]|$)"));
    assert.ok(calls.includes("avd delete deckhand_pv1_android_0"));
    // The developer's own simulator is never touched.
    assert.ok(!calls.some((c) => c.includes("CCC")));
  });

  it("keeps the AVD of an emulator that survived the kill", async () => {
    // The reaper is the last line of defence three comments in preview.ts point at:
    // deleting the AVD takes its name out of `listAvds()`, and `pkill -f "avd <name>"`
    // over those names is the only thing that can ever address that QEMU again. A
    // signal is not a death, so the delete waits on the confirmation, not on the send.
    const survivor = "deckhand_pv1_android_0";
    const deleted: string[] = [];
    const reaper = new Reaper({
      simctl: fakeSimctl({ listDevices: async () => [] }),
      android: fakeAndroid({
        listAvds: async () => avds,
        attachedSerials: async () => [],
        deleteAvd: async (n: string) => void deleted.push(n),
      }),
      kill: async (pattern: string) => !pattern.includes(survivor),
    });

    const report = await reaper.reap();

    assert.deepEqual(deleted, ["deckhand_pv2_android_1"], `a live emulator's AVD was deleted — saw ${JSON.stringify(deleted)}`);
    assert.deepEqual(report.avds, ["deckhand_pv2_android_1"], "and it is not reported as reaped either");
  });

  it("spares a device that is being created right now, by name", async () => {
    // The boot reap runs after the port is bound, so a start_preview can already
    // hold a lease and be mid-`simctl create` — the name exists before any UDID
    // the engine could pass in `udids`.
    const { reaper, calls } = makeReaper();
    const report = await reaper.reap({ names: ["deckhand-pv1-ios-0", "deckhand_pv1_android_0"] });

    assert.deepEqual(report.sims, ["BBB"], "the in-flight simulator survives");
    assert.deepEqual(report.avds, ["deckhand_pv2_android_1"]);
    assert.ok(!calls.some((c) => c.includes("AAA")), "no shutdown, no delete, no helper kill");
    assert.ok(!calls.some((c) => c.includes("deckhand_pv1_android_0")));
  });

  it("spares a simulator whose name is leased DURING the sweep, when keep is read lazily", async () => {
    // The window the by-value form cannot close: `reap` awaits a pkill, a
    // shutdown and a delete per orphan, so a start_preview landing after the
    // first iteration leases a name that a snapshot taken at entry can never
    // contain. Read through the thunk at the decision point and it survives.
    const leased = new Set<string>();
    const calls: string[] = [];
    const reaper = new Reaper({
      simctl: fakeSimctl({
        listDevices: async () => sims,
        shutdown: async (u: string) => {
          calls.push(`sim shutdown ${u}`);
          leased.add("deckhand-pv2-ios-0"); // an agent's start_preview lands mid-sweep
        },
        delete: async (u: string) => void calls.push(`sim delete ${u}`),
      }),
      android: fakeAndroid({ listAvds: async () => [], attachedSerials: async () => [] }),
      kill: async (pattern: string) => {
        calls.push(`kill ${pattern}`);
        return true; // confirmed gone; the "it survived" case has its own test
      },
    });

    const report = await reaper.reap(() => ({ names: [...leased] }));

    assert.deepEqual(report.sims, ["AAA"], "only the device that was already an orphan is deleted");
    assert.ok(!calls.some((c) => c.includes("BBB")), "the just-leased simulator is neither killed, shut down nor deleted");
  });

  it("spares an AVD created DURING the simulator pass, when keep is read lazily", async () => {
    // Same window, one loop later and worse: the AVD list is read after every
    // simulator await, so an emulator that booted in the meantime is live, in
    // `listAvds()`, and in a keep-set snapshot taken before any of it happened.
    // Reaping it pkills QEMU out from under a running preview and deletes the image.
    const leased = new Set<string>();
    const calls: string[] = [];
    const reaper = new Reaper({
      simctl: fakeSimctl({
        listDevices: async () => sims,
        shutdown: async (u: string) => {
          calls.push(`sim shutdown ${u}`);
          leased.add("deckhand_pv9_android_0");
        },
        delete: async (u: string) => void calls.push(`sim delete ${u}`),
      }),
      android: fakeAndroid({
        listAvds: async () => [...avds, ...leased],
        attachedSerials: async () => [],
        deleteAvd: async (n: string) => void calls.push(`avd delete ${n}`),
      }),
      kill: async (pattern: string) => {
        calls.push(`kill ${pattern}`);
        return true; // confirmed gone; the "it survived" case has its own test
      },
    });

    const report = await reaper.reap(() => ({ names: [...leased] }));

    assert.ok(!report.avds.includes("deckhand_pv9_android_0"), "the in-flight AVD is not reported deleted");
    assert.ok(!calls.some((c) => c.includes("deckhand_pv9_android_0")), "no QEMU kill, no image delete");
  });

  it("still accepts a plain keep-set, so the by-value callers keep working", async () => {
    const { reaper, calls } = makeReaper();
    const report = await reaper.reap({ udids: ["AAA"] });
    assert.deepEqual(report.sims, ["BBB"]);
    assert.ok(!calls.some((c) => c.includes("AAA")));
  });

  it("shuts pooled devices down but leaves them on disk to be reused", async () => {
    const pooledSims: SimDevice[] = [{ udid: "PPP", name: "deckhand-pool-iphone-16-pro-ios-26-0", state: "Booted" }];
    const seen: string[] = [];
    const { reaper } = makeReaper({
      simctl: fakeSimctl({
        listDevices: async () => pooledSims,
        shutdown: async (u: string) => void seen.push(`sim shutdown ${u}`),
        delete: async (u: string) => void seen.push(`sim delete ${u}`),
      }),
      android: fakeAndroid({
        listAvds: async () => ["deckhand_pool_pixel_7_api34"],
        attachedSerials: async () => [],
        deleteAvd: async (n: string) => void seen.push(`avd delete ${n}`),
      }),
    });
    const report = await reaper.reap();
    assert.deepEqual(report.sims, []);
    assert.deepEqual(report.avds, []);
    assert.deepEqual(report.keptPooled, ["deckhand-pool-iphone-16-pro-ios-26-0", "deckhand_pool_pixel_7_api34"]);
    assert.ok(seen.includes("sim shutdown PPP"), "a stale-booted pool device is still shut down");
    assert.ok(!seen.some((c) => c.startsWith("sim delete") || c.startsWith("avd delete")), "but never deleted");
  });

  it("survives a missing Xcode or Android SDK", async () => {
    const { reaper, calls } = makeReaper({
      simctl: fakeSimctl({
        listDevices: async () => {
          throw new Error("xcrun: not found");
        },
      }),
      android: fakeAndroid({
        listAvds: async () => {
          throw new Error("avdmanager: not found");
        },
        attachedSerials: async () => [],
      }),
    });
    const report = await reaper.reap();
    assert.deepEqual(report, { sims: [], avds: [], keptPooled: [] });
    assert.deepEqual(calls, []);
  });
});

describe("the serve-sim kill pattern", () => {
  // The pattern is a bare string handed to `pkill -f`, so nothing type-checks it
  // and nothing notices when it stops matching. It had not matched since it was
  // written: the real argv is ".../serve-sim.js <udid> --port N", and the pattern
  // looked for "serve-sim <udid>" — the ".js" between them meant every detached
  // helper survived every restart, holding its port. Pin it to a real argv.
  const ARGV =
    "/usr/local/bin/node /repo/node_modules/serve-sim/dist/serve-sim.js AAA --port 3100 --host 127.0.0.1";
  /**
   * POSIX ERE (what pkill reads) → JS RegExp. Only `[[:space:]]` needs
   * translating; everything else in the pattern is common to both dialects,
   * which is itself the reason to keep the pattern free of POSIX-only classes.
   */
  const asRegExp = (p: string) => new RegExp(p.replaceAll("[[:space:]]", "\\s"));

  it("matches the helper's real command line", async () => {
    const { reaper, calls } = makeReaper();
    await reaper.reap();
    const pattern = calls.find((c) => c.startsWith("kill serve-sim"))!.slice("kill ".length);
    assert.match(ARGV, asRegExp(pattern));
  });

  it("spares a helper streaming a different device", async () => {
    const { reaper, calls } = makeReaper();
    await reaper.reap();
    const pattern = calls.find((c) => c.startsWith("kill serve-sim"))!.slice("kill ".length);
    assert.equal(asRegExp(pattern).test(ARGV.replace(" AAA ", " ZZZ ")), false);
  });
});

describe("Reaper.reapOrphansByMarker", () => {
  // Two things are spawned detached and outlive the server: Metro (leaked one
  // per restart until the 8081-8099 range was full) and the livesync runners
  // (36 orphans at 418% CPU, measured — which starved the CPU-bound Android
  // emulators while native iOS stayed fine).
  const make = (pids: number[]) => {
    const killed: number[] = [];
    const reaper = new Reaper({
      simctl: fakeSimctl({ listDevices: async () => [] }),
      android: fakeAndroid({ listAvds: async () => [], attachedSerials: async () => [] }),
      markedPids: async () => pids,
      killPid: (pid) => void killed.push(pid),
    });
    return { reaper, killed };
  };

  it("kills every process carrying deckhand's marker", async () => {
    const { reaper, killed } = make([111, 222]);
    assert.deepEqual(await reaper.reapOrphansByMarker("DECKHAND_METRO"), [111, 222]);
    assert.deepEqual(killed, [111, 222]);
  });

  it("spares pids the caller still owns, and never signals itself", async () => {
    const { reaper, killed } = make([111, 222, process.pid]);
    assert.deepEqual(await reaper.reapOrphansByMarker("DECKHAND_METRO", [222]), [111]);
    assert.deepEqual(killed, [111]);
  });

  it("works for any marker, not just Metro's", async () => {
    const { reaper, killed } = make([777]);
    assert.deepEqual(await reaper.reapOrphansByMarker("DECKHAND_DEV_RUN"), [777]);
    assert.deepEqual(killed, [777]);
  });

  it("kills nothing when the marker matches nothing — the developer's own `expo start` looks identical from the outside", async () => {
    const { reaper, killed } = make([]);
    assert.deepEqual(await reaper.reapOrphansByMarker("DECKHAND_METRO"), []);
    assert.deepEqual(killed, []);
  });
});

describe("the default killer", () => {
  // Against real processes, because the confirmation is `pgrep`'s to give: an injected
  // killer can prove the reaper ACTS on the answer, never that there is an answer. The
  // version this replaced resolved on pkill's callback whatever the exit code, so every
  // caller read "signal sent" as "process dead" — and the AVD delete that follows takes
  // away the only name anything could have used to find it.
  const spawnMarked = (script: string): { marker: string; child: ReturnType<typeof spawn> } => {
    const marker = `deckhand-killer-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
    // A loop, never a bare `sleep`: sh execs a lone final command, which would replace
    // the argv the marker lives in and leave pgrep nothing to find — the test would
    // then pass by never seeing the process at all.
    const child = spawn("/bin/sh", ["-c", `${script} # ${marker}`], { stdio: "ignore" });
    return { marker, child };
  };

  const running = (marker: string): Promise<boolean> =>
    new Promise((resolve) => execFile("pgrep", ["-f", marker], (err, stdout) => resolve(!err && stdout.trim() !== "")));

  const waitForIt = async (marker: string): Promise<void> => {
    for (let i = 0; i < 100 && !(await running(marker)); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(await running(marker), "the fixture process never became visible to pgrep");
  };

  it("answers true only once the signalled process has actually gone", async () => {
    const { marker, child } = spawnMarked("while :; do sleep 1; done");
    try {
      await waitForIt(marker);
      assert.equal(await makeKiller(4000, 25)(marker), true);
      assert.equal(await running(marker), false, "it answered `gone` while the process was still there");
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("answers false when the process outlives the signal", async () => {
    const { marker, child } = spawnMarked('trap "" TERM; while :; do sleep 1; done');
    try {
      await waitForIt(marker);
      const started = Date.now();
      assert.equal(await makeKiller(300, 25)(marker), false, "pkill exiting 0 is not a death");
      assert.ok(Date.now() - started >= 300, "it must watch for the grace period, not answer on the callback");
      assert.equal(await running(marker), true, "and the process really is still running");
    } finally {
      child.kill("SIGKILL");
    }
  });
});
