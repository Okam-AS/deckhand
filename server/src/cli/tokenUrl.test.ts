import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A connector token used to be UNRECOVERABLE.
 *
 * `token add` printed the URL once; `token list` showed only names. Lose the
 * scrollback and the only ways back were minting a new token — which invalidates every client
 * already using the old one — or opening tokens.yaml by hand, which is what people did.
 * Reported by a user running `deckhand token list` after being told, by this repo's own setup
 * output, that it shows the connector URL. It did not.
 */

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "deckhand.mjs");
let home: string;

const run = (...args: string[]): string =>
  execFileSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, DECKHAND_HOME: home },
  });

before(() => {
  home = mkdtempSync(join(tmpdir(), "deckhand-tok-"));
  run("init", "--hostname", "deckhand.example.com");
  run("token", "add", "alice");
  run("token", "add", "bob"); // a second credential, for the ambiguity case
});
after(() => rmSync(home, { recursive: true, force: true }));

describe("deckhand token url", () => {
  it("prints one token's full connector URL", () => {
    const url = run("token", "url", "alice").trim();
    assert.match(url, /^https:\/\/deckhand\.example\.com\/mcp\/[0-9a-f]{64}$/, "usable as-is, no assembly required");
  });

  it("prints a DIFFERENT url for a different token", () => {
    assert.notEqual(run("token", "url", "alice").trim(), run("token", "url", "bob").trim());
  });

  it("names the mistake when the token does not exist", () => {
    assert.throws(
      () => run("token", "url", "nope"),
      (e: Error & { stderr?: string }) => {
        assert.match(`${e.stderr ?? ""}`, /no token named "nope"/);
        return true;
      },
    );
  });
});

describe("deckhand token list", () => {
  it("masks the tokens, because listing who has access should not hand out credentials", () => {
    // `list` answers "which credentials exist". Printing every one in full to answer that puts
    // them in a scrollback, a screen share and a screenshot. The one you want is a deliberate
    // act: `token url <name>`.
    const out = run("token", "list");
    assert.match(out, /alice/);
    assert.match(out, /bob/);
    assert.doesNotMatch(out, /[0-9a-f]{64}/, "no full token may appear here");
    assert.match(out, /deckhand token url <name>/, "and it says how to get the real one");
  });

  it("tells a fresh install what to do instead of printing nothing", () => {
    const fresh = mkdtempSync(join(tmpdir(), "deckhand-tok0-"));
    try {
      const out = execFileSync(process.execPath, [BIN, "token", "list"], {
        encoding: "utf8",
        env: { ...process.env, DECKHAND_HOME: fresh },
      });
      assert.match(out, /no tokens yet/, "silence reads as a broken command");
      assert.match(out, /deckhand token/);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe("deckhand token rm", () => {
  it("revokes one credential and leaves the other", () => {
    // The way back from a leaked connector URL. Before this existed the answer was
    // "hand-edit tokens.yaml", and the running server ignored the edit anyway
    // (tokensWatcher compared names, not content).
    const fresh = mkdtempSync(join(tmpdir(), "deckhand-tokrm-"));
    const at = (...args: string[]): string =>
      execFileSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, DECKHAND_HOME: fresh } });
    try {
      at("init", "--hostname", "deckhand.example.com");
      at("token", "add", "keep");
      at("token", "add", "leaked");
      const out = at("token", "rm", "leaked");
      assert.match(out, /revoked "leaked"/);
      assert.doesNotMatch(out, /[0-9a-f]{64}/, "revoking must not print the credential it just killed");
      const list = at("token", "list");
      assert.match(list, /keep/);
      assert.doesNotMatch(list, /leaked/, "and it is gone from the file");
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("names the mistake when the token does not exist", () => {
    assert.throws(
      () => run("token", "rm", "nope"),
      (e: Error & { stderr?: string }) => {
        assert.match(`${e.stderr ?? ""}`, /no token named "nope"/);
        return true;
      },
    );
  });
});

describe("deckhand token (no subcommand)", () => {
  it("creates one on a fresh install and prints the URL", () => {
    // More than one token is a CLIENT concept — a second one for another machine, which is what
    // `list` shows. Nobody should have to learn that to answer "what do I paste into claude.ai".
    const fresh = mkdtempSync(join(tmpdir(), "deckhand-tok1-"));
    const at = (...args: string[]): string =>
      execFileSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, DECKHAND_HOME: fresh } });
    try {
      at("init", "--hostname", "deckhand.example.com");
      const first = at("token").trim();
      assert.match(first, /https:\/\/deckhand\.example\.com\/mcp\/[0-9a-f]{64}$/m);
      // Idempotent: running it again must not mint a second token and silently invalidate
      // nothing — but it also must not create clutter the user then has to disambiguate.
      assert.equal(at("token").trim(), first.split("\n").pop()!.trim(), "the same URL, not a new token");
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("refuses to guess when several tokens exist", () => {
    // Picking one at random would hand out a credential the caller did not mean.
    assert.throws(
      () => run("token"),
      (e: Error & { stderr?: string }) => {
        assert.match(`${e.stderr ?? ""}`, /2 tokens exist/);
        assert.match(`${e.stderr ?? ""}`, /deckhand token url alice/, "and it names the exact commands");
        return true;
      },
    );
  });
});
