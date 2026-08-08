# Deckhand — Implementation Plan

> **This document is the single source of truth for what Deckhand IS** — locked decisions,
> architecture, the MCP surface, the streaming seam, the security model. It is not a build
> order. Read it with the reference docs in `docs/reference/`.

## 1. Vision

Deckhand is a single persistent server running on a Mac mini. It exposes an **MCP server**
(Streamable HTTP, reachable through a Cloudflare named tunnel) so that Claude — on claude.ai
web/mobile/desktop, in Claude Code, in Claude Routines, or any MCP client — can:

1. Boot iOS simulators and Android emulators running **any branch or PR** of pre-registered
   mobile-app repos (built locally on the mini from source).
2. Reply to the user with a **link**: one calm browser page showing all requested devices
   live, with full touch control, optionally PIN-protected.
3. See and drive the devices itself (`screenshot`, `describe`, `ui`) so it can verify the app
   is in the right state *before* handing over the link.

Canonical user story: *"Test the onboarding screens on iOS 26, iOS 27 and Android 14"* →
Claude calls `start_preview` with three devices, polls `preview_status`, navigates to the
onboarding screen with `ui`/`describe`, verifies with `screenshot`, then answers with the
viewer URL.

Deckhand deliberately does **not** have: a dashboard SPA, user accounts/login,
webhooks, a database, CI integration, WebRTC/TURN infrastructure, or any arbitrary-command
execution surface.

## 2. Locked decisions

These were decided with the product owner and are not open for re-litigation during
implementation:

| Area | Decision |
|---|---|
| Streaming (iOS) | **[serve-sim](https://github.com/EvanBacon/serve-sim)** (Apache-2.0, npm) — H.264 served as `stream.avcc`, AVCC-framed over a long-lived **chunked HTTP response** (not a WebSocket), decoded with WebCodecs; automatic MJPEG-over-HTTP fallback; input over the helper's WebSocket, plus the accessibility tree on the same helper. Free, no relay infrastructure, rides the tunnel as plain HTTPS/WSS. Captures via `simctl io` (a public Apple interface — survives new iOS runtimes as long as simctl does). Pin the npm version. |
| Streaming (Android) | **adb-based**, not scrcpy. The decision gate (ws-scrcpy vs embedded scrcpy-server) resolved against both: scrcpy's raw H.264 wire protocol is version-specific and needs extensive on-device iteration, which cannot be validated without a live emulator. Shipped: `screencap` MJPEG plus on-device `screenrecord` H.264, behind the same `StreamingBackend` seam — see §8 for the full outcome. A scrcpy upgrade remains possible behind that seam; it is not planned. |
| NOT WebRTC/TURN; SimDeck for CONTROL only | An earlier revision of this plan used SimDeck + WebRTC relayed through Cloudflare TURN. **Rejected (2026-07-09):** TURN costs $0.05/GB and adds a credential/relay subsystem; SimDeck removed its WS transport (v0.1.31) and its display bridge rides private CoreSimulator APIs (unhedgeable risk against future Xcode); most of the predecessor project's operational scar tissue (display-heal ladder, daemon port cleanup, token discovery) was SimDeck-specific pathology. Serving H.264 over the ordinary HTTP tunnel has none of these problems: free, no relay to run or pay for, and exactly as firewall-proof as claude.ai itself — video and input ride the same HTTPS/WSS a browser already reaches claude.ai with. What SimDeck IS used for, since 2026-07-17, is its control/inspection REST surface behind `describe` and `ui` — see `.claude/rules/testing-control.md`. |
| App types (day one) | React Native (Expo **and** bare) + NativeScript. Flutter / plain-Xcode later. **Amended (2026-07-15): `web`.** A fourth app type hosts a **frontend web project** (a Vite dev server). It is unlike the mobile types: no device/simulator, **local-`path` only** (registered on the machine via `deckhand app add <id> --path <dir> --type web`, never over MCP), and the "preview" IS the running dev server — `start_preview` starts `npm run dev` as a long-lived process (reusing `DevProcessManager`, like NativeScript livesync) on a loopback port and reverse-proxies it through the share URL. Ready = the dev server answers HTTP 200 (no first-frame/screenshot; `screenshot` returns a clear error for web). The dev server is started with Vite's `--base=/s/<shareId>/web/ --host 127.0.0.1 --port <p>` so every asset URL (and HMR) sits under the share path. Vite-first; Next.js/others and git-based web previews are follow-ups. |
| Build strategy | Build locally on the mini: git worktree → install deps → native build. No CI artifacts. |
| Local dev mode + daily-loop contract | **Amended (2026-07-15):** an app may declare a local `path` (instead of, or alongside, `repo`). Local previews build **in place** in the developer's working copy — no worktree, no push — and NativeScript runs as a long-lived **livesync** process (`ns run --no-hmr`, watch on, HMR off — NS HMR is unreliable) so file saves reach the running sim with no tool calls. The loop rides in the tools themselves: `start_preview` is **idempotent** per (app, source, ref), share ids are **stable per app** (persisted; a bookmarked viewer URL never rots), and `restart_preview` rebuilds in place (git: fetch new tip + reset worktree; local: re-run) on the same booted devices. Consequence: named branches/PRs now **always fetch** (the old local-first shortcut served stale commits; SHAs remain local-first). Local previews trade snapshot determinism for the loop — the build mirrors whatever is on disk; the source dir is borrowed, never wiped (`npm ci` guarded) and never removed. Local apps are registered on the machine itself (`deckhand app add <id> --path <dir>`), not over MCP. |
| Tunnel | `cloudflared` **named tunnel** with a stable hostname on the owner's Cloudflare-managed domain. Deckhand binds `127.0.0.1` only. |
| MCP auth | An `Authorization: Bearer` credential at `/mcp` — **never a path segment**. Two ways to hold one, both per-person: an **OAuth grant** (the claude.ai path), or a local `tokens.yaml` token for a client on the machine that has no browser. Every credential is still the operator's, so authenticating IS authorizing and there are still no roles. **Superseded (2026-08-07): the path token, and the "no OAuth" decision with it.** `/mcp/<token>` was safe only while the connector URL was a secret, and it is not: a connector added in **Claude Enterprise is visible to the whole organisation**, so everyone in it could read the credential out of the URL and drive this Mac. OAuth is what makes each client authorize individually; completing it needs a pairing code the operator mints at the machine — `deckhand pair`, typed into the page `/oauth/authorize` serves (§11.6). The original worry — many people on one Mac's six device slots — is answered by that approval, not by hoping a URL stays private. |
| GitHub access | **Minimal GitHub App** — permissions `Contents: Read-only` (optionally `Pull requests: Read-only`), **no webhooks, no OAuth, no callback URLs**. One App ID + private key PEM on the mini. Each repo org installs the app and picks repos. Hourly installation tokens, injected into git via ephemeral `GIT_ASKPASS`. The set of app installations *is* the repo allowlist. **Amended (2026-07-10):** a **fine-grained PAT** (`Contents: Read-only`, selected repos) is an equally supported auth mode — same tokenResolver seam, far less setup, and the mode agent-led onboarding (§6) walks new users through. The App remains the recommended path for multi-org installs. **Amended (2026-07-15): the access ladder.** Asking a user for a PAT when the machine can already read the repo is bad onboarding, so credentials resolve in order: PAT file → GitHub App → (if `githubAmbient`, default on) the deckhand user's **gh CLI session** (`gh auth token`, in-memory, same `GIT_ASKPASS` handling) → anonymous git (public repos; gated on `allowPublicRepos`) → the one-time setup URL as **last resort**. Explicit credentials always shadow ambient ones, so an App's installation set remains the allowlist. Before any of this, onboarding steers to a **local checkout** when one exists (§6). Ambient tradeoff recorded in §11 item 4. |
| Multi-org / multi-dev | **Dropped (2026-08-05.)** One install, one operator, however many repo orgs their credential reaches. A second developer runs their own deckhand; a colleague who only needs to WATCH uses the share link, which needs no token. |
| Viewer | One page (ours — not serve-sim's preview UI), multiple devices side by side, live video + **touch control on** (not view-only), public or PIN-protected share links. |
| Setup story | Setup on the mini will be performed **by an AI over SSH**. `AGENTS.md`/`CLAUDE.md` must be an agent runbook; the installer — `deckhand setup` (§10), not the config-writing `init` it calls — must be idempotent/resumable with non-interactive flags; `deckhand doctor --device-only` must prove the install works end to end on real hardware. The human is asked as little as the tooling cannot infer: `setup`'s preflight (`humanInput` in `cli/preflight.ts`) asks for a tunnel hostname, and optionally a second hostname for web previews. Credentials are not among them — the GitHub ladder (above) reaches an ambient `gh` session before it asks for anything. |
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
│  /mcp                      MCP Streamable HTTP (stateless), bearer-gated tools            │
│  /s/<shareId>              viewer page (our built static assets + preview metadata)       │
│  /s/<shareId>/dev/<id>/*   scoped proxy → that device's streaming helper                  │
│                            (video avcc/MJPEG over HTTP, ax, input WS — nothing else)      │
│                                                                                           │
│  auth ── mcp tools ── previewEngine ── deviceManager ── streaming backends                │
│              │              │                │                  │                         │
│         audit log     git worktrees     simctl / avdmanager   iOS: serve-sim helper       │
│                       + build recipes   + emulator + adb        (one per device, 3100+)   │
│                                                               Android: adb screencap/screenrecord │
└───────────────────────────────────────────────────────────────────────────────────────────┘

on-disk:  ~/.deckhand/{config.yaml, apps.yaml, tokens.yaml, oauth.json, github-app.pem, state.json,
                       secrets/<appId>.env, audit.jsonl, logs/}
          ~/.deckhand/repos/<appId>/          (base clone)
          ~/.deckhand/worktrees/<previewId>/  (detached worktree per preview)
```

One Node process owns everything; streaming helpers are small per-device child processes it
spawns and reaps. cloudflared runs as its own launchd service. Nothing but cloudflared is
reachable from outside the machine. **All video and input is plain HTTP/WebSocket riding the
tunnel** — if a network can reach claude.ai, it can view and control a preview. No STUN, no
TURN, no media leaving through any side channel.

## 4. Stack

*(There is deliberately no repository tree here. One lived in this section and rotted three
times — it named a server test directory and an Expo fixture app, neither of which ever
existed, and a path written inside a fenced block is invisible to the guardrail that polices
PLAN's paths. Read the directories; git keeps them current for free.)*

Node ≥ 22, TypeScript, ESM. Key deps: `@modelcontextprotocol/sdk`, `express`, `zod`,
`yaml`, `ws` (proxy), `react`+`vite` (viewer only), `serve-sim` (pinned). **No database
driver.** Keep the dependency list ruthlessly short.

## 5. Configuration files (all under `~/.deckhand/`)

`deckhand init` writes `config.yaml`, plus empty `apps.yaml`/`tokens.yaml` if they are not
there. `oauth.json` and `state.json` are the server's, written as it runs.

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
githubAmbient: true               # no PAT/App → fall back to the deckhand user's gh CLI session (§11 item 4 note)
allowPublicRepos: false           # public repos from owners without an app installation; also
                                  # gates anonymous git for credential-less installs
limits:
  maxDevicesPerPreview: 4
  maxTotalDevices: 6
  idleMinutes: 60                 # auto-stop a ready preview after this long with no viewer traffic (0 = never)
  failedGraceMinutes: 15          # a failed preview keeps its devices this long, so Rebuild still works (0 = never)
  stuckMinutes: 90                # give up on a preview that has made no progress at all for this long (0 = never)
  reuseDevices: true              # pool simulators/AVDs by device shape instead of one throwaway per preview
  disk:                           # free-space tiers (GiB); PARSED AND READ BY NOTHING — no code
                                  # measures free space, so these three numbers change no behaviour
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
    token: <64 hex chars>         # generated by `deckhand token add <name>`
  - name: audun-laptop            # a second CLIENT, not a second person
    token: <64 hex chars>
```

These are LOCAL credentials, for a client on this Mac (Claude Code) that cannot run a browser
sign-in. claude.ai does not use them — it authorizes through OAuth (§11.6). They are sent as
`Authorization: Bearer <token>` and never appear in a URL.

Auth middleware: store `sha256(token) → entry` in memory; match by hashing the presented
bearer value and `timingSafeEqual`. Unknown or missing credential → 401 with
`WWW-Authenticate: Bearer resource_metadata="…"`, which is how an MCP client discovers where
to authorize. Every tool call is appended to `audit.jsonl`
(`{ts, tokenName, tool, args-summary, result}`); for an OAuth grant the name is the client the
operator approved.

### oauth.json

Per-person connector grants and the OAuth clients that hold them. Mode 0600, sha256 hashes
only — a leaked file cannot be replayed. Written by the server, never hand-edited.

## 6. MCP surface

Server: `@modelcontextprotocol/sdk` `McpServer` + `StreamableHTTPServerTransport` in
**stateless mode** (new transport per request, GET/DELETE rejected) mounted at
`/mcp`, authenticated by a bearer header. Tool input schemas in zod. Errors are returned as structured tool results
(`{ok: false, error: {code, message, hint}}`) — never bare exceptions — so Claude can relay
actionable messages ("missing credential for owner X — run `deckhand …` on the mini").

### The onboarding contract

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
   transcript would outlive the conversation. This preserves §11 item 5 exactly.

Target first-contact conversation: user installs the connector and says "run my app" →
agent (from `list_apps` empty state) asks which repos → `add_app` → agent relays the
PAT instructions + setup link → user completes it → `add_app` re-run auto-detects type,
doctor-builds, reports `ready` → agent offers the first `start_preview`.

| Tool | Input → Output |
|---|---|
| `list_apps` | → apps with `{id, repo, type, defaultBranch, lastDoctor}` |
| `list_devices` | → available iOS runtimes + device types (`simctl list -j`), Android API levels/system images, connected PHYSICAL devices (`physical`: paired iOS hardware via `devicectl`, adb-connected Android — detection only, `server/src/devices/physical.ts`; `targetable` says whether start_preview can build to them, and is always false — building to physical hardware is not implemented; `errors` marks a FAILED scan as distinct from a zero-device one), current capacity vs `limits` |
| `start_preview` | `{app, ref?, pr?, devices?: [{platform: "ios"\|"android", runtime?, model?}], alongside?: [{app?\|ref?\|worktree?\|repo?}], items?, share: {access: "public"\|"pin", pin?}}` → `{previewId, url, source, alreadyRunning, alongside?, nextStep, devices: [...]}`. **Idempotent**: an equivalent live preview (same app+source(+ref)) is returned as-is with `alreadyRunning: true` — this is also how the agent answers "what's the link?". No ref/pr on a `path` app → local dev mode. Returns immediately; work continues async. **Amended (2026-07-31):** `alongside` puts extra sources on the SAME page — the page is a set of panes, so one link and one PIN cover however many sources. `{}` means the app's registered `migratesFrom`. Each `alongside` entry carries the pane's own `previewId` — panes are drivable, but ONLY by that id: a pane runs under a synthetic app id, so by-app lookups answer `app_is_a_pane` with the pane's previewId instead of a "boot one" hint, and a plain `start_preview` of an app already on a page as a pane returns `duplicatesPane` with a leading warning in `nextStep` (the duplicate's devices are invisible to whoever watches the page). See "One page, several sources" below. |
| `restart_preview` | `{previewId?}` or `{app?}` → rebuild in place on the same booted devices, same shareId/URL. Local: re-run the livesync build (needed after native-level changes; ordinary edits livesync by themselves). Git: fetch the ref's new tip, reset the worktree, rebuild — the post-push step of the loop. |
| `preview_status` | `{previewId?}` or `{app?}` → per-device `{phase, detail, error?, logTail?}`; overall `{ready, url, source}` |
| `stop_preview` | `{previewId|app}` → teardown (devices deleted, worktree removed per policy; a local app's source dir is never touched) |
| `stop_device` | `{previewId|app, deviceId}` → tear down ONE device, leave the rest running and the URL unchanged. The way back from `start_preview` with an extra platform. Refuses the last device — that is `stop_preview`, which also frees the worktree and the share |
| `screenshot` | `{previewId, deviceId}` → MCP image content (PNG). iOS: `xcrun simctl io <udid> screenshot`; Android: `adb -s <serial> exec-out screencap -p` |
| `describe` | `{previewId, deviceId}` → accessibility tree. iOS: serve-sim's ax endpoint (token-efficient, built for agents); Android: `adb shell uiautomator dump` (parsed/compacted) |
| `ui` | `{previewId, deviceId, action}` where action ∈ `{tap {x,y}, type {text}, key {name}, button {name}, home, openUrl {url}}` (normalized 0..1 coords) — validated passthrough. iOS: serve-sim gesture/button/type commands; Android: adb input |
| `logs` | `{previewId?\|app?, deviceId?, source?: "build"\|"stream"\|"metro"\|"app", tailLines?}` → the last `tailLines` (500 retained per source) of one device's captured log. `build` (default) is build/install output plus the NativeScript livesync and web dev-server streams — where a failed build says why. `stream` is the browser→helper trace, the one to read when the device says ready and the viewer shows nothing (see §7 "Streaming diagnostics"). `metro`/`app` are reserved and capture nothing yet. |
| `add_app` | `{repo, type?}` → clone, detect, **doctor build** on a default device, structured report (`ready` or `missing: [...]`) |
| `remove_app` | `{id, deleteCheckout?}` |
| `start_test_run` / `update_test_run` / `finish_test_run` / `clear_test_run` | **Amended (2026-07-17):** agent-driven end-to-end testing. The agent (the brain) reports what it's testing — `{title, steps}`, per-step `running`/`passed`/`failed`, then a verdict + summary — surfaced live in the viewer as a calm spinner button + step popover. deckhand records; the agent writes the human report in chat. |
| `parity_set` / `parity_status` | Maintain and read the per-item parity checklist (`pending`/`doing`/`done`/`adjusted`/`regression`). Deliberately NOT merged with the `*_test_run` tools: a test run is one ephemeral pass whose steps go pending → running → passed, parity is a durable per-screen verdict, and the viewer renders them as separate sections precisely because the statuses do not mean the same thing. |

**Amended (2026-07-17): `describe`/`ui` backend = SimDeck, control-only.** The 2026-07-09
rejection of SimDeck (row §2) was about its **video transport** (WebRTC/TURN); its
**control + inspection is decoupled from video** and is a much stronger `describe`/`ui`
backend than serve-sim-ax/uiautomator — especially for NativeScript (component tree, CSS
classes, and **.ts/.html source locations** via `@nativescript/simdeck-inspector`, an
opt-in). deckhand keeps its own backends (serve-sim on iOS, adb on Android) for the
human **video**, and drives
SimDeck **REST only** — `GET /api/health`, `GET /accessibility-tree`, `POST /action`,
`POST /pasteboard` (non-US iOS typing) and `GET /screenshot.png` —
on the device it already booted (iOS by UDID, Android by `android:<avd>`). Two hard rules
(enforced in `server/src/testing/`): **never** touch SimDeck's `/input`/`/control` WS,
`/webrtc/offer`, or `/refresh` (they spin up the fragile private display/encoder session);
and auth via the **same-origin loopback** allowance, so deckhand holds **no SimDeck token**.
iOS HID can't type non-US text — non-ASCII `type` routes through the clipboard + paste.
`logs` ships (see the tool table); its `metro` and `app` sources are the part that
did not — they are accepted by the schema and reserved, and nothing appends to them.

**Amended (2026-08-01): the drive loop is steered to a cheaper model.** Driving
(`screenshot`→`describe`→`ui`→`update_test_run`) is mechanical and high-volume — it does
not need the agent's primary model, only a fast cheap one. An MCP server cannot choose
the caller's model, and deckhand no longer tries to influence it. It used to: the drive
contract asked the agent to hand the loop to a subagent on its cheapest fast model.
That was removed (2026-08-02) because measurement contradicted it. Deckhand is not the
slow part — `ui` answers in 0.43–0.69s, `describe` in 0.03–0.59s, `screenshot` in 0.15s
— while a delegated five-step run took 583s across 66 tool calls, about 5% of it
deckhand. A weaker model makes that worse, not cheaper: every mis-aimed tap costs three
more round trips. And the real cost was not tokens but two confident, wrong root causes
("the permission dialog is unresponsive"; "critical UI bugs, button ID mapping broken"),
both nearly filed as app bugs. The agent that calls the tool does the work; a test in
`server.test.ts` fails if any model advice comes back.

**Migration features (added 2026-07-18).** Deckhand can host a **NativeScript → React
Native** (or any app→app) migration as a *parity harness*, never a migration engine. Most
of the loop already works with existing tools (register both apps, `start_preview` each,
`describe`/`ui`/`screenshot` to inspect) — the agent is the comparator and the code
translator. Three small additions close the gap:
1. **`migratesFrom`** (apps.yaml field): the TARGET app declares the SOURCE app id it is
   migrating from. Cross-app-validated (source must exist, not self). Set via
   `deckhand app add … --migrates-from <source>` or `add_app`.
2. **Showing both apps at once.** This was FIRST built as a singular pair — `shareState`
   carried one optional `pairedWith` block naming the source preview, and the viewer entered
   a compare mode against it. That shape was replaced (see "One page, several sources"
   below) for two reasons worth not rediscovering: with no cross-share unlock, a PIN on the
   target could not cover the source, so the reference pane had to be **public by
   construction**; and one slot cannot say "old app + `main` + this branch". The live shape
   is `panes[]` plus `pairedShareIds()`.
3. **Parity ledger**: an agent-maintained `deckhand.migration.yaml` in the TARGET repo root
   (`screens: [{name, status, note?}]`). Deckhand **reads** it from the target's checkout
   (bounded single-file read) and surfaces it as `shareState.ledger`; the viewer renders a
   calm checklist. It lives in the repo — version-controlled, reviewable — not in `state.json`.
   Deliberately NOT built (keeps the invariants clean): a mechanical screenshot/tree `compare`
   tool (the agent is multimodal — it judges), golden-snapshot capture (the source runs as a
   live oracle), and any persisted migration session (the pair derives from `migratesFrom` +
   the existing stable per-app shareIds). Boundary: deckhand runs and shows both apps and
   reads the ledger; the agent translates code, judges parity, and writes the ledger — and
   deckhand never writes to either repo (§11 item 4).

**One page, several sources (amended 2026-07-31).** The above was built as a *pair*: one
working preview plus one reference, on two URLs, the reference forced public because there
was no cross-share unlock (see item 2 above). That shape could not say "old app +
`main` + this branch", and it made comparing a mode the viewer entered rather than something
a page simply was. Generalised:

1. **The page is a set of panes.** `shareState` returns `panes[]` — every live source, in
   old → new order, this share's own last — instead of a singular `pairedWith`. An ordinary
   preview has exactly one pane, so the viewer renders a list and never asks "is this a
   comparison?". `CompareView` is deleted; there is one stage.
2. **One link, one PIN.** `pairedShareIds()` fans the unlock out over the whole set, so the
   public-by-construction reference is gone. Panes still stream from **their own**
   shareIds — §8's proxy contract ("only for device IDs belonging
   to that share's preview") and §11 item 6's narrow allow-list are untouched, so no new route is
   forwarded and the streaming seam did not change. The proxy's unlock minting did: it fans
   out from a single partner to the set, FORWARD ONLY — a pane never mints for the page
   holding it, because panes are content-keyed and two pages can share one.
3. **Still no persisted session.** The pane set stays in-memory on the working preview, as
   the compare session already was. Nothing new lands in `state.json` (a protected pane's PIN uses the existing `pins` map, so it survives a restart), and share ids stay
   stable per app: the page lives at the primary app's existing URL, and extra panes are
   additive content on it. A bookmarked link does not rot.
4. **`start_preview` covers this via `alongside`** (see the tool table), so there is one
   way to start something. What bounds it is the host allow-list in `parseRepo`, re-checked in
   the `alongside` branch before any credential is resolved — and nothing else, since the role
   and owner-scope gates went with team support (§11 item 3).

**Accepted risk — reach across owner boundaries (2026-07-31).** A page may now show panes
from more than two registered apps, and whoever holds the link plus any one pane's PIN
reaches all of them. This is a difference of degree, not of kind: the two-app case was
already accepted above and in `partnerIsReachable`, whose rule is preserved unchanged — a
protected pane joins only when the page itself is protected, so access is never granted
from nothing. The panes are chosen by an operator holding a valid token, which since
2026-08-05 is the whole of the check (§11 item 3). Revisit if deckhand ever serves mutually-untrusted parties on
one hostname; the fix then is a per-page principal, not a narrower pane list. Note this
compounds the cookie-jar risk in §11 item 6 for `web` panes specifically — "per share" stops
being a sufficient scope unit when one page spans several apps.

Validation rules enforced server-side (never trust the model): app must exist; ref/PR must
resolve in that app's repo; device count within limits. Not owner-scope — `role` and `owners`
are stripped from a token as legacy keys before it is parsed (`config.ts`), and §11 item 3
says why.

> **Fork PRs (audit 2026-07-27):** `allowForkPRs` was **removed**. It was parsed into the
> app schema and never read anywhere, while this document claimed "fork PRs rejected unless
> `allowForkPRs`" — a flag that only reads as a protection is worse than none. A fork PR
> previews like any other ref, so treat "can open a PR against a previewed repo" as "can run
> that PR's install and build scripts on the deckhand machine" — the accepted
> builds-are-RCE-by-design tradeoff (§11 item 7). What *is* bounded: the git credential
> offered alongside them (askpass host-pinned to the app's own repo host, App tokens minted
> per repo). Existing apps.yaml files carrying the key still load; it is stripped on parse.
> If fork PRs ever need gating, gate them for real.

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

| Type | iOS | Android | Launch |
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
- **Android**: enumerate installed system images (`sdkmanager --list_installed`); create
  AVD via `avdmanager create avd --force --name deckhand_<...> --package <sysimg>` (the
  lowercase `deckhand_` prefix is `AVD_PREFIX`, and the orphan sweep selects on it — an AVD
  named anything else is never reaped); **deckhand
  boots the emulator itself**: `emulator -avd <name> -no-window -gpu host`, plus
  `-no-audio -no-boot-anim -no-snapshot`. Windowless but NOT software-rendered — dropping
  `-gpu host` is what makes a headless emulator expensive, and `android.ts` carries the
  measurement that settled it. Wait for `adb wait-for-device` +
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
   A boot-time reap was written for this and never called.
2. **Nothing ever expired.** A preview nobody watched, or one that failed to build, held its
   devices forever — and failed previews were counted as using *zero* devices, so capacity
   never pushed back.

The contract now:

- **Reap on boot** (`engine/reaper.ts`, called from `listen()` immediately AFTER the port is
  bound — the bind is what proves only one server is running, so a second `deckhand serve` dies
  on `EADDRINUSE` before it can delete the live server's sims and AVDs): deckhand binds a single
  loopback port, so exactly one server runs at a time and every `deckhand-…` device on the
  machine at startup is by definition an orphan. Helpers are killed first (`serve-sim <udid>`;
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
  // endpoint is up — a first frame is a separate wait (see AttachedStream).
  attach(device: { platform: "ios" | "android"; udid: string; serial?: string }): Promise<AttachedStream>;
}
interface AttachedStream {
  origin: string;                   // loopback upstream, e.g. "http://127.0.0.1:3100"
  helperBasePath: string;           // e.g. "/helper/<udid>" — the proxy exposes only
                                    // stream.avcc (H.264 over chunked HTTP), stream.mjpeg,
                                    // ws (input) and ax beneath it; never public
  waitForFirstFrame(timeoutMs?: number): Promise<boolean>;
  describe(): Promise<string>;      // token-efficient a11y tree
  detach(): Promise<void>;          // kill helper, release port
}
```

### iOS backend: serve-sim

Full API notes in `docs/reference/serve-sim-notes.md` — read them before implementing.
Essentials:

- Deckhand installs the **pinned** npm package and spawns **one helper per device**
  (`serve-sim --detach -p <port> <udid>`). Embedding serve-sim's `simMiddleware` in
  deckhand's own Express server was considered and NOT taken, and it is not an
  implementer's choice: a helper in its own process means a crashed capture kills one
  device rather than deckhand, and embedding couples the server's stability to a native
  addon. Helpers bind loopback ports from `helperPortRange`; deckhand tracks
  pid/port per udid and reaps on detach. serve-sim also keeps a state file under
  `$TMPDIR/serve-sim/` and supports `--list`/`--kill` — the janitor uses these to find and
  kill **orphans** after crashes.
- Video: **`stream.avcc`** — H.264 in AVCC framing over a single long-lived **chunked HTTP
  response**, NOT a WebSocket — decoded with WebCodecs when the browser supports it
  (`codec: auto`), with automatic **MJPEG-over-HTTP fallback** (`stream.mjpeg`) — this
  replaces any hand-rolled screenshot-poll degradation; it is built in. The pinned helper
  routes `/stream.avcc`; whether a given machine actually encodes is a runtime answer, so
  the viewer probes it and reads a 404 as "use MJPEG" rather than as a failure.
- Input: pointer/keyboard over the helper's `ws` channel — the only WebSocket it serves,
  and it carries no video (plus CLI commands
  `gesture`/`button`/`type`/`rotate` used by the `ui` MCP tool).
- `describe`: serve-sim's accessibility endpoints (`ax`) — the only non-video helper route
  the share proxy forwards. `logs` does NOT come from the helper: it returns the per-device
  lines deckhand captured itself (see the tool table), and there is no log route in the
  proxy's allow-list.
- When proxying: wire WS `upgrade` handling and forward `X-Forwarded-Proto` so
  helper URLs come out `https`/`wss` behind the tunnel (documented requirement; without it
  the page mixes content and input dies).

### Android backend — the gate (2026-07-09) and what streams now

The gate (ws-scrcpy vs embedded scrcpy-server vs …) resolved at the time to: **ship an
adb-based backend first, keep scrcpy H.264 as a possible upgrade behind the same seam.**
Reason: scrcpy's raw H.264 wire protocol is version-specific and needs extensive on-device
iteration to get right, which cannot be validated without a live emulator — too much risk
for the initial cut. The first cut was `streaming/androidAdb.ts` (`AndroidAdbBackend`),
which:

- serves **`adb exec-out screencap -p` as a multipart PNG stream** on a loopback port — which
  **reuses Deckhand's existing viewer verbatim** (the MJPEG parser slices by Content-Length;
  `createImageBitmap` decodes PNG), so no new viewer code and zero scrcpy-protocol risk;
- carries touch over the **same `/ws` protocol** (`[0x03][JSON {type,x,y}]`) translated to
  `adb shell input tap/swipe` (normalized → device pixels via `wm size`);
- provides `describe` via `uiautomator dump`.

That path is no longer the primary one, and the reason it was replaced is the point:
PNG-per-frame cost ~640 KB per frame at a fixed 6.7 fps (~4.2 MB/s on a 1080x2400
emulator) and wrote on a timer regardless of whether the socket could take them, so a
client pulling ~1 MB/s fell further behind until the canvas stopped painting entirely.
`streaming/androidH264.ts` (`adb exec-out screenrecord`, Annex-B repackaged to AVCC,
decoded by the same WebCodecs player as iOS) carries the same content for ~12 KB/s and
is what Android streams over now. One `screenrecord` process serves every viewer of a
device — Android tolerates few concurrent recorders, and N would cost N encodes — so a
late joiner is handed the cached parameter sets plus the current GOP rather than waiting
out the ~10 s keyframe interval. `androidAdb.ts` remains the **fallback** for system
images with no working AVC encoder (notably the API 29 emulator, where MediaCodec
throws): that is detected on first use, the route 404s, and the viewer drops to MJPEG
instead of staring at a dead stream. The upgrade landed entirely behind
`StreamingBackend` and changed nothing outside `streaming/`, which is what the seam was
for. **scrcpy was never taken** — see the §2 row for why, and note that the gate's
premise (that H.264 needed scrcpy) turned out to be false: `screenrecord` is on every
device already.

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
deliberately **inverts** the device proxy's narrow-allow-list posture (§11 item 6): the whole
dev-server origin is exposed, gated only by the 144-bit `shareId` + the PIN a web share
always carries (see §9).
Every other invariant holds — the upstream is strictly **that share's own loopback
dev-server port** (resolved via `findByShareId`; no SSRF to sibling ports, no path
traversal), `X-Forwarded-Proto: https` is preserved (so Vite emits `wss://` HMR behind
the tunnel), and the web preview is idle-reaped and torn down like any other (the source
dir is never touched).

## 9. Viewer & share links

### Share model

- `start_preview` issues a `shareId` = `crypto.randomBytes(18).toString("base64url")`.
- `access: "public"` → the 144-bit URL is the gate.
- **Amended (2026-07-16): numeric PIN protection (shipped).** `share.access` on
  `start_preview` is `"public" | "pin"` and is **required** — the tool fails
  (`needs_access_choice`) until the agent has asked the user, so every link is a
  deliberate PIN-or-public choice. A `pin` is 4–6 numeric digits (user-chosen), stored
  per app as `scrypt(pin)` in `state.json`'s `pins` map (persisted, so a bookmarked
  protected URL stays protected across restarts). `set_pin` adds/changes/removes the PIN
  on a live preview later (same URL). The gate: content routes (`/dev`, `/web`, `/restart`,
  the subdomain-web proxy) and both WS upgrades require a valid HMAC unlock cookie
  (`deck_unlock`, signed with an auto-generated `~/.deckhand/share-secret`); `/state` +
  `/unlock` + the viewer shell stay public. `/unlock` is throttled per share: 5 wrong PINs lock it
  for 30s, and every lockout after that DOUBLES (capped at 15 min) with a budget of one
  attempt — the count survives its own lock, so waiting one out no longer buys a fresh five.
  Before 2026-08-05 the lockout reset the counter, which made the throttle a self-renewing
  ~600 guesses/hour against a 4-digit space. The viewer shows an elegant pad (auto-submits on the last digit, shakes on
  a wrong code); subdomain-web hosts get a self-contained vanilla pad since they have no
  React viewer.
  **Amended (audit 2026-07-27): a web share is ALWAYS PIN-protected.** `start_preview` on a
  `web` app rejects `access: "public"` (`web_needs_pin`), the engine refuses to boot a web
  device with no PIN record in force, and `set_pin` with `remove: true` fails while a web preview is
  live — three layers, so no caller can route around it. Why web and not mobile: a mobile
  share exposes four allow-listed helper subpaths, while a web share exposes the dev
  server's whole route surface (including `@fs` if the previewed repo relaxed Vite's
  `server.fs.strict`, which deckhand must not edit) — and a subdomain-hosted framework
  serves at a bare public hostname with no 144-bit shareId in the URL at all, discoverable
  from DNS or certificate transparency. Per-preview subdomains would have been the other
  answer; Cloudflare Universal SSL covers only one wildcard level, so the PIN is the fix.
  The cookie also binds the PIN in force (`pinFingerprint`), so changing or removing a PIN
  revokes cookies issued under the old one instead of leaving them valid for the 12 h TTL —
  which mattered because shareIds are stable per app and reused across stop/restart.
  **Deliberate §11 item 5 relaxation:** the user chose to set the PIN by telling
  the agent (through MCP) rather than an out-of-band setup URL — so a share PIN (a low-value,
  shareable access code, not a standing bearer credential) may travel through MCP. It is
  **redacted from the audit log** (`summarizeArgs`), never stored in plaintext, and the tool
  descriptions tell the agent not to echo it in chat. The one-time-setup-URL path (§6) stays
  the option for zero PIN exposure.
- Share dies with the preview (`stop_preview`) → viewer shows a calm
  "this preview has ended" state.

### Stream client (ours, in `viewer/`)

- **H.264 over chunked HTTP (`stream.avcc`, read with `fetch` + a body reader) + WebCodecs
  `VideoDecoder`** painted to a canvas, matching serve-sim's
  own client. Built by adapting serve-sim's client utilities (Apache-2.0, attribution kept)
  into `viewer/src/stream/`: `avcc.ts` (codec + fallback), `mjpeg.ts` (frame parsing),
  `input.ts` (pointer/key encoding), `player.ts` (the decode loop and reconnect).
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

- `deckhand setup` — **the only command a new install needs.** Run with no arguments it is a
  PREFLIGHT: it reports every prerequisite (Node, Xcode, cloudflared, Android SDK) with *who
  can fix it* — `fix:` for what a non-interactive process can do, `you:` for a fix only a
  person at the machine can perform (an App Store Xcode, the machine's default Node), and a
  **BLOCKED** block for what needs a browser and someone's Cloudflare account. That classification
  (`cli/preflight.ts`) exists because an agent handed only a repo URL will otherwise run
  `cloudflared tunnel login` and block on a prompt nobody sees.
  Run with `--hostname` it does the rest: adopt-or-create the named tunnel, DNS route,
  **merge** `~/.cloudflared/config.yml` (`cli/tunnelConfig.ts` — never generate it; that file
  routinely carries other services), `npm link` the `deckhand` command onto PATH, write
  `config.yaml`, mint the connector URL, install the launchd agents, run doctor.
  Idempotent by design, so it is also the repair tool.
- `deckhand init` — writes `config.yaml`, and empty `apps.yaml`/`tokens.yaml` if absent.
  `setup` calls it; you rarely call it directly.
  Flags: `--hostname`, `--port`, and optionally `--github-app-id`/`--github-app-pem` (the App
  is optional — without it deckhand uses the ambient `gh` CLI session).
- `deckhand pair` — **mint a pairing code** (§11.6), good for ten minutes and one use. It is
  the only way a new client gets in; the visitor types it into the authorize page.
- `deckhand connections` — clients holding a grant now; `deckhand revoke <client-id>` takes one
  away, effective on its next MCP call.
- `deckhand token` — **your connector URL**, `https://<hostname>/mcp`. It carries no
  credential and is safe to share with your organisation. The subcommands manage LOCAL
  credentials instead, for a client on this Mac that cannot run a browser sign-in:
  `token list` shows which exist with the values MASKED; `token url <name>` prints one in
  full; `token add` mints another; `token rm <name>` revokes one, effective on the running
  server (the watcher compares content, so rotating a value under the same name applies too).
  There are no roles: every credential is the operator's (CONSTITUTION §"Who it is for").
- `deckhand doctor` — the verification loop, each check independently reportable:
  toolchains present (xcodebuild, simctl, node; java, sdkmanager, adb, emulator for Android),
  the vendored serve-sim present **with its exec-stripping patch still applied**, a connector
  credential exists, GitHub App JWT mints and each installation returns a token, tunnel answers
  **from the public hostname**. Exit non-zero on any failure. Plain `doctor`
  touches no device: it is the paperwork pass, and nothing in it proves video works.
  `--smoke` adds the hardware pass: it creates a simulator and an emulator and checks boot,
  **first frame** and describe on each — six independent checks, no fixture app and no build.
  `--device-only` runs the same set as `--smoke` — every paperwork check still runs and is
  still printed — but its exit code covers only the device checks, so a code gate cannot go
  red on an install problem its author cannot fix.
- `deckhand serve` — run the server (what launchd invokes).
- `deckhand token add|rm|list|url`, `deckhand app add|list`,
  `deckhand env set <appId> KEY=VALUE`.

## 11. Security model (recap, enforced in code)

1. **Reachability**: deckhand and every streaming helper bind loopback; only cloudflared is
   exposed; TLS at Cloudflare's edge. **Amended (2026-08-07):** "no tokenless code path exists
   at all" is no longer true, and pretending otherwise would hide where to look. Four paths are
   unauthenticated *by construction*, because a client with no credential yet has to start
   somewhere: the two `/.well-known/oauth-*` discovery documents (public, no secret in them),
   `POST /oauth/register` (RFC 7591 dynamic registration — capped, since it writes to disk), and
   `GET /oauth/authorize`, which is unauthenticated at the origin and gated by **a pairing code
   the operator minted at the machine**. Registering or discovering buys nothing, and nothing
   incoming is stored: a grant needs a code that only `deckhand pair` produces, and wrong guesses
   lock out the SOURCE rather than burning the code (§11.6). The other direction — park the
   incoming request and let the operator approve one from a list — was tried and rejected,
   because parking is unauthenticated and a stranger parked faster than a person could walk to
   the Mac. Everything that touches a device or a repo is still behind a credential.
   **Caveat (audit 2026-07-27):** loopback is *not* a boundary against a share holder. An
   iOS Simulator shares the host's network stack (`127.0.0.1` inside it is the Mac's
   loopback; Android's emulator aliases it as `10.0.2.2`), and a share grants real device
   input — so anything a booted device can reach, a share holder can reach, bypassing the
   proxy allow-list entirely. That is why serve-sim is vendored with its host shell-exec
   routes patched out, and why PLAN §11 item 7's dedicated unprivileged user matters.
   **Caveat (audit 2026-07-29):** the Expo/Metro dev server is the one helper that is *not*
   loopback-bound — it binds the wildcard on its allocated port (8081-8099), because
   `--localhost` binds IPv6 `::1` only and the simulator then cannot load the bundle
   (`metro.ts`). It serves the previewed app's JS bundle to anything on the LAN for the
   life of the preview. Item 7's dedicated user and a host firewall are the mitigations.
2. **MCP auth**: 256-bit bearer credentials in an `Authorization` header — never in a URL —
   hashed lookup, constant-time compare, 401 + `WWW-Authenticate` on miss, JSONL audit of
   every call under the credential's name. No roles: one install, one operator, so a valid
   credential is the operator and there is nobody to grant less to. Who may *obtain* one is
   §11.6.
3. **Capability bounding**: no arbitrary shell tool; only registered apps; only refs in
   those repos; device-count limits. (`start_preview`'s `alongside[].worktree` /
   `alongside[].repo` reach past "registered apps" by design, and since 2026-08-05 nothing
   gates them but the token — the role and owner-scope gates went with team support. What
   still bounds `repo` is the HOST in the repo string, which decides who receives deckhand's
   git credential — allow-listed in `parseRepo` (github.com only until someone widens it
   deliberately) and re-checked in the `alongside` branch before any credential is resolved.
   Fork PRs are *not* gated either; see §6.)
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
6. **Shares**: 144-bit IDs, scrypt-hashed PINs, HMAC-signed unlock cookies, the
   `deck_unlock` cookie stripped before proxying so the HMAC never reaches the app,
   shares die with their preview. The proxy exposes only video, `ax` and input for the
   share's own devices — serve-sim's other endpoints (camera, devtools, exec) are never
   forwarded. **Web previews (2026-07-15) are the deliberate exception:** a `web` app's
   share proxies the whole dev-server origin (a dev server serves arbitrary paths), so the
   144-bit `shareId` (+ the PIN a web share always carries) is the gate rather than a
   narrow allow-list. The upstream is confined to that share's own loopback dev-server port (no SSRF/traversal),
   still binds `127.0.0.1`, and is still idle-reaped — see §8 "Web proxy".

   **Accepted risk — cookie isolation between web shares (2026-07-27).** The web proxy
   forwards request headers by denylist (only `deck_unlock` is stripped), so the whole
   `cookie` and `authorization` headers reach the app's dev server. Every share lives on
   the same public hostname, so a cookie set by the app under `/s/A/web/` is sent by the
   browser to a *different* app under `/s/B/web/`. Reviewed and **accepted**: all shares
   on this deployment are the operator's own apps behind a PIN, and the alternatives
   (path-scoped cookies, per-share name prefixes, or returning to a header allow-list)
   each cost more than the exposure is worth today. Revisit before any deployment where
   two mutually-untrusted parties can hold shares on one hostname — the fix is to scope
   the cookie jar per share, not to re-narrow the header list.
7. **Host hygiene** (documented in runbook, not code): dedicated macOS user, no personal
   credentials on the machine, FileVault on.

### 11.6 Who may connect — approval at the machine (2026-08-07)

The connector URL is **public by construction**. Added in Claude Enterprise it is visible to
the whole organisation, so nothing about deckhand's safety may rest on it staying private.
What keeps everyone else out is not a list — it is that **nobody is admitted without the
operator saying so, once, per client, at the Mac**:

- `/oauth/authorize` asks for a **pairing code** and stores nothing. It authorizes nobody and
  mints nothing until a request arrives carrying a code the operator minted.
- `deckhand pair` mints one: ten minutes, single use, replaced if minted again. Guessing is the
  only move a stranger has, and it is bounded by locking out the SOURCE that guessed wrong —
  never by burning the code, which would let anyone shred every code the operator mints and
  leave the person actually being paired with a dead one.
- **Direction, deliberately.** The first design parked incoming requests and let the operator
  approve one from a list. That collapses under load: parking is unauthenticated, so a stranger
  can park five requests a second and the operator's own is evicted before they can read its
  code and walk to the Mac. Bounding the queue does not help — anything a stranger can create,
  a stranger can create enough of. Storing nothing incoming removes the class.
- The two halves are protected differently, and that asymmetry IS the design. The public half
  (`/oauth/register`, `/oauth/authorize`) proves nothing and needs nothing. The
  deciding half (`/pair/*`) needs a `tokens.yaml` credential — obtainable only by being at the
  machine. An OAuth grant deliberately cannot approve, or one connector could wave the next one
  through.
- **Superseded (2026-08-07): Cloudflare Access and `connector.allowedEmails`.** Both are gone.
  They worked, but they made a from-scratch install stop dead on an errand deckhand could not
  perform — creating an Access application needs a Cloudflare API token with `Access: Edit`, a
  credential with a far wider blast radius than the tunnel's, held forever to save one dashboard
  visit. Approval needs no second account, no list to maintain, and no answer at setup time.
  It is also strictly narrower: an allowlist admits an address forever, an approval admits one
  client once.
- The code lives **in memory**. One outstanding at a time, because the operator is one person
  doing one thing, and a code that survived a restart would outlive the person who asked for it.
- Revocation is `deckhand revoke <client-id>`, keyed by client because a client is what was
  approved. Effective on that client's next call, with no restart — a restart tears down every
  booted simulator on the machine, so it can never be the price of taking access away.
- The OAuth server itself: authorization-code + PKCE **S256 only** (`plain` puts the verifier
  in the same redirect as the code), single-use codes burned even on a failed redemption,
  rotating refresh tokens, public clients via RFC 7591
  dynamic registration, https redirect URIs only, and errors RENDERED rather than redirected —
  registration is unauthenticated, so "a registered redirect_uri" is any URI a stranger asked
  for, and bouncing a browser there is an open redirector however well the match is done.

## 11a. Staying current

Deckhand reports whether it is running the latest code; it never updates itself.

**The version is the commit.** `server/src/version.ts` reads the running
checkout's sha and `git describe --tags --always`, and compares against
`git ls-remote origin refs/heads/main`. Nothing is stored and nothing is bumped:
a version number in `package.json` is only true while someone remembers to
change it, and a sha cannot drift from the code because it *is* the code. Tag
when a round number is wanted; nothing depends on it.

`ls-remote` rather than the GitHub API — it reuses the credential the checkout
already clones with, needs no token wiring and no dependency, works for a
private repo, and touches nothing on disk. Deckhand must never fetch into its
own checkout behind the operator's back.

The answer is cached for 30 minutes and refreshed in the background, so no tool
response ever waits on the network. It is attached through the shared `ok()`
funnel — and only when there is something to say, so the normal case is unchanged
and a tool added later cannot forget it. One tool goes around the funnel:
`screenshot` returns an image content block with nowhere to put JSON, so it
carries no notice, and `mcp/responses.test.ts` keeps it the only one.

The two states are gated differently. `pull-and-restart` compares the checkout to
`origin/main` and speaks **only** for a clean checkout on `main`, because a feature
branch is not out of date. `restart` compares the sha this process booted on against
the sha on disk, so it fires on any branch and on a dirty tree — running code being
stale is true regardless. `version.ts` does compose a factual note for an off-`main`
or dirty checkout, but `ok()` ships a note only alongside a `deckhandUpdate`, so that
note never reaches a tool response.

**Never automatic.** Updating means restarting, and a restart tears down every
booted simulator on the machine. The tool reports; the human decides.

## 12. Reference material

- `docs/reference/serve-sim-notes.md` — serve-sim's CLI, endpoints, embedding/middleware
  API, state file, and constraints, as verified from its source. **Read before implementing
  `streaming/serveSim.ts` or the viewer client.**
- `docs/reference/auto-mate-learnings.md` — distilled implementation knowledge from the
  predecessor project (build recipes, 14 concrete pitfalls, transport-agnostic stream-client
  behaviors, share/proxy patterns, git/worktree mechanics). **Read before implementing the
  engine or the viewer.**
- serve-sim source: `git clone --depth 1 https://github.com/EvanBacon/serve-sim.git` —
  especially `packages/serve-sim/src/client/` (stream client to vendor) and
  `packages/serve-sim/README.md` (embedding, proxy, X-Forwarded-Proto).
- scrcpy: https://github.com/Genymobile/scrcpy — evaluated and NOT adopted (§8); kept only as the reference for a possible future H.264 upgrade behind the streaming seam.
- The predecessor repo (`auto-mate`) may exist at `~/auto-mate/auto-mate` on the dev
  machine; file references in the learnings doc point into it. It is a reference only —
  **do not import code or patterns wholesale; this project stays small.**
