# Hosting non-Vite web frameworks at the root of their own host

**Shipped.** deckhand detects the web framework and hosts Nuxt/Next/static at the ROOT of a
host of its own, via a host-based reverse proxy plus the framework's HMR websocket, with
**zero checkout edits**. The public side is `webHost` in config (`server/src/config.ts`),
set by `deckhand setup --web-host <host>`: one host that the installer controls and whose
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
checkout** — which deckhand must never do (borrow-never-own; see AGENTS.md). This plan
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
- `deckhand setup --web-host <host>` does both.

### 2. Host-based routing (server)
- Middleware keyed on the **Host header**: if it matches the configured `webHost`,
  reverse-proxy `/*` to the active web preview's dev-server origin (loopback). A
  `<hostId>.<hostname>` label resolves the same way for loopback testing. Otherwise 404.
- Parallel to — not a replacement for — the existing path router (`/s/:shareId/...`), which
  still serves MCP, the viewer, and device/Vite-path previews.

### 3. Dev-server launch (engine + recipes)
- Add a per-framework "root dev run" alongside `webDevRun` — **no `--base`**, framework's
  own host/port flags:
  - Vite: `vite --host 127.0.0.1 --port <p>` (base defaults to `/`).
  - Nuxt 2: `nuxt-ts --hostname 127.0.0.1 --port <p>` (or `HOST`/`PORT` env).
  - Next: `next dev -H 127.0.0.1 -p <p>`.
  - Static: `vite preview` / a tiny static file server over `dist/`.
- Detection (`detect.ts`) grows to classify the framework (already returns `web` for Vite;
  add `nuxt`/`next` sub-classification, or a `webFramework` field on the app).
- Readiness: same HTTP-200 probe (`WebBackend`), now against `http://127.0.0.1:<p>/`.

### 4. Reverse proxy (share/proxy.ts)
- A **host-scoped** variant of the web proxy: forward the whole request (`req.originalUrl`,
  any method later) to `${origin}${req.originalUrl}`; forward the framework's HMR websocket
  wherever it lives (root for Vite, `/_nuxt/` for Nuxt webpack HMR — proxied because we
  forward everything under the host). Keep `X-Forwarded-Proto: https`, `X-Forwarded-Host`,
  safe close-code mapping, loopback-only upstream.

### 5. Share auth on the web host
- The PIN gate runs on the web host before anything is proxied, and the unlock cookie it
  sets is signed **per shareId** — a cookie minted for one share does not validate for
  another. Never widen that cookie to a wildcard domain.
- The 144-bit `shareId` stays as unguessable as it is in the path form.

### 6. Viewer
- The host serves the app **directly** — no deckhand chrome, no iframe, and no React viewer
  on that host. A standalone numeric PIN pad and a calm auto-refreshing "starting…" page are
  served there until the dev server answers (`server/src/share/proxy.ts`). The alternative
  considered was iframing the calm viewer from the apex, which would have preserved the
  Rebuild button at the cost of a cross-origin iframe that apps sending
  `X-Frame-Options: DENY` would break.

## Coexistence
- Keep path-based Vite hosting as the default for Vite (no infra needed, works today).
- Use subdomain hosting for non-Vite frameworks, or make it the default for all `web` apps
  once the DNS/tunnel is in place. A per-app `hosting: path | subdomain` (auto-selected by
  framework) keeps both live during migration.

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
| CRA / static | ❌ | ✅ (serve `dist/` at root) | none |

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
  the user controls, e.g. `web.<their-domain>`, and wires it: the tunnel DNS route, the
  ingress rule, and `webHost:` in config.yaml. Omit the flag and nothing about web appears —
  a mobile-only install is never asked.
- **`deckhand doctor`** (shipped) only surfaces web at all when web apps are registered:
  it's `skipped` with no web apps, a plain ✓ for Vite-only, and a non-failing ⚠ when a
  Nuxt/Next/static app exists but `webHost` is unset. Doctor never fails on this.
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
- **cloudflared wildcard ingress** exact syntax, if the wildcard upgrade is ever taken —
  a wildcard hostname may need its own DNS route add.
- **Nuxt 2 webpack HMR** (sockjs/websocket at `/_nuxt/`) through the proxy — needs a real
  end-to-end check like the Vite `vite-hmr` one already done.
- Per-framework dev-run flags and detection surface (a small `webFramework` enum).
