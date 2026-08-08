---
name: reviewing-deckhand
description: Use when reviewing a diff in the deckhand repo — your own before pushing, or someone else's PR. Encodes the bug classes that automation cannot catch here, and the order to look for them in.
---

# reviewing-deckhand

The checks that cannot be automated, and why each one exists.

Everything mechanical already runs: `npm run typecheck`, `npm test` (which
includes the guardrails in `server/src/test-support/`), and `npm run test:device`
for the real-hardware path. **Do not spend review time on what those cover.**
This skill is only for what they cannot see.

That distinction is earned. A fifty-bug audit of one session sorted every defect
by "what would have caught this automatically". Three classes came back
**NOTHING PRACTICAL** — and they included the worst bug in the set, a cross-page
authentication bypass. All three were found by people reading adversarially.

## Before you start

1. **The guardrails are the baseline, not the review.** Run `npm test` first. If
   a guardrail fails, it is telling you about a decision this project already
   made — read the failure message, which names the decision. Do not make the
   check pass.
2. **Read the diff against `main`, and read the files it does *not* touch.**
   Every finding worth having in this repo came from a file the branch never
   opened.

---

## Pass 1 — Preconditions the diff invalidated

**The highest-yield pass, and the one no tool replaces.**

A comment states a precondition. The same diff makes it false. Nothing fails.

The worst example: `pairedShareIds` had a reverse direction justified by *"a
compare reference is a synthetic app the operator just booted as one pane of one
page"*. That was true when written. The same PR keyed panes by CONTENT so that
two pages would deliberately share one — and the comment, now false, was still
load-bearing. Result: a holder of page B's PIN got a valid unlock cookie for page
A, with A's shareId disclosed.

How to run it:

- For every comment in the diff that asserts something ("only ever", "always",
  "belongs to one", "can never"), ask: **does this change make that false?**
- For every comment *near* the diff that the diff did not touch: same question.
  The dangerous ones are the comments nobody edited.
- When you find one that is still true and load-bearing, **ask whether a test
  fails when it breaks.** If not, that is the finding — not the comment.

**A false precondition is the only comment defect worth a finding.** Do not report
comment wording, tone, over-claiming prose, or a rationale that could be phrased
better: a review round spent on prose is a round the code did not get, and every
edit to it voids the cold round.

## Pass 2 — Ordering: bookkeeping before the effect it records

Look for a line that records an outcome above the line that produces it.

- A pooled AVD's tenancy was recorded *before* the `-wipe-data` boot; a boot that
  threw left the new app as owner, so the retry skipped the wipe and handed over
  the previous tenant's storage — across owner scopes.
- `reapOrphans()` ran before `listen()` bound the port, so a second `deckhand
  serve` deleted the running server's simulators and *then* died on EADDRINUSE.
- Adding one `await` between reading `liveDeviceHandles()` and acting on it
  widened the window a device can be created in.

Ask of every reordering, and every new `await`: **what is true between these two
lines that was true before them?**

## Pass 3 — Cardinality that moved from one to N

This repo changed from "a preview plus one reference" to "a page of panes", and
almost every bug that followed was an assumption of *one* surviving the move.

- The idle heartbeat covered only the page's own preview, so extra panes aged out
  under an active viewer.
- `pairedShareId` returned a single partner; the proxy minted one cookie.
- A pane's ref was captured once at boot and never re-read.

Grep the diff for singular names — `partner`, `reference`, `the pane`, `first`,
`[0]` — and ask whether N is now possible.

## Pass 4 — Permissive defaults on an ambiguous failure

An empty result and a failed lookup must not be the same value.

- `loadAppsSafe()` returned `[]` on any failure; `app add` then wrote a file
  containing only the new app and printed success. Every registered app gone.
- `allocAndroidPort` never asked adb, so "no answer" and "nothing attached" were
  the same, and deckhand hijacked the developer's own emulator.
- `Simctl.delete()` swallowed its exit code, making a guard one layer up
  unreachable — and the test fake was more honest than the real class.

For every new `catch {}`, `?? []`, `|| false`, or unchecked exit code: **which
direction does this fail in, and is that the safe one?**

## Pass 5 — Tests that assert less than they appear to

- A test whose fix was never removed proves nothing. **Ask the author whether
  they saw it fail.** The commit messages in this repo record that step; if the
  branch does not, that is a finding.
- A fake cast with `as unknown as X` can silently lack the method under test —
  use `test-support/fakes.ts`. This has bitten four times.
- A test that exercises a branch that is switched off (wrong config key, a
  preview still holding the lease) passes for the wrong reason. Check the fixture
  actually reaches the code.
- A guardrail can pass for the wrong reason too: the detached-spawn check matched
  the marker's own `export const` after the stamp had been deleted.

## Pass 6 — The claims in the diff's own prose

PLAN.md and AGENTS.md are checked mechanically for tool and file names, but not
for *claims*. In the last review both said the change "touched no proxy code"
while the proxy change was the feature — the sentence most likely to stop a
reviewer looking exactly where the security bug sat.

Read the PR body and the commit messages as assertions to verify, not as context.

---

## The report

Four sections: **must-fix**, **should-fix**, **nits**, and **verified good —
what you attacked and could not break**. The last is not padding: it tells the
author what not to re-litigate, and it is the only evidence the review had teeth.

Every finding needs `file:line`, the trigger, and why it matters. A finding you
could not verify says so.

## One honest limit

A self-review does not find your own blind spots. When this skill was run by the
author of the diff, three cold readers found two blocking bugs the author had
not seen — two of them finding the same auth bypass independently. If you are
reviewing your own work, spawn readers who have not seen it, and treat their
claims as claims: verify each one before reporting it.
