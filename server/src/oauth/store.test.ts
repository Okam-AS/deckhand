import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuthStore, RegistryFullError, type Grant, type OAuthClient } from "./store.ts";

/**
 * What the store writes, as opposed to what it holds.
 *
 * `oauth.json` is the only thing that survives a restart, so a path that mutates the map and
 * skips the write leaves the running server and the next one disagreeing — and the disagreement
 * shows up as "unknown client" for a client that is in the file.
 */

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "deckhand-oauth-"));
  file = join(dir, "oauth.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const seed = (clients: number): string[] => {
  const ids = Array.from({ length: clients }, (_, i) => `client-${i}`);
  const rows: OAuthClient[] = ids.map((clientId) => ({
    clientId,
    redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
    name: "Claude",
    createdMs: 1_000 + Number(clientId.split("-")[1]),
  }));
  writeFileSync(file, JSON.stringify({ clients: rows, grants: [] as Grant[] }));
  return ids;
};

const onDisk = (): OAuthClient[] => (JSON.parse(readFileSync(file, "utf8")) as { clients: OAuthClient[] }).clients;

describe("the client registry's ceiling", () => {
  // The refusal path threw before saving, so an eviction that had already happened in memory was
  // never written: the dropped clients answered "unknown client" until a restart brought them
  // back from the file, and a file that was already oversized was never trimmed by this path.
  it("persists the eviction it performed even when the registration is refused", () => {
    const ids = seed(70);
    const store = new OAuthStore({ file, now: () => 9_000 });
    // Every client that could be evicted is mid-flow, so there is no room for a newcomer.
    const busy = new Set(ids.slice(0, 64));
    assert.throws(() => store.registerClient({ redirectUris: ["https://claude.ai/cb"] }, busy), RegistryFullError);
    assert.equal(store.clientCount(), 64, "the oldest idle clients are gone from memory");
    assert.equal(onDisk().length, 64, "and from the file, or the next boot disagrees with this one");
    // client-64 upward are the idle ones — the only candidates, since 0..63 are mid-flow.
    assert.equal(
      onDisk().some((c) => c.clientId === "client-64"),
      false,
      "the client evicted in memory must not reappear on restart",
    );
    assert.ok(
      onDisk().some((c) => c.clientId === "client-0"),
      "and a client mid-flow must survive, in the file as well as in memory",
    );
  });

  // …and writes NOTHING when there was nothing to evict, which is the steady state under a
  // flood: every slot busy, so every refusal evicted nobody. Saving unconditionally there turned
  // the one register path that touched no disk into a whole-file write+rename per request, at
  // whatever rate an unauthenticated caller likes — the write amplification the cap exists to
  // prevent (measured: 200 refusals, 10.8 kB rewritten each, bytes identical every time).
  it("does not rewrite the file for a refusal that evicted nobody", () => {
    const ids = seed(64);
    const store = new OAuthStore({ file, now: () => 9_000 });
    const busy = new Set(ids);
    const before = statSync(file).mtimeMs;
    for (let i = 0; i < 5; i++) {
      assert.throws(() => store.registerClient({ redirectUris: ["https://claude.ai/cb"] }, busy), RegistryFullError);
    }
    assert.equal(statSync(file).mtimeMs, before, "a refusal that changed nothing must not touch the disk");
  });

  // The other half of the same path: when an idle client CAN be evicted, the registration
  // succeeds rather than being refused, so a full-but-idle registry still admits a newcomer.
  it("admits a newcomer by evicting an idle client rather than refusing", () => {
    seed(64);
    const store = new OAuthStore({ file, now: () => 9_000 });
    const client = store.registerClient({ redirectUris: ["https://claude.ai/cb"] });
    assert.equal(store.clientCount(), 64);
    assert.ok(store.getClient(client.clientId), "the client just registered must be the one that survives");
    assert.equal(onDisk().length, 64);
  });
});
