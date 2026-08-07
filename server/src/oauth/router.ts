import express from "express";
import type { OAuthStore } from "./store.ts";
import type { PairingStore } from "./pairing.ts";

// ---------------------------------------------------------------------------
// Deckhand's OAuth 2.1 authorization server (PLAN §11.6).
//
// It exists for one reason: a connector URL added to a Claude organisation is
// visible to that whole organisation, so the URL cannot be the credential. With
// OAuth, every person authorizes individually — and nobody is authorized by
// arriving here. `/oauth/authorize` PARKS the request and shows a code; the
// operator approves it on the Mac with `deckhand approve`, matching that code.
//
// So the check is not "who are you" — deckhand has no way to know and no list to
// check you against — it is "did the person at the machine say yes to THIS
// request". A colleague holding the same URL gets a parked request and a code
// nobody will match.
// ---------------------------------------------------------------------------

export interface OAuthRouterDeps {
  store: OAuthStore;
  /** Requests waiting for the operator. See `pairing.ts` for why the wait is the whole design. */
  pairing: PairingStore;
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
/* The viewer's palette (viewer/src/global.css). Somebody meets this page and the device grid
   minutes apart, so they are one surface: neutral dark, hue only where something failed. */
body{font-family:"SF Pro Rounded",ui-rounded,system-ui,-apple-system,sans-serif;line-height:1.55;color:#fcfcf6;
  background:#1e1e1e;max-width:34rem;margin:0 auto;padding:9vh 1.25rem;-webkit-font-smoothing:antialiased}
h1{font-family:"New York","Iowan Old Style",Georgia,ui-serif,serif;font-weight:650;font-size:1.5rem;margin:0 0 .6rem}
p{color:#c6c7c1}code{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:.9em;color:#fcfcf6}
.codebox{display:flex;align-items:center;gap:.75rem;background:#121212;border:1px solid #3b3b3b;
  border-radius:14px;padding:.7rem .7rem .7rem 1.1rem;margin:.6rem 0 1.1rem;max-width:22rem}
.code{flex:1;font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:1.9rem;letter-spacing:.18em;color:#fcfcf6}
button{font:inherit;font-weight:600;font-size:.85rem;border:0;border-radius:999px;padding:.5rem 1rem;
  color:#141414;background:#fcfcf6;cursor:pointer;transition:transform .12s ease,opacity .12s ease}
button:hover{transform:translateY(-1px)}button:active{transform:scale(.98)}
.status{color:#8a8a86;font-size:.85rem}
</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`,
  );
}

/**
 * The page that asks for the code.
 *
 * No status, no polling, no waiting: the browser holds everything needed to finish, and the
 * only missing piece is a string that exists on the operator's machine. The form carries the
 * request's own parameters so the POST can re-validate them rather than trust a session.
 */
function codeForm(
  res: express.Response,
  req: { clientId: string; redirectUri: string; state: string | null; challenge: string },
  error?: string,
): void {
  const hidden = (name: string, value: string): string => `<input type="hidden" name="${name}" value="${esc(value)}">`;
  page(
    res,
    error ? 400 : 200,
    "Enter the pairing code",
    `<p>Ask whoever runs this deckhand for a pairing code — they run <code>deckhand pair</code>.</p>
     ${error ? `<p class="err">${esc(error)}</p>` : ""}
     <form method="post" action="/oauth/authorize">
       ${hidden("client_id", req.clientId)}${hidden("redirect_uri", req.redirectUri)}
       ${hidden("code_challenge", req.challenge)}${req.state ? hidden("state", req.state) : ""}
       <input class="code" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false"
              placeholder="ABC-123" maxlength="7" autofocus>
       <button type="submit">Connect</button>
     </form>`,
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
    const client = deps.store.registerClient({
      redirectUris: uris,
      // Bounded: this name becomes the grant's label and the audit trail's actor, and it
      // arrives from an unauthenticated endpoint.
      name: (singleString(body.client_name) ?? "unnamed client").slice(0, 60),
    });
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

  // -- Authorize: park the request, show the code, wait for the operator ------
  router.get("/authorize", (req, res) => {
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

    // Errors are RENDERED, never redirected. The spec prefers a redirect, and the premise it
    // rests on does not hold here: registration is unauthenticated, so "a registered
    // redirect_uri" is any https URI a stranger asked for two requests ago. Redirecting to it
    // turns this hostname into a general-purpose open redirector that echoes an
    // attacker-chosen `state`. Deckhand serves one operator; a page costs a client a clearer
    // error and costs an abuser the whole trick.
    const fail = (error: string, description: string): void => {
      page(res, 400, "Cannot authorize that request", `<p>${esc(description)}</p><p><code>${esc(error)}</code></p>`);
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

    // Nothing is stored and nothing waits. The request carries no authority; the CODE does,
    // and the operator minted it at the machine.
    codeForm(res, { clientId: client.clientId, redirectUri, state, challenge });
  });

  // -- The visitor submits the code the operator minted -----------------------
  router.post("/authorize", (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const clientId = singleString(b.client_id);
    const redirectUri = singleString(b.redirect_uri);
    const state = singleString(b.state);
    const challenge = singleString(b.code_challenge);
    const client = clientId ? deps.store.getClient(clientId) : null;
    // Re-validated from scratch: these arrive from a form the visitor controls, so trusting
    // them because GET checked them once would let a submission name any client it liked.
    if (!clientId || !client || !redirectUri || !client.redirectUris.includes(redirectUri) || !challenge) {
      page(res, 400, "Cannot authorize that request", `<p>This form no longer matches a client deckhand knows.</p>`);
      return;
    }
    if (!deps.pairing.claim(singleString(b.code) ?? "")) {
      // Deliberately one message for wrong, expired, spent and never-minted. Telling them
      // apart tells an attacker whether a code exists to be guessed.
      codeForm(res, { clientId, redirectUri, state, challenge }, "That code is not valid. Ask for a fresh one.");
      return;
    }
    const authCode = deps.store.mintCode({ clientId, redirectUri, label: client.name, codeChallenge: challenge });
    const url = new URL(redirectUri);
    url.searchParams.set("code", authCode);
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
      // No second check here on purpose: approval is a decision about THIS request,
      // and the code it minted is single-use and short-lived. There is no list that
      // could have changed underneath it — revoking is `deckhand revoke`, which drops
      // the grant itself.
      const issued = deps.store.issueGrant({ label: redeemed.label, clientId });
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
