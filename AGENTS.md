# Agent guide — deckhand


## Read this first

[`CONSTITUTION.md`](./CONSTITUTION.md) — what deckhand is, who it is for, and the
seven principles that settle an argument PLAN and this file do not. It is one page.
Every principle in it was paid for by a bug in this repo.

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
the **Cloudflare named tunnel** (2026-07-15: a named tunnel → loopback :4300, healthz
answers publicly, tokenless paths 404). **2026-07-15: first full real previews ran
end-to-end** on a dev Mac with a private NativeScript app, cloned via the ambient
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
   architecture, module specs, the MCP surface, and the security model.
2. Before writing streaming or viewer code, read
   [docs/reference/serve-sim-notes.md](./docs/reference/serve-sim-notes.md); before engine
   or viewer code, read
   [docs/reference/auto-mate-learnings.md](./docs/reference/auto-mate-learnings.md)
   (14 concrete pitfalls that cost the predecessor project weeks).
   `docs/reference/simdeck-notes.md` is historical — do not implement against it.
3. Deckhand is built. PLAN describes what it IS — architecture, the MCP surface, the
   streaming seam, the security model — not a build order. The phase list and the
   pre-build risk register were deleted once they started naming modules nobody had built
   and decisions long since made. Add to PLAN when you change what the system is; git
   holds how it got here.
   **Every bug fixed gets a regression test in the closest layer** — the one rule from the
   old §13 that is not covered by `npm run ci` or the guardrails.
4. The streaming layer is **decided** (PLAN.md §2/§8): iOS via **serve-sim**
   (H.264-over-WebSocket + WebCodecs, MJPEG fallback), Android via **adb** — `screencap`
   for MJPEG and on-device `screenrecord` for H.264, NOT scrcpy, which was evaluated and
   not taken — and web via a proxy to the dev server. All behind the `StreamingBackend`
   seam. **No WebRTC, no TURN, and no SimDeck for VIDEO** —
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
- Comment sparsely. Much of this codebase carries heavy comment blocks; do not match that
  density. Most code is self-explanatory — write a comment only when it states something
  the code cannot (a precondition, a decided tradeoff, a why), and remember: a comment
  that states a precondition needs a test that fails when the precondition breaks (see
  the three rules below). Never narrate what the next line does. And when a file you are
  already editing carries bloat comments — narration of the next line, restatements of
  the code, before/after changelog notes — delete them as you pass. Preconditions, whys
  and tradeoffs stay.

## How work lands here

**Run the `shipping-a-change` skill before you open the PR. Every time, including
the one-line fix.** It is in `.claude/skills/shipping-a-change/`. Nothing can force
you to — that is exactly why it is written down, and why step 5 of it turns whatever
you caught into a check that fires next time. Four of this repo's guardrails exist
because that step was skipped and a user found the defect instead.

**Never commit to `main`.** Every change — including a one-line fix — goes:

```
git switch -c feature/<short-name>     # branch first, always
… work, committing as you go …
npm run ci                             # exactly what CI runs; must be green
# ← run the shipping-a-change skill HERE, before the next line
gh pr create --base main               # PR, with the reasoning in the body
gh pr merge <n> --squash --delete-branch
```

**Branch from `main`, never from another PR's branch.** Stacking looks efficient
when two changes touch the same files. It is not, and both failure modes were
paid for in one session:

- Squash-merging the bottom PR rewrites its commits, so the PR above it still
  carries the originals and its diff double-counts. It has to be rebased before
  it means anything.
- Deleting the bottom branch on merge **auto-closes** every PR based on it —
  and a closed PR whose base branch is gone can be neither reopened nor
  retargeted. The work survives on `refs/pull/<n>/head`; the PR does not.

If two changes really are entangled, put them in one PR, or land the first and
wait. `main` is protected and requires green CI, so waiting costs one CI run.

**Branching from `main` is necessary but not sufficient — `main` is `strict`.**
Protection requires a PR to be *up to date* with `main`, not merely conflict-free.
So the second and every later branch cut from the same `main` goes `BEHIND` the
moment the first one lands, and `gh pr merge` refuses with a message that names a
status check rather than the real reason:

```
GraphQL: Required status check "check" is expected. (mergePullRequest)
```

That message is misleading — the check had already passed. Ask what is actually
wrong before believing it:

```sh
gh pr view <n> --json mergeable,mergeStateStatus   # BEHIND is the answer, not the check
git switch <branch> && git rebase origin/main      # then force-with-lease, then wait for CI
```

Four PRs opened together cost three rebases and three serialized CI runs. **Open
one, land it, open the next** — the cost of parallel PRs is paid at merge time,
which is exactly when you have stopped thinking about it.

**After a force-push, `gh pr checks` reports the PREVIOUS run.** There is a window
where the old conclusion is still attached to the PR, so a poll for `pass` returns
immediately, the merge is attempted against a head with no finished check, and it
is rejected. Poll the check runs for the *current head SHA* instead:

```sh
SHA=$(git rev-parse origin/<branch>)
gh api "repos/Okam-AS/deckhand/commits/$SHA/check-runs" \
  --jq '[.check_runs[]|select(.name=="check")|{status,conclusion}]|.[0]'
```

**Leaving the branches tidy is the agent's job, not the user's.** Finish the
session with no open PRs you meant to land, no local branch that is not `main`,
and no branch on the remote whose PR is closed. `gh pr list --state open` and
`git branch` take a second each; a user who has to ask "is this merged?" has been
handed your bookkeeping.

**Watch out for `--delete-branch`**: it switches you to `main` without saying so.
Chaining `gh pr merge ... --delete-branch && git switch <next>` silently skips
the switch, and the next command runs against `main`.

Why a PR for a one-liner. It is not ceremony — it is the only point where a
reader who has not seen the change looks at it. A fifty-bug audit of one session
marked three defect classes NOTHING PRACTICAL for automation, and they included
the worst bug in the set: a cross-page authentication bypass, found by cold
readers, two of them independently. There is no tool that replaces that step, so
the workflow has to create it.

The PR body carries the reasoning, not a changelog. What was wrong, why this is
the fix, and what you verified — a reviewer's questions, answered before they
ask. If you fixed a bug, say what you did to prove the test fails without the
fix.

**Delete the branch on merge.** `--delete-branch` does it; a stale branch is a
second version of the truth waiting to be mistaken for the current one.

**Deploy after merging, not before.** `launchctl kickstart -k
gui/$(id -u)/no.deckhand.server` tears down every booted simulator on the
machine — so a restart mid-session costs whoever is watching a preview several
minutes of rebuilding. Batch them, and say so before you do it.

## Running the checks

```
npm run ci              # typecheck + tests + build — EXACTLY what CI runs
npm run hooks:install   # once: makes the above run before every commit
npm run test:device     # real simulator, real helper, real first frame
```

`npm run ci` exists so "will CI pass?" is answerable in fifteen seconds instead
of after a push. The pre-commit hook runs the same command — if the two ever
diverge, the hook is the one that is wrong. `--no-verify` deliberately still
works: a hook that cannot be skipped gets uninstalled instead of respected.

`test:device` is not in the hook and not in CI (GitHub runners cannot do Android
emulators, so a green run there would mean "half the devices" while reading as
"all of them"). It boots a real simulator AND a real emulator, so it takes
several minutes. Run it by hand.

### Dev-build overlays: deckhand switches them off, you do not

An Expo dev build registers three launch overlays as UserDefaults *defaults*
(`EXDevMenuShowsAtLaunch`, `EXDevMenuIsOnboardingFinished`,
`EXDevMenuShowFloatingActionButton` — see `expo-dev-menu`'s
`DevMenuPreferences.swift`). Deckhand writes all three off before it launches the
app, so a preview comes up straight into the app's own UI.

Writing them needs no detection: on a non-Expo app they are unread keys in its own
preference domain, and writing them twice is the same as writing them once. That is
why this is not "check whether the app is Expo, and whether the button is already
off" — there is nothing to check.

**The line, and it matters:** deckhand may switch off what the DEV BUILD added, and
must never touch what the APP does. A location permission alert is not on that list
on purpose — a user meets it too, so an agent should dismiss it the way a user
would. Granting it silently would have every agent testing a flow nobody ships.

If a dev menu still appears, `describe` says so and how to close it. Treat that as
deckhand's packaging, never as an app bug: three separate runs in one session hit a
dev overlay and reported a working app as having "critical UI bugs".

### Nothing is "tested" until this is green

`npm run test:device` is the only check that touches hardware. It verifies three
capabilities on **both** platforms, as six independent checks:

|  | boot | stream | describe |
|---|---|---|---|
| **ios** | `simctl create` + boot | serve-sim first frame | accessibility tree |
| **android** | AVD create + emulator boot | adb helper first frame | `uiautomator dump` |

They are separate checks on purpose: "it booted" must never stand in for "it
streamed". A device that comes up and never produces a frame is the most common
failure on this machine, and it was invisible while one check covered both.

**Do not report a change to the device, streaming, or control path as tested
without pasting this output.** Not "tests pass" — that is `npm run ci`, which
never touches a device. If you cannot run it, say which of the six is unverified
and who has to run it. `?` is an honest answer; a tick you did not earn is not.

What it does NOT cover, so do not imply it does: **input injection**. A tap
landing on the device rides the WebSocket bridge and needs a viewer on the other
end. `describe` proves the control path can READ; nothing here proves it writes.

The gate found a real bug on its first run against hardware: `describe` returned
`""` for a failed `uiautomator dump`, so a failed lookup and a blank screen were
the same value — and an agent reading that tree would confidently report an empty
screen. That is the class this exists to catch.

## Waiting for a preview to build

An agent on THIS machine should read `~/.deckhand/state.json` rather than
sleep-looping `preview_status` — and must check every device for an `error`
before trusting the preview phase, because a preview with one failed device and
one ready device reports `ready` (`preview.ts:952`). The how-to, including a
ready-to-paste poller, is the `waiting-for-a-preview` skill in `.claude/skills/`.

## If a tool response carries `deckhandUpdate`

Every successful tool response carries `deckhandUpdate` when the code the server
is RUNNING is not the newest — in one of two states, which need different words:

- `action: "restart"` — the checkout was already pulled and the process is still
  on the old code. Ask: **"deckhand has been updated on disk but is still running
  the old code — restart it?"**
- `action: "pull-and-restart"` — there is newer code on `main`. Ask: **"there is a
  newer deckhand — pull and restart?"**

**Ask, then stop.** Do not pull and do not restart on your own: a restart tears
down every booted simulator on the machine, so someone may be mid-test on a
preview you cannot see. Offer it in one sentence, at the top of your reply — not
buried under a status list.

The version is the commit (`version.ts`) — nothing to bump, so nothing to forget.
It only speaks when the checkout is a clean `main`; a feature branch or a dirty
tree gets a factual note instead of a nag, because a notice that fires when it
should not is one nobody reads when it should.

## Setting a user up, or unsticking one

You will be asked "how do I install this" and "why is my connector not working".
Get these exactly right — three times in one day an agent (me) told a user to run
something that did not exist, and each time they assumed the fault was theirs.

**Install, from nothing.** Do NOT write out the steps from memory — this section
deliberately does not list them, because it drifted from the code within a day of
being written. Run the command and relay what it says:

```sh
git clone https://github.com/Okam-AS/deckhand && cd deckhand
npm install && npm run build
npx tsx server/src/cli.ts setup          # no arguments, on purpose
```

`setup` with no arguments is a preflight. It prints every prerequisite with **who
can fix it**, and — this is the part to get right — it distinguishes an errand
from a question:

- `fix: <command>` — yours to run. Run it.
- **BLOCKED** — an errand needing a browser or their Cloudflare account. Relay it
  and stop. **Never attempt these**; `cloudflared tunnel login` opens a browser
  and will hang you forever, and retrying changes nothing.
- **ASK THE USER** — an input, not an obstacle. Ask the one question in the words
  given, take the answer, and carry on yourself.

**Do not paste the report at the user.** When nothing is missing and nothing is
blocked, the only thing left is one answer — so ask one question. An agent that
files a status report there has turned a ten-second exchange into a puzzle.

Then run `setup --hostname <their answer>`. It does the rest — tunnel, DNS, the cloudflared config
(merged, never overwritten), the `deckhand` command, the LaunchAgents, doctor —
and is safe to re-run, so it is also the repair tool.

`npx tsx …` for the first run only: `deckhand` is not on PATH until setup links it.

Android is **optional**. Without the SDK, iOS previews work and Android does not;
`doctor` says so as a warning. Do not treat it as a failed install.

**When setup finishes, lead with the one action — do not report status.**
deckhand is installed and *does nothing* until the connector is pasted into
claude.ai. That is not one item in a list of five; it is the step. Say it first,
in two lines:

> Run `deckhand token` and paste the URL into claude.ai → Settings → Connectors.

Then, if it is useful, what you did. Not before. A user who reads three lines and
stops must still have the thing they need — and they will stop, because a numbered
list of green ticks reads as "nothing left to do".

**Their connector URL:** `deckhand token`. Creates one the first time, prints the
same one after. NOT `token list`, which masks them by design. It is a credential —
never repeat it back in chat, and never put it in a commit or a PR.

**Registering something to preview:**

```sh
deckhand app add <id> --path /abs/path/to/their/checkout   # local, no GitHub needed
deckhand app add <id> github.com/owner/repo                # from git
```

Local is the default when they are working in a project. See the `nextStep` that
`list_apps` returns on an empty install — it is written for you, and it is right.

**When something is wrong:** `deckhand doctor` first, always. It names the missing
piece and the command that fixes it. `deckhand doctor --device-only` boots a real
simulator and emulator; it takes minutes and is the only check that touches
hardware.

**Never** run `launchctl kickstart` on the server without saying so first: it tears
down every booted simulator on the machine, and somebody may be watching a preview
you cannot see.

## Before you change an area, read its rule

`.claude/rules/` holds one file per area, each scoped to the paths it covers, so
Claude Code surfaces the right one the moment you open a file there. They carry
what a guardrail cannot: WHY the rule exists, and what it cost when it was
broken. Every rule cites the check that enforces it, and a check renamed out
from under a citation fails `docs.test.ts`.

| Rule | Covers |
|---|---|
| `streaming.md` | `server/src/streaming/**` — the backend seam, loopback binds, helper ownership |
| `engine.md` | `server/src/engine/**`, `server/src/devices/**` — detached spawns, ordering, borrow-never-own |
| `share-proxy.md` | `server/src/share/**` — the public surface; both auth bypasses lived here |
| `mcp-tools.md` | `server/src/mcp/**` — the agent-facing surface, where a description IS a prompt |
| `tests.md` | every `*.test.ts` — see it fail first; fakes are complete or they lie |

## The guardrails — read this before you change anything

`server/src/test-support/` holds checks that fail the build when a decision this
project already made gets broken. They exist because prose did not work: PLAN §2
and §11 say they are "acceptance criteria, not suggestions", and they were
broken repeatedly anyway by agents who had not read 885 lines.

If one of these fails, it is telling you about a decision — not asking you to
make the check pass.

| Check | What it protects |
|---|---|
| dependency allow-list (runtime + dev, incl. the root package.json) · no DB driver | PLAN §2 "keep the list ruthlessly short". Adding a dep is a PLAN decision — argue it there, then widen the set. The root and `devDependencies` are in scope because a dep added there hoists into the shared `node_modules` and is importable everywhere |
| serve-sim pinned exactly + a matching patch file | The pin is a SECURITY control: serve-sim ships `/exec`, reachable from inside the simulator, which shares the host's loopback. `patch-package` strips it. A caret range drifts past the patch |
| no concrete backend imported outside `streaming/` | PLAN §8's seam. Two composition roots are named explicitly, so the exception is a decision rather than an erosion |
| every MCP tool wrapped in `audited()` | PLAN §11.2. A tool added without it is invisible to the audit trail and nothing else fails |
| every `.listen()` binds 127.0.0.1, and server.ts has exactly one | PLAN §11.1. A wildcard bind puts the whole MCP surface on the LAN. Repo-wide: the per-device Android helper binds a socket too. One exemption, by file and reason: metro.ts's port-availability probe, which must bind every interface to mean anything |
| the share gate keeps its `i` flag | Express dispatches routes case-insensitively. Losing it was a live auth bypass. Checked on every matching line with comments stripped — quoting the pattern in a comment used to satisfy it |
| every detached spawn stamps a marker (any `detached:` that is not `false`) | Four resources outlive the server; three leaked, one to 36 orphans at 418% CPU that starved the emulators. An in-memory Map is not an owner |
| docs name only tools and files that exist | PLAN documented a tool nobody built, and the dead name leaked into a tool *description* — text a model reads as instructions. There is no "but I'm recording history" exemption: PLAN and this file describe what exists now, and git holds the past |

### Three rules that are not checkable, and cost the most when broken

1. **A new test must fail before it passes.** Write it, remove the fix, watch it
   fail, put the fix back. Every test in this repo that was added without that
   step turned out to assert nothing — including one that passed because a POSIX
   character class means something else in JavaScript.
2. **Fakes are complete or they lie.** Use `test-support/fakes.ts`, never
   `as unknown as X` on a literal. `fakes.ts` currently covers two of the twelve
   injected dependencies, so most fakes in the tree still take the banned form —
   convert the one you touch rather than copying it. That form disables missing-property checking,
   so a new method on a real class leaves every fake silently behind. It cost
   four bugs in one day, and once made the orphan sweep a no-op that reported
   success.
3. **A comment that states a precondition needs a test that fails when the
   precondition breaks.** The worst bug of the last review was a correct comment
   ("a pane belongs to one page") that the same diff made false. No type, lint or
   test sees that — only a reader who is looking for it. Adversarial review is
   not optional here; it is the only thing that catches this class.

### Reviewing

Reviewing a diff — yours or someone else's — is the `reviewing-deckhand` skill in
`.claude/skills/`. It covers only what the guardrails cannot: preconditions a
diff invalidated, bookkeeping written before the effect it records, an assumption
of "one" surviving a move to N, permissive defaults on ambiguous failures, and
tests that assert less than they appear to. Those are the classes a fifty-bug
audit marked NOTHING PRACTICAL, and they include the worst bug in the set.

## Later: setup runbook

When Phase 4 lands, this file will be rewritten as the **setup runbook** for an agent
installing deckhand on a Mac mini over SSH (preflight checks, ordered steps, the three
human questions, and `deckhand doctor` as the definition of done). Until then, setup
instructions live in PLAN.md §10.
