import { Readable, pipeline } from "node:stream";
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { PreviewError, type PreviewEngine } from "../engine/preview.ts";
import { isAllowedSubpath } from "../streaming/backend.ts";
import { signUnlockCookie, verifyUnlockCookie, pinFingerprint } from "./shares.ts";

// ---------------------------------------------------------------------------
// Share viewer + scoped proxy (PLAN §8/§9). The ONLY public path to a device:
// forwards just the helper's video (stream.avcc/stream.mjpeg), ax, and input
// (ws) subpaths, and only for a device that belongs to the share's preview.
// serve-sim's other routes (devtools, camera, grid) are not reachable THROUGH HERE — but
// this allow-list is not the boundary it reads as: a simulator shares the host's network
// stack, so a share holder with device input can drive the helper on loopback directly,
// never touching this proxy. serve-sim is vendored with its host shell-exec routes patched
// out for exactly that reason (see streaming/serveSim.ts).
// ---------------------------------------------------------------------------

export interface ShareDeps {
  engine: PreviewEngine;
  /** PIN gate: cookie validation + attempt throttle (shared with the host proxy + WS). */
  pinGate: PinGate;
  /** Built viewer dist dir (index.html served for /s/:shareId). */
  viewerDist?: string;
  /** Min gap between viewer-triggered restarts per share (test override). */
  restartCooldownMs?: number;
}

/** Resolve the loopback upstream URL for a device subpath within a share, or null. */

/**
 * Record a diagnostic line on the device's `stream` log. Wrapped: diagnostics
 * must never be able to fail a request they were only meant to explain.
 */
function trace(engine: PreviewEngine, shareId: string, deviceId: string, line: string): void {
  try {
    // Sanitize HERE, not at the call sites: these lines interpolate URL path
    // segments the share holder chooses, and the reader is an agent acting on
    // what the `logs` tool shows it. A %0A in a subpath forged extra log lines.
    engine.logStreamEvent(shareId, deviceId, line.replace(/[\r\n]+/g, " ").slice(0, TRACE_LINE_CAP));
  } catch {
    /* noop */
  }
}

/** Long enough for a helper URL plus a reason; short enough that one line can't flood the buffer. */
const TRACE_LINE_CAP = 500;

/** Why `resolveUpstream` returned null — the difference an agent needs to act. */
function upstreamMissReason(engine: PreviewEngine, shareId: string, deviceId: string, sub: string): string {
  if (!isAllowedSubpath(sub)) return `subpath "${sub}" is not on the allow-list`;
  const found = engine.findByShareId(shareId);
  if (!found) return "no live preview for this share (ended, or never started)";
  const dev = found.devices.find((d) => d.deviceId === deviceId);
  if (!dev) return `preview has no device "${deviceId}" (has: ${found.devices.map((d) => d.deviceId).join(", ")})`;
  return "device has no attached stream (the helper never came up, or was detached)";
}

/**
 * A proxy fetch that cancels cleanly when the browser disconnects. Without an
 * explicit abort, undici surfaces a client-torn socket mid-stream as an
 * *uncaughtException* ("TypeError: terminated" from Fetch.onAborted) — a routine
 * disconnect that would otherwise reach the process-level handler. Tying an
 * AbortController to res 'close' gives undici an abort reason, so it cancels the
 * fetch and its body stream quietly. (res 'close' after a normal end is a no-op
 * abort.) Pair with `pipeline(...)`, which handles the Node-stream side.
 */
function proxyFetch(res: express.Response, target: string, init: RequestInit & { duplex?: string } = {}): Promise<Response> {
  const ac = new AbortController();
  res.once("close", () => ac.abort());
  return fetch(target, { ...init, signal: ac.signal } as RequestInit);
}

/** A short, safe label for a thrown value — never a stack, never a URL with a token. */
function errLabel(e: unknown): string {
  const code = (e as { code?: string; cause?: { code?: string } })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
  const msg = e instanceof Error ? e.message : String(e);
  return (code ? `${code} ${msg}` : msg).slice(0, 160);
}

function resolveUpstream(engine: PreviewEngine, shareId: string, deviceId: string, sub: string): string | null {
  if (!isAllowedSubpath(sub)) return null;
  const found = engine.findByShareId(shareId);
  const dev = found?.devices.find((d) => d.deviceId === deviceId);
  if (!found || !dev?.stream) return null;
  return `${dev.stream.origin}${dev.stream.helperBasePath}/${sub}`;
}

/**
 * Resolve the loopback upstream URL for an arbitrary path within a web preview's
 * dev server. Unlike the device proxy's fixed allow-list, this forwards ANY path
 * (a dev server serves its own HTML/assets/routes) — so the security argument is
 * different: the upstream is strictly THIS share's own web dev server, resolved
 * via findByShareId (no SSRF to sibling ports, no path traversal), gated by the
 * 144-bit shareId. The dev server was started with --base=<helperBasePath>/, so
 * the full path is reconstructed to match its base. (PLAN §11.6 amendment.)
 */
function resolveWebUpstream(engine: PreviewEngine, shareId: string, rest: string): string | null {
  const found = engine.findByShareId(shareId);
  const dev = found?.devices.find((d) => d.platform === "web");
  if (!found || !dev?.stream) return null;
  const base = dev.stream.helperBasePath;
  // Validate AFTER normalization, never by blocklist: `%252e%252e` and `\..\..`
  // both slip past a literal ".." check yet are still collapsed by WHATWG URL
  // parsing. Building the URL first and then asserting the base prefix survives
  // is the only check that sees what the upstream will actually receive.
  const url = new URL(rest ? `${base}/${rest}` : `${base}/`, dev.stream.origin);
  if (url.origin !== new URL(dev.stream.origin).origin) return null;
  if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return null;
  return url.toString();
}

/** Headers never forwarded to the dev server: hop-by-hop, host (fetch sets its own),
 *  accept-encoding/content-length (the body is re-streamed decoded/chunked). */
const WEB_REQUEST_DROP = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-connection",
  "accept-encoding",
  "content-length",
]);

/** Request headers forwarded to the dev server: everything except the drop list, so app
 *  requests keep content-type, authorization, cookies and custom API headers (an allowlist
 *  here silently broke every POST — no content-type → 415 from typed backends). Adds
 *  x-forwarded-proto/-host; strips the deck_unlock cookie so the HMAC never reaches the app. */
function webRequestHeaders(req: express.Request): Record<string, string> {
  const h: Record<string, string> = {};
  for (const [name, v] of Object.entries(req.headers)) {
    const n = name.toLowerCase();
    if (WEB_REQUEST_DROP.has(n) || n.startsWith("x-forwarded-")) continue;
    if (typeof v === "string") h[n] = v;
    else if (Array.isArray(v)) h[n] = v.join(", ");
  }
  if (h.cookie) {
    const kept = h.cookie
      .split(";")
      .map((c) => c.trim())
      .filter((c) => !c.startsWith(`${UNLOCK_COOKIE}=`));
    if (kept.length) h.cookie = kept.join("; ");
    else delete h.cookie;
  }
  h["x-forwarded-proto"] = "https";
  if (req.headers.host) h["x-forwarded-host"] = req.headers.host;
  return h;
}

/** Response headers safe to forward back (not content-length/encoding — the body is re-streamed decoded). */
const WEB_RESPONSE_HEADERS = ["content-type", "cache-control", "etag", "last-modified", "location", "vary", "content-disposition"];

// --- PIN gate ---------------------------------------------------------------
// A share can require a numeric PIN (set per app, via MCP). Content routes (the
// device stream, the web app, the input/HMR WebSockets) require a valid HMAC
// unlock cookie; the viewer shell, /state, and /unlock stay public so the pad
// can render. Crypto lives in shares.ts. (PLAN §9/§11.6.)

const UNLOCK_COOKIE = "deck_unlock";
const UNLOCK_TTL_MS = 12 * 60 * 60_000;

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    const raw = part.slice(i + 1).trim();
    // decodeURIComponent throws URIError on a stray '%' — and a browser will
    // happily send any cookie set on this hostname, including ones deckhand
    // never wrote (a web preview's app can set its own). One malformed value
    // then took down EVERY cookie on the request: on an HTTP route that is a
    // 500, but the WS upgrade path has no error boundary at all, so it
    // destroyed the socket and the viewer retried forever with nothing on
    // screen. A value we cannot decode is not a reason to lose the ones we can.
    try {
      out[k] = decodeURIComponent(raw);
    } catch {
      out[k] = raw;
    }
  }
  return out;
}

/** Only send a Secure cookie over https (so loopback/http testing still works). */
function isHttps(req: { secure?: boolean; headers: IncomingMessage["headers"] }): boolean {
  return Boolean(req.secure) || req.headers["x-forwarded-proto"] === "https";
}

export interface PinGate {
  /** Whether the share requires a PIN, and its digit length (for the pad). */
  info(shareId: string): { required: boolean; length: number };
  /** True when no PIN is needed, or the request carries a valid unlock cookie. */
  allowed(cookieHeader: string | undefined, shareId: string): boolean;
  /** Try a PIN: on success returns the signed cookie value; on failure the lockout ms (0 = wrong PIN). */
  attempt(shareId: string, pin: string): { ok: true; cookie: string } | { ok: false; lockedMs: number };
  /**
   * Mint an unlock cookie for a share WITHOUT a PIN attempt, for the paired
   * share of a compare session the caller has already unlocked. Never reachable
   * from a request path on its own — the unlock route calls it only after
   * `attempt` succeeded on the partner, and only for a live pairing.
   * Returns null when the share has no PIN (nothing to unlock).
   */
  issue(shareId: string): string | null;
}

export interface PinGateOptions {
  ttlMs?: number;
  maxFails?: number;
  lockMs?: number;
  now?: () => number;
}

/** Far above any real share count; a bound, not a tuning knob. */
const THROTTLE_MAX_ENTRIES = 1000;

/** Build the shared PIN gate: cookie validation + a per-share attempt throttle. */
export function createPinGate(engine: PreviewEngine, shareSecret: string, opts: PinGateOptions = {}): PinGate {
  const ttlMs = opts.ttlMs ?? UNLOCK_TTL_MS;
  const maxFails = opts.maxFails ?? 5;
  const lockMs = opts.lockMs ?? 30_000;
  const now = opts.now ?? (() => Date.now());
  const throttle = new Map<string, { fails: number; lockedUntil: number }>();
  return {
    info: (shareId) => engine.pinInfoForShare(shareId),
    allowed: (cookieHeader, shareId) => {
      const rec = engine.pinRecordForShare(shareId);
      if (!rec) return true;
      const cookie = parseCookies(cookieHeader)[UNLOCK_COOKIE];
      // Checked against the PIN in force RIGHT NOW, not just the signature: a
      // cookie issued under a previous PIN (or under no PIN) must stop working
      // the moment set_pin changes it, not 12 hours later.
      return cookie ? verifyUnlockCookie(shareSecret, shareId, cookie, now(), pinFingerprint(shareSecret, rec)) : false;
    },
    issue: (shareId) => {
      const rec = engine.pinRecordForShare(shareId);
      if (!rec) return null;
      // Bound to the PIN in force now, exactly like `attempt` — so set_pin on
      // the partner invalidates this cookie too.
      return signUnlockCookie(shareSecret, shareId, now() + ttlMs, pinFingerprint(shareSecret, rec));
    },
    attempt: (shareId, pin) => {
      // Only track shares that exist. `POST /s/<anything>/unlock` used to mint a
      // throttle entry for any attacker-chosen string — one free Map entry per
      // request, unbounded — while verifyPin just returns false for unknown ids.
      if (!engine.pinInfoForShare(shareId).required) return { ok: false, lockedMs: 0 };
      // Cheap eviction backstop. Only drop entries whose LOCK has expired
      // (lockedUntil > 0 and now past it) — a lapsed lock grants a fresh budget
      // on its own, so forgetting it changes nothing. Entries mid-accumulation
      // (lockedUntil === 0, fails 1..max-1) are the brute-force counter itself,
      // so they must survive: evicting them hands the attacker a clean slate.
      if (throttle.size > THROTTLE_MAX_ENTRIES) {
        for (const [id, entry] of throttle) {
          if (entry.lockedUntil > 0 && entry.lockedUntil <= now()) throttle.delete(id);
        }
      }
      const t = throttle.get(shareId) ?? { fails: 0, lockedUntil: 0 };
      const remaining = t.lockedUntil - now();
      if (remaining > 0) return { ok: false, lockedMs: remaining };
      if (engine.verifyPin(shareId, pin)) {
        throttle.delete(shareId);
        const fp = pinFingerprint(shareSecret, engine.pinRecordForShare(shareId));
        return { ok: true, cookie: signUnlockCookie(shareSecret, shareId, now() + ttlMs, fp) };
      }
      t.fails += 1;
      if (t.fails >= maxFails) {
        t.lockedUntil = now() + lockMs;
        t.fails = 0;
      }
      throttle.set(shareId, t);
      return { ok: false, lockedMs: Math.max(0, t.lockedUntil - now()) };
    },
  };
}

/** Read a request's raw body (for the subdomain unlock POST, which has no body parser). */
function readBody(req: IncomingMessage, limit = 4096): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > limit) {
        data = data.slice(0, limit);
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(data));
  });
}

/**
 * A self-contained numeric PIN pad served on a subdomain-web host (which has no
 * React viewer). Same calm design language as the setup page: dots fill as you
 * type, no submit button (auto-unlocks on the last digit), shake + message on a
 * wrong code. POSTs {pin} to /__deck/unlock, then reloads into the app.
 */
function pinPadPage(length: number): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Enter PIN</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;height:100dvh;display:grid;place-items:center;background:radial-gradient(120% 120% at 50% 0,#2c2025,#1a1218);color:#f2e8dc;font:16px/1.4 system-ui,-apple-system,sans-serif}
.card{display:flex;flex-direction:column;align-items:center;gap:22px;padding:34px 30px;border-radius:22px;background:linear-gradient(165deg,#33262c,#2c2025);box-shadow:0 28px 60px rgba(0,0,0,.42);border:1px solid rgba(242,232,220,.08);animation:rise .5s cubic-bezier(.2,.7,.2,1) both}
h1{margin:0;font-size:15px;font-weight:500;letter-spacing:.02em;color:#c9bcae}
.dots{display:flex;gap:14px;height:16px}.dot{width:14px;height:14px;border-radius:50%;border:1.5px solid rgba(242,232,220,.28);transition:.18s}.dot.on{background:linear-gradient(150deg,#e0a971,#d98873);border-color:transparent}
.dots.err{animation:shake .4s}
.pad{display:grid;grid-template-columns:repeat(3,72px);gap:12px}
.key{height:64px;border:0;border-radius:16px;background:rgba(242,232,220,.06);color:#f2e8dc;font:300 26px system-ui;cursor:pointer;transition:.12s;backdrop-filter:blur(6px)}
.key:hover{background:rgba(242,232,220,.11)}.key:active{transform:scale(.94)}.key.blank{background:transparent;pointer-events:none}
.msg{min-height:18px;font-size:13px;color:#d98873;opacity:0;transition:.2s}.msg.show{opacity:1}
@keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@keyframes shake{10%,90%{transform:translateX(-2px)}30%,70%{transform:translateX(5px)}50%{transform:translateX(-8px)}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body><div class="card">
<h1>Enter PIN to view</h1><div class="dots" id="dots"></div>
<div class="pad" id="pad"></div><div class="msg" id="msg"></div></div>
<script>
var LEN=${length},pin="",busy=false;
var dots=document.getElementById("dots"),pad=document.getElementById("pad"),msg=document.getElementById("msg");
function draw(){dots.innerHTML="";for(var i=0;i<LEN;i++){var d=document.createElement("div");d.className="dot"+(i<pin.length?" on":"");dots.appendChild(d)}}
function shake(t){dots.classList.add("err");msg.textContent=t;msg.classList.add("show");setTimeout(function(){dots.classList.remove("err")},400)}
function press(n){if(busy||pin.length>=LEN)return;pin+=n;msg.classList.remove("show");draw();if(pin.length===LEN)submit()}
function back(){if(busy)return;pin=pin.slice(0,-1);draw()}
function submit(){busy=true;fetch(location.pathname==="/"?"/__deck/unlock":"/__deck/unlock",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({pin:pin})}).then(function(r){if(r.ok){location.reload();return}return r.json().catch(function(){return{}}).then(function(j){busy=false;pin="";draw();if(r.status===429){shake("Too many attempts — wait "+Math.ceil((j.lockedMs||30000)/1000)+"s")}else{shake("Wrong PIN")}if(navigator.vibrate)navigator.vibrate(60)})}).catch(function(){busy=false;pin="";draw();shake("Network error")})}
var keys=["1","2","3","4","5","6","7","8","9","","0","⌫"];
keys.forEach(function(k){var b=document.createElement("button");if(!k){b.className="key blank"}else if(k==="⌫"){b.className="key";b.textContent="⌫";b.onclick=back}else{b.className="key";b.textContent=k;b.onclick=function(){press(k)}}pad.appendChild(b)});
window.addEventListener("keydown",function(e){if(e.key>="0"&&e.key<="9")press(e.key);else if(e.key==="Backspace")back()});
draw();
</script></body></html>`;
}

// --- subdomain (host-based) web hosting ------------------------------------
// A web framework that can't set its base at runtime (Nuxt/Next) is served at
// the ROOT of its host — so no --base and no checkout config edit. The engine
// resolves the request's Host to that preview's own loopback dev server
// (engine.resolveWebHost, matching the configured webHost or a hostId label).

/** A calm "starting…" page shown on the subdomain while the dev server boots (auto-refresh). */
const WEB_STARTING_HTML =
  '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2">' +
  '<title>Starting…</title><style>html{color-scheme:light dark;font:16px system-ui;display:grid;' +
  "place-items:center;height:100%}body{margin:0;opacity:.7}</style><body>Starting the dev server…</body>";

/**
 * Express middleware: if the request's Host is a live subdomain-web preview,
 * reverse-proxy it (at root) to that preview's loopback dev server. Otherwise
 * `next()` so normal apex routing (MCP, viewer, path shares) proceeds.
 */
export function createHostWebProxyMiddleware(engine: PreviewEngine, pinGate: PinGate): express.RequestHandler {
  return async (req, res, next) => {
    const found = engine.resolveWebHost(req.headers.host);
    if (!found) return next(); // not a web host → normal routing on the apex host
    const shareId = found.shareId;
    // PIN gate: no React viewer on a subdomain, so serve a standalone pad.
    if (pinGate.info(shareId).required && !pinGate.allowed(req.headers.cookie, shareId)) {
      if (req.method === "POST" && req.path === "/__deck/unlock") {
        const raw = await readBody(req);
        let pin = "";
        try {
          pin = String((JSON.parse(raw) as { pin?: unknown }).pin ?? "");
        } catch {
          /* bad body → empty pin → fails */
        }
        const r = pinGate.attempt(shareId, pin);
        if (r.ok) {
          res.cookie(UNLOCK_COOKIE, r.cookie, { httpOnly: true, secure: isHttps(req), sameSite: "lax", path: "/", maxAge: UNLOCK_TTL_MS });
          res.json({ ok: true });
        } else if (r.lockedMs > 0) {
          res.status(429).json({ ok: false, lockedMs: r.lockedMs });
        } else {
          res.status(401).json({ ok: false });
        }
        return;
      }
      res.status(200).setHeader("content-type", "text/html").end(pinPadPage(pinGate.info(shareId).length));
      return;
    }
    if (!found.ready || !found.origin) {
      res.status(503).setHeader("retry-after", "2").setHeader("content-type", "text/html").end(WEB_STARTING_HTML);
      return;
    }
    const target = `${found.origin}${req.originalUrl}`;
    const method = (req.method ?? "GET").toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD";
    try {
      const upstream = await proxyFetch(res, target, {
        method,
        headers: webRequestHeaders(req),
        redirect: "manual",
        ...(hasBody ? { body: req as unknown as ReadableStream, duplex: "half" } : {}),
      });
      res.status(upstream.status);
      for (const name of WEB_RESPONSE_HEADERS) {
        const v = upstream.headers.get(name);
        if (v) res.setHeader(name, v);
      }
      const cookies = upstream.headers.getSetCookie?.() ?? [];
      if (cookies.length) res.setHeader("set-cookie", cookies);
      const bodyless = upstream.status === 204 || upstream.status === 304 || !upstream.body;
      if (bodyless) {
        res.end();
      } else {
        const nodeStream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
        pipeline(nodeStream, res, () => {
          /* ordinary disconnects/teardowns — swallow */
        });
      }
    } catch {
      if (!res.headersSent) res.status(502).end();
    }
  };
}

/** Set the path-scoped unlock cookie for one share. */
function setUnlockCookie(res: express.Response, req: express.Request, shareId: string, cookie: string): void {
  res.cookie(UNLOCK_COOKIE, cookie, {
    httpOnly: true,
    secure: isHttps(req),
    sameSite: "lax",
    path: `/s/${shareId}`,
    maxAge: UNLOCK_TTL_MS,
  });
}

export function createShareRouter(deps: ShareDeps): express.Router {
  const router = express.Router();

  // Sanitized preview state for the viewer (device list + phases; no secrets).
  // Public, but when the share is PIN-protected and not yet unlocked it returns
  // only { locked, pinLength } so the viewer can render the pad without leaking
  // the preview's details. (This route + /unlock + the viewer shell stay open.)
  router.get("/:shareId/state", (req, res) => {
    const shareId = req.params.shareId;
    const info = deps.pinGate.info(shareId);
    if (info.required && !deps.pinGate.allowed(req.headers.cookie, shareId)) {
      res.json({ locked: true, pinLength: info.length });
      return;
    }
    // This share is PIN-protected and THIS browser proved the PIN — so top up
    // the partner's cookie too. /unlock does this at PIN time, but a pair can
    // form AFTER the unlock (two independently started previews that only became
    // a pair once the second one booted, or a cookie from an earlier session).
    // The reference pane then streamed from a shareId this browser had no cookie
    // for and sat on "Connecting…" forever, with no way to unlock it: the pad
    // only ever renders for the page's own share. This route is polled, so the
    // pair self-heals within one poll.
    //
    // `info.required` is the whole authorization check: we only get here having
    // already returned above when the PIN was required and unmet. Without it a
    // PUBLIC share would mint its protected partner's cookie to any caller —
    // and every compare/migration reference pane is public by construction
    // (bootReference), so `GET /s/<publicReferenceId>/state` would have handed
    // out an unlock cookie for the protected working share.
    if (info.required) {
      // The `allowed` term is belt-and-braces, not an optimisation: each
      // partner's cookie is path-scoped to `/s/<partner>`, so the browser never
      // sends it here and this is in practice always true — every partner's
      // cookie is re-minted on each poll, identical each time.
      for (const partner of deps.engine.pairedShareIds(shareId)) {
        if (!deps.pinGate.info(partner).required || deps.pinGate.allowed(req.headers.cookie, partner)) continue;
        const cookie = deps.pinGate.issue(partner);
        if (cookie) setUnlockCookie(res, req, partner, cookie);
      }
    }
    const state = deps.engine.shareState(shareId);
    if (!state) {
      res.status(404).json({ error: "preview not found or ended" });
      return;
    }
    res.json({ ...state, locked: false });
  });

  // Verify a PIN and, on success, set the signed unlock cookie (scoped to this
  // share's path). Throttled per share against brute-force.
  router.post("/:shareId/unlock", express.json({ limit: "1kb" }), (req, res) => {
    const shareId = req.params.shareId;
    const pin = typeof (req.body as { pin?: unknown })?.pin === "string" ? (req.body as { pin: string }).pin : "";
    const r = deps.pinGate.attempt(shareId, pin);
    if (r.ok) {
      const setUnlock = (id: string, cookie: string) => setUnlockCookie(res, req, id, cookie);
      setUnlock(shareId, r.cookie);
      // A compare session is one page showing several shares side by side. Each
      // extra pane streams from its OWN shareId, so its own path-scoped cookie:
      // without this, a PIN on any pane left the others stuck on "Connecting…"
      // while their WS was refused once a second. Unlocking one pane of a live
      // page unlocks the rest — the operator asked for one PIN, and the panes
      // are only ever shown together.
      //
      // Mint each partner's cookie through ITS OWN gate, so a partner with a
      // different PIN length/secret still gets a correctly-bound cookie, and a
      // partner with no PIN at all is simply skipped.
      for (const paired of deps.engine.pairedShareIds(shareId)) {
        if (!deps.pinGate.info(paired).required) continue;
        const p = deps.pinGate.issue(paired);
        if (p) setUnlock(paired, p);
      }
      // The state rides along with the unlock.
      //
      // The viewer used to POST /unlock, wait, then GET /state, wait again, and only then
      // show anything — two sequential round trips for one action. On the server both are
      // sub-millisecond; through the tunnel each costs ~230ms, so the pad sat there with all
      // four dots filled for half a second minimum, showing nothing. The second call asked
      // for something this handler already has.
      res.json({ ok: true, state: deps.engine.shareState(shareId) });
    } else if (r.lockedMs > 0) {
      res.status(429).json({ ok: false, lockedMs: r.lockedMs });
    } else {
      res.status(401).json({ ok: false });
    }
  });

  // Gate the content routes (device stream, web app, restart) behind the PIN.
  // Registered AFTER /state and /unlock (which must stay public) and before the
  // content routes below, so only they are gated; the viewer shell (/:shareId) is
  // a single segment and never matches this.
  router.use((req, res, next) => {
    // The `i` is load-bearing. Express dispatches STRING routes
    // case-insensitively by default (this router is built with no options and
    // nothing sets "case sensitive routing"), so a case-sensitive gate in front
    // of them gates nothing: `/s/<id>/Dev/<dev>/ax` reached the live screen and
    // accessibility tree of a PIN-locked share with no PIN at all.
    const m = /^\/([^/]+)\/(dev|web|restart)(?:\/|$)/i.exec(req.path);
    if (!m) return next();
    // DECODE, because `req.path` does not and `req.params` does. The handlers below read
    // `req.params.shareId`, so a gate reading the raw segment resolves a DIFFERENT share:
    // `/s/%73hare1/web/…` gated on the literal "%73hare1" — an id nobody holds, therefore no
    // PIN record, therefore treated as public — and then served "share1", which is locked.
    // That is the third bypass on this seam and the third time its cause was the gate and the
    // handler disagreeing about what the shareId IS (case, then pane pairing, now encoding).
    // A malformed escape fails CLOSED: decodeURIComponent throws on "%zz", and a request we
    // cannot resolve is not a request we may wave through.
    let shareId: string;
    try {
      shareId = decodeURIComponent(m[1]!);
    } catch {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    if (deps.pinGate.allowed(req.headers.cookie, shareId)) return next();
    res.status(401).json({ error: "locked", ...deps.pinGate.info(shareId) });
  });

  // Viewer refresh button: rebuild a LOCAL preview in place (the engine rejects
  // git shares). Cooldown guards against double-taps; anything holding the
  // share link may already control the app via input, so restart adds no new
  // trust — but it does run a build, hence the throttle.
  const restartCooldownMs = deps.restartCooldownMs ?? 10_000;
  const lastRestart = new Map<string, number>();
  router.post("/:shareId/restart", (req, res) => {
    const shareId = req.params.shareId;
    const now = Date.now();
    const last = lastRestart.get(shareId) ?? 0;
    if (now - last < restartCooldownMs) {
      res.status(429).json({ error: "a restart was just triggered — give it a moment" });
      return;
    }
    try {
      deps.engine.restartByShareId(shareId);
      lastRestart.set(shareId, now);
      res.status(202).json({ ok: true });
    } catch (e) {
      if (e instanceof PreviewError) {
        const gone = /no active preview/.test(e.message);
        res.status(gone ? 404 : 409).json({ error: e.message });
        return;
      }
      res.status(500).json({ error: "restart failed" });
    }
  });

  // Proxy the video/ax subpaths (chunked HTTP). `ws` is handled on upgrade.
  router.get("/:shareId/dev/:deviceId/:sub", async (req, res) => {
    const { shareId, deviceId, sub } = req.params;
    if (sub === "ws") {
      res.status(426).json({ error: "use a WebSocket upgrade" });
      return;
    }
    const target = resolveUpstream(deps.engine, shareId, deviceId, sub);
    if (!target) {
      // Say WHICH of the three reasons it was: an agent debugging a stuck
      // viewer cannot act on a bare 404.
      trace(deps.engine, shareId, deviceId, `GET ${sub} → 404 (${upstreamMissReason(deps.engine, shareId, deviceId, sub)})`);
      res.status(404).end();
      return;
    }
    const started = Date.now();
    try {
      const upstream = await proxyFetch(res, target, {
        headers: { accept: req.headers.accept ?? "*/*", "x-forwarded-proto": "https" },
      });
      trace(deps.engine, 
        shareId,
        deviceId,
        `GET ${sub} → helper ${upstream.status} in ${Date.now() - started}ms (${upstream.headers.get("content-type") ?? "no content-type"})`,
      );
      res.status(upstream.status);
      for (const h of ["content-type", "cache-control"]) {
        const v = upstream.headers.get(h);
        if (v) res.setHeader(h, v);
      }
      // Long-lived chunked bodies (avcc/mjpeg/ax SSE). Use pipeline, not pipe:
      // it propagates errors and destroys BOTH ends on a client disconnect or an
      // upstream (helper) teardown mid-stream. A bare `.pipe` leaves the source's
      // 'error' unhandled, and an aborted helper socket would then crash the whole
      // process (one preview's teardown must never take the server down).
      if (upstream.body) {
        const nodeStream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
        let bytes = 0;
        nodeStream.on("data", (c: Buffer) => {
          bytes += c.length;
        });
        pipeline(nodeStream, res, (err) => {
          // Errors here are ordinary disconnects/teardowns — swallow, don't throw.
          // They are still the single most useful fact when a stream dies early,
          // so record how far it got and why it ended.
          trace(deps.engine, 
            shareId,
            deviceId,
            `GET ${sub} ended after ${Date.now() - started}ms, ${bytes} bytes${err ? `: ${errLabel(err)}` : ""}`,
          );
        });
      } else {
        trace(deps.engine, shareId, deviceId, `GET ${sub} → empty body`);
        res.end();
      }
    } catch (e) {
      trace(deps.engine, shareId, deviceId, `GET ${sub} → helper unreachable: ${errLabel(e)}`);
      if (!res.headersSent) res.status(502).end();
    }
  });

  // The viewer's own view of the stream. The browser is the only place that can
  // tell "the helper is fine but WebCodecs never produced a picture" from "the
  // request never arrived", and that difference is invisible server-side.
  router.post("/:shareId/dev/:deviceId/clientlog", express.json({ limit: "2kb" }), (req, res) => {
    const { shareId, deviceId } = req.params;
    const body = req.body as { event?: unknown; detail?: unknown };
    const event = typeof body?.event === "string" ? body.event.slice(0, 40) : "";
    if (!/^[a-z0-9 :._-]{1,40}$/i.test(event)) {
      res.status(400).end();
      return;
    }
    const detail = typeof body?.detail === "string" ? body.detail.replace(/[\r\n]+/g, " ").slice(0, 200) : "";
    trace(deps.engine, shareId, deviceId, `viewer: ${event}${detail ? ` — ${detail}` : ""}`);
    res.status(204).end();
  });

  // Web preview: reverse-proxy the whole dev server under the share. The
  // wildcard (which requires the trailing slash) is registered FIRST so the
  // trailing-slash base `/web` hits it; a bare `/:shareId/web` falls through to
  // the redirect below. (Order matters: Express's non-strict routing lets the
  // bare route also match `/web/`, which would otherwise redirect to itself.)
  router.get(/^\/([^/]+)\/web\/(.*)$/, async (req, res) => {
    const shareId = (req.params as unknown as string[])[0]!;
    const rest = (req.params as unknown as string[])[1] ?? "";
    const base = resolveWebUpstream(deps.engine, shareId, rest);
    if (!base) {
      res.status(404).end();
      return;
    }
    const qIdx = req.originalUrl.indexOf("?");
    const target = base + (qIdx >= 0 ? req.originalUrl.slice(qIdx) : "");
    try {
      // redirect: manual so a dev-server 3xx is forwarded to the browser (which
      // stays on the tunnel), not chased server-side to a loopback URL.
      const upstream = await proxyFetch(res, target, { headers: webRequestHeaders(req), redirect: "manual" });
      res.status(upstream.status);
      for (const name of WEB_RESPONSE_HEADERS) {
        const v = upstream.headers.get(name);
        if (v) res.setHeader(name, v);
      }
      const bodyless = upstream.status === 204 || upstream.status === 304 || !upstream.body;
      if (bodyless) {
        res.end();
      } else {
        const nodeStream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
        pipeline(nodeStream, res, () => {
          // Ordinary disconnects/teardowns — swallow, don't throw (see the device proxy).
        });
      }
    } catch {
      if (!res.headersSent) res.status(502).end();
    }
  });
  // Bare base with no trailing slash → redirect so the dev server's absolute
  // asset URLs (which include the base) resolve under the wildcard above.
  router.get("/:shareId/web", (req, res) => res.redirect(302, `/s/${encodeURIComponent(req.params.shareId)}/web/`));

  // Viewer page for any share id (client reads the id from location.pathname).
  // no-cache the HTML shell so a browser always revalidates it and picks up a new
  // hashed bundle after a deploy (a stale index.html → old bundle crashes on new
  // states like the PIN gate). The hashed /assets/* stay cacheable.
  if (deps.viewerDist) {
    router.get("/:shareId", (_req, res) =>
      res.set("Cache-Control", "no-cache").sendFile(join(deps.viewerDist!, "index.html")),
    );
  }

  return router;
}

// --- WebSocket input proxy (server 'upgrade') ------------------------------

const SHARE_WS_RE = /^\/s\/([^/]+)\/dev\/([^/]+)\/ws$/;
// Any upgrade under a web preview's share path is the dev server's HMR socket.
const SHARE_WEB_WS_RE = /^\/s\/([^/]+)\/web(?:\/.*)?$/;
const MAX_BUFFERED = 16;

/** Map close codes safely: never forward 1005/1006/1015 (use 1011). */
function safeCloseCode(code: number | undefined): number {
  if (code == null || code === 1005 || code === 1006 || code === 1015) return 1011;
  if (code < 1000 || code > 4999) return 1011;
  return code;
}

/**
 * Bridge an accepted client socket to a loopback upstream WebSocket: buffer
 * early client frames until the upstream opens (learnings §6), mirror both
 * directions, and map close codes safely. Optional subprotocols are forwarded
 * to the upstream (Vite HMR negotiates "vite-hmr").
 */
function bridgeSockets(
  wss: WebSocketServer,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  target: string,
  protocols?: string[],
  onUpstreamError?: (message: string) => void,
): void {
  wss.handleUpgrade(req, socket, head, (client) => {
    const upstream = protocols && protocols.length ? new WebSocket(target, protocols) : new WebSocket(target);
    const pending: Array<Buffer | ArrayBuffer | Buffer[]> = [];
    let upstreamOpen = false;

    client.on("message", (data, isBinary) => {
      const payload = isBinary ? (data as Buffer) : data.toString();
      if (upstreamOpen) {
        upstream.send(payload);
      } else if (pending.length < MAX_BUFFERED) {
        pending.push(data as Buffer);
      }
    });
    upstream.on("open", () => {
      upstreamOpen = true;
      for (const p of pending) upstream.send(p as Buffer);
      pending.length = 0;
    });
    upstream.on("message", (data, isBinary) => {
      if (client.readyState === client.OPEN) client.send(isBinary ? data : data.toString());
    });

    const closeBoth = (code?: number) => {
      const c = safeCloseCode(code);
      try {
        client.close(c);
      } catch {
        /* noop */
      }
      try {
        upstream.close(c);
      } catch {
        /* noop */
      }
    };
    client.on("close", (code) => closeBoth(code));
    upstream.on("close", (code) => closeBoth(code));
    client.on("error", () => closeBoth());
    upstream.on("error", (e) => {
      // Without this the client saw only a silent close and retried forever —
      // a dead helper produced an "upgrade accepted" flood with no cause line.
      onUpstreamError?.(e instanceof Error ? e.message : String(e));
      closeBoth();
    });
  });
}

/**
 * Handle a WebSocket upgrade for a share. Device input rides
 * `/s/:shareId/dev/:deviceId/ws`; a web preview's Vite HMR rides anywhere under
 * `/s/:shareId/web/…`. Returns true if it claimed the socket.
 */
export function handleShareUpgrade(
  engine: PreviewEngine,
  pinGate: PinGate,
  wss: WebSocketServer,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): boolean {
  const url = (req.url ?? "").split("?")[0]!;

  const mDev = SHARE_WS_RE.exec(url);
  if (mDev) {
    const [, shareId, deviceId] = mDev as unknown as [string, string, string];
    const found = engine.findByShareId(shareId);
    const dev = found?.devices.find((d) => d.deviceId === deviceId);
    if (!found || !dev?.stream || !pinGate.allowed(req.headers.cookie, shareId)) {
      // A destroyed upgrade is indistinguishable from a network problem in the
      // browser — the viewer just retries forever. Record which gate rejected it.
      trace(engine, 
        shareId,
        deviceId,
        `ws upgrade REFUSED: ${
          !found
            ? "no live preview for this share"
            : !dev
              ? `no device "${deviceId}"`
              : !dev.stream
                ? "device has no attached stream"
                : "share is PIN-locked (no valid unlock cookie)"
        }`,
      );
      socket.destroy();
      return true;
    }
    trace(engine, shareId, deviceId, "ws upgrade accepted → bridging to helper");
    const targetOrigin = dev.stream.origin.replace(/^http/, "ws");
    bridgeSockets(wss, req, socket, head, `${targetOrigin}${dev.stream.helperBasePath}/ws`, undefined, (msg) =>
      trace(engine, shareId, deviceId, `ws bridge → helper FAILED: ${msg}`),
    );
    return true;
  }

  const mWeb = SHARE_WEB_WS_RE.exec(url);
  if (mWeb) {
    const [, shareId] = mWeb as unknown as [string, string];
    const found = engine.findByShareId(shareId);
    const dev = found?.devices.find((d) => d.platform === "web");
    if (!found || !dev?.stream || !pinGate.allowed(req.headers.cookie, shareId)) {
      socket.destroy();
      return true;
    }
    // Vite HMR connects to its base path with the "vite-hmr" subprotocol. Forward
    // the exact request path (already the dev server's base) and the subprotocol.
    const targetOrigin = dev.stream.origin.replace(/^http/, "ws");
    bridgeSockets(wss, req, socket, head, `${targetOrigin}${req.url ?? ""}`, wsSubprotocols(req));
    return true;
  }

  return false;
}

/** Comma-separated `Sec-WebSocket-Protocol` header → the list to forward upstream. */
function wsSubprotocols(req: IncomingMessage): string[] | undefined {
  const proto = req.headers["sec-websocket-protocol"];
  return typeof proto === "string" ? proto.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
}

/**
 * Handle a WebSocket upgrade addressed to a subdomain-web preview's host
 * (`<hostId>.<hostname>`), proxying it to that preview's dev server — this is how
 * a subdomain-hosted framework's HMR socket (Vite, Nuxt webpack, …) rides the
 * tunnel. Returns true if it claimed the socket, false to fall through to the
 * apex share-ws handler.
 */
export function handleHostWebUpgrade(
  engine: PreviewEngine,
  pinGate: PinGate,
  wss: WebSocketServer,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): boolean {
  const found = engine.resolveWebHost(req.headers.host);
  if (!found) return false; // apex/normal host — let the share-ws handler try
  if (!found.ready || !found.origin || !pinGate.allowed(req.headers.cookie, found.shareId)) {
    socket.destroy();
    return true;
  }
  const targetOrigin = found.origin.replace(/^http/, "ws");
  bridgeSockets(wss, req, socket, head, `${targetOrigin}${req.url ?? ""}`, wsSubprotocols(req));
  return true;
}
