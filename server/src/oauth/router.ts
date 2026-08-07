import express from "express";
import type { AccessIdentityVerifier } from "./access.ts";
import type { OAuthStore } from "./store.ts";

// ---------------------------------------------------------------------------
// Deckhand's OAuth 2.1 authorization server (PLAN §11.6).
//
// It exists for one reason: a connector URL added to a Claude organisation is
// visible to that whole organisation, so the URL cannot be the credential. With
// OAuth, every person authorizes individually — and `/oauth/authorize` is the one
// endpoint Cloudflare Access sits in front of, which is where a colleague who is
// not on the allowlist is stopped.
//
// WHICH ENDPOINTS ACCESS MAY PROTECT, and why it matters:
//   /oauth/authorize   — a BROWSER navigation. Access protects this one.
//   /oauth/register    — called by Claude's backend. Access would break it.
//   /oauth/token       — called by Claude's backend. Access would break it.
//   /mcp               — called by Claude's backend. Access would break it.
// `deckhand doctor` asserts exactly this shape, because an Access policy widened
// to `/oauth/*` fails in a way that reads as "the connector is broken".
// ---------------------------------------------------------------------------

export interface OAuthRouterDeps {
  store: OAuthStore;
  /** Null when Cloudflare Access is not configured — authorize then refuses outright rather than falling open. */
  access: AccessIdentityVerifier | null;
  /** Is this address allowed to hold a connector grant? */
  isAllowed: (email: string) => boolean;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function page(res: express.Response, status: number, title: string, body: string): void {
  res.status(status).type("html").send(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · deckhand</title>
<style>
body{font-family:ui-rounded,system-ui,-apple-system,sans-serif;line-height:1.55;color:#f2e8dc;
  background:#241b20;max-width:34rem;margin:0 auto;padding:9vh 1.25rem}
h1{font-family:"New York",Georgia,ui-serif,serif;font-size:1.5rem;margin:0 0 .6rem}
p{color:#c9baae}code{font-family:ui-monospace,Menlo,monospace;font-size:.9em;color:#e0a971}
</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`,
  );
}

/** An OAuth error the spec says to return as JSON, not as a redirect. */
function oauthError(res: express.Response, status: number, error: string, description: string): void {
  res.status(status).json({ error, error_description: description });
}

const singleString = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/**
 * The `/oauth` router: dynamic client registration, the authorize page, and the
 * token endpoint. Mount at `/oauth`.
 */
export function createOAuthRouter(deps: OAuthRouterDeps): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: "64kb" }));
  router.use(express.urlencoded({ extended: false, limit: "64kb" }));

  // -- Dynamic client registration (RFC 7591) --------------------------------
  router.post("/register", (req, res) => {
    const body = (req.body ?? {}) as { redirect_uris?: unknown; client_name?: unknown };
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
    if (uris.length === 0) {
      oauthError(res, 400, "invalid_redirect_uri", "redirect_uris is required and must list at least one https URI");
      return;
    }
    // http is refused outright: an authorization code lands in this URI, and the
    // only reason to accept a cleartext one is a client we are not serving.
    if (uris.some((u) => !/^https:\/\//i.test(u))) {
      oauthError(res, 400, "invalid_redirect_uri", "redirect_uris must be https");
      return;
    }
    const client = deps.store.registerClient({ redirectUris: uris, name: singleString(body.client_name) ?? "unnamed client" });
    res.status(201).json({
      client_id: client.clientId,
      client_id_issued_at: Math.floor(client.createdMs / 1000),
      redirect_uris: client.redirectUris,
      client_name: client.name,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // Public client: there is no secret to protect, PKCE is what binds the
      // redemption to the browser that started the flow.
      token_endpoint_auth_method: "none",
    });
  });

  // -- Authorize (the ONLY endpoint behind Cloudflare Access) ----------------
  router.get("/authorize", async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const clientId = singleString(q.client_id);
    const redirectUri = singleString(q.redirect_uri);
    const state = singleString(q.state);
    const challenge = singleString(q.code_challenge);

    const client = clientId ? deps.store.getClient(clientId) : null;
    // Until the client AND redirect_uri are known-good, an error must never be
    // redirected: doing so turns this endpoint into an open redirector, and hands
    // the error (with `state`) to whoever supplied the URI.
    if (!client) {
      page(res, 400, "Unknown client", `<p>This authorization request names a client deckhand has not registered.</p>`);
      return;
    }
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      page(res, 400, "Bad redirect", `<p>The redirect URI is not one this client registered.</p>`);
      return;
    }

    const fail = (error: string, description: string): void => {
      const url = new URL(redirectUri);
      url.searchParams.set("error", error);
      url.searchParams.set("error_description", description);
      if (state) url.searchParams.set("state", state);
      res.redirect(302, url.toString());
    };

    if (singleString(q.response_type) !== "code") {
      fail("unsupported_response_type", "deckhand only supports the authorization code flow");
      return;
    }
    // S256 only. `plain` puts the verifier in the same redirect as the code,
    // which is no protection at all.
    if (!challenge || singleString(q.code_challenge_method) !== "S256") {
      fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
      return;
    }

    // Not configured is a REFUSAL, not a bypass. If this ever fell through to
    // issuing a code, every member of the organisation holding the connector URL
    // would get one — the exact failure this whole flow exists to prevent.
    if (!deps.access) {
      page(
        res,
        503,
        "Not accepting connections yet",
        `<p>This deckhand has no Cloudflare Access application configured, so it cannot tell who you are.</p>
         <p>The operator fixes this by running <code>deckhand setup --hostname &lt;host&gt;</code> on the machine.</p>`,
      );
      return;
    }

    const identity = await deps.access.verify(req.header("cf-access-jwt-assertion") ?? undefined);
    if (!identity) {
      // Reaching here means the request did not come through the Access
      // application — a misconfigured policy, or someone hitting the origin
      // directly. Either way there is no identity, so there is no code.
      page(
        res,
        403,
        "Not signed in",
        `<p>This page must be reached through Cloudflare Access, which did not vouch for this request.</p>
         <p>If you are the operator, check that the Access application covers <code>/oauth/authorize</code> on this hostname.</p>`,
      );
      return;
    }

    if (!deps.isAllowed(identity.email)) {
      // Says the address back — that is the one thing the visitor already knows,
      // and without it "not authorized" is unactionable. It does NOT list who is
      // allowed; that is the operator's business.
      page(
        res,
        403,
        "Not authorized",
        `<p><code>${esc(identity.email)}</code> is not on this deckhand's allowlist, so it cannot connect.</p>
         <p>It previews apps from one person's machine. If that should be you, ask the operator to run
         <code>deckhand allow ${esc(identity.email)}</code>.</p>`,
      );
      return;
    }

    const code = deps.store.mintCode({ clientId: client.clientId, redirectUri, email: identity.email, codeChallenge: challenge });
    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    res.redirect(302, url.toString());
  });

  // -- Token -----------------------------------------------------------------
  router.post("/token", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const grantType = singleString(body.grant_type);
    const clientId = singleString(body.client_id);
    if (!clientId || !deps.store.getClient(clientId)) {
      oauthError(res, 401, "invalid_client", "unknown client_id");
      return;
    }

    if (grantType === "authorization_code") {
      const code = singleString(body.code);
      const redirectUri = singleString(body.redirect_uri);
      const verifier = singleString(body.code_verifier);
      if (!code || !redirectUri || !verifier) {
        oauthError(res, 400, "invalid_request", "code, redirect_uri and code_verifier are required");
        return;
      }
      const redeemed = deps.store.redeemCode(code, { clientId, redirectUri, codeVerifier: verifier });
      if (!redeemed) {
        oauthError(res, 400, "invalid_grant", "the authorization code is unknown, expired, or already used");
        return;
      }
      // Re-checked at redemption as well as at authorize: an address removed from
      // the allowlist between the two must not complete the exchange.
      if (!deps.isAllowed(redeemed.email)) {
        oauthError(res, 400, "invalid_grant", "that address is no longer allowed to connect to this deckhand");
        return;
      }
      const issued = deps.store.issueGrant({ email: redeemed.email, clientId });
      res.json({
        access_token: issued.accessToken,
        refresh_token: issued.refreshToken,
        token_type: "Bearer",
        expires_in: issued.expiresInSec,
      });
      return;
    }

    if (grantType === "refresh_token") {
      const refreshToken = singleString(body.refresh_token);
      if (!refreshToken) {
        oauthError(res, 400, "invalid_request", "refresh_token is required");
        return;
      }
      const rotated = deps.store.refresh(refreshToken, { clientId });
      if (!rotated) {
        oauthError(res, 400, "invalid_grant", "the refresh token is unknown or belongs to another client");
        return;
      }
      if (!deps.isAllowed(rotated.email)) {
        deps.store.revokeEmail(rotated.email);
        oauthError(res, 400, "invalid_grant", "that address is no longer allowed to connect to this deckhand");
        return;
      }
      res.json({
        access_token: rotated.accessToken,
        refresh_token: rotated.refreshToken,
        token_type: "Bearer",
        expires_in: rotated.expiresInSec,
      });
      return;
    }

    oauthError(res, 400, "unsupported_grant_type", "supported: authorization_code, refresh_token");
  });

  return router;
}

/**
 * The two discovery documents, mounted at the ORIGIN root because that is where
 * RFC 8414 and RFC 9728 say a client looks. Both are public and carry no secret;
 * they are readable cross-origin so a browser-based client can complete discovery.
 */
export function createOAuthMetadataRouter(baseUrl: string): express.Router {
  const router = express.Router();

  const publicJson = (res: express.Response, body: unknown): void => {
    res.set("Access-Control-Allow-Origin", "*");
    res.json(body);
  };

  const resourceMetadata = {
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ["header"],
  };
  router.get("/.well-known/oauth-protected-resource", (_req, res) => publicJson(res, resourceMetadata));
  router.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => publicJson(res, resourceMetadata));

  router.get("/.well-known/oauth-authorization-server", (_req, res) =>
    publicJson(res, {
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    }),
  );

  return router;
}
