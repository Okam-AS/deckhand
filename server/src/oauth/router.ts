import express from "express";
import { RegistryFullError, type OAuthClient, type OAuthStore } from "./store.ts";
import type { PairingStore } from "./pairing.ts";

// ---------------------------------------------------------------------------
// Deckhand's OAuth 2.1 authorization server (PLAN §11.6).
//
// It exists for one reason: a connector URL added to a Claude organisation is
// visible to that whole organisation, so the URL cannot be the credential. With
// OAuth, every client authorizes individually — and nobody is authorized by
// arriving here. `/oauth/authorize` asks for a PAIRING CODE, and the only place one
// exists is `deckhand pair` on the machine.
//
// So the check is not "who are you" — deckhand has no way to know and no list to
// check you against — it is "did the person at the machine hand you a code". A
// colleague holding the same URL is asked for one they have not got.
// ---------------------------------------------------------------------------

export interface OAuthRouterDeps {
  store: OAuthStore;
  /**
   * The code the operator minted at the machine. Nothing incoming is stored and nothing waits
   * for approval: the park-and-approve direction was tried and rejected, because parking is
   * unauthenticated and a stranger parks faster than a person can walk to the Mac. See
   * `pairing.ts` for the full argument.
   */
  pairing: PairingStore;
  /**
   * The clock the in-flight deadlines are read against. Injected only so a test can prove the
   * TIME bound exists: the sweep could be deleted with every test still green, while the router
   * comment, the connector-auth rule and the 503 body all promise it.
   */
  now?: () => number;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function page(res: express.Response, status: number, title: string, body: string, sub = ""): void {
  res.status(status).type("html").send(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · deckhand</title>
<style>
/* The viewer's palette (viewer/src/global.css). Somebody meets this page and the device grid
   minutes apart, so they are one surface: neutral dark, hue only where something failed.
   The panel is DARKER than the page — a well, not a card — which is the viewer's rule too. */
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:1.25rem;
  font-family:"SF Pro Rounded",ui-rounded,system-ui,-apple-system,sans-serif;line-height:1.5;
  color:#fcfcf6;background:#1e1e1e;-webkit-font-smoothing:antialiased}
.card{width:100%;max-width:23rem;background:#121212;border:1px solid #3b3b3b;border-radius:20px;
  padding:2rem 1.75rem;box-shadow:0 28px 60px rgba(0,0,0,.45);text-align:center}
h1{font-family:"New York","Iowan Old Style",Georgia,ui-serif,serif;font-weight:650;
  font-size:1.35rem;letter-spacing:-.01em;margin:0 0 .4rem}
.sub{color:#8a8a86;font-size:.9rem;margin:0 0 1.4rem}
p{color:#c6c7c1;margin:0 0 1rem}
code{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:.88em;color:#fcfcf6}
input{width:100%;padding:.85rem .5rem;text-align:center;background:#1a1a1a;color:#fcfcf6;
  border:1px solid #3b3b3b;border-radius:14px;outline:none;caret-color:#fcfcf6;
  font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:1.6rem;letter-spacing:.28em;
  text-indent:.28em;transition:border-color .15s ease,box-shadow .15s ease}
input::placeholder{color:#4a4a48;letter-spacing:.28em}
input:focus{border-color:#8a8a86;box-shadow:0 0 0 4px rgba(252,252,246,.07)}
button{width:100%;margin-top:.9rem;padding:.8rem 1rem;font:inherit;font-weight:600;font-size:.95rem;
  border:0;border-radius:999px;color:#141414;background:#fcfcf6;cursor:pointer;
  transition:transform .12s ease,opacity .12s ease}
button:hover{transform:translateY(-1px)}button:active{transform:scale(.985)}
button[disabled]{opacity:.45;cursor:default;transform:none}
.err{color:#c98b7f;font-size:.88rem;margin:.9rem 0 0}
.hint{color:#8a8a86;font-size:.8rem;margin:.6rem 0 0}
.who{color:#c6c7c1;font-size:.85rem;margin:1.3rem 0 0;padding-top:1.1rem;border-top:1px solid #2a2a2a}
.who strong{color:#fcfcf6;font-weight:600}.who span{color:#8a8a86;font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:.8rem}
</style></head><body><main class="card"><h1>${esc(title)}</h1>${sub ? `<p class="sub">${esc(sub)}</p>` : ""}${body}</main></body></html>`,
  );
}

/**
 * The pairing form's behaviour, as source rather than inline in the page, so a test can run it
 * against stub elements. It is browser code: no imports, no TypeScript.
 *
 * It goes into the page unescaped, and `esc()` would be the wrong tool inside a script body
 * anyway — so nothing derived from the request may ever be interpolated here.
 */
export const PAIR_FORM_SCRIPT = `
  const c = document.getElementById("c"), b = document.getElementById("b");
  const format = (v) => {
    const raw = v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    return raw.length > 3 ? raw.slice(0, 3) + "-" + raw.slice(3) : raw;
  };
  let sent = false;
  // The code is single-use, so a second POST spends nothing and tells the visitor "invalid code"
  // about a code that just worked. Auto-submit makes that easy to hit: pasting submits, and the
  // hand already on its way to Connect clicks a form that is mid-flight.
  c.form.addEventListener("submit", (e) => {
    if (sent) { e.preventDefault(); return; }
    sent = true;
    b.disabled = true;
    c.readOnly = true;
  });
  c.addEventListener("input", () => {
    if (sent) return;
    c.value = format(c.value);
    b.disabled = c.value.length !== 7;
    // Submitting on completion, because the last thing between two screens should not be
    // hunting for a button.
    if (!b.disabled) c.form.requestSubmit();
  });
`;

/**
 * The page that asks for the code.
 *
 * No status, no polling, no waiting: the browser holds everything needed to finish, and the
 * only missing piece is a string that exists on the operator's machine. The form carries the
 * request's own parameters so the POST can re-validate them rather than trust a session.
 *
 * The input does the tidying a person should not have to: upper-cases, inserts the hyphen, and
 * submits itself the moment six characters are in. Somebody is reading this off another screen
 * — every keystroke of ceremony is a chance to mistype the one string that matters.
 */
function codeForm(
  res: express.Response,
  req: { clientId: string; redirectUri: string; state: string | null; challenge: string; clientName: string },
  error?: string,
): void {
  const hidden = (name: string, value: string): string => `<input type="hidden" name="${name}" value="${esc(value)}">`;
  page(
    res,
    error ? 400 : 200,
    "Pairing code",
    `<form method="post" action="/oauth/authorize">
       ${hidden("client_id", req.clientId)}${hidden("redirect_uri", req.redirectUri)}
       ${hidden("code_challenge", req.challenge)}${req.state ? hidden("state", req.state) : ""}
       <input id="c" name="code" inputmode="text" autocomplete="one-time-code" autocapitalize="characters"
              spellcheck="false" placeholder="XXX-XXX" maxlength="7" autofocus aria-label="Pairing code">
       <button id="b" type="submit" disabled>Connect</button>
       ${error ? `<p class="err">${esc(error)}</p>` : ""}
     </form>
     <!-- WHO is asking. A pairing code proves the operator meant to connect something; without
          this it does not say WHAT, and a stranger can hand them a link to this very page on
          their own trusted hostname and collect the grant. -->
     <p class="who">Connecting <strong>${esc(req.clientName)}</strong><br><span>${esc(new URL(req.redirectUri).host)}</span></p>
     <p class="hint">Run <code>deckhand pair</code> on the Mac to get a code.</p>
     <script>${PAIR_FORM_SCRIPT}</script>`,
    "Ask whoever runs this deckhand for the code.",
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
  /**
   * Clients that have reached the authorize page and not finished, each with a deadline.
   *
   * Bounded by TIME, which is the only bound available: a visitor who closes the tab tells us
   * nothing, and the first version — a plain Set cleared only on a successful POST — could be
   * filled with 64 abandoned page loads. Because a busy client cannot be evicted, that jammed
   * registration for everyone until a restart: exactly the failure it was written to prevent,
   * made permanent. Entries lapse, so abandonment costs minutes rather than forever.
   *
   * Held until the TOKEN EXCHANGE, not until the code is submitted. Between those two is a
   * redirect through the client's own backend, and the pairing code is already spent there —
   * an eviction in that window is unrecoverable.
   */
  const inFlight = new Map<string, number>();
  const IN_FLIGHT_TTL_MS = 10 * 60 * 1000;
  const clock = (): number => (deps.now ?? Date.now)();
  const busyClients = (): ReadonlySet<string> => {
    const now = clock();
    for (const [id, until] of inFlight) if (until <= now) inFlight.delete(id);
    return new Set(inFlight.keys());
  };
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
    let client: OAuthClient;
    try {
      client = deps.store.registerClient(
        {
          redirectUris: uris,
          // Bounded: this name becomes the grant's label and the audit trail's actor, and it
          // arrives from an unauthenticated endpoint.
          name: (singleString(body.client_name) ?? "unnamed client").slice(0, 60),
        },
        // Clients mid-flow are not idle, whatever the grant table says. Without this the cap is a
        // weapon: register past it and the client currently completing a pairing is evicted, so
        // its token exchange fails after the code was already spent.
        busyClients(),
      );
    } catch (e) {
      if (!(e instanceof RegistryFullError)) throw e;
      // Capacity, not a bad request. It clears itself when the slots are held by clients
      // mid-pairing, and it does NOT when they are held by approved ones: a grant has no expiry,
      // so 64 real clients fill the registry permanently. Saying only "try again" there sends the
      // operator to wait for something that will not happen, so the message names the repair too.
      oauthError(
        res,
        503,
        "temporarily_unavailable",
        "the client registry is full: every client is mid-pairing or holds a grant. A pairing attempt lapses within ten " +
          "minutes, so try again then. A grant does not lapse — `deckhand connections` lists who holds one and " +
          "`deckhand revoke <client-id>` frees a slot. If it lists nobody, the slots are pairing attempts being renewed " +
          "faster than they lapse: they live in the server's memory, so a restart clears them at once — at the cost of every " +
          "booted preview on the machine.",
      );
      return;
    }
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

  // -- Authorize: ask for the code the operator minted ------------------------
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
    inFlight.set(client.clientId, clock() + IN_FLIGHT_TTL_MS);
    codeForm(res, { clientId: client.clientId, redirectUri, state, challenge, clientName: client.name });
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
    // Keyed by source so one guesser cannot spend the budget of the person the operator is
    // actually talking to. Behind the tunnel this is Cloudflare's header; direct on loopback it
    // is the socket. Spoofable only by something already inside, which has the token anyway.
    const source = req.header("cf-connecting-ip") ?? req.ip ?? "unknown";
    if (!deps.pairing.claim(singleString(b.code) ?? "", source)) {
      // Deliberately one message for wrong, expired, spent and never-minted. Telling them
      // apart tells an attacker whether a code exists to be guessed.
      codeForm(res, { clientId, redirectUri, state, challenge, clientName: client.name }, "That code is not valid. Ask for a fresh one.");
      return;
    }
    // NOT cleared here: the exchange has not happened yet.
    inFlight.set(clientId, clock() + IN_FLIGHT_TTL_MS);
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
      // The flow is over: the grant now protects this client from eviction on its own.
      inFlight.delete(clientId);
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
