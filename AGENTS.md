# Agent guide — deckhand

## Current state: Phases 1, 2 & 2.5 implemented (iOS + Android, multi-device, local dev mode)

Phases 0–2.5 are done, and most of Phase 3 (CI green). The server has config/auth/state/audit,
GitHub App auth + git worktrees, build recipes + detection (Expo/RN/NativeScript, iOS +
Android), iOS simctl control, Android device layer (avdmanager/emulator/adb, uiautomator
describe, toolEnv), the streaming router (serve-sim for iOS, H.264/screencap backend for
Android), the preview engine (**platform-grouped, build-once-install-many, parallel
boots/installs**), the MCP server (token auth) + scoped share proxy, and the CLI.
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
KEYCODE_DEL). **Not yet validated on-device:** the local (`path`) livesync build path.
**Android streaming's primary path is H.264** (`adb exec-out screenrecord` repackaged to
AVCC, `streaming/androidH264.ts`); the adb-screencap MJPEG backend is now only the fallback
for system images with no working AVC encoder (notably the API 29 emulator). Both sit behind
the same `StreamingBackend` seam (PLAN §8).

**Migration features (2026-07-18, generalised 2026-07-31):** deckhand can host an app→app
migration (e.g. NativeScript → React Native) as a *parity harness*. A target app declares
`migratesFrom` (the source app id), and a parity checklist comes either from `items` on
`start_preview` or from `deckhand.migration.yaml` in the target repo. Deckhand runs/shows
the apps and reads the ledger; the agent translates code, judges parity, and writes the
ledger. No mechanical diff tool, no golden snapshots, no persisted migration session —
deliberately not built (agent is the comparator; keeps the no-DB / no-repo-writes
invariants clean).

**A page is a set of panes, not a pair.** There is no compare view and no compare tool.
`start_preview`'s `alongside` puts extra sources on the same page — another app, this app
at another ref, a worktree, an arbitrary repo, or `{}` for the registered `migratesFrom` —
and `shareState` returns `panes[]` (old → new, own share last). One link, one PIN, however
many sources; `pairedShareIds()` fans the unlock across them, so the old public-by-
construction reference pane is gone. Panes still stream from their **own** shareIds, so the
streaming seam is untouched and no new route is forwarded — the one proxy change is the
unlock minting fanning out from a single partner to the set. The viewer has ONE stage:
`computeStage` in `viewer/src/panes.ts` decides grouping and visibility as a pure function
(one source → all its devices; several → one each; mobile → one), and it is the only
tested code in `viewer/` — keep new layout rules there, not in `App.tsx`.
See PLAN §6 "One page, several sources" and the accepted-risk note beside it.

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
   both behind the `StreamingBackend` seam. **No WebRTC, no TURN, and no SimDeck for VIDEO** —
SimDeck's REST control surface *is* used for `describe`/`ui` (PLAN §6 amendment 2026-07-17);
the 2026-07-09 rejection was about its video transport only. Vendor
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

## The guardrails — read this before you change anything

`server/src/test-support/` holds checks that fail the build when a decision this
project already made gets broken. They exist because prose did not work: PLAN §2
and §11 say they are "acceptance criteria, not suggestions", and they were
broken repeatedly anyway by agents who had not read 885 lines.

If one of these fails, it is telling you about a decision — not asking you to
make the check pass.

| Check | What it protects |
|---|---|
| dependency allow-list · no DB driver | PLAN §2 "keep the list ruthlessly short". Adding a dep is a PLAN decision — argue it there, then widen the set |
| serve-sim pinned exactly + a matching patch file | The pin is a SECURITY control: serve-sim ships `/exec`, reachable from inside the simulator, which shares the host's loopback. `patch-package` strips it. A caret range drifts past the patch |
| no concrete backend imported outside `streaming/` | PLAN §8's seam. Two composition roots are named explicitly, so the exception is a decision rather than an erosion |
| every MCP tool wrapped in `audited()` | PLAN §11.2. A tool added without it is invisible to the audit trail and nothing else fails |
| exactly one `.listen()`, on 127.0.0.1 | PLAN §11.1. A wildcard bind puts the whole MCP surface on the LAN |
| the share gate keeps its `i` flag | Express dispatches routes case-insensitively. Losing it was a live auth bypass |
| every `detached: true` spawn stamps a marker | Four resources outlive the server; three leaked, one to 36 orphans at 418% CPU that starved the emulators. An in-memory Map is not an owner |
| docs name only tools and files that exist | PLAN documented a tool nobody built, and the dead name leaked into a tool *description* — text a model reads as instructions |

### Three rules that are not checkable, and cost the most when broken

1. **A new test must fail before it passes.** Write it, remove the fix, watch it
   fail, put the fix back. Every test in this repo that was added without that
   step turned out to assert nothing — including one that passed because a POSIX
   character class means something else in JavaScript.
2. **Fakes are complete or they lie.** Use `test-support/fakes.ts`, never
   `as unknown as X` on a literal. That form disables missing-property checking,
   so a new method on a real class leaves every fake silently behind. It cost
   four bugs in one day, and once made the orphan sweep a no-op that reported
   success.
3. **A comment that states a precondition needs a test that fails when the
   precondition breaks.** The worst bug of the last review was a correct comment
   ("a pane belongs to one page") that the same diff made false. No type, lint or
   test sees that — only a reader who is looking for it. Adversarial review is
   not optional here; it is the only thing that catches this class.

### Running them

`npm run hooks:install` once, and the two mechanical gates run before every
commit (`--no-verify` escapes; a hook that cannot be skipped gets uninstalled
instead). The device gate stays manual — it boots a simulator and is too slow to
sit in front of a commit.

Reviewing a diff — yours or someone else's — is the `reviewing-deckhand` skill in
`.claude/skills/`. It covers only what the guardrails cannot: preconditions a
diff invalidated, bookkeeping written before the effect it records, an assumption
of "one" surviving a move to N, permissive defaults on ambiguous failures, and
tests that assert less than they appear to. Those are the classes a fifty-bug
audit marked NOTHING PRACTICAL, and they include the worst bug in the set.

`npm test` runs everything, including the guardrails. `npm run typecheck` is the
other half — the fakes and branded types do their work at compile time, not run
time. CI runs both on every PR.

`deckhand doctor --smoke` is the only check that touches real hardware: it
creates a simulator, boots it, attaches a stream and waits for a first frame. Run
it after anything that touches the streaming path, because a whole class of bug
here — deadlines calibrated against an idle machine — is invisible to every test
above.

## Later: setup runbook

When Phase 4 lands, this file will be rewritten as the **setup runbook** for an agent
installing deckhand on a Mac mini over SSH (preflight checks, ordered steps, the three
human questions, and `deckhand doctor` as the definition of done). Until then, setup
instructions live in PLAN.md §10.
