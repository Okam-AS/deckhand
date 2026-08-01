import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { watchTokens } from "./tokensWatcher.ts";
import { TokenAuthenticator } from "./auth.ts";

/**
 * The bug this closes broke a brand-new install at the one step nobody can skip.
 *
 * `setup` starts the server (LaunchAgent) and then mints the admin token. `loadTokens()` had
 * already run, so the server did not know the only token that existed: every request to
 * `/mcp/<token>` answered 404, and claude.ai — finding no MCP server — fell back to OAuth
 * discovery and told the user "Couldn't register with Deckhand's sign-in service".
 *
 * Observed on a real machine. The fix at the time was a restart nobody would have guessed at.
 */

let dir: string;
let file: string;
const stops: (() => void)[] = [];

/** A valid 64-char lowercase-hex token, deterministic per name — the schema enforces the shape. */
const tokenOf = (n: string): string => createHash("sha256").update(n).digest("hex");

const write = (...names: string[]): void => {
  const body = `tokens:\n${names.map((n) => `  - name: ${n}\n    token: ${tokenOf(n)}\n    role: admin\n`).join("")}`;
  // Mirror writeTokens: temp file + rename, which swaps the inode.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, file);
};
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 400));

before(() => {
  dir = mkdtempSync(join(tmpdir(), "deckhand-tokens-"));
  file = join(dir, "tokens.yaml");
});
after(() => {
  while (stops.length) stops.pop()!();
  rmSync(dir, { recursive: true, force: true });
});

describe("watchTokens", () => {
  it("makes a token minted after boot work without a restart", async () => {
    // Exactly the fresh-install sequence: server up with no tokens, then setup mints one.
    write();
    const auth = new TokenAuthenticator([]);
    stops.push(watchTokens(auth, { file, debounceMs: 20, pollMs: 100 }));
    assert.equal(auth.authenticate(tokenOf("alice")), null, "before: unknown, which is the 404");

    write("alice");
    await settle();
    assert.equal(auth.authenticate(tokenOf("alice"))?.name, "alice", "after: it just works");
  });

  it("revokes immediately, rather than keeping the old list", async () => {
    // Opposite of apps.yaml, deliberately. There an empty file is treated as a truncated
    // write; here the safe direction is the other way — a token someone deleted must stop
    // opening the door at once, not after the next restart.
    write("alice", "bob");
    const auth = new TokenAuthenticator([]);
    stops.push(watchTokens(auth, { file, debounceMs: 20, pollMs: 100 }));
    await settle();
    assert.ok(auth.authenticate(tokenOf("bob")));

    write("alice");
    await settle();
    assert.equal(auth.authenticate(tokenOf("bob")), null, "revoked means revoked");
    assert.ok(auth.authenticate(tokenOf("alice")), "and the others still work");
  });

  it("keeps the current tokens when the file is unreadable", async () => {
    // A half-written file must not lock everyone out mid-session.
    write("alice");
    const auth = new TokenAuthenticator([]);
    const errors: unknown[] = [];
    stops.push(watchTokens(auth, { file, debounceMs: 20, pollMs: 100, onError: (e) => errors.push(e) }));
    await settle();

    writeFileSync(file, "tokens: [[[ not yaml");
    await settle();
    assert.ok(auth.authenticate(tokenOf("alice")), "still authenticating");
    assert.ok(errors.length > 0, "and the operator is told");
  });

  it("survives the rename an atomic write performs", async () => {
    // writeTokens renames a temp file over the target, so a file-level watcher would end up
    // listening to an inode nobody writes to again. This watches the directory.
    write("alice");
    const auth = new TokenAuthenticator([]);
    stops.push(watchTokens(auth, { file, debounceMs: 20, pollMs: 100 }));
    await settle();
    for (const name of ["bravo", "charlie"]) {
      write(name);
      await settle();
      assert.ok(auth.authenticate(tokenOf(name)), `${name} works after a rename`);
    }
  });
});
