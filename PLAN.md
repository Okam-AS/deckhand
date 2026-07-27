# Deckhand — Implementation Plan

> **Status: Phase 0 done (scaffold + green CI). This document is the single source of truth
> for building Deckhand.** It is written to be self-contained: an implementing agent should
> be able to build the whole product from this plan plus the reference docs in
> `docs/reference/`.

## 1. Vision

Deckhand is a single persistent server running on a Mac mini. It exposes an **MCP server**
(Streamable HTTP, reachable through a Cloudflare named tunnel) so that Claude — on claude.ai
web/mobile/desktop, in Claude Code, in Claude Routines, or any MCP client — can:

1. Boot iOS simulators and Android emulators running **any branch or PR** of pre-registered
   mobile-app repos (built locally on the mini from source).
2. Reply to the user with a **link**: one calm browser page showing all requested devices
   live, with full touch control, optionally password-protected.
3. See and drive the devices itself (`screenshot`, `describe`, `ui`) so it can verify the app
   is in the right state *before* handing over the link.

Canonical user story: *"Test the onboarding screens on iOS 26, iOS 27 and Android 14"* →
Claude calls `start_preview` with three devices, polls `preview_status`, navigates to the
onboarding screen with `ui`/`describe`, verifies with `screenshot`, then answers with the
viewer URL.

Deckhand deliberately does **not** have: a dashboard SPA, user accounts/login, OAuth (v1),
webhooks, a database, CI integration, WebRTC/TURN infrastructure, or any arbitrary-command
execution surface.

## 2. Locked decisions

These were decided with the product owner and are not open for re-litigation during
implementation:

| Area | Decision |
|---|---|
| Streaming (iOS) | **[serve-sim](https://github.com/EvanBacon/serve-sim)** (Apache-2.0, npm) — H.264-over-WebSocket decoded with WebCodecs, automatic MJPEG-over-HTTP fallback, input + accessibility tree + logs over the same helper. Free, no relay infrastructure, rides the tunnel as plain WSS/HTTPS. Captures via `simctl io` (a public Apple interface — survives new iOS runtimes as long as simctl does). Pin the npm version. |
| Streaming (Android, Phase 2) | **scrcpy-based** H.264-over-WebSocket. scrcpy (Genymobile) is the most battle-tested Android screen/input stack; an emulator is just an adb device. Whether to adopt `ws-scrcpy` or embed `scrcpy-server` behind a thin WS bridge is a **scoped Phase 2 evaluation** — both are free and tunnel-native. |
| NOT WebRTC/TURN, NOT SimDeck | An earlier revision of this plan used SimDeck + WebRTC relayed through Cloudflare TURN. **Rejected (2026-07-09):** TURN costs $0.05/GB and adds a credential/relay subsystem; SimDeck removed its WS transport (v0.1.31) and its display bridge rides private CoreSimulator APIs (unhedgeable risk against future Xcode); most of the predecessor project's operational scar tissue (display-heal ladder, daemon port cleanup, token discovery) was SimDeck-specific pathology. WS-carried H.264 has none of these problems: free, and exactly as firewall-proof as claude.ai itself. `docs/reference/simdeck-notes.md` is retained as historical context only. |
| App types (day one) | React Native (Expo **and** bare) + NativeScript. Flutter / plain-Xcode later. **Amended (2026-07-15): `web`.** A fourth app type hosts a **frontend web project** (a Vite dev server). It is unlike the mobile types: no device/simulator, **local-`path` only** (registered on the machine via `deckhand app add <id> --path <dir> --type web`, never over MCP), and the "preview" IS the running dev server — `start_preview` starts `npm run dev` as a long-lived process (reusing `DevProcessManager`, like NativeScript livesync) on a loopback port and reverse-proxies it through the share URL. Ready = the dev server answers HTTP 200 (no first-frame/screenshot; `screenshot` returns a clear error for web). The dev server is started with Vite's `--base=/s/<shareId>/web/ --host 127.0.0.1 --port <p>` so every asset URL (and HMR) sits under the share path. Vite-first; Next.js/others and git-based web previews are follow-ups. |
| Build strategy | Build locally on the mini: git worktree → install deps → native build. No CI artifacts. |
| Local dev mode + daily-loop contract | **Amended (2026-07-15):** an app may declare a local `path` (instead of, or alongside, `repo`). Local previews build **in place** in the developer's working copy — no worktree, no push — and NativeScript runs as a long-lived **livesync** process (`ns run --no-hmr`, watch on, HMR off — NS HMR is unreliable) so file saves reach the running sim with no tool calls. The loop rides in the tools themselves: `start_preview` is **idempotent** per (app, source, ref), share ids are **stable per app** (persisted; a bookmarked viewer URL never rots), and `restart_preview` rebuilds in place (git: fetch new tip + reset worktree; local: re-run) on the same booted devices. Consequence: named branches/PRs now **always fetch** (the old local-first shortcut served stale commits; SHAs remain local-first). Local previews trade snapshot determinism for the loop — the build mirrors whatever is on disk; the source dir is borrowed, never wiped (`npm ci` guarded) and never removed. Local apps are registered on the machine itself (`deckhand app add <id> --path <dir>`), not over MCP; owner-scoped tokens cannot touch repo-less apps. |
| Tunnel | `cloudflared` **named tunnel** with a stable hostname on the owner's Cloudflare-managed domain. Deckhand binds `127.0.0.1` only. |
| MCP auth (v1) | Per-person secret token in the URL path: `/mcp/<token>`. Roles `admin`/`member` in `tokens.yaml`. No OAuth yet — but isolate auth in one module so OAuth 2.1 (for Claude Enterprise org-wide connectors) can be added later without touching anything else. |
| GitHub access | **Minimal GitHub App** — permissions `Contents: Read-only` (optionally `Pull requests: Read-only`), **no webhooks, no OAuth, no callback URLs**. One App ID + private key PEM on the mini. Each repo org installs the app and picks repos. Hourly installation tokens, injected into git via ephemeral `GIT_ASKPASS`. The set of app installations *is* the repo allowlist. **Amended (2026-07-10):** a **fine-grained PAT** (`Contents: Read-only`, selected repos) is an equally supported auth mode — same tokenResolver seam, far less setup, and the mode agent-led onboarding (§6) walks new users through. The App remains the recommended path for multi-org installs. **Amended (2026-07-15): the access ladder.** Asking a user for a PAT when the machine can already read the repo is bad onboarding, so credentials resolve in order: PAT file → GitHub App → (if `githubAmbient`, default on) the deckhand user's **gh CLI session** (`gh auth token`, in-memory, same `GIT_ASKPASS` handling) → anonymous git (public repos; gated on `allowPublicRepos`) → the one-time setup URL as **last resort**. Explicit credentials always shadow ambient ones, so an App's installation set remains the allowlist. Before any of this, onboarding steers to a **local checkout** when one exists (§6). Ambient tradeoff recorded in §11.4. |
| Multi-org / multi-dev | The mini serves ~3 different repo orgs and several developers. Tokens support optional `owners: [...]` scoping. Fork PRs are rejected by default (per-app opt-in). |
| Viewer | One page (ours — not serve-sim's preview UI), multiple devices side by side, live video + **touch control on** (not view-only), public or password-protected share links. |
| Setup story | Setup on the mini will be performed **by an AI over SSH**. `AGENTS.md`/`CLAUDE.md` must be an agent runbook; `deckhand init` must be idempotent/resumable with non-interactive flags; `deckhand doctor` must prove the install works end to end. Target: only 3 human questions (GitHub App ID + PEM, tunnel hostname, MCP token holders). |
| State | No database. `config.yaml`, `apps.yaml`, `tokens.yaml` + a small `state.json` (atomic writes) for restart recovery. Previews are ephemeral. |
| Host | Apple Silicon Mac mini (serve-sim's helper binary is arm64-only). |

## 3. Architecture

```
claude.ai / Claude Code / Routines / any MCP client        share-link viewers (any browser)
        │ HTTPS                                                     │ HTTPS/WSS
        └──────────────────────┬────────────────────────────────────┘
                               ▼
        cloudflared named tunnel  (mate.<domain>  →  http://127.0.0.1:4300)
                               │
┌──────────────────────────────▼─── deckhand server (Node, 127.0.0.1:4300) ────────────────┐
│                                                                                           │
│  /mcp/<token>              MCP Streamable HTTP (stateless), ~11 tools, role-gated         │
│  /s/<shareId>              viewer page (our built static assets + preview metadata)       │
│  /s/<shareId>/dev/<id>/*   scoped proxy → that device's streaming helper                  │
│                            (video WS / MJPEG, input WS — nothing else)                    │
│                                                                                           │
│  auth ── mcp tools ── previewEngine ── deviceManager ── streaming backends                │
│              │              │                │                  │                         │
│         audit log     git worktrees     simctl / avdmanager   iOS: serve-sim helper       │
│                       + build recipes   + emulator + adb        (one per device, 3100+)   │
│                                                               Android (P2): scrcpy bridge │
└───────────────────────────────────────────────────────────────────────────────────────────┘

on-disk:  ~/.deckhand/{config.yaml, apps.yaml, tokens.yaml, github-app.pem, state.json,
                       secrets/<appId>.env, audit.jsonl, logs/}
          ~/.deckhand/repos/<appId>/          (base clone)
          ~/.deckhand/worktrees/<previewId>/  (detached worktree per preview)
```

One Node process owns everything; streaming helpers are small per-device child processes it
spawns and reaps. cloudflared runs as its own launchd service. Nothing but cloudflared is
reachable from outside the machine. **All video and input is plain HTTP/WebSocket riding the
tunnel** — if a network can reach claude.ai, it can view and control a preview. No STUN, no
TURN, no media leaving through any side channel.

## 4. Repository layout

```
deckhand/
├── PLAN.md                      # this file
├── README.md                    # human quickstart
├── AGENTS.md / CLAUDE.md        # agent guide (Phase 4 turns this into the setup runbook)
├── package.json                 # workspaces: server, viewer   (DONE — Phase 0)
├── server/
│   ├── src/
│   │   ├── cli.ts               # `deckhand` CLI entry: init, doctor, serve, token, app, env
│   │   ├── server.ts            # express app wiring: /mcp, /s, health
│   │   ├── config.ts            # load/validate config.yaml, apps.yaml, tokens.yaml (zod)
│   │   ├── auth.ts              # token lookup (sha256 map, timingSafeEqual), roles, owner scoping
│   │   ├── audit.ts             # append-only JSONL audit log
│   │   ├── mcp/
│   │   │   ├── index.ts         # McpServer + StreamableHTTPServerTransport (stateless)
│   │   │   └── tools/*.ts       # one file per tool
│   │   ├── engine/
│   │   │   ├── preview.ts       # Preview + PreviewDevice state machines, orchestration
│   │   │   ├── recipes.ts       # per-app-type command builders (expo / rn / nativescript)
│   │   │   ├── detect.ts        # app type + bundle id detection
│   │   │   ├── metro.ts         # Metro/Expo dev-server lifecycle (port 8081, env-signature keyed)
│   │   │   ├── worktree.ts      # clone, fetch ref/PR, detached worktrees, local-first resolution
│   │   │   ├── procs.ts         # spawn helpers: logging, idle watchdogs, kill trees
│   │   │   └── janitor.ts       # disk budget, orphan cleanup (incl. helpers)
│   │   ├── devices/
│   │   │   ├── ios.ts           # simctl: runtimes, create, boot(status), install, launch, delete
│   │   │   ├── android.ts       # (P2) sdkmanager/avdmanager, emulator boot, adb, pm path verify
│   │   │   └── toolEnv.ts       # JAVA_HOME / ANDROID_HOME / PATH resolution (see learnings doc)
│   │   ├── streaming/
│   │   │   ├── backend.ts       # the swappable interface (see §8)
│   │   │   ├── serveSim.ts      # iOS backend: spawn/track/kill serve-sim helpers, endpoints
│   │   │   └── scrcpy.ts        # (P2) Android backend
│   │   ├── github/
│   │   │   └── appAuth.ts       # App JWT → installation tokens (cache ~55m), askpass injection
│   │   ├── share/
│   │   │   ├── shares.ts        # shareId issuance, scrypt password, expiry, unlock cookies
│   │   │   └── proxy.ts         # scoped HTTP+WS proxy /s/:shareId/dev/:deviceId/* → helper
│   │   └── state.ts             # state.json atomic read/write, restart reconciliation
│   └── test/                    # node:test unit tests colocated by module
├── viewer/                      # Vite + React (scaffolded in Phase 0)
│   └── src/                     # single page: device grid, stream client, touch input, password gate
├── docs/reference/              # serve-sim-notes.md, auto-mate-learnings.md, simdeck-notes.md (historical)
├── fixtures/
│   └── expo-smoke/              # tiny Expo app used by doctor + integration tests
└── scripts/                     # dev/build helpers
```

Stack: Node ≥ 22, TypeScript, ESM. Key deps: `@modelcontextprotocol/sdk`, `express`, `zod`,
`yaml`, `ws` (proxy), `react`+`vite` (viewer only), `serve-sim` (pinned). **No database
driver.** Keep the dependency list ruthlessly short.

## 5. Configuration files (all under `~/.deckhand/`, created by `deckhand init`)

### config.yaml

```yaml
hostname: mate.example.com        # public hostname behind the named tunnel
port: 4300                        # loopback bind
streaming:
  serveSim:
    version: "x.y.z"              # exact npm pin, recorded by `deckhand init`
    codec: auto                   # auto = H.264 via WebCodecs; mjpeg = force fallback
    helperPortRange: [3100, 3199] # per-device helper ports (loopback only)
githubApp:                        # EITHER a GitHub App (multi-org)…
  appId: 12345
  privateKeyPath: ~/.deckhand/github-app.pem
# githubPat:                      # …OR a fine-grained PAT (single-owner; see §2 amendment)
#   path: ~/.deckhand/github-pat  # mode 0600, written via the one-time setup URL (§6) or SSH
githubAmbient: true               # no PAT/App → fall back to the deckhand user's gh CLI session (§11.4 note)
allowPublicRepos: false           # public repos from owners without an app installation; also
                                  # gates anonymous git for credential-less installs
limits:
  maxDevicesPerPreview: 4
  maxTotalDevices: 6
  idleMinutes: 45                 # auto-stop a ready preview after this long with no viewer traffic (0 = never)
  failedGraceMinutes: 15          # a failed preview keeps its devices this long, so Rebuild still works (0 = never)
  stuckMinutes: 90                # give up on a preview that has made no progress at all for this long (0 = never)
  reuseDevices: true              # pool simulators/AVDs by device shape instead of one throwaway per preview
  disk:                           # free-space tiers (GiB); at critical, refuse new previews
    watch: 50
    pressure: 35
    critical: 20
```

### apps.yaml (managed via `add_app` MCP tool or `deckhand app add` CLI)

```yaml
apps:
  - id: my-app
    repo: github.com/ainfrastructure/my-app
    type: expo                    # auto-detected: expo | react-native | nativescript
    defaultBranch: main
    allowForkPRs: false
    bundleId: com.example.myapp   # auto-detected, overridable
    env:                          # NON-secret build/runtime env only
      EXPO_PUBLIC_API_URL: https://staging.example.com
  - id: my-local-app              # local dev mode (§2 amendment 2026-07-15)
    path: /Users/dev/apps/my-app  # absolute; previews build IN PLACE (no worktree, no push)
    # repo: …                     # optional alongside path — ref/pr previews still work
    type: nativescript
  - id: my-app-rn                 # migration target (§6 migration features, 2026-07-18)
    path: /Users/dev/apps/my-app-rn
    type: react-native
    migratesFrom: my-local-app    # the SOURCE app it is being migrated from (must exist)
```

Secrets live in `~/.deckhand/secrets/<appId>.env` (mode 0600), set only via
`deckhand env set <appId> KEY=VALUE` on the mini (SSH). **No MCP tool reads or writes
secrets.** At build/launch, deckhand merges `apps.yaml env` + secrets env into the build,
Metro, and launch environments (see learnings doc: `EXPO_PUBLIC_*` must reach Metro *and*
the native build env).

### tokens.yaml

```yaml
tokens:
  - name: audun
    role: admin                   # admin: everything. member: preview lifecycle only.
    token: <64 hex chars>         # generated by `deckhand token add`
  - name: kari
    role: member
    owners: [ainfrastructure]     # optional: restrict to apps under these repo owners
    token: <64 hex chars>
```

Auth middleware: store `sha256(token) → entry` in memory; match by hashing the path segment
and `timingSafeEqual`. Unknown token → 404 (indistinguishable from wrong path). Every
tool call is appended to `audit.jsonl` (`{ts, tokenName, tool, args-summary, result}`).

## 6. MCP surface

Server: `@modelcontextprotocol/sdk` `McpServer` + `StreamableHTTPServerTransport` in
**stateless mode** (new transport per request, GET/DELETE rejected) mounted at
`/mcp/:token`. Tool input schemas in zod. Errors are returned as structured tool results
(`{ok: false, error: {code, message, hint}}`) — never bare exceptions — so Claude can relay
actionable messages ("missing credential for owner X — run `deckhand …` on the mini").

### The onboarding contract (Phase 3)

The MCP is **self-onboarding**: the agent connected to it must be able to take a
brand-new user from empty install to first preview *without having read this plan*. The
onboarding script lives in the tool responses; the agent is only the messenger. Rules:

1. **Empty states carry the next step.** `list_apps` with no apps registered returns
   `onboarding: {state: "no_apps", nextStep: "No apps registered. Ask the user which
   GitHub repos they want to preview, then call add_app for each."}`. `start_preview`
   against an unknown app returns the same structured redirect — never a bare "not found".
   Every `nextStep`/`hint` is written to be relayed to the user verbatim.
2. **`add_app` is the onboarding state machine.** Each failure names its stage and tells
   the agent exactly what to ask the user: private repo without credentials →
   `{error: {code: "github_auth_missing", hint: <exact PAT-creation steps>}, setupUrl}`;
   doctor-build gaps → `missing: [...]` where every item is a human-readable instruction
   ("Xcode not installed — …", "app needs env API_URL — set it at <setupUrl>").
   **Amended (2026-07-15): local checkout first.** The empty state and the
   `github_auth_missing` hint both open with the cheapest path: responses carry
   `host: {hostname, user}` (where deckhand runs) so a **co-located agent** — one whose
   own `hostname` matches — is instructed to look for an existing checkout, verify it
   (`git -C <dir> remote get-url origin`), and register it with
   `deckhand app add <id> --path <dir>` before any credential flow. Combined with the
   §2 access ladder, the PAT setup URL is what remains when everything cheaper failed.
3. **Secrets go around the chat, never through it.** When auth or secret env is needed,
   the tool mints a **one-time setup URL** — `/setup/<128-bit nonce>`, served through the
   tunnel, single-use, short TTL, bound to the pending action — where the user pastes the
   PAT / uploads the App PEM / sets secret env directly into the mini (written mode 0600).
   The agent guides step by step but never sees the secret; a token pasted into a chat
   transcript would outlive the conversation. This preserves §11.5 exactly.

Target first-contact conversation: user installs the connector and says "run my app" →
agent (from `list_apps` empty state) asks which repos → `add_app` → agent relays the
PAT instructions + setup link → user completes it → `add_app` re-run auto-detects type,
doctor-builds, reports `ready` → agent offers the first `start_preview`.

| Tool | Role | Input → Output |
|---|---|---|
| `list_apps` | member | → apps with `{id, repo, type, defaultBranch, lastDoctor}` |
| `list_devices` | member | → available iOS runtimes + device types (`simctl list -j`), Android API levels/system images (P2), current capacity vs `limits` |
| `start_preview` | member | `{app, ref?, pr?, devices?: [{platform: "ios"\|"android", runtime?, model?}], share?: {access: "public"\|"password"}}` → `{previewId, url, source, alreadyRunning, nextStep, devices: [...]}`. **Idempotent**: an equivalent live preview (same app+source(+ref)) is returned as-is with `alreadyRunning: true` — this is also how the agent answers "what's the link?". No ref/pr on a `path` app → local dev mode. Returns immediately; work continues async. |
| `restart_preview` | member | `{previewId?}` or `{app?}` → rebuild in place on the same booted devices, same shareId/URL. Local: re-run the livesync build (needed after native-level changes; ordinary edits livesync by themselves). Git: fetch the ref's new tip, reset the worktree, rebuild — the post-push step of the loop. |
| `preview_status` | member | `{previewId?}` or `{app?}` → per-device `{phase, detail, error?, logTail?}`; overall `{ready, url, source}` |
| `stop_preview` | member | `{previewId}` → teardown (devices deleted, worktree removed per policy; a local app's source dir is never touched) |
| `screenshot` | member | `{previewId, deviceId}` → MCP image content (PNG). iOS: `xcrun simctl io <udid> screenshot`; Android: `adb -s <serial> exec-out screencap -p` |
| `describe` | member | `{previewId, deviceId}` → accessibility tree. iOS: serve-sim's ax endpoint (token-efficient, built for agents); Android: `adb shell uiautomator dump` (parsed/compacted) |
| `ui` | member | `{previewId, deviceId, action}` where action ∈ `{tap {x,y}, type {text}, key {name}, button {name}, home, openUrl {url}}` (normalized 0..1 coords) — validated passthrough. iOS: serve-sim gesture/button/type commands; Android: adb input / scrcpy control |
| `logs` | member | `{previewId, deviceId?, source: "build"\|"metro"\|"app", tailLines?}` → text. `app` taps the streaming helper's forwarded simulator logs (serve-sim event-log) / adb logcat |
| `add_app` | admin | `{repo, type?}` → clone, detect, **doctor build** on a default device, structured report (`ready` or `missing: [...]`) |
| `remove_app` | admin | `{id, deleteCheckout?}` |
| `start_test_run` / `update_test_run` / `finish_test_run` | member | **Amended (2026-07-17):** agent-driven end-to-end testing. The agent (the brain) reports what it's testing — `{title, steps}`, per-step `running`/`passed`/`failed`, then a verdict + summary — surfaced live in the viewer as a calm spinner button + step popover. deckhand records; the agent writes the human report in chat. |
| `start_migration_preview` | member | **Added (2026-07-18):** `{target, devices?, share}` → (re)open the paired migration preview: boot the TARGET app next to its SOURCE (the `migratesFrom` app) on matching devices, and return one viewer link that renders old vs new side by side plus the parity ledger. Named `_preview` because a migration spans many sessions — this idempotently re-opens the same stable link, it does not "run" the migration. Source boots public; target takes the chosen access. Both booted via `start_preview` internally. |

**Amended (2026-07-17): `describe`/`ui` backend = SimDeck, control-only.** The 2026-07-09
rejection of SimDeck (row §2) was about its **video transport** (WebRTC/TURN); its
**control + inspection is decoupled from video** and is a much stronger `describe`/`ui`
backend than serve-sim-ax/uiautomator — especially for NativeScript (component tree, CSS
classes, and **.ts/.html source locations** via `@nativescript/simdeck-inspector`, an
opt-in). deckhand keeps serve-sim / adb-screencap for the human **video**, and drives
SimDeck **REST only** — `GET /accessibility-tree`, `POST /action`, `GET /screenshot.png` —
on the device it already booted (iOS by UDID, Android by `android:<avd>`). Two hard rules
(enforced in `server/src/testing/`): **never** touch SimDeck's `/input`/`/control` WS,
`/webrtc/offer`, or `/refresh` (they spin up the fragile private display/encoder session);
and auth via the **same-origin loopback** allowance, so deckhand holds **no SimDeck token**.
iOS HID can't type non-US text — non-ASCII `type` routes through the clipboard + paste.
`logs` (metro/app) remains a follow-up.

**Migration features (added 2026-07-18).** Deckhand can host a **NativeScript → React
Native** (or any app→app) migration as a *parity harness*, never a migration engine. Most
of the loop already works with existing tools (register both apps, `start_preview` each,
`describe`/`ui`/`screenshot` to inspect) — the agent is the comparator and the code
translator. Three small additions close the gap:
1. **`migratesFrom`** (apps.yaml field): the TARGET app declares the SOURCE app id it is
   migrating from. Cross-app-validated (source must exist, not self). Set via
   `deckhand app add … --migrates-from <source>` or `add_app`.
2. **Paired side-by-side view**: `shareState` gains an optional `pairedWith` block (the live
   source preview's shareId + sanitized devices) whenever a target's `migratesFrom` source
   is running. The viewer renders a second column reusing `DeviceFrame` against the source's
   shareId — **zero new proxy/stream code**; PIN caveat: v1 assumes the source preview is
   public (no cross-share unlock). `start_migration_preview` is the ergonomic entry point
   (named `_preview` — a migration spans many sessions, so it re-opens the paired preview
   idempotently rather than "running" a one-shot migration).
3. **Parity ledger**: an agent-maintained `deckhand.migration.yaml` in the TARGET repo root
   (`screens: [{name, status, note?}]`). Deckhand **reads** it from the target's checkout
   (bounded single-file read) and surfaces it as `shareState.ledger`; the viewer renders a
   calm checklist. It lives in the repo — version-controlled, reviewable — not in `state.json`.
   Deliberately NOT built (keeps the invariants clean): a mechanical screenshot/tree `compare`
   tool (the agent is multimodal — it judges), golden-snapshot capture (the source runs as a
   live oracle), and any persisted migration session (the pair derives from `migratesFrom` +
   the existing stable per-app shareIds). Boundary: deckhand runs and shows both apps and
   reads the ledger; the agent translates code, judges parity, and writes the ledger — and
   deckhand never writes to either repo (§11.4).

Validation rules enforced server-side (never trust the model): app must exist; ref/PR must
resolve in that app's repo; fork PRs rejected unless `allowForkPRs`; device count within
limits; disk tier not critical; token owner-scope honored.

## 7. Preview engine

### State machine

Per preview: `pending → running → ready → stopping → stopped` (or `failed`).
Per device: `pending → preparing → building → booting → installing-app → launching → ready | failed`.

Key orchestration rules (rationale in `docs/reference/auto-mate-learnings.md`):

1. **Build once per (app, ref, platform), install to N devices.** Three iOS devices of one
   preview share one build product; do not build three times.
2. **Overlap boot with prep** — `simctl bootstatus` costs ~40 s; run device boot concurrently
   with checkout + `npm ci` + pod/SPM resolution. Cold cost ≈ max(boot, prep), not the sum.
3. **Verify install by querying the device**, not by trusting CLI exit codes: poll
   `simctl get_app_container <udid> <bundleId>` (iOS) / `adb shell pm path <pkg>` (Android)
   in parallel with the install process.
4. **Per-stage idle watchdogs** on spawned processes (a general one, plus a shorter one for
   known-stall stages like SPM "Resolve Package Graph").
5. One concurrent install per worktree; guard with a set-before-await marker.
6. When a device reaches `ready`, its streaming helper is started (or confirmed healthy) and
   the first frame is verified **before** `preview_status` reports ready — never hand out a
   link that shows a black frame.

### Worktrees & git

- Base clone per app at `~/.deckhand/repos/<appId>`; per-preview detached worktree
  (`git worktree add --detach`) at `~/.deckhand/worktrees/<previewId>/`.
- Branch ref: `git fetch origin <branch>`; PR ref: `git fetch origin refs/pull/<N>/head:…`
  (works for fork PRs from the base repo — no fork access needed).
- **Named refs always fetch** (amended 2026-07-15; the old local-first shortcut made a
  repeat preview of a branch build the previous push). Only commit SHAs — immutable, and
  unfetchable by refspec — resolve local-first with no network and no token.
- `restart_preview` (git): fetch + `git reset --hard <new tip>` inside the existing
  worktree — untracked build artifacts survive, so the rebuild is warm.
- **Local source (dev mode)**: a `path` app skips all of the above — the preview builds
  in the developer's working copy in place. The dir is borrowed, never owned: teardown
  never removes it, and dependency install is guarded (`node_modules` present → skipped;
  a worktree-style `npm ci` would wipe it). One live preview per local app, one device
  per platform (the livesync process targets a single device).
- Tokens via ephemeral `GIT_ASKPASS` script (username `x-access-token`), `GIT_TERMINAL_PROMPT=0`,
  temp script removed in `finally`. Tokens must never appear in remote URLs, `.git/config`,
  argv, or logs.
- `git submodule update --init --recursive` after checkout (token resolver invoked lazily,
  only when `.gitmodules` exists).

### Build recipes (initial set — exact commands, pitfalls in the learnings doc)

| Type | iOS | Android (P2) | Launch |
|---|---|---|---|
| **expo** | `npx expo run:ios --device <udid> --no-bundler` | `npx expo run:android --device <serial> --no-bundler` | Start Metro (`npx expo start --dev-client --localhost --port 8081`, **never `--clear`**), pre-approve URL scheme in sim plist, open `exp+<slug>://expo-development-client/?url=…&disableOnboarding=1` |
| **react-native** (bare) | guarded `pod install` (skip when `Podfile.lock` == `Pods/Manifest.lock`), then `npx react-native run-ios --udid <udid> --mode Release --no-packager` | `npx react-native run-android --deviceId <serial>` | `simctl launch` (Release embeds the JS bundle; no Metro) |
| **nativescript** | pre-resolve SPM out-of-band, then `ns run ios --no-hmr --no-watch --justlaunch --device <udid>` | `ns run android --no-hmr --no-watch --justlaunch --device <serial>` | ns launches as part of run |

Dependency install: `[ -f package-lock.json ] && npm ci || npm install`, skipped when a
`node_modules` marker is newer than the newest manifest/lockfile.

Metro: fixed port 8081, one server reused across previews of the same app, keyed by an
env-signature; restart only when env changes or health (`GET /status`) fails. Env:
`REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1`, `CI=1`.

### Devices

- **iOS**: enumerate `xcrun simctl list runtimes devicetypes -j`, then `simctl create` +
  `boot` + `bootstatus -b`. serve-sim attaches to any booted simulator. Naming and teardown
  follow the pooling rules below (a per-preview `deckhand-<previewId>-<n>` device, deleted on
  teardown, only when `limits.reuseDevices` is off).
- **Android (P2)**: enumerate installed system images (`sdkmanager --list_installed`); create
  AVD via `avdmanager create avd --force --name Deckhand_<...> --package <sysimg>`; **deckhand
  boots the emulator itself**: `emulator -avd <name> -no-audio -no-boot-anim` (headless flags
  per the P2 evaluation; keep GPU on for rendering), wait for `adb wait-for-device` +
  `sys.boot_completed=1`. The serial is deterministic from the console port deckhand assigns
  (`emulator-<port>`). Install with `ANDROID_SERIAL=<serial>`.
- Tool env resolution (JAVA_HOME/ANDROID_HOME/PATH) is fiddly on macOS — port the approach
  described in the learnings doc.

### Streaming diagnostics — the `stream` log source (amendment 2026-07-27)

A viewer stuck on "Connecting…" was the hardest failure to debug remotely: the device
reports `ready` (deckhand saw a first frame), the proxy answered a bare 404/502 with no
message, `catch {}` swallowed every error, and the browser reported nothing at all. An
agent on the machine had no thread to pull.

Every device now carries a fourth log source, **`stream`**, readable via the `logs` MCP
tool — the browser→device path end to end:

- **attach**: helper URL and how long attach took; each first-frame probe and its outcome.
- **proxy**: every stream request with its upstream status, duration and byte count; when a
  request cannot be routed, *which* of the three reasons applied (no live preview / no such
  device, with the ids that do exist / no attached stream); helper-unreachable errors with
  their errno.
- **WebSocket**: upgrades accepted, and refusals with the exact gate that rejected them
  (a destroyed upgrade is indistinguishable from a network fault in the browser).
- **viewer**: the player POSTs its own turning points to `…/dev/<id>/clientlog` — transport
  chosen, MJPEG fallback and why, connection lost, giving up. Validated and length-capped
  server-side, bounded per player, and behind the same PIN gate as the rest of the share.

Rules: diagnostics never fail the request they explain (every trace call is wrapped), and
they carry no secrets — no tokens, no cookies, no PINs, no request bodies (§11).

### Device lifecycle — pooling + auto-teardown (amendment 2026-07-27)

Devices used to be created per preview and released only by an explicit `stop_preview`.
Two holes followed, and both were observed on the dev Mac (4 booted simulators, 9 AVDs,
4 emulator processes — for **one** live preview):

1. **Nothing survives a restart, and nothing collected the leftovers.** A crash or a plain
   `deckhand serve` restart orphaned every booted simulator, emulator and serve-sim helper.
   `staleOnBoot()` was written for this and never called.
2. **Nothing ever expired.** A preview nobody watched, or one that failed to build, held its
   devices forever — and failed previews were counted as using *zero* devices, so capacity
   never pushed back.

The contract now:

- **Reap on boot** (`engine/reaper.ts`, called from `listen()` before binding): deckhand binds
  a single loopback port, so exactly one server runs at a time and every `deckhand-…` device on
  the machine at startup is by definition an orphan. Helpers are killed first (`serve-sim <udid>`;
  emulators by their `-avd` argument, since orphans collide on console port 5554), then the
  device is shut down. Devices the developer created themselves are never touched.
- **Pooled devices** (`limits.reuseDevices`, default on) are named by *shape*, not by preview:
  `deckhand-pool-<model>-<runtime>` / `deckhand_pool_<profile>_api<n>`. They are shut down on
  teardown and kept on disk for the next preview of that shape (concurrent previews of one shape
  get `…-2`, `…-3` — reused across previews, never shared by two at once). A pooled device is
  factory-reset (`simctl erase` / `emulator -wipe-data`) only when it changes hands — including
  after a restart, when the tenant map is gone. The pool is trimmed to `maxTotalDevices`.
- **Auto-teardown** (janitor, 60 s): a `ready` preview with no viewer traffic for
  `limits.idleMinutes` is stopped; a `failed` one is torn down after `limits.failedGraceMinutes`,
  which keeps the viewer's Rebuild button working on a broken build; one that has made no
  progress at all for `limits.stuckMinutes` is collected as wedged (it is neither ready nor
  failed, so nothing else would ever reclaim it). Viewer polls, proxied requests — including
  the subdomain-web host resolver, which has no viewer page behind it — and per-preview
  `preview_status` calls count as traffic; `list()` deliberately does not, or one agent's
  enumeration would keep every idle preview alive. Each sweep takes 0 to disable.
- **Capacity counts what is actually booted**: devices holding a handle (a failed preview's
  included, since they stay booted for the grace window) plus teardowns still in flight. A
  preview that failed during clone or build never booted anything and must not consume a slot.
- **`failed` is terminal for a device.** A step still in flight when the device fails (a boot
  racing a failed checkout) must not write its phase over it — that left previews stuck in
  `running` forever, invisible to every sweep. Only an explicit restart resets it.

## 8. Streaming backends (the swappable layer)

The streaming layer is deliberately a **thin, swappable seam**. Nothing outside
`server/src/streaming/` may import a backend directly; the engine, proxy, and MCP tools see
only this interface:

```ts
interface StreamingBackend {
  // Attach to an already-booted device; idempotent. Resolves when the stream
  // endpoint is up and has produced a first frame.
  attach(device: { platform: "ios" | "android"; udid: string; serial?: string }): Promise<AttachedStream>;
}
interface AttachedStream {
  endpoints: {
    video: { kind: "h264-ws" | "mjpeg-http"; path: string };  // proxied, never public
    input: { kind: "ws"; path: string };
  };
  describe(): Promise<string>;      // token-efficient a11y tree
  logsTail(lines: number): Promise<string>;
  detach(): Promise<void>;          // kill helper, release port
}
```

### iOS backend: serve-sim (Phase 1)

Full API notes in `docs/reference/serve-sim-notes.md` — read them before implementing.
Essentials:

- Deckhand installs the **pinned** npm package and spawns **one helper per device**
  (`serve-sim --no-preview -q -p <port> <device>` or via its documented middleware/embedding
  API — implementer's choice; prefer whichever makes deckhand own the child process
  lifecycle directly). Helpers bind loopback ports from `helperPortRange`; deckhand tracks
  pid/port per udid and reaps on detach. serve-sim also keeps a state file under
  `$TMPDIR/serve-sim/` and supports `--list`/`--kill` — the janitor uses these to find and
  kill **orphans** after crashes.
- Video: H.264 over WebSocket decoded with WebCodecs when the browser supports it
  (`codec: auto`), with automatic **MJPEG-over-HTTP fallback** (`stream.mjpeg`) — this
  replaces any hand-rolled screenshot-poll degradation; it is built in.
- Input: pointer/keyboard over the helper's WebSocket control channel (plus CLI commands
  `gesture`/`button`/`type`/`rotate` used by the `ui` MCP tool).
- `describe`: serve-sim's accessibility endpoints (`ax`); `logs`: its forwarded simulator
  log/event stream.
- When embedding/proxying: wire WS `upgrade` handling and forward `X-Forwarded-Proto` so
  helper URLs come out `https`/`wss` behind the tunnel (documented requirement; without it
  the page mixes content and input dies).

### Android backend — decision-gate outcome (2026-07-09)

The gate (ws-scrcpy vs embedded scrcpy-server vs …) resolved to: **ship an adb-based backend
first, keep scrcpy H.264 as a documented follow-up upgrade behind the same seam.** Reason:
scrcpy's raw H.264 wire protocol is version-specific and needs extensive on-device iteration
to get right, which cannot be validated without a live emulator — too much risk for the
initial cut. The shipped `streaming/androidAdb.ts` (`AndroidAdbBackend`):

- serves **`adb exec-out screencap -p` as a multipart PNG stream** on a loopback port — which
  **reuses Deckhand's existing viewer verbatim** (the MJPEG parser slices by Content-Length;
  `createImageBitmap` decodes PNG), so no new viewer code and zero scrcpy-protocol risk;
- carries touch over the **same `/ws` protocol** (`[0x03][JSON {type,x,y}]`) translated to
  `adb shell input tap/swipe` (normalized → device pixels via `wm size`);
- provides `describe` via `uiautomator dump`.

It is lower-fidelity than scrcpy H.264 (a few fps, not 60), and is honestly labeled as the
initial Android path — **not** the "screenshot polling is never primary" rule that applies to
iOS (where serve-sim gives real H.264). scrcpy H.264 (embedded `scrcpy-server` + a thin WS
bridge, decoded Annex-B in the viewer) is the planned smoothness upgrade; because backends
sit behind `StreamingBackend`, adding it changes nothing outside `streaming/`.

`describe` / agent-grade input come from adb independent of the video path either way.

### Proxy contract

`/s/:shareId/dev/:deviceId/*` forwards **only** the backend's declared `video` and `input`
endpoints — and only for device IDs belonging to that share's preview. The proxy buffers
early client WS messages while the upstream connects, mirrors both directions, and maps
close codes safely (never forward 1005/1006/1015; use 1011). Helpers are loopback-only;
the proxy is the sole path in, with share auth enforced at upgrade time.

**Web proxy (2026-07-15 amendment).** A web preview is served under
`/s/:shareId/web/*` — a **wildcard** reverse proxy (a dev server serves arbitrary
paths, unlike the four-subpath device allow-list), plus a WebSocket branch under the
same base for Vite HMR (the `vite-hmr` subprotocol is echoed and forwarded). This
deliberately **inverts** the device proxy's narrow-allow-list posture (§11.6): the whole
dev-server origin is exposed, gated only by the 144-bit `shareId` (+ optional password).
Every other invariant holds — the upstream is strictly **that share's own loopback
dev-server port** (resolved via `findByShareId`; no SSRF to sibling ports, no path
traversal), `X-Forwarded-Proto: https` is preserved (so Vite emits `wss://` HMR behind
the tunnel), and the web preview is idle-reaped and torn down like any other (the source
dir is never touched).

## 9. Viewer & share links

### Share model

- `start_preview` issues a `shareId` = `crypto.randomBytes(18).toString("base64url")`.
- `access: "public"` → the 144-bit URL is the gate. `access: "password"` → deckhand
  generates a human-friendly password (or accepts one), stores `scrypt(password, salt)`,
  and the viewer shows a password gate; successful unlock sets an HMAC-signed, expiring
  cookie scoped to `/s/<shareId>`. WS upgrades validate the same cookie (or `?password=`,
  which is stripped before any proxying).
- **Amended (2026-07-16): numeric PIN protection (shipped).** `share.access` on
  `start_preview` is `"public" | "pin"` and is **required** — the tool fails
  (`needs_access_choice`) until the agent has asked the user, so every link is a
  deliberate PIN-or-public choice. A `pin` is 4–6 numeric digits (user-chosen), stored
  per app as `scrypt(pin)` in `state.json`'s `pins` map (persisted, so a bookmarked
  protected URL stays protected across restarts). `set_pin` adds/changes/removes the PIN
  on a live preview later (same URL). The gate: content routes (`/dev`, `/web`, `/restart`,
  the subdomain-web proxy) and both WS upgrades require a valid HMAC unlock cookie
  (`deck_unlock`, signed with an auto-generated `~/.deckhand/share-secret`); `/state` +
  `/unlock` + the viewer shell stay public. `/unlock` is throttled per share (lockout after
  N wrong PINs). The viewer shows an elegant pad (auto-submits on the last digit, shakes on
  a wrong code); subdomain-web hosts get a self-contained vanilla pad since they have no
  React viewer. **Deliberate §11.5 relaxation:** the user chose to set the PIN by telling
  the agent (through MCP) rather than an out-of-band setup URL — so a share PIN (a low-value,
  shareable access code, not a standing bearer credential) may travel through MCP. It is
  **redacted from the audit log** (`summarizeArgs`), never stored in plaintext, and the tool
  descriptions tell the agent not to echo it in chat. The one-time-setup-URL path (§6) stays
  the option for zero PIN exposure.
- Share dies with the preview (`stop_preview`) → viewer shows a calm
  "this preview has ended" state.

### Stream client (ours, in `viewer/`)

- **H.264-over-WS + WebCodecs `VideoDecoder`** painted to a canvas, matching serve-sim's
  own client. Vendor/adapt serve-sim's client utilities where practical (Apache-2.0 with
  attribution): `avcc-codec.ts`, `avcc-fallback.ts`, `mjpeg-frame-parser.ts`, `hid.ts`.
  Do not invent a new wire format — speak exactly what the helper serves.
- Apply the battle-tested, transport-agnostic behaviors from
  `docs/reference/auto-mate-learnings.md` §2: feed no deltas before a true IDR, monotonic
  decode timestamps, decode-backlog reset (queue > 2 → reinit + keyframe), rAF-painted
  single pending frame (close superseded frames), IntersectionObserver + visibilitychange
  gating (no decode when hidden), first-frame watchdog with bounded auto-recovery, and a
  single `disposed` flag guarding every async callback.
- **MJPEG fallback**: if WebCodecs is unavailable or H.264 fails repeatedly, switch to the
  helper's MJPEG stream (visibly labeled as reduced quality), keep input working, and retry
  H.264 in the background.

### Input

Normalized 0..1 coordinates with **letterbox correction** (canvas aspect vs DOM box) — see
learnings §2. Realtime pointer events over the helper's input/control WS, moves throttled
via rAF (latest-only), reconnect at ~350 ms. Keyboard forwarded when the canvas is focused.
Never send raw scroll events; use short touch drags.

### Design values

The page must feel **calm, airy, and reassuring** — like being in the clouds. Soft motion,
gentle staggered reveals, subtle depth and blur, rounded surfaces, low-contrast boundaries.
No dashboard chrome, no card sprawl: device frames on a quiet background, app name + ref,
per-device runtime label, and an unobtrusive status while building (phases as a soft
progress narrative, not a spinner wall). Mobile-first: one device per viewport width on
phones, side-by-side grid on desktop. Hide secondary controls until needed; every state
change eases in/out — nothing snaps.

## 10. Ops CLI, tunnel, services

`deckhand` CLI subcommands (same binary as the server):

- `deckhand init` — **idempotent and resumable**: detects what is already configured, does
  the next missing step, prints what remains. Non-interactive flags for everything:
  `--github-app-id`, `--github-app-pem <path>`, `--hostname`, `--port`. Steps: create
  `~/.deckhand`, write configs, install + **pin** serve-sim (record exact version in
  config), verify Xcode/simctl (and, P2, Android toolchains), configure cloudflared named
  tunnel (`cloudflared tunnel create deckhand`, DNS route `<hostname>`, config ingress →
  `http://127.0.0.1:4300`), install launchd plists (deckhand + cloudflared), generate first
  admin token.
- `deckhand doctor` — the verification loop, each check independently reportable:
  toolchains present (xcodebuild, simctl, node; P2: java, sdkmanager, adb, emulator),
  serve-sim helper spawns for a booted sim + **stream WS upgrades + a first frame decodes**
  (the real "will video work" check), GitHub App JWT mints and each installation returns a
  token, tunnel answers **from the public hostname**, disk tier, and a full smoke test:
  boot a sim, build+install `fixtures/expo-smoke`, screenshot, teardown. Exit non-zero on
  any failure.
- `deckhand serve` — run the server (what launchd invokes).
- `deckhand token add|revoke|list`, `deckhand app add|remove|list`,
  `deckhand env set|unset <appId> KEY[=VALUE]`, `deckhand service install|status|restart`.

## 11. Security model (recap, enforced in code)

1. **Reachability**: deckhand and every streaming helper bind loopback; only cloudflared is
   exposed; TLS at Cloudflare's edge. No tokenless code path exists at all.
2. **MCP auth**: per-person 256-bit path tokens, hashed lookup, constant-time compare,
   404 on miss, roles + optional owner scoping, JSONL audit of every call.
3. **Capability bounding**: no arbitrary shell tool; only registered apps; only refs in
   those repos; fork PRs opt-in; device-count + disk-tier limits.
4. **GitHub**: App with Contents:Read-only — deckhand can never write to any repo. Hourly
   installation tokens, never persisted, never in argv/URLs/logs. **Ambient-credential
   note (2026-07-15):** with `githubAmbient` (no PAT/App configured, `gh` logged in on
   the machine) the borrowed session token usually carries write scopes, so read-only
   becomes a behavioral guarantee (deckhand only ever runs read operations) rather than
   a capability-bounded one. Fine for a dev Mac; on a shared mini configure a PAT/App
   (which shadow ambient) or set `githubAmbient: false`.
5. **Secrets**: app secrets never through MCP or the viewer. Two write channels only:
   SSH CLI, or the one-time setup URL (§6 onboarding contract — 128-bit single-use nonce,
   short TTL, direct browser→mini). Both land as mode-0600 files; the MCP/agent side sees
   only "configured: yes/no".
6. **Shares**: 144-bit IDs, scrypt passwords, signed unlock cookies, password stripped
   before proxying, shares die with their preview. The proxy exposes only video+input for
   the share's own devices — serve-sim's other endpoints (camera, devtools, exec) are never
   forwarded. **Web previews (2026-07-15) are the deliberate exception:** a `web` app's
   share proxies the whole dev-server origin (a dev server serves arbitrary paths), so the
   144-bit `shareId` (+ optional password) is the gate rather than a narrow allow-list. The
   upstream is confined to that share's own loopback dev-server port (no SSRF/traversal),
   still binds `127.0.0.1`, and is still idle-reaped — see §8 "Web proxy".
7. **Host hygiene** (documented in runbook, not code): dedicated macOS user, no personal
   credentials on the machine, FileVault on.

## 12. Implementation phases

Work top to bottom; each phase ends with its acceptance test passing. Commit in small
reviewable units; keep `npm test` green throughout.

### Phase 0 — Scaffold ✅ (done)
Workspaces (`server`, `viewer`), TypeScript strict ESM, `node:test` + `npm test`,
GitHub Actions CI (typecheck + unit tests on macOS runner). CI is green.

### Phase 1 — Core loop, iOS, single device (the big one)
1. `config.ts`, `auth.ts`, `state.ts`, `audit.ts` (+ unit tests).
2. `github/appAuth.ts`: App JWT → installation token, 55-min cache, askpass wrapper.
3. `worktree.ts` + `detect.ts` + `recipes.ts` (expo, react-native, nativescript — command
   builders unit-tested as pure functions).
4. `devices/ios.ts` + `streaming/backend.ts` + `streaming/serveSim.ts` (spawn, first-frame
   probe, detach, orphan kill).
5. `engine/preview.ts`: single-device pipeline with boot/prep overlap, install verification
   polling, watchdogs, log capture.
6. MCP server with `list_apps`, `list_devices`, `start_preview` (1 iOS device),
   `preview_status`, `stop_preview`, `screenshot`.
7. Viewer page: one device, H.264-WS WebCodecs client (vendored serve-sim client utils) +
   MJPEG fallback + touch input, public share, proxied end to end.
8. Manual tunnel setup documented; `deckhand serve` + minimal `deckhand doctor` (toolchains
   + serve-sim first-frame + GitHub checks).
**Done when:** from claude.ai with the connector configured, "start a preview of
`<app>` branch `<x>`" yields a link that streams and accepts touch **from a phone outside
the LAN**, `preview_status` reports phases truthfully, `stop_preview` tears down cleanly
(no orphan helpers, sims, or worktrees), and a failed build surfaces a useful `logTail`
through `preview_status`.

### Phase 2 — Multi-device + Android
Build-once-install-many; parallel per-device pipelines; **scrcpy decision gate** (timeboxed
eval: ws-scrcpy vs embedded scrcpy-server + WS bridge — pick by maintenance, embed-ability,
input latency) → `streaming/scrcpy.ts`; `devices/android.ts` (AVD create, emulator boot,
serial from console port, pm-path verify, uiautomator describe); runtime/model selection in
`start_preview`; viewer device grid with per-device labels/status.
**Done when:** one `start_preview` call with iOS 26 + iOS 27 + an Android emulator produces
a single page with all three live and controllable; total wall-clock ≈ slowest device, not
the sum.

### Phase 2.5 — Local dev mode + daily-loop contract ✅ (done 2026-07-15, user-directed)
Pulled forward ahead of Phase 3 (§2 amendment 2026-07-15): app `path` source; in-place
builds with guarded deps; NativeScript livesync dev process (`engine/devProcess.ts`);
named refs always fetch (stale-branch fix) + `updateWorktree` (fetch + reset for warm
git restarts); idempotent `start_preview`; persisted per-app stable share ids;
`restart_preview` tool (+ status/restart by app id); viewer Rebuild button via
rate-limited `POST /s/:shareId/restart` (local shares only); `deckhand app add --path`
with dir-based type/bundle-id detection.
**Done when (met):** unit + e2e tests cover the loop: start → edit (livesync, no calls) →
restart-in-place → same URL after stop/start and server restart; teardown never touches
the source dir.

### Phase 3 — Sharing + agent control + governance + onboarding
Password shares (scrypt + signed cookie + WS gate — shipped as a numeric PIN gate);
`describe`, `ui`, `logs` tools; `add_app`/`remove_app` with doctor-build report;
(**dropped 2026-07-17, user-directed:** the idle reaper + share `expiresAt` — previews
end on `stop_preview`, not on an idle timer; the `idleTeardownMinutes` config knob was
removed too. Don't reintroduce automatic idle teardown without a new decision.)
**the onboarding contract (§6)**: empty-state `nextStep`s, agent-relayable `add_app`
failure instructions, PAT auth mode, one-time setup URL for secrets;
token roles + owner scoping enforced; audit log complete.
**Done when:** a password link works on a device that has never seen the app; a member
token cannot call `add_app` nor touch apps outside its `owners` scope; Claude can navigate
an app to a named screen using only `describe`/`ui`/`screenshot`; **and a fresh agent
given only the MCP token takes a new user from zero apps to a ready preview of a private
repo — asking the user for repo choice and PAT via the setup link — without SSH and
without any secret appearing in the conversation.**

### Phase 4 — Ops hardening + the AI runbook
Full `deckhand init` (idempotent, flags, tunnel + launchd install); full `deckhand doctor`
(incl. public-hostname check + smoke test); `janitor.ts` (disk tiers, orphan worktrees,
stale sims/AVDs, **orphan streaming helpers** via serve-sim `--list`/`--kill` + pid
tracking, `simctl delete unavailable` ≤1/24 h); helper-restart escalation (stream unhealthy
→ kill + respawn helper, then recreate device — cheap, no global daemon to heal); GitHub
App installation health warnings; **rewrite `AGENTS.md`/`CLAUDE.md` as the setup runbook**:
preflight checks with exact verification commands (incl. Apple Silicon check), ordered
steps, explicit ask-the-user-only-when rules (target: 3 questions), and "finish =
`deckhand doctor` green".
**Done when:** a fresh agent given only SSH access and the repo URL completes setup asking
≤3 questions, and `deckhand doctor` passes including the public smoke test.

### Phase 5 (later, explicitly out of scope now)
Warm device pool (pre-booted bare devices, ~40 s saved per preview), OAuth 2.1 for Claude
Enterprise org-wide connector rollout, Flutter + plain-Xcode recipes, artifact-based builds.
**Per-share subdomain hosting for non-Vite web frameworks** (Nuxt 2, Next.js, static) so
they can be hosted with zero checkout edits — design in
[docs/web-wildcard-hosting-plan.md](./docs/web-wildcard-hosting-plan.md).

## 13. Testing strategy

- **Unit** (`node:test`, colocated): recipe command builders, config/token validation, auth
  (timing-safe, role gates), share password + cookie logic, worktree ref resolution
  (local-first), GitHub App JWT shape, proxy path scoping, backend interface conformance.
  These run in CI on every push.
- **Integration (mac-only, opt-in `npm run test:device`)**: against a real booted simulator:
  serve-sim helper attaches and yields a decodable first frame, screenshot non-empty, input
  tap acknowledged, teardown leaves no sims/worktrees/helpers behind.
- **`deckhand doctor`** is the permanent end-to-end test — keep it honest and fast.
- Every bug fixed gets a regression test in the closest layer.

## 14. Known risks / open investigations

| Risk | Mitigation |
|---|---|
| serve-sim is a young project | Apache-2.0 and small: vendor/fork if abandoned. It rides public `simctl` interfaces (not private frameworks). The backend seam (§8) makes replacement a contained change; our viewer client is ours. |
| serve-sim helper is arm64-only | Locked decision: Apple Silicon mini. Runbook preflight checks `uname -m == arm64`. |
| Android wrapper choice (ws-scrcpy vs embed scrcpy-server) | Timeboxed Phase 2 decision gate with explicit criteria; both options are free and satisfy the same backend interface; scrcpy itself is Genymobile-maintained and battle-tested. |
| New iOS runtimes (e.g. iOS 27 beta) break capture | Lower risk than private-API bridges (simctl is the public seam), but verify on beta Xcode early; `doctor` smoke test catches it. |
| Helper process sprawl / orphans after crashes | Deckhand owns child pids; janitor sweeps via pid table + serve-sim state file (`--list`/`--kill`). Integration test asserts zero leftovers. |
| Streaming lots of video through Cloudflare Tunnel | Free tier is fine for a small team's dev usage; not a 24/7 broadcast workload. If it ever grows, revisit (self-hosted relay or Tunnel paid plan) — the backend seam keeps this a config problem. |
| First build of a real app fails on missing secrets/registries | `add_app` doctor-build reports exactly what's missing; secrets flow via one-time setup URL or SSH (§6/§11.5). |
| Long cold builds (2–5 min) feel broken in chat | `start_preview` returns immediately; `preview_status` gives phase-level truth; viewer shows the same phases calmly. |
| Disk exhaustion from worktrees/DerivedData | Janitor tiers + refuse-new-work threshold (simple free-space check already in Phase 1). |

## 15. Reference material

- `docs/reference/serve-sim-notes.md` — serve-sim's CLI, endpoints, embedding/middleware
  API, state file, and constraints, as verified from its source. **Read before implementing
  `streaming/serveSim.ts` or the viewer client.**
- `docs/reference/auto-mate-learnings.md` — distilled implementation knowledge from the
  predecessor project (build recipes, 14 concrete pitfalls, transport-agnostic stream-client
  behaviors, share/proxy patterns, git/worktree mechanics). **Read before implementing the
  engine or the viewer.**
- `docs/reference/simdeck-notes.md` — **historical only**: notes on SimDeck, the previously
  planned device layer, kept for context on why it was rejected.
- serve-sim source: `git clone --depth 1 https://github.com/EvanBacon/serve-sim.git` —
  especially `packages/serve-sim/src/client/` (stream client to vendor) and
  `packages/serve-sim/README.md` (embedding, proxy, X-Forwarded-Proto).
- scrcpy: https://github.com/Genymobile/scrcpy (Phase 2).
- The predecessor repo (`auto-mate`) may exist at `~/auto-mate/auto-mate` on the dev
  machine; file references in the learnings doc point into it. It is a reference only —
  **do not import code or patterns wholesale; this project stays small.**
