---
name: shipping-a-change
description: Run this before opening ANY pull request in deckhand. The mandatory gate — mechanical checks, the doc-consistency questions no check can ask, the adversarial review, and the rule that anything you catch here becomes a new check.
---

# shipping-a-change

**Run this before every PR. Every one, including the one-line fix.**

Two things are now mechanical, so start by knowing where you stand:

```sh
npm run review:show     # this branch's review curve so far
npm run review:check    # exactly what the gate will say
```

**You open the pull request yourself, but only after you have earned it.** Nothing blocks
`gh pr create` any more, and nothing can: `--body` and `--fill` need no file. What you get
instead is a strong default — the documented route, `--body-file`, needs a file that does
not exist until you have earned it. Review to convergence, run the gates on a clean
checkout, then `npm run review:handover`, which writes `.claude/pr-body.md` **only if the
gate passes**, deletes any body left over from another branch or an older diff, and prints
the command. Skip the review and there is nothing to open. AGENTS.md § "How work lands
here" lists the four conditions; all of them, or you stop and say which one is missing.

The rest is what the guardrails cannot see, and it still has to happen in a head.

## Why it is mandatory, in evidence

In a single day, one agent (me) shipped:

- an `AGENTS.md` install section that was wrong **one PR after it was written** — it
  told an agent to run a command that hangs on a browser prompt
- a `README` telling people to type `deckhand`, which was not a command
- `PLAN.md` with **zero** mentions of `deckhand setup`, while crediting `init` with
  four things it has never done
- `deckhand token list` documented as printing the connector URL, which it did not

Every one was caught by the user, typing what we told them to. None was caught by a
test, because no test asked. Four of them now have checks — see step 5, which is the
most important step here.

---

## 1. The mechanical gate

```sh
npm run ci          # typecheck + tests + build. Must be green.
```

If it is red, stop. Do not read further; there is nothing to review yet.

Touched the device, streaming or control path? `npm run test:device` too — it boots a
real simulator AND a real emulator, takes minutes, and is the only check that touches
hardware. If you cannot run it, say which of its six checks is unverified and who has
to run it. `?` is an honest answer; a tick you did not earn is not.

## 2. Did you change what a user types, or what an agent is told?

Answer out loud, per file. These are the ones that rot:

- **A new or changed CLI verb** → `PLAN.md` §10, and the usage string in `cli.ts`.
  A check enforces PLAN; nothing enforces the usage text.
- **A new MCP tool** → PLAN's tool table, `audited()`, and its description reads as
  an instruction to a model, not documentation for a human.
- **A changed setup or onboarding step** → do NOT restate it in `AGENTS.md`. Point at
  the command. That section drifted in a day precisely because it restated things.
- **Anything a human-only step touches** (a browser, sudo, an account) → it belongs
  in `preflight.ts`'s classification, not in a shell block someone copies.
- **A new guardrail** → the rule it encodes belongs in the matching `.claude/rules/`
  file, with the citation the docs check verifies.

Then: **run the commands you wrote.** From a directory that is not this repo, as the
reader will. `CONSTITUTION.md` principle 1 exists because that step was skipped three
times in one day.

## 3. Read the diff for what tests cannot see

Run the six passes in [`reviewing-deckhand`](../reviewing-deckhand/SKILL.md) — they
are the classes a fifty-bug audit marked NOTHING PRACTICAL for automation, and they
include the worst bug in the set.

Do not re-derive them here. Read that skill.

## 4. Prove your tests can fail

For every test you added: break the thing it guards, watch it fail, put it back.

Say in the commit message that you saw it fail. Mutation testing caught **six**
checks passing for the wrong reason in one day — one reading its own explanatory
comment as if it were code, one scanning `.ts` while the bug lived in `.tsx`, one
matching a bare name that a cleanup line satisfied on its own.

A check that has never failed is a check you have not written yet.

## 5. Whatever you caught in steps 2–4, make it a check

**This is the step that compounds, and the reason this skill exists.**

If you found a doc that lied, a command that did not exist, a claim nothing verified
— fixing it is half the work. The other half is the check that fails next time.

Today's guardrails were all born this way:

| Caught | Became |
|---|---|
| PLAN naming files nobody built | documented paths must exist |
| a tool registered without `audited()` | every tool is audited, parsed one way |
| the share gate defeated by a comment | comments stripped before the check |
| docs telling people to run a missing command | every `deckhand <verb>` must exist |
| PLAN not knowing a command existed | every CLI verb must be in PLAN |
| a human-only command in a runnable block | AGENTS blocks are agent-safe |
| a test writing to the real `~/.deckhand` | writers require `DECKHAND_HOME` |
| shipping one install's hostname | no host/user/private repo in shipped code |

If you cannot make it mechanical, say so in the PR and add it to the rules file for
the area, so the next reader is told what the next test cannot be.

## 6. Review until it stops finding things — one round is not a review

A single pass reports what the first lens happened to catch. Run rounds until one
surfaces **no blocking finding an earlier round hadn't already reported**.

1. Run steps 3–5, then record the round — **every** finding, with its severity. The test
   for severity is: *would I merge this as it stands?* If yes it's a `nit`.

   ```sh
   echo '{"lens":"shipping-a-change:inline","cold":false,"findings":[
       {"file":"server/src/server.ts","claim":"the allowlist is read per call but never watched",
        "severity":"must","evidence":"server.ts:102 reads config loaded once at boot; no watchAllowlist call"},
       {"file":"server/src/auth.ts","claim":"stale 404 in the comment","severity":"nit"}],
     "conversions":[{"finding":"server/src/server.ts::the allowlist is read per call but never watched",
        "check":"invariants.test.ts watches tokens.yaml as well as apps.yaml"}]}' \
     | npm run review:round --silent
   ```

   It prints how many were new and whether the gate is satisfied yet.
   **`evidence` is required for anything blocking** — a `file:line`, or the command output
   that shows it. A finding that costs a round has to be checkable, and having to produce
   the evidence is what separates reading the code from recalling it.

2. **Nits don't hold the gate open, and they don't converge it either.** Only `must` and
   `should` count: a reviewer can always find one more naming quibble, and if those counted
   the curve would never reach zero. Record them anyway — they stay visible in
   `review:show`, so a round that is mostly quibbles reads as one. Severity defaults to
   `should`, so the lazy path is the safe one, and a nit a later round raises to `should`
   **does** count as new — filing something small to defuse it doesn't work.
3. **Fix a blocking finding, then SAY SO in the next round.** Put its fingerprint (from
   `review:show`) in that round's `"resolved": [...]`. The TRACKED code has to have moved on
   from what the finding was raised against, and must not have gone back to it — a fix moves
   the code, so if it has not moved you have not fixed anything, and if it moved back you have
   unfixed it. Record it once and it carries forward; re-report it and it reopens. Until you
   record it the finding is open however many rounds pass without mentioning it.
   Not bookkeeping for its own sake, and the wording is exact for a reason. `validate` first
   cleared a finding the moment ANY edit moved the hash, so fixing one finding silently
   cleared every other one raised beside it. The repair — "a later round at a DIFFERENT diff"
   — was then bypassed with `touch scratch.tmp` … `resolved` … `rm scratch.tmp`, because
   `diffHash` folds in untracked files. Hence "tracked", and hence the revert clause.
4. **Don't count "new" yourself.** `review:round` deduplicates against every earlier round,
   including rounds recorded in sessions you never saw. That is the number the gate rests
   on, so it is computed, not asserted.
5. If the round found something new, **change the lens** and go again: a different pass
   emphasis, a fresh subagent with no session context, a different model. Repeating one
   lens re-finds one lens's bugs.
6. **At least one round must be cold, and it must have read the code as it SHIPS** — a
   reviewer starting from the diff alone, carrying none of the context this code was written
   in. A cold round against an older diff does not count, because fixing something moves the
   hash: `cold → fix → inline` is refused, and the shape that passes is `cold → fix → cold`. Your own session has the blind spot built
   in, so re-reading your work is never a cold round however carefully you do it. A fresh
   session, a colleague, or a subagent spawned for exactly this all qualify; say which.
   When you spawn one, give it the diff and **nothing else** — no summary of your reasoning,
   or you have handed it your blind spot along with the code. Never mark your own re-read as
   cold.
7. The curve accumulates on disk, so a later session extends it rather than starting over.

## 7. The gates, last

```sh
npm run review:gates          # a throwaway worktree at HEAD + `npm ci` — what CI does
npm run review:gates:quick    # the same gates in place: faster, does NOT satisfy the gate
```

**Run `review:gates` after the final commit.** It doesn't take your word for `npm run ci`
— it runs it and records the exit code, stamped with this diff, so any later edit voids it.

The throwaway worktree is the whole point. Green locally and red in CI is not bad luck:
your disk has files git has never seen, a `node_modules` that may have drifted from the
lockfile, and build output nobody committed. `npm run ci` in place cannot see any of that
because all of it is present. It refuses to run on a dirty tree for the same reason — CI
tests what you push.

## 8. The handover — you open the PR, from the body the gate wrote

Body carries the reasoning, not a changelog: what was wrong, why this is the fix, what you
verified, and **what you did not**. Name which check covers which half when a fix has two.

```sh
npm run review:handover --silent <<'BODY'
## What was wrong
…
BODY
```

It refuses unless `review:check` passes, writes `.claude/pr-body.md` stamped with this
branch and this diff, and prints the `gh pr create` command. Run it, then say in **one
line** that the PR is open, with its URL. Don't restate the diff — they can read the PR.

**If the gate refuses, do not route around it. Nothing stops you, and that is the point of
saying it.** Writing the body file by hand, or passing `--body` or `--fill` instead of
`--body-file`, opens a PR whose review receipt is a fiction — and that is the one thing here
that makes everything else worthless, because no later reader can tell. If the gate is
genuinely wrong, say which check is wrong and why, and let the user decide.

Merging, branch cleanup and the rest of the workflow are in `AGENTS.md` — branch from
`main`, never from another PR's branch, squash-merge, delete the branch.
