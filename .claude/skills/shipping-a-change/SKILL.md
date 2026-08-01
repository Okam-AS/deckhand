---
name: shipping-a-change
description: Run this before opening ANY pull request in deckhand. The mandatory gate — mechanical checks, the doc-consistency questions no check can ask, the adversarial review, and the rule that anything you catch here becomes a new check.
---

# shipping-a-change

**Run this before every PR. Every one, including the one-line fix.**

There is no CI job that can force you to. That is the point of writing it down: the
guardrails catch what a skipped review would have missed *mechanically*, and this
skill is the part that has to happen in a head.

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

## 6. The PR

Body carries the reasoning, not a changelog: what was wrong, why this is the fix,
what you verified, and **what you did not**. Name which check covers which half when
a fix has two.

Then the workflow in `AGENTS.md` — branch from `main`, never from another PR's
branch, squash-merge, delete the branch.
