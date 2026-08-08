# Agent guide — deckhand

## Read this first

[`CONSTITUTION.md`](./CONSTITUTION.md) — ten principles that settle an argument PLAN and
this file do not. One page, every principle paid for by a bug here.

[PLAN.md](./PLAN.md) is the source of truth: locked decisions, architecture, module specs,
the MCP surface, the security model. Read it end to end before you implement. Before
streaming or viewer code, read [serve-sim-notes](./docs/reference/serve-sim-notes.md);
before engine or viewer code, [auto-mate-learnings](./docs/reference/auto-mate-learnings.md).

## What deckhand is today (iOS + Android, multi-device, local dev mode)

*(What exists, not how it got here. When you change what the system is, change this
section and PLAN in the same PR. Deckhand is built: PLAN describes what it IS, so do not
add a phase list, a risk register or a dated "Validated:" log back to either.)*

PLAN describes the architecture. The invariants that bind every change:

- **The daily dev loop** (PLAN §2): local `path` apps build in place — no worktree, no push,
  NativeScript as a long-lived livesync process with HMR off — `start_preview` is idempotent,
  share URLs are stable per app (persisted in state.json), `restart_preview` rebuilds in place
  (git: fetch+reset; local: re-run) on the same booted devices, named refs always fetch, and
  the viewer has a Rebuild button for local shares.
- **A local app's source dir is borrowed, never owned:** never `npm ci`-wiped, never
  removed on teardown, and its git state is deckhand's to read/run, never to write.
  Anything deckhand generates to host the app stays **untracked** — outside the tree, or
  appended to the checkout's `.git/info/exclude`. Never commit or push local changes
  deckhand caused in a user's repo. (Hence the `web` type injecting Vite's base/host/port
  as runtime CLI flags; frameworks that cannot be configured at runtime use the
  wildcard-hostname model, PLAN §2/§8, not an edited config.)
- **The connector is public; the approval is not** (PLAN §11.6). `/mcp` takes an
  `Authorization: Bearer` credential and never a path token — a connector URL added in a
  Claude organisation is visible to everyone in it, so the URL cannot be the secret.
  `/oauth/authorize` asks for a **pairing code**, and the only place one exists is
  `deckhand pair` on the machine. Nothing incoming is stored, so there is nothing to flood;
  wrong tries lock out the guesser, never the code, since burning it would let a stranger
  shred every code the operator mints. `deckhand revoke <client-id>` takes a client back on
  its next call. Claude Code on the machine uses a local `tokens.yaml` bearer token instead.
- **The GitHub access ladder** (PLAN §2/§6/§11 item 4): PAT → GitHub App → ambient `gh` CLI
  session (`githubAmbient`) → anonymous git for public repos (gated on `allowPublicRepos`)
  → one-time PAT setup URL. Onboarding responses (`list_apps` empty state,
  `github_auth_missing`) steer a co-located agent to register a local checkout first.
- **Streaming is decided** (PLAN §2/§8), all behind the `StreamingBackend` seam. iOS via
  serve-sim, whose `stream.avcc` rides a long-lived **chunked HTTP** response decoded with
  WebCodecs, NOT a WebSocket — the WebSocket carries no video, and whether avcc works is a
  runtime probe (404 → `stream.mjpeg`), never written down in advance. Android via adb,
  NOT scrcpy, which was evaluated and not taken: H.264 (`streaming/androidH264.ts`) with
  screencap MJPEG only as the fallback for images with no working AVC encoder. Web via a
  proxy to the dev server. **No WebRTC, no TURN, no SimDeck for VIDEO** — SimDeck's REST
  control surface *is* used for `describe`/`ui`; only its video transport was rejected.
  Vendor serve-sim's client parsing (Apache-2.0, keep attribution) rather than invent a
  wire format.
- **Migration is a parity harness, not a diff tool.** Deckhand runs the apps and reads the
  ledger; the agent judges parity and writes it. A target app declares `migratesFrom` (the
  source app id) and the checklist comes from `items` on `start_preview` or from
  `deckhand.migration.yaml` in the target repo. No diff tool, no golden snapshots, no
  persisted session — deliberately not built.
- **A page is a set of panes, not a pair** (PLAN §6), and there is no compare view or
  compare tool. `start_preview`'s `alongside` puts extra sources on one page — another app,
  this app at another ref, a worktree, an arbitrary repo, or `{}` for the registered
  `migratesFrom` — and `shareState` returns `panes[]`; one link, one PIN, `pairedShareIds()`
  fanning the unlock across them. Panes stream from their **own** shareIds, so the streaming seam is
  untouched. The viewer has ONE stage: `computeStage` in `viewer/src/panes.ts` decides
  grouping and visibility as a pure function, so keep new layout rules there and not in
  `App.tsx`, which has no tests of its own.
- **Physical devices are OUT** on both platforms; PLAN §2 says why. **Three known gaps, so
  do not imply otherwise:** the local (`path`) livesync build path is unvalidated on-device,
  the `metro`/`app` `logs` sources are accepted and capture nothing, and PLAN §11 item 7's
  host hygiene (dedicated macOS user, no personal credentials, FileVault) is stated in PLAN
  and in no runbook — nothing tells an operator how to set it up or check it holds.

Non-negotiables while implementing:

- Keep it small. No database, no SPA framework beyond the single viewer page, no new
  dependency without a strong reason. In doubt, re-read PLAN §2.
- Security invariants (PLAN §11) are acceptance criteria: loopback-only binding, no
  credentialless path to a device or a repo (PLAN §11 item 1 tabulates the
  seven open-by-construction OAuth handlers — count them against `server/src/oauth/router.ts`
  before you trust the list), no secrets through MCP, tokens never in argv/URLs/logs.
- Structured, actionable MCP errors: the model relaying one to a human must be able to say
  exactly what to do next.
- **Every bug fixed gets a regression test in the closest layer** — the one rule not
  covered by `npm run ci` or the guardrails.

## Comments

**The default is no comment.** Agents write far too many here — a fix feels like it needs
its story told beside it, and it does not. Anyone reading this code can read code, so the
*what* is already on screen. A comment is the exception, it is **one line**, and only three
reasons qualify:

- A **quirk** — a platform or a dependency behaving unlike its docs.
- A **deliberate divergence or a decided tradeoff** — state the rule, so the next agent
  does not "fix" it back.
- A **trap** — the obvious edit reintroduces a bug. Name the bug, not the reasoning.

Do **not** narrate: the bug you just fixed, what a review said, what the code plainly
does, or why an alternative was rejected. That belongs in the commit message, the PR, or a
test name. **A test name is cheaper than a comment — prefer it**, and a guardrail in
`server/src/test-support/` is cheaper than prose anyone can skip.

Two rules that survive the brevity:

- **A comment stating a precondition needs a test that fails when the precondition
  breaks** — and if none exists, say so in the comment.
- **Delete an obsolete claim; do not annotate it.** "Superseded", "no longer used" — a
  reader landing mid-file via grep acts on the thing you labelled dead. The one exception:
  a rejected design is load-bearing when deleting it would let the next agent rebuild the
  bug, and that belongs in the `.claude/rules/` file for the area, not in a document that
  rots.

When a file you are editing carries narration or changelog notes, delete them as you pass.
A diff that adds more comment lines than code lines is the signal: cut it back.

**The same applies to every sentence you leave behind** — doc, tool description, test name,
landing copy — because a reader acts on it without seeing what you saw, and a false map is
trusted where an absent one is not. Two rules beyond deleting the obsolete claim:

- **Do not restate what you can point at.** Install steps, a dependency's capabilities, a
  line number, a test count, a file tree: all of these rotted here, one within a day of
  being written. Point at the command, probe the capability, name the method.
- **Put the past tense IN the sentence, never only in the heading** — a grep landing does
  not see the heading. Never delete the example itself: it is the evidence the rule was
  paid for.

## HOW WE WORK — the lead agent delegates, it does not code

**Standing law for every task a human hands the lead agent.** The human's time with the
agent is the scarce resource; the lead agent stays free to talk, decide and untangle, so
it does NOT do the work itself:

1. **One task in, one subagent out** — its own `Agent` call with a self-contained brief:
   what to change, which files, which rule files and gates apply.
2. **The lead agent stays available**, in conversation with the human. It never disappears
   into a long edit of its own.
3. **Conflicts are the lead agent's job** — it decides, or asks the human when the call is
   theirs. Subagents never resolve each other's conflicts.
4. **Subagents ship their own slice**: each runs the gates for what it touched — `npm run
   ci`, plus § "Nothing is \"tested\" until this is green" for anything on the device,
   streaming or control path — and reports evidence. The lead agent re-runs the full gate after conflict resolution, since a merge
   can break what each half proved green.
5. **Commit per landed slice**, not per batch — a long uncommitted run is how work gets
   lost. **Never `git add -A` / `git add .`**, and never bare `git commit -m` / `git commit
   -a` over a pre-populated index: in a shared tree each sweeps another agent's
   half-finished file into your commit, which happened three times in two days. `git commit
   --only <your paths>` is the form that cannot do it. Then read `git show --stat`; if the
   file list is not yours alone, `git reset --soft HEAD~1` and re-commit with `--only`.
   **Never `git commit --amend`** — `HEAD` is not yours, and an amend once rewrote another
   agent's commit. Make a second commit; tidy history is not worth their work.
6. **Exceptions the lead agent may do inline:** answering a question, reading to brief a
   subagent, a one-line fix, and the conflict resolution itself.

## How work lands here

**Run the `shipping-a-change` skill before you open the PR. Every time, including the
one-line fix.** Nothing can force you to — that is why it is written down, and why its
step 5 turns whatever you caught into a check. Four guardrails here exist because that
step was skipped and a user found the defect instead.

**You may open the PR yourself — once `review:handover` has written the body.** Nothing
local blocks `gh pr create`, and nothing can: `--body` and `--fill` need no file. This is
a rule with a strong default, not an enforcement; say it that way. The permission is a
conjunction:

1. `npm run ci` is green, and `npm run review:gates` is green on a clean checkout of HEAD.
2. `npm run review:check` says the review converged — at least two rounds, one of them
   cold against the code AS IT SHIPS, nothing blocking left standing.
3. `npm run review:handover` exited 0 and wrote `.claude/pr-body.md`.
4. The branch is pushed, and it is not `main`.

All four, then run the command it printed. Any one missing and you have not earned it —
say which one, in a line, and stop. Do not hand-write a body or reach for `--body` /
`--fill` to route around step 3: forging the handover is the one thing here no later
reader can catch.

**Never commit to `main`.** Every change — including a one-line fix — goes:

```
git switch -c feature/<short-name>     # branch first, always
… work, committing as you go …
npm run ci                             # exactly what CI runs; must be green
# ← run the shipping-a-change skill HERE: review to convergence, record each round
npm run review:gates                   # the same gates on a clean checkout of HEAD
git push -u origin feature/<name>
npm run review:handover <<'BODY' …     # refuses unless the review converged
```

The review is a loop with a receipt, not a single pass: `npm run review:show`,
`review:check`, `review:round`. Two things cost a round if you learn them late: the cold
round must have read the code as it ships (`cold → fix → inline` is refused — budget for
`cold → fix → cold`), and a blocking finding leaves the record two ways, fixed (a later
round lists its fingerprint in `resolved`, and the file it names holds different bytes) or
waived with a reason plus a cold round after it. Silence is not a resolution. Mechanics
and honest limits: the `shipping-a-change` skill and `scripts/review-receipt.ts`.

Merging is yours once the PR exists: `gh pr merge <n> --squash --delete-branch`.

**Branch from `main`, never from another PR's branch.** Squash-merging the bottom PR
rewrites its commits, so the one above double-counts its diff until rebased — and
`--delete-branch` on the bottom auto-closes every PR based on it, which can then be
neither reopened nor retargeted. Entangled changes go in one PR, or land the first and wait.

**`main` is `strict`**, so a PR must be *up to date*, not merely conflict-free: the second
branch cut from the same `main` goes `BEHIND` the moment the first lands, and `gh pr merge`
refuses with a message naming a status check that had already passed. Ask what is actually
wrong before believing it:

```sh
gh pr view <n> --json mergeable,mergeStateStatus   # BEHIND is the answer, not the check
git switch <branch> && git rebase origin/main      # then force-with-lease, then wait for CI
```

**Open one PR, land it, open the next** — four opened together cost three rebases and
three serialized CI runs.

**After a force-push, `gh pr checks` reports the PREVIOUS run**, so a poll for `pass`
returns immediately and the merge is rejected against a head with no finished check. Poll
the check runs for the *current head SHA*:

```sh
SHA=$(git rev-parse origin/<branch>)
gh api "repos/Okam-AS/deckhand/commits/$SHA/check-runs" \
  --jq '[.check_runs[]|select(.name=="check")|{status,conclusion}]|.[0]'
```

**`--delete-branch` switches you to `main` without saying so**, so chaining it with
`&& git switch <next>` silently skips the switch. **Leaving the branches tidy is the
agent's job:** end the session with no open PR you meant to land, no local branch that is
not `main`, no remote branch whose PR is closed.

The PR body carries the reasoning, not a changelog: what was wrong, why this is the fix,
what you verified. If you fixed a bug, say what proved the test fails without it. Even a
one-liner earns a PR — it is the only point where a reader who has not seen the change
looks at it, and two cold readers independently found this repo's worst bug, a cross-page
authentication bypass, that way.

**Deploy after merging, not before.** `launchctl kickstart -k gui/$(id -u)/no.deckhand.server`
tears down every booted simulator on the machine, costing whoever is watching a preview
several minutes of rebuilding. Batch restarts, and say so before you do one.

## Running the checks

```
npm run ci              # typecheck + tests + build — EXACTLY what CI runs
npm run hooks:install   # once: makes the above run before every commit
npm run test:device     # real simulator, real helper, real first frame
```

The pre-commit hook runs the same command as CI — if the two diverge, the hook is wrong.
`--no-verify` deliberately still works: a hook that cannot be skipped gets uninstalled
instead of respected.

### Dev-build overlays: deckhand switches them off, you do not

An Expo dev build registers three launch overlays as UserDefaults *defaults*
(`EXDevMenuShowsAtLaunch`, `EXDevMenuIsOnboardingFinished`,
`EXDevMenuShowFloatingActionButton`); deckhand writes all three off before launch. That
needs no detection — on a non-Expo app they are unread keys in its own preference domain,
and writing them twice is the same as once — so do not add an "is it Expo, is it already
off" check.

**The line, and it matters:** deckhand may switch off what the DEV BUILD added, never what
the APP does. A location permission alert is deliberately not on that list — a user meets
it too, so an agent should dismiss it the way a user would.

If a dev menu still appears, `describe` says so and how to close it. Treat that as
deckhand's packaging, never an app bug: three runs in one session hit a dev overlay and
reported a working app as having "critical UI bugs".

### Nothing is "tested" until this is green

`npm run test:device` is the hardware pass and one spelling of `deckhand doctor
--device-only`; `deckhand doctor --smoke` runs the same device checks, differing in exit
code, not work (`cli.ts`, and PLAN §10 says which is for what). Nothing else in the repo
touches a device; plain `doctor` and `npm run ci` are paperwork. It is not in the hook and
not in CI, because GitHub runners cannot do Android emulators and a green run there would
mean "half the devices" while reading as "all of them" — so run it by hand; it takes
several minutes. Three capabilities on **both** platforms, as six independent checks:

|  | boot | stream | describe |
|---|---|---|---|
| **ios** | `simctl create` + boot | serve-sim first frame | accessibility tree |
| **android** | AVD create + emulator boot | adb helper first frame | `uiautomator dump` |

Separate on purpose: "it booted" must never stand in for "it streamed" — a device that
comes up and never produces a frame is the most common failure here, and it was invisible
while one check covered both.

**Do not report a change to the device, streaming or control path as tested without
pasting this output.** Not "tests pass" — that is `npm run ci`, which never touches a
device. If you cannot run it, say which of the six is unverified and who has to run it.
`?` is an honest answer; a tick you did not earn is not. It does NOT cover **input
injection**: `describe` proves the control path can READ, nothing more.

## Waiting for a preview to build

An agent on THIS machine reads `~/.deckhand/state.json` rather than sleep-looping
`preview_status` — and must check every device for an `error` before trusting the phase,
because a preview with one failed and one ready device reports `ready`
(`recomputePreviewPhase` in `server/src/engine/preview.ts`). Poller and traps: the
`waiting-for-a-preview` skill.

## If a tool response carries `deckhandUpdate`

Every successful JSON tool response carries `deckhandUpdate` when the code the server is
RUNNING is not the newest. (`screenshot` is the one exception — an image block has nowhere
to put JSON; `mcp/responses.test.ts` keeps it the only one.) Two states, two wordings:

- `action: "restart"` — already pulled, process still on the old code. Ask: **"deckhand has
  been updated on disk but is still running the old code — restart it?"**
- `action: "pull-and-restart"` — newer code on `main`. Ask: **"there is a newer deckhand —
  pull and restart?"**

**Ask, then stop.** Do not pull and do not restart on your own: a restart tears down every
booted simulator, so someone may be mid-test on a preview you cannot see. Offer it in one
sentence at the top of your reply, not buried under a status list.

The version is the commit (`version.ts`) — nothing to bump. `pull-and-restart` compares
against `origin/main` and speaks only on a clean `main` checkout, because a feature branch
is not "out of date"; `restart` compares the sha this process booted on against the sha on
disk, so it fires on any branch and on a dirty tree.

## Setting a user up, or unsticking one

Get this right: three times in one day an agent told a user to run something that did not
exist, and each time they assumed the fault was theirs.

**Install, from nothing.** Do NOT write out the steps from memory — this section
deliberately does not list them, because it drifted from the code within a day. Run the
command and relay what it says:

```sh
git clone https://github.com/Okam-AS/deckhand && cd deckhand
npm install && npm run build
npx tsx server/src/cli.ts setup          # no arguments, on purpose
```

`setup` with no arguments is a preflight: every prerequisite with **who can fix it**, and
it distinguishes an errand from a question.

- `fix: <command>` — yours to run, and **the only one of the four you may run.**
- `you: <what to do>` — only a person at this Mac can do it (an App Store install, an Apple
  ID, a `sudo` licence accept, the machine's default Node). Relay the line as written and
  stop; setup is safe to re-run once they say it is done. Say these as the local chores they
  are — reporting one as blocked reads as "the install failed".
- **BLOCKED** — also relay-and-stop, but an errand off this machine: a browser and their
  Cloudflare account. Never attempt these; the Cloudflare tunnel login opens a browser and
  hangs you forever.
- **ASK THE USER** — an input, not an obstacle. Ask each question in the words given and
  carry on yourself. There is more than one.

**Do not paste the report at the user.** With nothing missing and nothing blocked, the only
thing left is the ASK THE USER questions — ask those, and nothing else.

Then run `setup --hostname <their answer>` (plus `--web-host <their answer>` for web
previews). It does the rest and is safe to re-run, so it is also the repair tool. `npx tsx
…` is for the first run only: `deckhand` is not on PATH until setup links it.

Android is **optional**. Without the SDK, iOS previews work and Android does not; `doctor`
says so as a warning. Not a failed install.

**When setup finishes, lead with the one action — do not report status.** deckhand is
installed and *does nothing* until the connector is pasted into claude.ai. Say it first:

> Run `deckhand token` and paste the URL into claude.ai → Settings → Connectors,
> then click Connect — the page asks for a pairing code. Here is one: `ABC-123`.

Then, if useful, what you did. Not before. A user who reads three lines and stops must
still have the thing they need.

**Their connector URL:** `deckhand token` — just `https://<their-host>/mcp`. It carries no
secret, so relaying it in chat is fine. **Run `deckhand pair` yourself and give them the
code** in the same breath, or a page asking for a code they have never heard of reads as
broken. With no local credential nothing can be minted; `deckhand doctor` fails on that,
and it is not a warning.

Do not confuse that with `deckhand token add|url <name>`, which mints a LOCAL bearer
credential for Claude Code on the machine. That one IS a password: never repeat it in chat,
never in a commit, a PR, or a URL. `token list` masks them by design.

**Registering something to preview:**

```sh
deckhand app add <id> --path /abs/path/to/their/checkout   # local, no GitHub needed
deckhand app add <id> github.com/owner/repo                # from git
```

Local is the default when they are working in a project. See the `nextStep` that
`list_apps` returns on an empty install — it is written for you, and it is right.

**When something is wrong:** `deckhand doctor` first, always; it names the missing piece
and the command that fixes it. `deckhand doctor --device-only` is the same run as `npm run
test:device`, so running one is not a reason to skip the other. Restarting the server to
unstick someone is subject to the same rule as deploying — say so first.

## Before you change an area, read its rule

`.claude/rules/` holds one file per area, scoped to the paths it covers, so Claude Code
surfaces the right one when you open a file there. They carry what a guardrail cannot: WHY
the rule exists and what it cost. Every rule cites the check that enforces it, and a check
renamed out from under a citation fails `docs.test.ts`.

| Rule | Covers |
|---|---|
| `streaming.md` | `server/src/streaming/**` — the backend seam, loopback binds, helper ownership |
| `engine.md` | `server/src/engine/**`, `server/src/devices/**` — detached spawns, ordering, borrow-never-own |
| `share-proxy.md` | `server/src/share/**` — the public surface; both auth bypasses lived here |
| `connector-auth.md` | `server/src/oauth/**`, `auth.ts` — who may drive this Mac; the connector URL is public |
| `mcp-tools.md` | `server/src/mcp/**` — the agent-facing surface, where a description IS a prompt |
| `testing-control.md` | `server/src/testing/**` — the SimDeck control seam; REST only, no token, no LAN bind |
| `landing.md` | `landing/**` — the public page; what it depicts is a claim about the product |
| `tests.md` | every `*.test.ts` — see it fail first; fakes are complete or they lie |

## The guardrails — read this before you change anything

`server/src/test-support/` holds checks that fail the build when a decision this project
already made gets broken. They exist because prose did not work.

**If one fails, it is telling you about a decision — not asking you to make it pass.**

The table is the decisions most often broken, not the full set: three dozen checks live
there and every one fails the build. Read the file, not this list, before concluding
something is unchecked.

| Check | What it protects |
|---|---|
| dependency allow-list (runtime + dev, incl. the root package.json) · no DB driver | PLAN §2 "keep the list ruthlessly short" — adding a dep is a PLAN decision, argued there first. `devDependencies` and the root count: a dep added there hoists into the shared `node_modules` and is importable everywhere |
| serve-sim pinned exactly + a matching patch file | A SECURITY control: serve-sim ships `/exec`, reachable from inside the simulator, which shares the host's loopback. `patch-package` strips it; a caret range drifts past the patch |
| no concrete backend imported outside `streaming/` | PLAN §8's seam. Two composition roots are named explicitly, so the exception is a decision rather than an erosion |
| every MCP tool wrapped in `audited()` | PLAN §11 item 2. A tool added without it is invisible to the audit trail and nothing else fails |
| every `.listen()` binds 127.0.0.1, and server.ts has exactly one | PLAN §11 item 1 — a wildcard bind puts the whole MCP surface on the LAN. Every file under `server/src`, plus `new WebSocketServer({ port })`, which opens a socket with no `.listen()`. Two exemptions by file and reason: metro.ts's port probe, which must bind every interface to mean anything, and cli.ts's delegation to `createServer().listen()` |
| the share gate keeps its `i` flag | Express dispatches routes case-insensitively; losing it was a live auth bypass. Checked with comments stripped — quoting the pattern in a comment used to satisfy it |
| every detached spawn stamps a marker (any `detached:` that is not `false`) | Four resources outlive the server; three leaked, one to 36 orphans at 418% CPU that starved the emulators. An in-memory Map is not an owner |
| docs name only tools and files that exist | A tool nobody built was documented, and the dead name leaked into a tool *description* — text a model reads as instructions. No "recording history" exemption: these documents describe what exists now |

### Three rules that are not checkable, and cost the most when broken

1. **A new test must fail before it passes.** Write it, remove the fix, watch it fail, put
   the fix back. Every test added here without that step turned out to assert nothing —
   including one that passed because a POSIX character class means something else in
   JavaScript.
2. **Fakes are complete or they lie.** Use `test-support/fakes.ts`, never `as unknown as X`
   on a literal — that form disables missing-property checking, so a new method on a real
   class leaves every fake silently behind. It cost four bugs in one day, and once made the
   orphan sweep a no-op that reported success.
3. **A comment that states a precondition needs a test that fails when the precondition
   breaks.** The worst bug of one review was a correct comment ("a pane belongs to one
   page") that the same diff made false. No type, lint or test sees that — only a reader
   looking for it.

### Reviewing

Reviewing a diff — yours or someone else's — is the `reviewing-deckhand` skill. It covers
what the guardrails cannot: preconditions a diff invalidated, bookkeeping written before
the effect it records, an assumption of "one" surviving a move to N, permissive defaults on
ambiguous failures, and tests that assert less than they appear to. Those are the classes a
fifty-bug audit marked NOTHING PRACTICAL, and they include the worst bug in the set.
