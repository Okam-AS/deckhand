# Agent guide — deckhand


## Read this first

[`CONSTITUTION.md`](./CONSTITUTION.md) — what deckhand is, who it is for, and the
ten principles that settle an argument PLAN and this file do not. It is one page.
Every principle in it was paid for by a bug in this repo.

## What deckhand is today (iOS + Android, multi-device, local dev mode)

*(What exists, not how it got here — git holds the history. When you change what the
system is, change this section and PLAN in the same PR; a dated "Validated:" log is
exactly the kind of line that rots, so do not add one back.)*

The server has config/auth/state/audit, GitHub App auth + git worktrees, build recipes +
detection (Expo/RN/NativeScript, iOS + Android), iOS simctl control, Android device layer
(avdmanager/emulator/adb, uiautomator describe, toolEnv), the streaming router (serve-sim
for iOS, H.264/screencap backend for Android), the preview engine (**platform-grouped,
build-once-install-many, parallel boots/installs**), the MCP server (token auth) + scoped
share proxy, and the CLI. The viewer is one calm page with no platform switch: where the
browser has WebCodecs it asks every device for `stream.avcc` (H.264) and falls back to
`stream.mjpeg` on a 404; a browser without WebCodecs starts on `stream.mjpeg` and never
probes. MJPEG is boundary-framed JPEG on iOS, `adb screencap` PNG on Android,
both painted through an `<img>`. Android's primary path is the WebCodecs one; the PNG
stream is its fallback, not its normal route.

**The daily dev loop:** apps can have a local `path` (built in place — no worktree, no
push; NativeScript runs as a long-lived livesync process, HMR off), `start_preview` is
idempotent, share URLs are **stable per app** (persisted in state.json), `restart_preview`
rebuilds in place (git: fetch+reset; local: re-run) on the same booted devices, named refs
always fetch, and the viewer has a Rebuild button for local shares. A local app's source
dir is borrowed, never owned: never `npm ci`-wiped, never removed on teardown — **and its
git state is deckhand's to read/run, never to write.** Deckhand must not modify tracked
files in a borrowed checkout; anything it must generate to host the app (dev-server
caches, a generated/override config for a non-Vite framework, a stray lockfile) has to
stay **untracked** — write it outside the tree, or append it to the checkout's
`.git/info/exclude` (a repo-local, never-pushed ignore) so `git add -A` can't stage it.
Any agent driving deckhand must **never commit or push local changes deckhand caused** in
a user's repo. (This is why the `web` type injects Vite's base/host/port as runtime CLI
flags — zero source edits; frameworks that can't be configured at runtime are hosted via
the wildcard-hostname model, see PLAN §2/§8, not by editing their config.)

**The connector is public; the approval is not** (PLAN §11.6). `/mcp` takes an
`Authorization: Bearer` credential and never a path token: a connector URL added in a Claude
organisation is visible to everyone in it, so the URL cannot be the secret. Nothing decides in
advance who may use it. `/oauth/authorize` asks for a **pairing code**, and the only place one
exists is `deckhand pair` on the machine — it needs the local `tokens.yaml` credential. Mint,
hand the code over, they type it in. A colleague holding the same URL is asked for a code they
have not got. The direction matters: the earlier design parked incoming requests for the
operator to approve, and a stranger could park faster than a person can walk to the Mac, so the
operator's own request was gone before they read it. Nothing incoming is stored now, so there is
nothing to flood — only guessing, and a few wrong tries lock out the GUESSER, not the code: burning
the code would hand a stranger a way to shred every code the operator mints. `deckhand revoke
<client-id>` takes a client back, effective on its next call, no restart. Claude Code on the machine
uses a local `tokens.yaml` bearer token instead and needs no approval.

**The GitHub access ladder** (PLAN §2/§6/§11.4): credentials resolve PAT → GitHub App →
ambient `gh` CLI session (`githubAmbient`, default on) → anonymous git for public repos
(gated on `allowPublicRepos`) → one-time PAT setup URL as last resort. Onboarding
responses (`list_apps` empty state, `github_auth_missing`) carry `host: {hostname, user}`
and steer a co-located agent to register an existing local checkout
(`deckhand app add <id> --path <dir>`) before any credential flow.

**Android streaming's primary path is H.264** (`adb exec-out screenrecord` repackaged to
AVCC, `streaming/androidH264.ts`); the adb-screencap MJPEG backend is only the fallback
for system images with no working AVC encoder (notably the API 29 emulator). Both sit
behind the same `StreamingBackend` seam (PLAN §8). **Known gap, so do not imply
otherwise:** the local (`path`) livesync build path has not been validated on-device.

**Migration is a parity harness, not a diff tool:** deckhand can host an app→app
migration (e.g. NativeScript → React Native). A target app declares `migratesFrom` (the
source app id), and a parity checklist comes either from `items` on `start_preview` or
from `deckhand.migration.yaml` in the target repo. Deckhand runs/shows the apps and reads
the ledger; the agent translates code, judges parity, and writes the ledger. No mechanical
diff tool, no golden snapshots, no persisted migration session — deliberately not built
(agent is the comparator; keeps the no-DB / no-repo-writes invariants clean).

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

What remains to build is PLAN's, not this file's, to enumerate — see PLAN §6 (of the
agent-led onboarding contract, password shares are the piece still outstanding; shares
today are PIN-gated) and the ops runbook work that follows it.

If you are here to **implement further**, your instructions are:

1. Read [PLAN.md](./PLAN.md) end to end. It is the source of truth: locked decisions,
   architecture, module specs, the MCP surface, and the security model.
2. Before writing streaming or viewer code, read
   [docs/reference/serve-sim-notes.md](./docs/reference/serve-sim-notes.md); before engine
   or viewer code, read
   [docs/reference/auto-mate-learnings.md](./docs/reference/auto-mate-learnings.md)
   (14 concrete pitfalls that cost the predecessor project weeks).
3. Deckhand is built. PLAN describes what it IS — architecture, the MCP surface, the
   streaming seam, the security model — not a build order; do not add a phase list or a
   risk register back. Add to PLAN when you change what the system is; git holds how it
   got here. **Every bug fixed gets a regression test in the closest layer** — the one
   rule not covered by `npm run ci` or the guardrails.
4. The streaming layer is **decided** (PLAN.md §2/§8): iOS via **serve-sim** — its
   H.264 path is `stream.avcc` over a long-lived **chunked HTTP** response decoded with
   WebCodecs, NOT a WebSocket (the WebSocket carries HID input only). The viewer probes
   avcc and reads a 404 as "use `stream.mjpeg`" — a runtime answer about this machine,
   never a claim written down in advance about what serve-sim can do. Android via
   **adb** — `screencap`
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
  loopback-only binding, no credentialless path to a device or a repo (PLAN §11 item 1
  names the four open-by-construction OAuth endpoints), no secrets through MCP, tokens never in
  argv/URLs/logs.
- Structured, actionable MCP errors: the model relaying the error to a human must be able
  to say exactly what to do next.
- Comment sparsely. Much of this codebase carries heavy comment blocks; do not match that
  density. Write a comment only when it states something the code cannot — a precondition,
  a decided tradeoff, a why — and a precondition comment needs a test that fails when the
  precondition breaks (see the three rules below). When a file you are already editing
  carries narration, restatements or before/after changelog notes, delete them as you pass.

## HOW WE WORK — the lead agent delegates, it does not code

**Standing law for every task a human hands the lead agent in this repo.** The human's time with
the agent is the scarce resource; the lead agent stays free to talk, decide, and untangle. It
therefore does NOT do the work itself:

1. **One task in, one subagent out.** Each thing the human asks for is handed to its own
   subagent (`Agent` tool) with a self-contained brief: what to change, which files/packages,
   which rule files and gates apply. The human feeds tasks one at a time; the lead agent
   dispatches them the same way.
2. **The lead agent stays available.** While subagents run, the lead agent is in conversation
   with the human — clarifying the next task, reviewing what came back, answering questions.
   It never disappears into a long edit of its own.
3. **Conflicts are the lead agent's job.** When two subagents touch the same file, or their
   results contradict (different constants, competing abstractions, merge conflicts), the lead
   agent resolves it — by deciding, or by asking the human when the call is theirs. Subagents
   never resolve each other's conflicts.
4. **Subagents ship their own slice.** Each subagent runs the gates for what it touched
   (`npm run ci`, and § "Nothing is \"tested\" until this is green" for anything on the device,
   streaming or control path) and reports evidence. The lead agent re-runs the full gate after
   conflict resolution, since a merge can break what each half proved green.
5. **Commit per landed slice**, not per batch — a long uncommitted run is how work gets lost.
   **Never `git add -A` / `git add .`** — with several agents in one tree that sweeps another
   agent's half-finished file into your commit. Stage the exact paths you changed, always. This
   happened twice on 2026-08-07 (`955998e`, `b23a251` each swallowed another agent's in-flight
   file); nothing was lost, but the authorship and the revert boundary were.
   **`git commit -a`, and a pre-populated index, are the same hazard by another route.** Another
   agent may have already run `git add` on its own files before you commit, so `git commit -m`
   with no paths ships them too — that happened again on 2026-08-08 and had to be unpicked with
   a soft reset. `git commit --only <your paths>` is the form that cannot do it, and it is the
   one to use in a shared tree. After committing, read `git show --stat` and confirm the file
   list is yours alone; if it is not, `git reset --soft HEAD~1` and re-commit with `--only`.
6. **Exceptions the lead agent may do inline:** answering a question, reading/searching to brief
   a subagent, a one-line fix, and the conflict resolution itself.

## How work lands here

**Run the `shipping-a-change` skill before you open the PR. Every time, including
the one-line fix.** It is in `.claude/skills/shipping-a-change/`. Nothing can force
you to — that is exactly why it is written down, and why step 5 of it turns whatever
you caught into a check that fires next time. Four of this repo's guardrails exist
because that step was skipped and a user found the defect instead.

**You may open the pull request — once, and only once, `review:handover` has written
the body.** There is no hook stopping you any more. A PreToolUse hook used to refuse
`gh pr create` with no override, and it was removed for the reason every other matcher
in it was removed before: a text matcher over a shell cannot enumerate the spellings of
a command, so it reserved a decision it could not actually reserve while reading as if
it could.

**Nothing replaced it, because nothing local can. This is a rule with a strong default,
not an enforcement — say it that way and do not let it grow back into a claim.**
`review:handover` refuses to write `.claude/pr-body.md` unless the review converged, so
the DOCUMENTED route (`gh pr create --body-file`) has nothing to open a PR with until
you have earned it; and every `review:*` command deletes a body file stamped for another
branch or an older diff, so a converged body cannot be inherited by the next branch (it
used to be: one fixed gitignored path that nothing ever cleaned up, so branch B found
branch A's body and `--body-file` succeeded). But `gh pr create --body` and `--fill`
never look at a file at all. The mechanism narrows the honest path; it does not close
the dishonest one, and the body itself names the branch and diff it attests to precisely
because the last line of defence is a human reading the PR.

So the permission is exact, and it is a conjunction:

1. `npm run ci` is green, and `npm run review:gates` is green on a clean checkout of HEAD.
2. `npm run review:check` says the review converged — at least two rounds, one of them
   cold against the code AS IT SHIPS, nothing blocking left standing.
3. `npm run review:handover` exited 0 and wrote `.claude/pr-body.md`.
4. The branch is pushed, and it is not `main`.

All four, then run the command it printed. Any one of them missing and you have not
earned it — say which one, in a line, and stop. Do not hand-write a body, and do not
reach for `--body` or `--fill`, to route around step 3: those are exactly the paths
nothing checks, which is why the rule is written here rather than enforced there.
Forging the handover is the one thing in this workflow no later reader can catch.

`main` is protected server-side, so a push at it is refused by GitHub whatever anything
local thinks; the restart rule is prose below and nothing else.

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

`review:handover` writes `.claude/pr-body.md` and prints the `gh pr create` command.
Run it. If the review has not converged it writes no body and deletes any it finds, so
the documented route has nothing to open — skipping the review leaves you with nothing
to hand over rather than a PR nobody reviewed.

The review itself is a **loop with a receipt**, not a single pass:

```
npm run review:show      # this branch's curve, one entry per round: "cold-subagent (cold): 4 · inline: 0"
npm run review:check     # exactly what the handover gate will say
npm run review:round     # record one round (JSON on stdin; see the skill)
```

The receipt records the SHAPE of what the review found over rounds — `[7, 3, 1, 0]` is
a converged review, `[0]` is one reviewer's first impression — and requires at least
two rounds, the last finding nothing new and nothing blocking left standing, at least
one round **cold** (a reviewer starting from the diff alone), and `npm run ci` green on
a clean checkout. It cannot tell a review from a claim about one; what it buys is that
the claim is explicit, attributable and readable afterwards. Details and the honest
limits: `scripts/review-receipt.ts`.

Two things it enforces that cost a round if you learn them late:

- **The cold round must have read the code AS IT SHIPS.** A cold round against an
  older diff does not count, so `cold → fix → inline` is refused: fixing moves the
  hash. In practice the converging round is itself a cold one, so budget for that —
  the shape is `cold → fix → cold`, not two rounds and done. (Accepting a stale cold
  round made the cheapest compliant path "one cold round early, then change whatever
  you like", with nothing cold having read what ships.)
- **A blocking finding leaves the record two ways: fixed, or waived with a reason.**
  `waived` takes the fingerprint from `review:show` and a sentence saying why it
  cannot be mechanised or why it is acceptable — at least 20 characters, because
  waiving used to cost nothing while reporting demanded evidence, which made
  dismissing a bug cheaper than raising one. A finding nobody mentions again stays
  open: silence is not a resolution.

Merging is still yours once the PR exists:

```
gh pr merge <n> --squash --delete-branch
```

**Branch from `main`, never from another PR's branch.** Stacking cost a session
twice: squash-merging the bottom PR rewrites its commits, so the one above it
double-counts its diff until rebased — and `--delete-branch` on the bottom
**auto-closes** every PR based on it, which can then be neither reopened nor
retargeted (the work survives on `refs/pull/<n>/head`; the PR does not). If two
changes are entangled, put them in one PR or land the first and wait.

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
one, land it, open the next.**

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
and no branch on the remote whose PR is closed.

**Watch out for `--delete-branch`**: it switches you to `main` without saying so.
Chaining `gh pr merge ... --delete-branch && git switch <next>` silently skips
the switch, and the next command runs against `main`.

Why a PR for a one-liner: it is the only point where a reader who has not seen
the change looks at it. A fifty-bug audit marked three defect classes NOTHING
PRACTICAL for automation, and they included the worst bug in the set — a
cross-page authentication bypass, found by two cold readers independently.

The PR body carries the reasoning, not a changelog: what was wrong, why this is
the fix, and what you verified. If you fixed a bug, say what you did to prove the
test fails without the fix.

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

The pre-commit hook runs the same command as CI — if the two ever diverge, the
hook is the one that is wrong. `--no-verify` deliberately still works: a hook
that cannot be skipped gets uninstalled instead of respected.

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
preference domain, and writing them twice is the same as writing them once — so do
not add an "is it Expo, is it already off" check.

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
one ready device reports `ready` (`recomputePreviewPhase` in
`server/src/engine/preview.ts`). The how-to, including a
ready-to-paste poller, is the `waiting-for-a-preview` skill in `.claude/skills/`.

## If a tool response carries `deckhandUpdate`

Every successful tool response that returns JSON carries `deckhandUpdate` when the
code the server is RUNNING is not the newest — in one of two states, which need
different words. (`screenshot` is the one exception: it returns an image block,
which has nowhere to put JSON, so it carries no notice. `mcp/responses.test.ts`
keeps it the only one.)

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
- `you: <what to do>` — a fix only a person at this Mac can perform: an App Store
  install, an Apple ID, a `sudo` licence accept, a decision about the machine's
  default Node. **Never attempt these either** — relay the line as written (it
  already says what it needs and why you cannot) and stop. Setup is safe to
  re-run, so pick up from `setup` again once they say it is done.
- **BLOCKED** — also relay-and-stop, but an errand off this machine: a browser and
  their Cloudflare account. **Never attempt these**; `cloudflared tunnel login`
  opens a browser and will hang you forever, and retrying changes nothing.
- **ASK THE USER** — an input, not an obstacle. Ask the one question in the words
  given, take the answer, and carry on yourself.

`fix:` is the only one of the four you may run. The other three are the user's, and
the two labels that look alike differ only in where the work happens — say `you:`
items as the local chores they are, rather than reporting them as blocked.

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

> Run `deckhand token` and paste the URL into claude.ai → Settings → Connectors,
> then click Connect — the page asks for a pairing code. Here is one: `ABC-123`.

Then, if it is useful, what you did. Not before. A user who reads three lines and
stops must still have the thing they need — and they will stop, because a numbered
list of green ticks reads as "nothing left to do".

**Their connector URL:** `deckhand token` — just `https://<their-host>/mcp`. It
carries no secret, so relaying it in chat is fine. What keeps everyone else out is
that Claude's page asks for a pairing code that exists only here. **Run `deckhand
pair` yourself and give them the code** — they type it into their browser. Say so in
the same breath as the URL, or a page asking for a code they have never heard of
reads as broken. With no local credential nothing can ever be minted; `deckhand
doctor` fails on that, and it is not a warning.

Do not confuse that with `deckhand token add|url <name>`, which mints a LOCAL
bearer credential for Claude Code on the machine. That one IS a password: never
repeat it back in chat, never put it in a commit or a PR, and never in a URL.
`token list` masks them by design.

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
hardware. Restarting the server to unstick one is subject to the same rule as
deploying — say so first (see "Deploy after merging, not before").

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
| `connector-auth.md` | `server/src/oauth/**`, `auth.ts` — who may drive this Mac; the connector URL is public |
| `mcp-tools.md` | `server/src/mcp/**` — the agent-facing surface, where a description IS a prompt |
| `testing-control.md` | `server/src/testing/**` — the SimDeck control seam; REST only, no token, no LAN bind |
| `landing.md` | `landing/**` — the public page; what it depicts is a claim about the product |
| `tests.md` | every `*.test.ts` — see it fail first; fakes are complete or they lie |

## A claim you leave behind is a claim someone will act on

**Every sentence in this repo — comment, doc, tool description, test name, landing
copy — is read by someone who cannot see what you saw.** They will act on it. That
makes an obsolete claim more expensive than no claim, because a false map is trusted
and an absent one is not.

The rules, learned by finding thirty-odd of these in one sweep:

1. **Delete it; do not annotate it.** "Superseded", "no longer used", "kept for
   historical reference" — a reader lands mid-file via grep and acts on the thing you
   labelled dead. If it is gone, remove every trace of it. The one exception is the
   next rule.
2. **A rejected design is load-bearing exactly when it stops someone rebuilding it.**
   Test: *would deleting this make it likely the next agent reintroduces the bug?* If
   yes, it does not belong in a document that rots — move it into the `.claude/rules/`
   file for that area, once, where an agent is handed it on opening the file.
3. **Put the past tense IN the sentence, never only in the heading.** "A document said
   `token list` shows the connector URL, while it showed masked names" survives a grep
   landing. "It did not" under a heading six lines up does not. Never delete the
   example itself — the example is the evidence a principle was paid for.
4. **Do not restate what you can point at.** The install steps, a dependency's
   capabilities, a line number, a test count, a file tree: all of these rotted here,
   some within a day of being written. Point at the command, probe the capability,
   name the method instead of the line. `serveSim.ts` claimed the pinned serve-sim
   could not serve avcc; two documents copied it during the cleanup PR that was
   removing claims exactly like it.
5. **A comment stating a precondition needs a test that fails when it breaks** — and
   if none exists, say so IN the comment. The worst finding of a recent audit was
   "Symmetric on purpose" sitting above a body that is forward-only, where the
   symmetry it invited had been a cross-page authentication bypass. The code was
   guarded; the comment was the hazard.
6. **When you change behaviour, re-read the comments you did NOT touch.** The
   dangerous one is never in the diff. A rationale ages while the code it justifies
   stays correct, which is the shape no reviewer catches by reading the change alone.
7. **Whatever you caught this way, make it a check** (see the skill's step 5). If it
   cannot be mechanised, write it into the area's rule file so the next reader is told
   what no test can tell them.

## The guardrails — read this before you change anything

`server/src/test-support/` holds checks that fail the build when a decision this
project already made gets broken. They exist because prose did not work — PLAN §2
and §11 were broken repeatedly by agents who had not read them.

If one of these fails, it is telling you about a decision — not asking you to
make the check pass.

The table below is the decisions most often broken, not the full set — there are
three dozen checks in that directory and every one of them fails the build. Read
the file, not this list, before concluding something is unchecked.

| Check | What it protects |
|---|---|
| dependency allow-list (runtime + dev, incl. the root package.json) · no DB driver | PLAN §2 "keep the list ruthlessly short". Adding a dep is a PLAN decision — argue it there, then widen the set. The root and `devDependencies` are in scope because a dep added there hoists into the shared `node_modules` and is importable everywhere |
| serve-sim pinned exactly + a matching patch file | The pin is a SECURITY control: serve-sim ships `/exec`, reachable from inside the simulator, which shares the host's loopback. `patch-package` strips it. A caret range drifts past the patch |
| no concrete backend imported outside `streaming/` | PLAN §8's seam. Two composition roots are named explicitly, so the exception is a decision rather than an erosion |
| every MCP tool wrapped in `audited()` | PLAN §11.2. A tool added without it is invisible to the audit trail and nothing else fails |
| every `.listen()` binds 127.0.0.1, and server.ts has exactly one | PLAN §11.1. A wildcard bind puts the whole MCP surface on the LAN. Every source file under `server/src`, because the per-device Android helper binds a socket too — and `new WebSocketServer({ port })`, which opens one without a `.listen()` at all. Two exemptions, by file and reason: metro.ts's port-availability probe, which must bind every interface to mean anything, and cli.ts's delegation to `createServer().listen()` |
| the share gate keeps its `i` flag | Express dispatches routes case-insensitively. Losing it was a live auth bypass. Checked on every matching line with comments stripped — quoting the pattern in a comment used to satisfy it |
| every detached spawn stamps a marker (any `detached:` that is not `false`) | Four resources outlive the server; three leaked, one to 36 orphans at 418% CPU that starved the emulators. An in-memory Map is not an owner |
| docs name only tools and files that exist | PLAN documented a tool nobody built, and the dead name leaked into a tool *description* — text a model reads as instructions. There is no "but I'm recording history" exemption: PLAN and this file describe what exists now, and git holds the past |

### Three rules that are not checkable, and cost the most when broken

1. **A new test must fail before it passes.** Write it, remove the fix, watch it
   fail, put the fix back. Every test in this repo that was added without that
   step turned out to assert nothing — including one that passed because a POSIX
   character class means something else in JavaScript.
2. **Fakes are complete or they lie.** Use `test-support/fakes.ts`, never
   `as unknown as X` on a literal — that form disables missing-property checking,
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
