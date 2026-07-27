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
    assert.deepEqual(calls.slice(0, 3), ["kill serve-sim AAA", "sim shutdown AAA", "sim delete AAA"]);
    // Emulators are killed by their -avd argument (console ports collide across
    // orphans, so `adb emu kill` cannot be trusted to reach the right one).
    // Anchored so a sibling pool slot (`…_2`) isn't killed along with it.
    assert.ok(calls.includes("kill avd deckhand_pv1_android_0([[:space:]]|$)"));
    assert.ok(calls.includes("avd delete deckhand_pv1_android_0"));
    // The developer's own simulator is never touched.
    assert.ok(!calls.some((c) => c.includes("CCC")));
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
      } as unknown as ReaperDeps["android"],
    });
    const report = await reaper.reap();
    assert.deepEqual(report, { sims: [], avds: [], keptPooled: [] });
    assert.deepEqual(calls, []);
  });
});
