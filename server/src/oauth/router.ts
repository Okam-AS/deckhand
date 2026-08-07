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
body{font-family:ui-rounded,system-ui,-apple-system,sans-serif;line-height:1.55;color:#f2e8dc;
  background:#241b20;max-width:34rem;margin:0 auto;padding:9vh 1.25rem}
h1{font-family:"New York",Georgia,ui-serif,serif;font-size:1.5rem;margin:0 0 .6rem}
p{color:#c9baae}code{font-family:ui-monospace,Menlo,monospace;font-size:.9em;color:#e0a971}
.code{font-family:ui-monospace,Menlo,monospace;font-size:2rem;letter-spacing:.18em;color:#e0a971;margin:.4rem 0 1rem}
</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`,
  );
}

/**
 * The page a visitor waits on, showing the code the operator must match.
 *
 * It polls rather than holding the connection open: a request parked for minutes behind a
 * tunnel is a request some proxy will cut, and a page that dies silently reads as deckhand
 * being broken. `<noscript>` gets a meta refresh — it cannot auto-resume, but it can tell the
 * visitor what is happening, which is the part that matters.
 */
function waitingPage(res: express.Response, id: string, code: string): void {
  page(
    res,
    200,
    "Waiting for approval",
    `<p>Ask whoever runs this deckhand to approve this code on their Mac:</p>
     <p class="code">${esc(code)}</p>
     <p>They run <code>deckhand approve</code> and confirm this code. Nothing connects until they do,
        and the request expires in a few minutes.</p>
     <p id="s">Waiting…</p>
     <noscript><meta http-equiv="refresh" content="5"><p>Reload this page once it has been approved.</p></noscript>
     <script>
       const id = ${JSON.stringify(id)};
       const say = (t) => { document.getElementById("s").textContent = t; };
       const tick = async () => {
         try {
           const r = await fetch("pending/" + encodeURIComponent(id), { headers: { accept: "application/json" } });
           const { status } = await r.json();
           if (status === "approved") { location.href = "resume/" + encodeURIComponent(id); return; }
           if (status === "denied") { say("Refused. Nothing was connected."); return; }
           if (status === "expired") { say("This request expired. Start again from Claude."); return; }
         } catch { /* a dropped poll is not a verdict — keep asking */ }
         setTimeout(tick, 2000);
       };
       tick();
     </script>`,
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

    // Nobody is authorized by arriving here. The request waits until the operator
    // approves it at the machine — that wait IS the authorization.
    const parked = deps.pairing.park({
      clientId: client.clientId,
      clientName: client.name,
      redirectUri,
      state: state ?? undefined,
      codeChallenge: challenge,
    });
    if (!parked) {
      // Refusing the overflow rather than evicting: see MAX_PENDING. This is a
      // page, not a redirect, because the visitor can act on it — wait and retry —
      // and handing it back to the client shows up as an opaque connector failure.
      page(
        res,
        503,
        "Too many requests waiting",
        `<p>This deckhand already has as many connection requests waiting as it will hold, so yours was not added.</p>
         <p>Try again in a few minutes. If that keeps happening, the operator should check what is asking.</p>`,
      );
      return;
    }
    waitingPage(res, parked.id, parked.code);
  });

  // -- The waiting browser asks whether it may proceed yet --------------------
  //
  // Unauthenticated on purpose, and safe because the id is a 32-byte secret handed
  // only to the browser that made the request: polling proves you opened the page,
  // which is exactly what it is allowed to prove. The APPROVAL is elsewhere and
  // needs the machine's own credential.
  router.get("/pending/:id", (req, res) => {
    // Status only. The authorization code is never handed to the page: the page
    // navigates to `/oauth/resume`, which builds the redirect server-side, so the
    // registered redirect URI stays the only place a code can land.
    res.json({ status: deps.pairing.poll(req.params.id ?? "").status });
  });

  // -- Approved: hand the browser back to the client --------------------------
  router.get("/resume/:id", (req, res) => {
    const parked = deps.pairing.take(req.params.id ?? "");
    if (!parked || parked.status !== "approved" || !parked.authCode) {
      page(res, 410, "Nothing to resume", `<p>This request was never approved, or it has already been used.</p>`);
      return;
    }
    const url = new URL(parked.redirectUri);
    url.searchParams.set("code", parked.authCode);
    if (parked.state) url.searchParams.set("state", parked.state);
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
