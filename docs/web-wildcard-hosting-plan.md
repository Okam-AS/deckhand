# Hosting non-Vite web frameworks at the root of their own host

**Shipped.** deckhand detects the web framework and hosts Nuxt/Next at the ROOT of a
host of its own, via a host-based reverse proxy plus the framework's HMR websocket, with
**zero checkout edits**. The public side is `webHost` in config (`server/src/config.ts`),
with `deckhand setup --web-host <host>` routing that host through the tunnel: one host that
the installer controls and whose
TLS cert already covers it, serving **the single active subdomain-web preview** at a time
(`resolveWebHost` in `server/src/engine/preview.ts`, the middleware and HMR upgrade in
`server/src/share/proxy.ts`). A `<hostId>.<hostname>` label is still matched, but only for
loopback and tests — it is not the public shape.

That is a deliberate narrowing of what this document originally proposed. A per-share
wildcard (`<shareId>.<host>`) would allow many concurrent public web previews, but on
Cloudflare's free Universal SSL a wildcard cert covers only one level, so a second-level
label under your zone gets a cert error; the wildcard needs paid Advanced Certificate
Manager. One first-level host costs nothing, needs one CNAME and one ingress rule, and buys
one web preview at a time. If concurrent public web previews are ever wanted, the wildcard
is the upgrade and the host-label router already there is what serves it.

`webHost` is optional: omit it and subdomain-web stays loopback-only.

This **extends** the `web` app type (PLAN §2/§8/§11 item 6 amendments) rather than competing
with it, because the path-based model rests on a Vite-specific trick — see "Context" below.
And the guarantee it exists to deliver is **zero checkout edits**; the "Coexistence" and
"Verification" sections below both depend on that.

## Context

The shipped `web` type serves a Vite dev server under a **path**: `/s/<shareId>/web/*`,
made to work by starting Vite with `--base=/s/<shareId>/web/` so every asset URL (and HMR)
sits under the share path. That base flag is the load-bearing trick, and it is
**Vite-specific**.

Frameworks that can't set their base path at runtime break this model:

- **Nuxt 2** sets its base via `router.base` in `nuxt.config`, and runs webpack HMR at
  `/_nuxt/`. Its dev CLI is `nuxt-ts`, which does not understand `--base`.
- **Next.js** sets `basePath` in `next.config.js`.
- **CRA** hardcodes `/` unless `homepage`/`PUBLIC_URL` is set at build time.

Making these work path-based would require **editing tracked config files in the user's
checkout** — which deckhand must never do (borrow-never-own; see AGENTS.md). Root hosting
removes that requirement entirely.

## Core idea

Serve a web preview at the **root of a host of its own** instead of under a path:

```
https://web.example.com/        →  http://127.0.0.1:<devPort>/
```

At root, the dev server needs **no base path** and **no config edit** for any framework —
its own absolute asset/HMR URLs (`/`, `/_nuxt/…`, `/@vite/…`, `/_next/…`) just work,
because they're already at root and the proxy forwards everything under the host.

### This is the direct answer to "don't push deckhand's local changes"

Root hosting makes deckhand-induced checkout edits **structurally unnecessary** — it
starts the dev server with host/port flags only and edits nothing in the tree. The
"never commit/push deckhand's local changes" guardrail (AGENTS.md) then has almost nothing
to guard: only gitignored dev-server caches remain, and even a stray lockfile is avoided
(`npm install --no-package-lock`, already shipped).

## Architecture

```
browser → https://web.example.com
   │  (one CNAME, covered by the zone's existing first-level cert)
   ▼
cloudflared named tunnel  (ingress: web.example.com → http://127.0.0.1:4300)
   ▼
deckhand server (127.0.0.1:4300)
   │  host-based router: Host matches webHost → the active web preview → its dev-server origin
   ▼
http://127.0.0.1:<devPort>/   (the framework's dev server, bound loopback, no --base)
```

### 1. DNS + tunnel (ops, one-time)
- Add a DNS record for the tunnel: the web host as a CNAME, same as the apex. A first-level
  host under your zone is covered by Cloudflare's free Universal SSL.
- **cloudflared ingress**: add a rule mapping that host → `http://127.0.0.1:4300`. The
  existing apex rule stays for MCP + path-based shares.
- `deckhand setup --web-host <host>` does both of those. It does **not** write the config
  key: `deckhand init` takes only hostname and port, and setup leaves an existing
  config.yaml alone — so `webHost:` goes into `~/.deckhand/config.yaml` by hand.

### 2. Host-based routing (server)
- `createHostWebProxyMiddleware` (`server/src/share/proxy.ts`) keys on the **Host header**
  and asks `engine.resolveWebHost`. A Host equal to the configured `webHost` resolves to
  the single active (newest, non-terminal) subdomain-web preview; a `<hostId>.<...>` label
  resolves to the preview whose shareId hashes to that label (loopback and tests). No match
  → `next()`, so ordinary apex routing (MCP, viewer, path shares) proceeds — it is parallel
  to the path router (`/s/:shareId/...`), not a replacement for it.
- Resolving a Host also marks the preview active: a subdomain-hosted app has no `/s/<id>`
  viewer polling behind it, so this is the only signal the idle sweep gets.
- While the dev server is still starting, the middleware answers 503 with an
  auto-refreshing "starting…" page instead of proxying.

### 3. Dev-server launch (engine + recipes)
- `webRootDevRun` (`server/src/engine/recipes.ts`) starts the dev server with **no
  `--base`** and loopback host/port only: `--host 127.0.0.1 --port <p> --strictPort` for
  Vite, `-H 127.0.0.1 -p <p>` for the rest. `startWebDevProcess` in `preview.ts` picks it
  over `webDevRun` for subdomain-hosted apps.
- `detect.ts` classifies the framework from the checkout's package.json deps and exports
  `WebFramework` (`vite | nuxt | next | static`); `webHostingMode` maps it to `path` (Vite,
  or an undetected `web` app) or `subdomain` (Nuxt/Next). The result is recorded on the
  preview record as `webFramework`. `static` is declared but unreachable — no detector
  returns it and nothing serves a built `dist/`.
- Readiness: the same HTTP-200 probe (`WebBackend`), against `http://127.0.0.1:<p>/` with
  an empty base path.

### 4. Reverse proxy (share/proxy.ts)
- The host-scoped proxy forwards the whole request (`req.originalUrl`, any method, body
  streamed) to `${origin}${req.originalUrl}`, sets `X-Forwarded-Proto: https` and
  `X-Forwarded-Host`, drops any inbound `x-forwarded-*`, and re-streams the response.
- `handleHostWebUpgrade` bridges the WebSocket upgrade at whatever path the framework's HMR
  lives (root for Vite, `/_nuxt/` for Nuxt webpack HMR) to the same loopback origin, and
  destroys the socket unless the share is unlocked and ready. Upstreams are loopback-only.

### 5. Share auth on the web host
- **A web preview cannot start without a PIN** — enforced in `preview.ts` where the
  preview is created, not only in the MCP tool, because on the configured `webHost` there
  is no shareId in the URL to keep anything secret. The PIN is the whole gate there.
- There is no React viewer on the web host, so the gate serves a standalone numeric pad.
  The `deck_unlock` cookie it sets is HMAC-signed **per shareId** and bound to the PIN in
  force, so a cookie minted for one share does not validate for another and a PIN change
  invalidates it immediately. It is stripped from every request before proxying, so it
  never reaches the app. Never widen that cookie to a wildcard domain.

### 6. Viewer
- The host serves the app **directly** — no deckhand chrome, no iframe, and no React viewer
  on that host. A standalone numeric PIN pad and a calm auto-refreshing "starting…" page are
  served there until the dev server answers (`server/src/share/proxy.ts`). The alternative
  considered was iframing the calm viewer from the apex, which would have preserved the
  Rebuild button at the cost of a cross-origin iframe that apps sending
  `X-Frame-Options: DENY` would break.

## Coexistence
Both models are live, and the choice is **automatic, from the detected framework**
(`webHostingMode` in `server/src/engine/detect.ts`): Vite — and any `web` app whose
framework is not detected — hosts path-based under `/s/<shareId>/web/` with `--base`, and
Nuxt/Next host at the root of the web host. There is no per-app hosting field and no
override: nothing in config.yaml or apps.yaml selects the mode.

## Security (maps to PLAN §11)
- **§11 item 1, loopback-only**: dev servers still bind `127.0.0.1`; the subdomain resolves to
  one preview's own loopback port (no SSRF/traversal). Only cloudflared is public.
- **§11 item 6, shares**: the whole origin is exposed (same posture as the path-based web proxy),
  gated by the PIN (+ the 144-bit shareId on the path form). Cookie isolation is the
  security-sensitive part: deckhand's own `deck_unlock` cookie is signed per share and is
  stripped before anything is forwarded upstream, so it never reaches the app. The *app's*
  own cookies are a different matter — every share sits on one public hostname, so a cookie
  an app sets under `/s/A/web/` is sent to a different app under `/s/B/web/`. That was
  reviewed and **accepted** (PLAN §11 item 6), not solved; revisit it before two mutually
  untrusted parties ever hold shares on one hostname.
- **Borrow-never-own**: zero checkout edits — the whole reason for this model.

## Framework support matrix
| Framework | Path-based | Root-hosted | Checkout edits |
|---|---|---|---|
| Vite | ✅ | ✅ | none |
| Nuxt 2 | ❌ (needs `router.base`) | ✅ (`-H/-p`) | none |
| Next.js | ❌ (needs `basePath`) | ✅ (`next dev -H -p`) | none |

CRA and plain static builds are not in that table because they are not detected as `web`
apps at all — `detectAppType` needs `nuxt`, `next` or `vite` in the dependencies, and
nothing serves a built `dist/` at root.

## Verification
- `deckhand app add <id> --path <abs-path-to-checkout> --type web` → `start_preview` →
  open `https://web.example.com/` → the app loads, HMR connects, and
  `git -C <abs-path-to-checkout> status` is **clean** (no tracked or stray changes). That
  clean-tree assertion is the acceptance criterion, and it held on a real Nuxt 2 app over
  loopback: served at root with root-relative `/_nuxt/` assets, checkout byte-for-byte
  unchanged after.

## New-user onboarding (web hosting is OPT-IN, never required)

Not every deckhand install hosts web apps — a mobile-only install must never be
burdened with `webHost`/DNS. So web setup is strictly opt-in:

- **`deckhand setup --web-host <host>`** (shipped) takes a first-level host under a domain
  the user controls, e.g. `web.<their-domain>`, and wires the tunnel DNS route and the
  ingress rule for it; `webHost:` itself is added to config.yaml by hand. Omit the flag and
  nothing about web appears — a mobile-only install is never asked.
- **`deckhand doctor`** (shipped) only surfaces web at all when web apps are registered:
  it's `skipped` with no web apps, a plain ✓ for Vite-only, and a non-failing ⚠ when a
  Nuxt/Next app exists but `webHost` is unset. Doctor never fails on this.
- **Per app** — "run up xxx webapp in deckhand":
  - *Co-located agent* (shell on the machine / SSH — deckhand's intended setup model):
    find or clone the checkout, `deckhand app add <id> --path <dir> --type web`,
    `start_preview`. Tool responses already steer here (empty-state + add_app web hint).
  - *Remote-only MCP agent* (no shell): web apps are **CLI-only to register** by design
    (owner-scoped tokens can't touch repo-less local apps), so it relays the one
    `deckhand app add … --type web` command for the user/co-located agent to run, then
    drives `start_preview`. The `start_preview` response also warns, in-band, when a
    subdomain-web app has no `webHost` yet (loopback-only until configured).

Net: Vite works out of the box with zero web setup; Nuxt/Next need the one-time opt-in
`webHost` step; nothing is imposed on installs that don't host web.

## Open questions / risks
- **cloudflared wildcard ingress** exact syntax, if the per-share wildcard is ever taken —
  a wildcard hostname may need its own DNS route add.
- **Nuxt 2 webpack HMR** (sockjs/websocket at `/_nuxt/`) through the proxy is **not
  verified end to end.** The upgrade path is wired (`handleHostWebUpgrade`) and Vite's
  `vite-hmr` socket is proxied, but nobody has watched a Nuxt edit hot-reload through it.
