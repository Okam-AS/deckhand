import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { createOAuthRouter, createOAuthMetadataRouter } from "./router.ts";
import { OAuthStore } from "./store.ts";
import { PairingStore } from "./pairing.ts";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const BASE_URL = "https://deckhand.example.com";

let base: string;
let server: Server;
let store: OAuthStore;
let pairing: PairingStore;

before(async () => {
  const app = express();
  app.use(createOAuthMetadataRouter(BASE_URL));
  app.use(
    "/oauth",
    createOAuthRouter({
      // Getters, so `beforeEach` can hand each test fresh stores without rebuilding the
      // server around them.
      get store() {
        return store;
      },
      get pairing() {
        return pairing;
      },
    }),
  );
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());

beforeEach(() => {
  store = new OAuthStore({ persist: false });
  pairing = new PairingStore();
});

async function register(): Promise<string> {
  const res = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Claude" }),
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { client_id: string }).client_id;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier, "utf8").digest("base64url") };
}

function authorizeUrl(clientId: string, challenge: string, overrides: Record<string, string> = {}): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "opaque-state",
    ...overrides,
  });
  return `${base}/oauth/authorize?${q}`;
}

/** GET authorize without following the redirect. Nobody is identified: the request parks. */
function authorize(url: string): Promise<Response> {
  return fetch(url, { redirect: "manual" });
}

/**
 * Do what a visitor does: read the form, get the code the operator minted, submit it. Returns
 * the redirect back to the client.
 */
async function submitCode(res: Response, clientId: string, challenge: string, code?: string): Promise<Response> {
  const html = await res.text();
  assert.match(html, /name="code"/, "the authorize page must ask for the code");
  const minted = code ?? pairing.mint().code;
  return fetch(`${base}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, state: "opaque-state", code: minted }),
  });
}

const codeFrom = (res: Response): string | null => new URL(res.headers.get("location")!).searchParams.get("code");

function token(body: Record<string, string>): Promise<Response> {
  return fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
}

describe("OAuth authorization server", () => {
  it("completes the flow once the operator approves, and returns a usable token pair", async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();

    const res = await submitCode(await authorize(authorizeUrl(clientId, challenge)), clientId, challenge);
    assert.equal(res.status, 302);
    const location = new URL(res.headers.get("location")!);
    assert.equal(location.origin + location.pathname, REDIRECT);
    assert.equal(location.searchParams.get("state"), "opaque-state", "state must come back or the client rejects the redirect");

    const t = await token({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code: location.searchParams.get("code")!,
      code_verifier: verifier,
    });
    assert.equal(t.status, 200);
    const body = (await t.json()) as { access_token: string; refresh_token: string; token_type: string };
    assert.equal(body.token_type, "Bearer");
    assert.deepEqual(store.authenticate(body.access_token), { label: "Claude", clientId });
  });

  it("never redirects an error to an unregistered redirect_uri", async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const res = await authorize(authorizeUrl(clientId, challenge, { redirect_uri: "https://attacker.example/catch" }));
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("location"), null, "redirecting here would make authorize an open redirector");
  });

  it("requires PKCE S256", async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const plain = await authorize(authorizeUrl(clientId, challenge, { code_challenge_method: "plain" }));
    assert.equal(plain.status, 400);
    assert.match(await plain.text(), /invalid_request/);
    assert.equal(plain.headers.get("location"), null);
  });

  // "Registered" is not a trust boundary: registration is unauthenticated, so any https URI a
  // stranger asked for is registered. Redirecting an error to it made this hostname a general
  // open redirector that echoed an attacker-chosen `state`.
  it("renders errors instead of redirecting them, even to a registered uri", async () => {
    const res = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://evil.example/phish"], client_name: "x" }),
    });
    const evil = ((await res.json()) as { client_id: string }).client_id;
    const q = new URLSearchParams({ response_type: "bogus", client_id: evil, redirect_uri: "https://evil.example/phish", state: "s" });
    const out = await fetch(`${base}/oauth/authorize?${q}`, { redirect: "manual" });
    assert.equal(out.status, 400);
    assert.equal(out.headers.get("location"), null, "deckhand must never bounce a browser to an origin a stranger named");
  });

  it("rejects a code redeemed with the wrong verifier, and burns it in the process", async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const code = codeFrom(await submitCode(await authorize(authorizeUrl(clientId, challenge)), clientId, challenge))!;

    const wrong = await token({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code,
      code_verifier: pkce().verifier,
    });
    assert.equal(wrong.status, 400);

    // Single-use even on failure: otherwise an observer who captured the code
    // could keep guessing verifiers against it.
    const retry = await token({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code,
      code_verifier: verifier,
    });
    assert.equal(retry.status, 400);
  });

  it("rejects a replayed code", async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const code = codeFrom(await submitCode(await authorize(authorizeUrl(clientId, challenge)), clientId, challenge))!;
    const args = { grant_type: "authorization_code", client_id: clientId, redirect_uri: REDIRECT, code, code_verifier: verifier };
    assert.equal((await token(args)).status, 200);
    assert.equal((await token(args)).status, 400);
  });

  it("rejects a code redeemed by a different client than the one it was minted for", async () => {
    const clientId = await register();
    const other = await register();
    const { verifier, challenge } = pkce();
    const code = codeFrom(await submitCode(await authorize(authorizeUrl(clientId, challenge)), clientId, challenge))!;
    const res = await token({
      grant_type: "authorization_code",
      client_id: other,
      redirect_uri: REDIRECT,
      code,
      code_verifier: verifier,
    });
    assert.equal(res.status, 400);
  });

  it("rotates the refresh token and refuses the one it replaced", async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const code = codeFrom(await submitCode(await authorize(authorizeUrl(clientId, challenge)), clientId, challenge))!;
    const first = (await (
      await token({ grant_type: "authorization_code", client_id: clientId, redirect_uri: REDIRECT, code, code_verifier: verifier })
    ).json()) as { refresh_token: string; access_token: string };

    const second = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: first.refresh_token });
    assert.equal(second.status, 200);
    const rotated = (await second.json()) as { access_token: string };
    assert.equal(store.authenticate(rotated.access_token)?.label, "Claude");
    assert.equal(store.authenticate(first.access_token), null, "rotation must retire the old access token too");

    const replay = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: first.refresh_token });
    assert.equal(replay.status, 400);
  });

  it("refuses registration without an https redirect uri", async () => {
    for (const body of [{}, { redirect_uris: [] }, { redirect_uris: ["http://localhost/cb"] }]) {
      const res = await fetch(`${base}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400);
    }
  });

  // /oauth/register is unauthenticated by design (RFC 7591) — a client has no credential yet.
  // Without a ceiling, anyone who can reach the tunnel grows oauth.json without limit, on a
  // machine that needs its free space for simulators and builds.
  it("caps registered clients, and never evicts one that holds a live grant", async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const code = codeFrom(await submitCode(await authorize(authorizeUrl(clientId, challenge)), clientId, challenge))!;
    assert.equal(
      (await token({ grant_type: "authorization_code", client_id: clientId, redirect_uri: REDIRECT, code, code_verifier: verifier }))
        .status,
      200,
    );

    for (let i = 0; i < 80; i++) await register();

    // The in-use client survives the flood; evicting it would log that person out.
    assert.ok(store.getClient(clientId), "a client holding a grant must not be evicted");
    assert.ok(store.clientCount() <= 65, `expected the client set to stay bounded, got ${store.clientCount()}`);
  });

  // The cap above is only a bound if it BINDS. A client mid-flow is deliberately unevictable,
  // and what makes one "mid-flow" is a GET of the authorize page — which needs no credential.
  // So two anonymous requests per client made the ceiling advisory: measured against this same
  // router, 2000 clients and a 440 kB oauth.json in 1.4 seconds, each register rewriting the
  // whole file. The flood in the test above never noticed, because it only ever registers, so
  // eviction always had a candidate.
  it("refuses to register past the cap rather than growing the file, when every client is mid-flow", async () => {
    const { challenge } = pkce();
    let refusals = 0;
    for (let i = 0; i < 90; i++) {
      const res = await fetch(`${base}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Claude" }),
      });
      if (res.status === 503) {
        refusals += 1;
        continue;
      }
      assert.equal(res.status, 201);
      // Reaching the authorize page is what marks a client busy, and it is a plain GET.
      await authorize(authorizeUrl(((await res.json()) as { client_id: string }).client_id, challenge));
    }
    assert.ok(refusals > 0, "the ceiling has to refuse someone, or it is not a ceiling");
    assert.ok(store.clientCount() <= 65, `the registry must stay bounded, got ${store.clientCount()}`);
  });

  // Capacity, not a bad request: an operator reading a 400 goes looking for a mistake in the
  // client, and this one clears itself when the in-flight entries lapse.
  it("says the refusal is temporary, and does not disturb a client that is already mid-flow", async () => {
    const { verifier, challenge } = pkce();
    const mine = await register();
    await authorize(authorizeUrl(mine, challenge));
    let last: Response | null = null;
    for (let i = 0; i < 90 && (last === null || last.status !== 503); i++) {
      last = await fetch(`${base}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [REDIRECT] }),
      });
      if (last.status === 201) await authorize(authorizeUrl(((await last.json()) as { client_id: string }).client_id, challenge));
    }
    assert.equal(last?.status, 503);
    assert.equal(((await last!.json()) as { error: string }).error, "temporarily_unavailable");
    // And the flood must not have cost the client that was pairing when it started.
    const code = codeFrom(await submitCode(await authorize(authorizeUrl(mine, challenge)), mine, challenge))!;
    assert.equal(
      (await token({ grant_type: "authorization_code", client_id: mine, redirect_uri: REDIRECT, code, code_verifier: verifier })).status,
      200,
    );
  });

  it("rejects an unknown client at the token endpoint", async () => {
    const res = await token({ grant_type: "refresh_token", client_id: "nope", refresh_token: "x" });
    assert.equal(res.status, 401);
  });

  it("publishes the discovery documents a client needs to find the authorize endpoint", async () => {
    const resource = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    assert.deepEqual(resource, {
      resource: `${BASE_URL}/mcp`,
      authorization_servers: [BASE_URL],
      bearer_methods_supported: ["header"],
    });
    const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    assert.equal(as.authorization_endpoint, `${BASE_URL}/oauth/authorize`);
    assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  });
});

describe("who can mint an authorization code", () => {
  // A source-level check, because the runtime tests only prove TODAY's authorize parks the
  // request. The failure this guards is a future edit that "just returns the code when there
  // is one obvious client" — which hands a grant to whoever holds the URL, the exact thing
  // the parking exists to prevent. Minting belongs to the approval path alone.
  // The registry cap is otherwise a weapon: register past it while somebody is mid-pairing and
  // their client is evicted, so the token exchange fails AFTER the code was spent. Reproduced
  // end to end before the fix existed, and repeatable, so pairing never completes.
  it("survives a registration flood while a client is mid-pairing", async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const submitted = await submitCode(await authorize(authorizeUrl(clientId, challenge)), clientId, challenge);
    assert.equal(submitted.status, 302, "the code was spent, so this client is committed");

    // Well past the cap, all anonymous, exactly as a stranger with the public URL would.
    for (let i = 0; i < 80; i++) await register();

    const t = await token({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code: new URL(submitted.headers.get("location")!).searchParams.get("code")!,
      code_verifier: verifier,
    });
    assert.equal(t.status, 200, "a client whose code was already spent must still be able to finish");
  });

  it("mints only after the pairing code has been spent", () => {
    const source = readFileSync(join(import.meta.dirname, "router.ts"), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    const mints = [...source.matchAll(/mintCode\(/g)];
    assert.equal(mints.length, 1, "one mint, in one place — a second is a second way in");
    const claim = source.indexOf("pairing.claim(");
    assert.ok(claim >= 0 && claim < mints[0]!.index!, "the mint must sit behind a claimed code, not beside it");
  });
});
