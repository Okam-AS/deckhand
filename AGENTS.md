# Agent guide — deckhand

## Current state: Phases 1, 2 & 2.5 implemented (iOS + Android, multi-device, local dev mode)

Phases 0–2.5 are done (168 tests green, CI green). The server has config/auth/state/audit,
GitHub App auth + git worktrees, build recipes + detection (Expo/RN/NativeScript, iOS +
Android), iOS simctl control, Android device layer (avdmanager/emulator/adb, uiautomator
describe, toolEnv), the streaming router (serve-sim for iOS, adb-screencap backend for
Android), the preview engine (**platform-grouped, build-once-install-many, parallel
boots/installs**), the MCP server (9 tools, token auth) + scoped share proxy, and the CLI.
The viewer is the calm WebCodecs page (reused for Android via multipart-PNG).

Phase 2.5 (PLAN §2 amendment 2026-07-15) added the **daily dev loop**: apps can have a
local `path` (built in place — no worktree, no push; NativeScript runs as a long-lived
livesync process, HMR off), `start_preview` is idempotent, share URLs are **stable per
app** (persisted in state.json), `restart_preview` rebuilds in place (git: fetch+reset;
local: re-run) on the same booted devices, named refs always fetch (stale-branch fix),
and the viewer has a Rebuild button for local shares. A local app's source dir is
borrowed, never owned: never `npm ci`-wiped, never removed on teardown — **and its git
state is deckhand's to read/run, never to write.** Deckhand must not modify tracked files
in a borrowed checkout; anything it must generate to host the app (dev-server caches, a
generated/override config for a non-Vite framework, a stray lockfile) has to stay
**untracked** — write it outside the tree, or append it to the checkout's
`.git/info/exclude` (a repo-local, never-pushed ignore) so `git add -A` can't stage it.
Any agent driving deckhand must **never commit or push local changes deckhand caused** in
a user's repo. (This is why the `web` type injects Vite's base/host/port as runtime CLI
flags — zero source edits; frameworks that can't be configured at runtime are hosted via
the wildcard-hostname model, see PLAN §2/§8, not by editing their config.)

2026-07-15 also added the **GitHub access ladder** (PLAN §2/§6/§11.4): credentials
resolve PAT → GitHub App → ambient `gh` CLI session (`githubAmbient`, default on) →
anonymous git for public repos (gated on `allowPublicRepos`) → one-time PAT setup URL
as last resort. Onboarding responses (`list_apps` empty state, `github_auth_missing`)
carry `host: {hostname, user}` and steer a co-located agent to register an existing
local checkout (`deckhand app add <id> --path <dir>`) before any credential flow.

**Validated:** iOS + Android orchestration logic (faked unit tests), MCP over HTTP e2e,
the **Cloudflare named tunnel** (2026-07-15: `deckhand.sharghi.no` → loopback :4300,
healthz answers publicly, tokenless paths 404). **2026-07-15: first full real previews ran
end-to-end** on a dev Mac with `Okam-AS/AdminApp` (NativeScript), cloned via the ambient
gh credential: iOS (iPhone 17 Pro + iPad Pro 13" M5, one shared build, parallel install)
and **Android (pixel_7 · API 29 emulator, first real NativeScript Android build+stream)**.
Verified live over the tunnel share proxy on **both** platforms: touch/navigation, typing
(iOS via HID usage, Android via `input text`), and backspace (iOS delete, Android
KEYCODE_DEL). **Not yet validated on-device:** the local (`path`) livesync build path, and
scrcpy H.264 for Android (still the adb-screencap backend, a few fps). **Android streaming is the adb-screencap backend (a few fps); scrcpy H.264 is
a documented follow-up upgrade behind the same `StreamingBackend` seam** (PLAN §8).

**Migration features (2026-07-18):** deckhand can host an app→app migration (e.g.
NativeScript → React Native) as a *parity harness*. A target app declares `migratesFrom`
(the source app id); `start_migration_preview` boots both side by side; the viewer renders old vs
new in two columns (reusing `DeviceFrame` per shareId — no new proxy code) plus a parity
checklist read from `deckhand.migration.yaml` in the target repo. Deckhand runs/shows both
and reads the ledger; the agent translates code, judges parity, and writes the ledger.
See PLAN §6 "Migration features". No mechanical diff tool, no golden snapshots, no persisted
migration session — those were deliberately not built (agent is the comparator; keeps the
no-DB / no-repo-writes invariants clean).

Next phases: 3 (password shares + describe/ui/logs + add_app + **the agent-led
onboarding contract**, PLAN §6 — empty-state `nextStep`s, relayable errors, PAT auth,
one-time setup URL for secrets), 4 (ops + AI runbook).

If you are here to **implement further**, your instructions are:

1. Read [PLAN.md](./PLAN.md) end to end. It is the source of truth: locked decisions,
   architecture, module specs, and ordered phases with acceptance criteria.
2. Before writing streaming or viewer code, read
   [docs/reference/serve-sim-notes.md](./docs/reference/serve-sim-notes.md); before engine
   or viewer code, read
   [docs/reference/auto-mate-learnings.md](./docs/reference/auto-mate-learnings.md)
   (14 concrete pitfalls that cost the predecessor project weeks).
   `docs/reference/simdeck-notes.md` is historical — do not implement against it.
3. Work the phases in order (PLAN.md §12). Phase 0 is done (scaffold, green CI). Do not
   start a phase before the previous phase's acceptance criterion passes. Keep `npm test`
   green on every commit.
4. The streaming layer is **decided** (PLAN.md §2/§8): iOS via **serve-sim**
   (H.264-over-WebSocket + WebCodecs, MJPEG fallback), Android via **scrcpy** in Phase 2,
   both behind the `StreamingBackend` seam. **No WebRTC, no TURN, no SimDeck.** Vendor
   serve-sim's client parsing (Apache-2.0, keep attribution) instead of inventing a wire
   format.

Non-negotiables while implementing:

- Keep it small. No database, no SPA framework beyond the single viewer page, no new
  dependencies without a strong reason. When in doubt, re-read PLAN.md §2.
- Security invariants (PLAN.md §11) are acceptance criteria, not suggestions — especially:
  loopback-only binding, no tokenless paths, no secrets through MCP, tokens never in
  argv/URLs/logs.
- Structured, actionable MCP errors: the model relaying the error to a human must be able
  to say exactly what to do next.

## Later: setup runbook

When Phase 4 lands, this file will be rewritten as the **setup runbook** for an agent
installing deckhand on a Mac mini over SSH (preflight checks, ordered steps, the three
human questions, and `deckhand doctor` as the definition of done). Until then, setup
instructions live in PLAN.md §10.
