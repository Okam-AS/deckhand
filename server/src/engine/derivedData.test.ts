import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneDerivedData } from "./derivedData.ts";

describe("pruneDerivedData", () => {
  const setup = (names: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "deckhand-dd-"));
    for (const n of names) {
      mkdirSync(join(dir, n), { recursive: true });
      writeFileSync(join(dir, n, "info.plist"), "");
    }
    return dir;
  };

  it("removes trees whose project is gone and keeps the ones still on disk", async () => {
    // Xcode keys DerivedData on the project PATH, so every abandoned checkout
    // leaves a multi-GB tree behind that nothing else reclaims.
    const dir = setup(["App-gone", "App-live", "ModuleCache.noindex"]);
    const live = mkdtempSync(join(tmpdir(), "deckhand-proj-"));
    try {
      const removed = await pruneDerivedData({
        dir,
        readWorkspacePath: async (p) => (p.includes("App-live") ? join(live, "App.xcodeproj") : "/wt/gone/App.xcodeproj"),
        exists: (p) => p.endsWith("info.plist") || p.startsWith(live),
        ownedRoots: ["/wt", live],
      });
      assert.deepEqual(removed.sort(), ["App-gone"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(live, { recursive: true, force: true });
    }
  });

  it("never reclaims a checkout that is building right now", async () => {
    // `ns prepare ios` / `expo prebuild` regenerate platforms/ios IN PLACE, so
    // mid-build the workspace path is briefly absent while the checkout is very
    // much alive. The janitor ticks every 60s — without the live keep-set it
    // deletes the DerivedData of the project currently being built.
    const dir = setup(["App-building"]);
    try {
      const removed = await pruneDerivedData({
        dir,
        readWorkspacePath: async () => "/wt/app-a/platforms/ios/App.xcworkspace",
        exists: (p) => p.endsWith("info.plist"),
        ownedRoots: ["/wt"],
        livePaths: ["/wt/app-a"],
      });
      assert.deepEqual(removed, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves a tree alone when the plist cannot be read", async () => {
    // An unreadable plist is not evidence of an orphan, and this deletes GBs.
    const dir = setup(["App-unknown"]);
    try {
      const removed = await pruneDerivedData({ dir, readWorkspacePath: async () => null, exists: () => true });
      assert.deepEqual(removed, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns nothing when there is no DerivedData directory", async () => {
    assert.deepEqual(await pruneDerivedData({ dir: "/nope/deckhand-missing" }), []);
  });
});

describe("the real plist reader", () => {
  it("reads WorkspacePath from an Xcode-shaped info.plist", async () => {
    // Xcode's plist carries a <date>, which plutil refuses to convert to JSON —
    // the first version read every tree as unknown and reclaimed nothing.
    const dir = mkdtempSync(join(tmpdir(), "deckhand-dd-real-"));
    try {
      mkdirSync(join(dir, "App-abc"), { recursive: true });
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>LastAccessedDate</key><date>2026-07-27T19:20:33Z</date>
  <key>WorkspacePath</key><string>/definitely/not/here/App.xcodeproj</string>
</dict></plist>`;
      writeFileSync(join(dir, "App-abc", "info.plist"), plist);
      assert.deepEqual(await pruneDerivedData({ dir, ownedRoots: ["/definitely/not"] }), ["App-abc"]);
      // ...and the same tree is left alone when it isn't deckhand's to delete.
      mkdirSync(join(dir, "App-abc"), { recursive: true });
      writeFileSync(join(dir, "App-abc", "info.plist"), plist);
      assert.deepEqual(await pruneDerivedData({ dir, ownedRoots: ["/somewhere/else"] }), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
