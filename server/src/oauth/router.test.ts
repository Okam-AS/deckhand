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
import type { AccessIdentity, AccessIdentityVerifier } from "./access.ts";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const OWNER = "owner@example.com";
const COLLEAGUE = "someone.else@example.com";
const BASE_URL = "https://deckhand.example.com";

/**
 * A complete stand-in for the Access verifier — one method, implemented, not cast.
 * `assertion` is the header value; this fake treats it as the email Cloudflare
 * would have vouched for, so a test controls identity without minting real JWTs
 * (access.test.ts covers the signature checking).
 */
class FakeAccess implements AccessIdentityVerifier {
  async verify(assertion: string | undefined): Promise<AccessIdentity | null> {
    return assertion ? { email: assertion.toLowerCase() } : null;
  }
}

let base: string;
let server: Server;
let store: OAuthStore;
let allowed: string[];
let accessConfigured: boolean;

before(async () => {
  const app = express();
  app.use(createOAuthMetadataRouter(BASE_URL));
  app.use(
    "/oauth",
    createOAuthRouter({
      // A getter, so a test can flip the deps between requests without rebuilding
      // the server — mirroring the live server, which reads the allowlist per call.
      get store() {
        return store;
      },
      get access() {
        return accessConfigured ? new FakeAccess() : null;
      },
      isAllowed: (email: string) => allowed.includes(email.toLowerCase()),
    }),
  );
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());

beforeEach(() => {
  store = new OAuthStore({ persist: false });
  allowed = [OWNER];
  accessConfigured = true;
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

/** GET authorize as `email` (via the fake Access header), without following the redirect. */
function authorize(url: string, email?: string): Promise<Response> {
  return fetch(url, {
    redirect: "manual",
    headers: email ? { "cf-access-jwt-assertion": email } : {},
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
  it("completes the flow for an allowlisted address and returns a usable token pair", async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();

    const res = await authorize(authorizeUrl(clientId, challenge), OWNER);
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
    assert.deepEqual(store.authenticate(body.access_token), { email: OWNER, clientId });
  });

  // The whole point of the change: the connector URL is visible to a whole Claude
  // organisation, and this is where everyone else in it is stopped.
  it("refuses an address Access proved but the allowlist does not carry, and mints no code", async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const res = await authorize(authorizeUrl(clientId, challenge), COLLEAGUE);
    assert.equal(res.status, 403);
    assert.equal(res.headers.get("location"), null, "a refusal must not redirect — there is no code to carry");
    assert.match(await res.text(), /not on this deckhand's allowlist/);
  });

  it("refuses when Access did not vouch for the request at all", async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const res = await authorize(authorizeUrl(clientId, challenge)); // no Access header
    assert.equal(res.status, 403);
  });

  // A permissive default here would hand a grant to everyone holding the URL —
  // exactly the failure the flow exists to prevent.
  it("refuses rather than falls open when no Access application is configured", async () => {
    accessConfigured = false;
    const clientId = await register();
    const { challenge } = pkce();
    const res = await authorize(authorizeUrl(clientId, challenge), OWNER);
    assert.equal(res.status, 503);
  });

  // Trusting this header would be a total bypass: anything that can reach the
  // origin can set it, and every process on this Mac shares loopback.
  it("does not accept the Cf-Access-Authenticated-User-Email header as identity", async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const res = await fetch(authorizeUrl(clientId, challenge), {
      redirect: "manual",
      headers: { "cf-access-authenticated-user-email": OWNER },
    });
    assert.equal(res.status, 403);
  });

  it("never redirects an error to an unregistered redirect_uri", async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const res = await authorize(authorizeUrl(clientId, challenge, { redirect_uri: "https://attacker.example/catch" }), OWNER);
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("location"), null, "redirecting here would make authorize an open redirector");
  });

  it("requires PKCE S256", async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const plain = await authorize(authorizeUrl(clientId, challenge, { code_challenge_method: "plain" }), OWNER);
    assert.equal(plain.status, 302);
    assert.equal(new URL(plain.headers.get("location")!).searchParams.get("error"), "invalid_request");
    assert.equal(codeFrom(plain), null);
  });

  it("rejects a code redeemed with the wrong verifier, and burns it in the process", async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const code = codeFrom(await authorize(authorizeUrl(clientId, challenge), OWNER))!;

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
    const code = codeFrom(await authorize(authorizeUrl(clientId, challenge), OWNER))!;
    const args = { grant_type: "authorization_code", client_id: clientId, redirect_uri: REDIRECT, code, code_verifier: verifier };
    assert.equal((await token(args)).status, 200);
    assert.equal((await token(args)).status, 400);
  });

  it("rejects a code redeemed by a different client than the one it was minted for", async () => {
    const clientId = await register();
    const other = await register();
    const { verifier, challenge } = pkce();
    const code = codeFrom(await authorize(authorizeUrl(clientId, challenge), OWNER))!;
    const res = await token({
      grant_type: "authorization_code",
      client_id: other,
      redirect_uri: REDIRECT,
      code,
      code_verifier: verifier,
    });
    assert.equal(res.status, 400);
  });

  // The gap between authorize and redemption is small but real, and the
  // allowlist is the authorization decision — not a one-time gate.
  it("refuses to complete the exchange when the address left the allowlist after authorize", async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const code = codeFrom(await authorize(authorizeUrl(clientId, challenge), OWNER))!;
    allowed = [];
    const res = await token({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code,
      code_verifier: verifier,
    });
    assert.equal(res.status, 400);
    assert.deepEqual(store.activeEmails(), []);
  });

  it("rotates the refresh token and refuses the one it replaced", async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const code = codeFrom(await authorize(authorizeUrl(clientId, challenge), OWNER))!;
    const first = (await (
      await token({ grant_type: "authorization_code", client_id: clientId, redirect_uri: REDIRECT, code, code_verifier: verifier })
    ).json()) as { refresh_token: string; access_token: string };

    const second = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: first.refresh_token });
    assert.equal(second.status, 200);
    const rotated = (await second.json()) as { access_token: string };
    assert.equal(store.authenticate(rotated.access_token)?.email, OWNER);
    assert.equal(store.authenticate(first.access_token), null, "rotation must retire the old access token too");

    const replay = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: first.refresh_token });
    assert.equal(replay.status, 400);
  });

  it("revokes every grant when a refresh arrives for an address that left the allowlist", async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const code = codeFrom(await authorize(authorizeUrl(clientId, challenge), OWNER))!;
    const issued = (await (
      await token({ grant_type: "authorization_code", client_id: clientId, redirect_uri: REDIRECT, code, code_verifier: verifier })
    ).json()) as { refresh_token: string };

    allowed = [];
    assert.equal((await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: issued.refresh_token })).status, 400);
    assert.deepEqual(store.activeEmails(), []);
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
    const code = codeFrom(await authorize(authorizeUrl(clientId, challenge), OWNER))!;
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

describe("Cloudflare Access header trust", () => {
  // A source-level check, because the runtime test above only proves TODAY's code
  // ignores the header. This one fails the moment someone reads it, which is the
  // change that would turn a signed assertion into a spoofable string.
  it("reads the identity header nowhere outside a comment", () => {
    const dir = import.meta.dirname;
    for (const file of ["access.ts", "router.ts"]) {
      const source = readFileSync(join(dir, file), "utf8")
        .split("\n")
        .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
        .join("\n");
      assert.doesNotMatch(
        source.toLowerCase(),
        /cf-access-authenticated-user-email/,
        `${file} must not read Cf-Access-Authenticated-User-Email — only the signed assertion is evidence`,
      );
    }
  });
});
