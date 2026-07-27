import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore, staleOnBoot, type PersistedPreview } from "./state.ts";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "deckhand-state-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function preview(id: string, phase: PersistedPreview["phase"]): PersistedPreview {
  return {
    previewId: id,
    shareId: `share-${id}`,
    appId: "my-app",
    ref: "main",
    source: "git" as const,
    phase,
    devices: [
      { deviceId: "ios-0", platform: "ios", label: "iPhone", phase: "ready" },
    ],
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
    passwordProtected: false,
  };
}

describe("StateStore", () => {
  it("returns empty state when the file does not exist", () => {
    const store = new StateStore(join(dir, "missing.json"));
    assert.deepEqual(store.load(), { version: 1, previews: [], shareIds: {}, pins: {} });
  });

  it("round-trips previews and stable share ids through an atomic write", () => {
    const file = join(dir, "state.json");
    const store = new StateStore(file);
    store.persist([preview("p1", "ready"), preview("p2", "running")], { "my-app": "share-stable" });
    assert.ok(existsSync(file));
    const loaded = store.load();
    assert.equal(loaded.previews.length, 2);
    assert.equal(loaded.previews[0]!.previewId, "p1");
    assert.equal(loaded.previews[1]!.phase, "running");
    assert.deepEqual(loaded.shareIds, { "my-app": "share-stable" });
  });

  it("tolerates a corrupt file by returning empty state", () => {
    const file = join(dir, "corrupt.json");
    writeFileSync(file, "{ not json");
    assert.deepEqual(new StateStore(file).load(), { version: 1, previews: [], shareIds: {}, pins: {} });
  });

  it("ignores a wrong-version payload", () => {
    const file = join(dir, "v2.json");
    writeFileSync(file, JSON.stringify({ version: 2, previews: [preview("p", "ready")] }));
    assert.deepEqual(new StateStore(file).load(), { version: 1, previews: [], shareIds: {}, pins: {} });
  });
});

describe("staleOnBoot", () => {
  it("selects previews that were still live", () => {
    const state = {
      version: 1 as const,
      previews: [
        preview("live1", "ready"),
        preview("live2", "running"),
        preview("done", "stopped"),
        preview("dead", "failed"),
      ],
      shareIds: {},
      pins: {},
    };
    assert.deepEqual(
      staleOnBoot(state).map((p) => p.previewId),
      ["live1", "live2"],
    );
  });
});
