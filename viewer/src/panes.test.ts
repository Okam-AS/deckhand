import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeStage, paneKey, shortDeviceName } from "./panes.ts";
import type { SharePane } from "./api.ts";

const dev = (deviceId: string, platform: string, label = deviceId) => ({ deviceId, platform, label, phase: "ready" });

const pane = (shareId: string, repo: string, ref: string, devices: ReturnType<typeof dev>[], extra: Partial<SharePane> = {}): SharePane => ({
  shareId,
  repo,
  ref,
  devices,
  ...extra,
});

const solo = [pane("s1", "github.com/acme/app", "main", [dev("ios-0", "ios"), dev("android-1", "android")], { self: true })];

const twoSources = [
  pane("old", "github.com/acme/legacy", "dev", [dev("ios-0", "ios"), dev("android-1", "android")]),
  pane("new", "github.com/acme/app", "feature/x", [dev("ios-0", "ios"), dev("android-1", "android")], { self: true }),
];

describe("computeStage — how many devices are on screen", () => {
  it("shows every device of a single source, so iOS and Android stay side by side", () => {
    const s = computeStage(solo, { isMobile: false });
    assert.equal(s.multiSource, false);
    assert.equal(s.visible.size, 2, "one app's two platforms both stay on screen");
  });

  it("shows one device per source when there are several, never four phones", () => {
    const s = computeStage(twoSources, { isMobile: false });
    assert.equal(s.multiSource, true);
    assert.equal(s.panes.length, 4, "all four stay mounted…");
    assert.equal(s.visible.size, 2, "…but only one per source is on screen");
    assert.deepEqual([...s.visible].sort(), [paneKey("new", "ios-0"), paneKey("old", "ios-0")].sort());
  });

  it("shows exactly one device on mobile, whatever the source count", () => {
    for (const panes of [solo, twoSources]) {
      assert.equal(computeStage(panes, { isMobile: true }).visible.size, 1);
    }
  });

  it("lets a single source switch devices off, but never down to an empty stage", () => {
    const one = computeStage(solo, { isMobile: false, hiddenKeys: [paneKey("s1", "android-1")] });
    assert.deepEqual([...one.visible], [paneKey("s1", "ios-0")]);

    const none = computeStage(solo, { isMobile: false, hiddenKeys: [paneKey("s1", "ios-0"), paneKey("s1", "android-1")] });
    assert.equal(none.visible.size, 1, "switching the last device off is a no-op, not a blank page");
  });

  it("ignores hiddenKeys with several sources, where each already shows one device", () => {
    const s = computeStage(twoSources, { isMobile: false, hiddenKeys: [paneKey("old", "ios-0")] });
    assert.equal(s.visible.size, 2);
  });

  it("keeps every device mounted even when hidden, so switching back is instant", () => {
    const s = computeStage(twoSources, { isMobile: true });
    assert.equal(s.panes.length, 4);
    assert.equal(s.visible.size, 1);
  });
});

describe("computeStage — pane identity", () => {
  it("keys panes by source AND device, because both sources call their first device ios-0", () => {
    // Keyed on deviceId alone these collide: React reuses the wrong frame, the
    // FLIP map reads a foreign rect, and input lands on the wrong phone.
    const s = computeStage(twoSources, { isMobile: false });
    assert.equal(new Set(s.panes.map((p) => p.key)).size, 4, "four distinct keys for four devices");
    assert.equal(s.panes.filter((p) => p.deviceId === "ios-0").length, 2, "…from only two distinct deviceIds");
  });

  it("keeps keys stable across a re-poll, so nothing remounts and restarts its decoder", () => {
    const a = computeStage(twoSources, { isMobile: false });
    const b = computeStage(structuredClone(twoSources), { isMobile: false });
    assert.deepEqual(
      a.panes.map((p) => p.key),
      b.panes.map((p) => p.key),
    );
  });
});

describe("computeStage — which device each source shows", () => {
  it("defaults to the first device", () => {
    const s = computeStage(twoSources, { isMobile: false });
    assert.equal(s.groups[0]!.activeKey, paneKey("old", "ios-0"));
  });

  it("follows the platform picked elsewhere, so both columns switch together", () => {
    const s = computeStage(twoSources, { isMobile: false, preferredPlatform: "android" });
    assert.deepEqual(
      s.groups.map((g) => g.activeKey),
      [paneKey("old", "android-1"), paneKey("new", "android-1")],
    );
  });

  it("lets an explicit pick beat the shared platform, to compare across platforms on purpose", () => {
    const s = computeStage(twoSources, {
      isMobile: false,
      preferredPlatform: "android",
      choices: { old: paneKey("old", "ios-0") },
    });
    assert.deepEqual(
      s.groups.map((g) => g.activeKey),
      [paneKey("old", "ios-0"), paneKey("new", "android-1")],
    );
  });

  it("falls back to the first device when a source lacks the preferred platform", () => {
    const mixed = [pane("a", "r/a", "main", [dev("ios-0", "ios")]), pane("b", "r/b", "main", [dev("android-0", "android")])];
    const s = computeStage(mixed, { isMobile: false, preferredPlatform: "android" });
    assert.deepEqual(
      s.groups.map((g) => g.activeKey),
      [paneKey("a", "ios-0"), paneKey("b", "android-0")],
    );
  });

  it("skips a failed device so a working one is what you see", () => {
    // A group shows ONE device. Picking positionally put "This device didn't
    // start" on screen while a healthy sim sat hidden behind the picker.
    const broken = [
      pane("a", "r/a", "main", [{ ...dev("ios-0", "ios"), phase: "failed" }, dev("android-1", "android")]),
      pane("b", "r/b", "main", [dev("ios-0", "ios")], { self: true }),
    ];
    const s = computeStage(broken, { isMobile: false });
    assert.equal(s.groups[0]!.activeKey, paneKey("a", "android-1"));
  });

  it("still shows a failed device when it is the only one", () => {
    const allBroken = [
      pane("a", "r/a", "main", [{ ...dev("ios-0", "ios"), phase: "failed" }]),
      pane("b", "r/b", "main", [dev("ios-0", "ios")], { self: true }),
    ];
    const s = computeStage(allBroken, { isMobile: false });
    assert.equal(s.groups[0]!.activeKey, paneKey("a", "ios-0"), "hiding it would leave an empty column and no error");
  });

  it("lets an explicit pick select a failed device, which is how you read the error", () => {
    const broken = [
      pane("a", "r/a", "main", [{ ...dev("ios-0", "ios"), phase: "failed" }, dev("android-1", "android")]),
      pane("b", "r/b", "main", [dev("ios-0", "ios")], { self: true }),
    ];
    const s = computeStage(broken, { isMobile: false, choices: { a: paneKey("a", "ios-0") } });
    assert.equal(s.groups[0]!.activeKey, paneKey("a", "ios-0"));
  });

  it("prefers a healthy device over the shared platform when that platform is broken", () => {
    const broken = [
      pane("a", "r/a", "main", [dev("ios-0", "ios"), { ...dev("android-1", "android"), phase: "failed" }]),
      pane("b", "r/b", "main", [dev("ios-0", "ios"), dev("android-1", "android")], { self: true }),
    ];
    const s = computeStage(broken, { isMobile: false, preferredPlatform: "android" });
    assert.equal(s.groups[0]!.activeKey, paneKey("a", "ios-0"), "a broken pane is worse than the wrong platform");
    assert.equal(s.groups[1]!.activeKey, paneKey("b", "android-1"), "…and the healthy source still follows the platform");
  });

  it("ignores a stale choice instead of blanking the source", () => {
    const s = computeStage(twoSources, { isMobile: false, choices: { old: paneKey("old", "ios-99") } });
    assert.equal(s.groups[0]!.activeKey, paneKey("old", "ios-0"));
  });

  it("ignores a stale mobile focus instead of showing nothing", () => {
    const s = computeStage(twoSources, { isMobile: true, focusKey: "gone:ios-0" });
    assert.equal(s.visible.size, 1);
    assert.deepEqual([...s.visible], [paneKey("old", "ios-0")]);
  });
});

describe("computeStage — headings", () => {
  it("names a source by its repo, with the branch underneath", () => {
    const s = computeStage(twoSources, { isMobile: false });
    assert.deepEqual(s.groups.map((g) => g.label), ["legacy", "app"]);
    assert.deepEqual(s.groups.map((g) => g.meta), ["dev", "feature/x"]);
  });

  it("distinguishes two refs of the SAME repo by the branch line", () => {
    // The case an agent-supplied name used to paper over: same repo twice, where
    // the repo name alone identifies neither pane.
    const sameRepo = [
      pane("a", "github.com/acme/app", "main", [dev("ios-0", "ios")]),
      pane("b", "github.com/acme/app", "feature/x", [dev("ios-0", "ios")], { self: true }),
    ];
    const s = computeStage(sameRepo, { isMobile: false });
    assert.deepEqual(s.groups.map((g) => g.label), ["app", "app"]);
    assert.deepEqual(s.groups.map((g) => g.meta), ["main", "feature/x"], "the branch is what tells them apart");
  });

  it("marks exactly one source as the page's own", () => {
    const s = computeStage(twoSources, { isMobile: false });
    assert.deepEqual(
      s.groups.map((g) => g.self),
      [false, true],
    );
  });

  it("drops a source with no devices rather than rendering an empty column", () => {
    const s = computeStage([pane("empty", "r/e", "main", []), ...twoSources], { isMobile: false });
    assert.equal(s.groups.length, 2);
    assert.equal(s.multiSource, true);
  });

  it("survives a page with no panes at all", () => {
    const s = computeStage([], { isMobile: false });
    assert.deepEqual(s.groups, []);
    assert.equal(s.visible.size, 0);
    assert.equal(s.multiSource, false);
  });
});

describe("shortDeviceName", () => {
  it("drops the runtime suffix the picker has no room for", () => {
    assert.equal(shortDeviceName("iPhone 16 Pro · iOS 26.5"), "iPhone 16 Pro");
    assert.equal(shortDeviceName("pixel_7"), "pixel_7");
  });
});
