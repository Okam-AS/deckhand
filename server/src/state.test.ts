import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { StateStore, type PersistedPreview } from "./state.ts";

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

describe("StateStore.load never silently discards state", () => {
  const tmp = (): string => join(mkdtempSync(join(tmpdir(), "deckhand-state-")), "state.json");

  it("treats only a MISSING file as an empty start", () => {
    const s = new StateStore(tmp());
    assert.deepEqual(s.load().previews, []);
    assert.deepEqual(s.load().pins, {});
  });

  it("quarantines an unparseable file instead of overwriting it", () => {
    // A truncated write, or a hand edit — AGENTS.md tells agents to READ this file, so hand
    // edits happen. Every failure used to collapse to EMPTY, and the first persist() then
    // destroyed every share id and PIN hash on the machine, silently.
    const file = tmp();
    writeFileSync(file, '{"version":1,"previews":[{"id":"pv1"}], TRUNCATED');
    const store = new StateStore(file);
    const loaded = store.load();
    assert.deepEqual(loaded.previews, [], "it does start clean…");

    const aside = readdirSync(dirname(file)).find((f) => f.includes(".corrupt-"));
    assert.ok(aside, "…but the original is preserved, because it is the only copy of every PIN hash");
    assert.match(readFileSync(join(dirname(file), aside!), "utf8"), /TRUNCATED/, "byte-for-byte");
    assert.equal(existsSync(file), false, "and the bad file is out of the way, so the next persist is clean");
  });

  it("quarantines a file of the wrong shape, not just invalid JSON", () => {
    // Valid JSON, wrong contents — a version bump, or something else writing to the path.
    const file = tmp();
    writeFileSync(file, JSON.stringify({ version: 99, previews: "not an array" }));
    new StateStore(file).load();
    assert.ok(readdirSync(dirname(file)).some((f) => f.includes(".corrupt-")));
  });

  it("refuses to start when the file exists but cannot be read", () => {
    // A permissions or IO fault is an operator problem. A server that cannot read this file
    // must not come up and overwrite it — that turns a fixable error into permanent loss.
    const file = tmp();
    writeFileSync(file, "{}", { mode: 0o600 });
    chmodSync(file, 0o000);
    try {
      assert.throws(() => new StateStore(file).load(), /Refusing to start/);
    } finally {
      chmodSync(file, 0o600);
    }
  });

  it("round-trips shareIds and pins", () => {
    const file = tmp();
    const store = new StateStore(file);
    store.persist([], { app1: "share-abc" }, { app1: { salt: "s", hash: "h", length: 4 } });
    const back = new StateStore(file).load();
    assert.equal(back.shareIds.app1, "share-abc");
    assert.equal(back.pins.app1?.length, 4);
  });
});
