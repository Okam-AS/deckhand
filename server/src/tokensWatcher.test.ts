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

  it("applies a rotation that keeps the name and changes the value", async () => {
    // THE case a leak is fixed by: `deckhand token` refuses a duplicate name, so rotating a
    // credential means writing a new value under the same name. The reload used to compare
    // NAMES and return early — so the file changed, the operator believed the old URL was
    // dead, and it kept opening the door until the next restart.
    //
    // Its OWN directory: the other cases share `file`, and a second watcher on it fires on
    // every write here. That coupling is what made an unrelated case fail when this one was
    // added — the tests were never independent, they only looked it.
    const ownDir = mkdtempSync(join(tmpdir(), "deckhand-rotate-"));
    const ownFile = join(ownDir, "tokens.yaml");
    const put = (value: string): void => {
      const tmp = `${ownFile}.tmp`;
      writeFileSync(tmp, `tokens:\n  - name: asharghi\n    token: ${value}\n`);
      renameSync(tmp, ownFile);
    };
    const oldValue = tokenOf("rotate-old");
    const newValue = tokenOf("rotate-new");
    put(oldValue);
    const auth = new TokenAuthenticator([]);
    const stop = watchTokens(auth, { file: ownFile, debounceMs: 20, pollMs: 100 });
    try {
      put(oldValue); // a touch the watcher can see, so the first list is loaded
      await settle();
      assert.ok(auth.authenticate(oldValue), "the old credential works to begin with");

      put(newValue);
      await settle();
      assert.equal(auth.authenticate(oldValue), null, "the rotated-away value must stop working");
      assert.equal(auth.authenticate(newValue)?.name, "asharghi", "and the new one must work");
    } finally {
      stop();
      rmSync(ownDir, { recursive: true, force: true });
    }
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
