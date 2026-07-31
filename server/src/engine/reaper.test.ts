import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Reaper, orphanSims, orphanAvds, type ReaperDeps } from "./reaper.ts";
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
});

function makeReaper(overrides: Partial<ReaperDeps> = {}) {
  const calls: string[] = [];
  const deps: ReaperDeps = {
    simctl: {
      listDevices: async () => sims,
      shutdown: async (u: string) => void calls.push(`sim shutdown ${u}`),
      delete: async (u: string) => void calls.push(`sim delete ${u}`),
    } as unknown as ReaperDeps["simctl"],
    android: {
      listAvds: async () => avds,
      attachedSerials: async () => [],
      deleteAvd: async (n: string) => void calls.push(`avd delete ${n}`),
    } as unknown as ReaperDeps["android"],
    kill: async (pattern: string) => void calls.push(`kill ${pattern}`),
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

  it("shuts pooled devices down but leaves them on disk to be reused", async () => {
    const pooledSims: SimDevice[] = [{ udid: "PPP", name: "deckhand-pool-iphone-16-pro-ios-26-0", state: "Booted" }];
    const seen: string[] = [];
    const { reaper } = makeReaper({
      simctl: {
        listDevices: async () => pooledSims,
        shutdown: async (u: string) => void seen.push(`sim shutdown ${u}`),
        delete: async (u: string) => void seen.push(`sim delete ${u}`),
      } as unknown as ReaperDeps["simctl"],
      android: {
        listAvds: async () => ["deckhand_pool_pixel_7_api34"],
        attachedSerials: async () => [],
        deleteAvd: async (n: string) => void seen.push(`avd delete ${n}`),
      } as unknown as ReaperDeps["android"],
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
      simctl: {
        listDevices: async () => {
          throw new Error("xcrun: not found");
        },
      } as unknown as ReaperDeps["simctl"],
      android: {
        listAvds: async () => {
          throw new Error("avdmanager: not found");
        },
        attachedSerials: async () => [],
      } as unknown as ReaperDeps["android"],
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
      simctl: { listDevices: async () => [] } as unknown as ReaperDeps["simctl"],
      android: { listAvds: async () => [], attachedSerials: async () => [] } as unknown as ReaperDeps["android"],
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
