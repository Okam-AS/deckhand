import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, statSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createSetupRouter } from "./router.ts";
import { SetupStore } from "./setupStore.ts";

/**
 * The one-time credential setup page.
 *
 * This is the highest security-per-line surface in the repo and had no tests at all. It is
 * **unauthenticated by design** — the nonce in the URL is the entire capability (PLAN §6) —
 * and it WRITES A CREDENTIAL to disk. Everything below is a property that must hold for that
 * trade to be safe, rather than a behaviour that happens to be true today.
 *
 * A real HTTP server rather than a mocked req/res: the things worth checking here are status
 * codes, a urlencoded body parser, and a file's mode. Mocks would assert my idea of express.
 */

interface Harness {
  origin: string;
  store: SetupStore;
  patPath: string;
  dir: string;
  onSet: number;
  close: () => Promise<void>;
}

async function harness(opts: { ttlMs?: number; now?: () => number } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "deckhand-setup-"));
  const patPath = join(dir, "secrets", "github-pat");
  const store = new SetupStore(opts.ttlMs ?? 15 * 60_000, opts.now);
  const h: Harness = { origin: "", store, patPath, dir, onSet: 0, close: async () => {} };
  const app = express();
  app.use("/setup", createSetupRouter({ store, patPath, onCredentialSet: () => void (h.onSet += 1) }));
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  h.origin = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  h.close = async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  };
  return h;
}

/** Always closes: a leaked listener means `node --test` never exits, so a failure would hang CI. */
async function withSetup(body: (h: Harness) => Promise<void>, opts?: { ttlMs?: number; now?: () => number }): Promise<void> {
  const h = await harness(opts);
  try {
    await body(h);
  } finally {
    await h.close();
  }
}

const post = (origin: string, path: string, token: string): Promise<Response> =>
  fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  });

const VALID = "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz012345";

describe("setup router — the nonce is the whole capability", () => {
  it("404s an unknown nonce without saying whether it ever existed", async () => {
    await withSetup(async (h) => {
      const res = await fetch(`${h.origin}/setup/not-a-real-nonce`);
      assert.equal(res.status, 404);
      const body = await res.text();
      assert.doesNotMatch(body, /<form/, "no form for a nonce we do not know");
      // Expired and never-existed must be indistinguishable, or the page is an oracle for
      // guessing which 128-bit values were once live.
      const stale = await fetch(`${h.origin}/setup/${"A".repeat(22)}`);
      assert.equal(stale.status, 404);
      assert.equal(await stale.text(), body, "the two cases render identically");
    });
  });

  it("404s an expired nonce, and never writes for one", async () => {
    let clock = 1_000;
    await withSetup(
      async (h) => {
        const nonce = h.store.mint("github-pat", "acme");
        clock += 60_000; // past the 15s TTL below
        assert.equal((await fetch(`${h.origin}/setup/${nonce}`)).status, 404);
        assert.equal((await post(h.origin, `/setup/${nonce}`, VALID)).status, 404);
        assert.equal(existsSync(h.patPath), false, "an expired link must not be able to write a credential");
      },
      { ttlMs: 15_000, now: () => clock },
    );
  });

  it("is single-use — the second POST cannot write", async () => {
    await withSetup(async (h) => {
      const nonce = h.store.mint("github-pat");
      assert.equal((await post(h.origin, `/setup/${nonce}`, VALID)).status, 200);
      assert.equal(readFileSync(h.patPath, "utf8").trim(), VALID);

      rmSync(h.patPath);
      assert.equal((await post(h.origin, `/setup/${nonce}`, VALID)).status, 404, "the nonce is burned");
      assert.equal(existsSync(h.patPath), false, "and a replay writes nothing");
    });
  });
});

describe("setup router — the credential", () => {
  it("writes the token to a 0600 file and reports it once", async () => {
    await withSetup(async (h) => {
      const nonce = h.store.mint("github-pat");
      const res = await post(h.origin, `/setup/${nonce}`, VALID);
      assert.equal(res.status, 200);
      assert.equal(readFileSync(h.patPath, "utf8"), `${VALID}\n`);
      // 0600, not 0644: this file is the credential. Anything readable by another account on
      // the mini is the same as not having the file permission at all.
      assert.equal(statSync(h.patPath).mode & 0o777, 0o600);
      assert.equal(h.onSet, 1, "the resolver is nudged exactly once");
    });
  });

  it("never echoes the token back in any response", async () => {
    // The whole point of this page is that the secret does not travel through the chat or a
    // log. A response that reflected it would put it in browser history, a proxy log, and any
    // screenshot of the confirmation.
    await withSetup(async (h) => {
      const nonce = h.store.mint("github-pat");
      const ok = await post(h.origin, `/setup/${nonce}`, VALID);
      assert.doesNotMatch(await ok.text(), new RegExp(VALID));

      const nonce2 = h.store.mint("github-pat");
      const bad = await post(h.origin, `/setup/${nonce2}`, "not-a-token-at-all");
      assert.equal(bad.status, 400);
      assert.doesNotMatch(await bad.text(), /not-a-token-at-all/, "not even the rejected value");
    });
  });

  it("rejects anything that is not a GitHub token shape, and keeps the nonce live", async () => {
    await withSetup(async (h) => {
      const nonce = h.store.mint("github-pat");
      for (const junk of ["", "   ", "hunter2", "github_pat_short", "ghp_", "'; rm -rf /"]) {
        const res = await post(h.origin, `/setup/${nonce}`, junk);
        assert.equal(res.status, 400, `"${junk}" must be rejected`);
        assert.equal(existsSync(h.patPath), false);
      }
      // A typo must not burn the link — otherwise every fat-fingered paste costs a round trip
      // through the agent to mint a new one, and users stop using the safe channel.
      assert.equal((await post(h.origin, `/setup/${nonce}`, VALID)).status, 200);
    });
  });

  it("accepts the token shapes GitHub actually issues, and trims whitespace", async () => {
    for (const tok of [VALID, `ghp_${"a".repeat(36)}`, `ghs_${"b".repeat(36)}`, `gho_${"c".repeat(36)}`]) {
      await withSetup(async (h) => {
        const nonce = h.store.mint("github-pat");
        // A pasted token routinely carries a trailing newline.
        assert.equal((await post(h.origin, `/setup/${nonce}`, `  ${tok}\n`)).status, 200);
        assert.equal(readFileSync(h.patPath, "utf8"), `${tok}\n`, "stored clean, exactly once");
      });
    }
  });
});

describe("setup router — the rendered page", () => {
  it("escapes the owner name instead of interpolating it", async () => {
    // `owner` comes from an MCP argument, so it is attacker-influenced in the same sense every
    // tool argument is. It is interpolated into HTML in five places on this page.
    await withSetup(async (h) => {
      const nonce = h.store.mint("github-pat", '<script>alert(1)</script>');
      const body = await (await fetch(`${h.origin}/setup/${nonce}`)).text();
      assert.doesNotMatch(body, /<script>alert\(1\)<\/script>/, "must not reach the DOM as markup");
      assert.match(body, /&lt;script&gt;/, "rendered as text");
    });
  });

  it("renders a form for a live nonce, with no value pre-filled", async () => {
    await withSetup(async (h) => {
      const nonce = h.store.mint("github-pat", "acme");
      const body = await (await fetch(`${h.origin}/setup/${nonce}`)).text();
      assert.match(body, /<form method="post">/);
      assert.match(body, /type="password"/, "the field must not render the token in plain text");
      assert.doesNotMatch(body, /value=/, "nothing is ever pre-filled into the token field");
      assert.match(body, /acme/, "the owner is shown so the user scopes the token correctly");
    });
  });
});
