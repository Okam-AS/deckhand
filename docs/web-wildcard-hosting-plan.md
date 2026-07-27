# Plan: host arbitrary web frameworks via per-share subdomains (wildcard hosting)

> Status (2026-07-16): **server side implemented + loopback-verified; public DNS/cert
> pending a decision.** deckhand now detects the web framework, hosts Vite path-based and
> Nuxt/Next/static at the ROOT of a per-share subdomain (`<hostId>.<hostname>`) via a
> host-based reverse proxy + HMR ws, with **zero checkout edits**. Verified end-to-end over
> loopback against the real Nuxt 2 app `Okam-AS/Web`: it serves at root with root-relative
> `/_nuxt/` assets and the checkout's git status was byte-for-byte unchanged after.
> **Not yet done — public exposure:** the edge cert is `*.sharghi.no` + `sharghi.no`, which
> does NOT cover the second-level `<hostId>.deckhand.sharghi.no`; see "TLS / DNS" below.
>
> Extends the `web` app type (PLAN §2/§8/§11.6 amendments) so deckhand can host web
> frameworks that are **not** Vite — Nuxt 2, Next.js, CRA, static exports — **without
> editing the user's checkout.**

## TLS / DNS (the remaining decision)

`<hostId>.deckhand.sharghi.no` is a **second-level** subdomain of the `sharghi.no` zone;
Cloudflare's free Universal SSL covers only one level (`*.sharghi.no`), so a browser hitting
`<hostId>.deckhand.sharghi.no` gets a cert error. Options:
- **A — Cloudflare Advanced Certificate Manager** (~$10/mo): issues `*.deckhand.sharghi.no`.
  Cleanest; the shipped host-label router works as-is, many concurrent web previews.
- **B — one dedicated first-level host** (e.g. `webpreview.sharghi.no`, covered by
  `*.sharghi.no`): a single CNAME + ingress rule, no cost; the host router matches that
  fixed host → the one active subdomain-web preview. Trade-off: one web preview at a time,
  and a record on the personal `sharghi.no` zone. Small router tweak.
- **C — self-signed / private-network** (Tailscale, `/etc/hosts`): fine for solo dev, not
  shareable.

Recommendation: **B** for a free, working MVP now; **A** if multiple concurrent public web
previews are wanted later.

## Context

The shipped `web` type serves a Vite dev server under a **path**: `/s/<shareId>/web/*`,
made to work by starting Vite with `--base=/s/<shareId>/web/` so every asset URL (and HMR)
sits under the share path. That base flag is the load-bearing trick, and it is
**Vite-specific**.

Frameworks that can't set their base path at runtime break this model:

- **Nuxt 2** (`Okam-AS/Web`, package `okam-consumer`) sets its base via `router.base` in
  `nuxt.config`, and runs webpack HMR at `/_nuxt/`. Its dev CLI is `nuxt-ts`, which does
  not understand `--base`.
- **Next.js** sets `basePath` in `next.config.js`.
- **CRA** hardcodes `/` unless `homepage`/`PUBLIC_URL` is set at build time.

Making these work path-based would require **editing tracked config files in the user's
checkout** — which deckhand must never do (borrow-never-own; see AGENTS.md). This plan
removes that requirement entirely.

## Core idea

Serve each web preview at the **root of its own subdomain** instead of under a path:

```
https://<shareId>.deckhand.sharghi.no/        →  http://127.0.0.1:<devPort>/
```

At root, the dev server needs **no base path** and **no config edit** for any framework —
its own absolute asset/HMR URLs (`/`, `/_nuxt/…`, `/@vite/…`, `/_next/…`) just work,
because they're already at root and the proxy forwards everything under the host.

### This is the direct answer to "don't push deckhand's local changes"

Subdomain mode makes deckhand-induced checkout edits **structurally unnecessary** — it
starts the dev server with host/port flags only and edits nothing in the tree. The
"never commit/push deckhand's local changes" guardrail (AGENTS.md) then has almost nothing
to guard: only gitignored dev-server caches remain, and even a stray lockfile is avoided
(`npm install --no-package-lock`, already shipped).

## Architecture

```
browser → https://<shareId>.deckhand.sharghi.no
   │  (wildcard DNS + Cloudflare edge cert for *.deckhand.sharghi.no)
   ▼
cloudflared named tunnel  (ingress: *.deckhand.sharghi.no → http://127.0.0.1:4300)
   ▼
deckhand server (127.0.0.1:4300)
   │  host-based router: shareId = subdomain label → find web preview → its dev-server origin
   ▼
http://127.0.0.1:<devPort>/   (the framework's dev server, bound loopback, no --base)
```

### 1. DNS + tunnel (ops, one-time)
- Add a **wildcard DNS** record for the tunnel: `*.deckhand.sharghi.no` (CNAME to the
  tunnel, same as the apex). Cloudflare issues an edge cert covering `*.domain`.
- **cloudflared ingress**: add a rule mapping `*.deckhand.sharghi.no` → `http://127.0.0.1:4300`
  (cloudflared supports wildcard hostnames in `ingress:`). The existing apex rule stays for
  MCP + path-based shares.
- Fold both into `deckhand init` (Phase 4) so setup stays "3 questions".

### 2. Host-based routing (server)
- New middleware/router keyed on the **Host header**: extract the leftmost label as the
  candidate `shareId`; if it resolves to a live **web** preview, reverse-proxy `/*` to that
  preview's dev-server origin (loopback). Otherwise 404.
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

### 5. Share auth by subdomain
- Password/unlock moves from a path cookie (`/s/<shareId>`) to a **host cookie** scoped to
  the **exact** `<shareId>.deckhand.sharghi.no` (never the wildcard domain — that would leak
  a cookie across shares). Serve a gate page on the subdomain before proxying.
- The 144-bit `shareId` in the subdomain is exactly as unguessable as in the path.

### 6. Viewer
- Two options (decide during build):
  - **(a) Subdomain serves the app directly** — no deckhand chrome, no iframe. Simplest;
    the "viewer" is just the app. Build/ready states shown by a lightweight interstitial
    served on the subdomain until the dev server answers.
  - **(b) Keep the calm viewer on the apex**, iframe `src=https://<shareId>.deckhand.sharghi.no/`.
    Preserves the building narrative + Rebuild button, at the cost of a cross-origin iframe.
- Recommendation: **(b)** for consistency with the device viewer, falling back to (a) if
  cross-origin iframe constraints (X-Frame-Options/CSP from the app) get in the way.

## Coexistence
- Keep path-based Vite hosting as the default for Vite (no infra needed, works today).
- Use subdomain hosting for non-Vite frameworks, or make it the default for all `web` apps
  once the DNS/tunnel is in place. A per-app `hosting: path | subdomain` (auto-selected by
  framework) keeps both live during migration.

## Security (maps to PLAN §11)
- **§11.1 loopback-only**: dev servers still bind `127.0.0.1`; the subdomain resolves to
  one preview's own loopback port (no SSRF/traversal). Only cloudflared is public.
- **§11.6 shares**: the whole origin is exposed (same posture as the path-based web proxy),
  gated by the 144-bit subdomain shareId (+ optional password). Cookie isolation per exact
  host is the new invariant to get right.
- **Borrow-never-own**: zero checkout edits — the whole reason for this model.

## Framework support matrix
| Framework | Path-based (today) | Subdomain (this plan) | Checkout edits |
|---|---|---|---|
| Vite | ✅ | ✅ | none |
| Nuxt 2 | ❌ (needs `router.base`) | ✅ (`-H/-p`) | none |
| Next.js | ❌ (needs `basePath`) | ✅ (`next dev -H -p`) | none |
| CRA / static | ❌ | ✅ (serve `dist/` at root) | none |

## Verification (when built)
- `deckhand app add okam-web --path /Users/asharghi/Okam/Web --type web` →
  `start_preview` → open `https://<shareId>.deckhand.sharghi.no/` → Nuxt app loads, HMR
  connects, `git -C /Users/asharghi/Okam/Web status` is **clean** (no tracked or stray
  changes). Same clean-tree assertion is the acceptance criterion.

## New-user onboarding (web hosting is OPT-IN, never required)

Not every deckhand install hosts web apps — a mobile-only install must never be
burdened with `webHost`/DNS. So web setup is strictly opt-in:

- **`deckhand init`** gains an optional, skippable step (design, not built): *"Host web
  apps on a public URL? (y/N)"* → only if yes, ask for the web host (a first-level host
  under a domain the user controls, e.g. `web.<their-domain>`), then wire it:
  `cloudflared tunnel route dns <tunnel> <webHost>`, add the ingress rule, write
  `webHost:` to config.yaml. Non-interactive: `--web-host <host>` (omit = no web hosting).
  A mobile-only user just skips it and nothing about web appears.
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
- **cloudflared wildcard ingress** exact syntax + whether the current tunnel token covers a
  new wildcard hostname (may need a DNS route add).
- **Cross-origin iframe** (option b): some apps send `X-Frame-Options: DENY`; may force
  option (a) for those.
- **Nuxt 2 webpack HMR** (sockjs/websocket at `/_nuxt/`) through the proxy — needs a real
  end-to-end check like the Vite `vite-hmr` one already done.
- **Cookie scoping** correctness across shares — the one genuinely new security-sensitive
  bit; test that a share-A unlock cookie is never sent to share B.
- Per-framework dev-run flags and detection surface (a small `webFramework` enum).
