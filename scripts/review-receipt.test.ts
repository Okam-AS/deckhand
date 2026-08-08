import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  appendRound,
  contentMoved,
  currentBranch,
  diffHash,
  diffHashes,
  fingerprint,
  gatesWorktree,
  HANDOVER_FILE,
  keepsCleanRun,
  handover,
  MIN_ROUNDS,
  pruneStaleHandover,
  readReceipt,
  reclaimAbandonedGates,
  RECEIPT_DIR,
  receiptPath,
  recordRound,
  summarize,
  UNRESOLVABLE_DIFF,
  validate,
  waiverAnswered,
  writeReceipt,
  type Receipt,
  type Round,
  type Snapshot,
} from "./review-receipt.ts";

const HASH = "a".repeat(64);
const OLD = "b".repeat(64);

/** What the CLI hands `recordRound`: the three things hashed about the code under review. */
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({ diff: HASH, code: HASH, files: {}, ...over });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "deckhand-receipt-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const round = (over: Partial<Round> = {}): Round => ({
  lens: "inline",
  cold: false,
  diff: HASH,
  findings: [],
  newFindings: 0,
  ...over,
});

/** A receipt that passes every check, so each test can break exactly one thing. */
const converged = (over: Partial<Receipt> = {}): Receipt => ({
  branch: "feature/x",
  rounds: [round({ lens: "inline", newFindings: 3, diff: OLD }), round({ lens: "cold-subagent", cold: true })],
  conversions: [{ finding: "f", check: "c" }],
  waived: [],
  gates: { passed: true, command: "npm run ci", diff: HASH, clean: true },
  ...over,
});

describe("the gate", () => {
  it("passes a converged, cold-reviewed, cleanly-gated receipt", () => {
    assert.deepEqual(validate(converged(), HASH), { ok: true });
  });

  it("refuses a missing receipt and names the skill that writes one", () => {
    const v = validate(null, HASH);
    assert.equal(v.ok, false);
    assert.match(!v.ok ? v.reason : "", /shipping-a-change/);
  });

  // A single round finding nothing is a claim about the reviewer, not about the code.
  it(`refuses fewer than ${MIN_ROUNDS} rounds even when that one round found nothing`, () => {
    const v = validate(converged({ rounds: [round({ cold: true })] }), HASH);
    assert.equal(v.ok, false);
    assert.match(!v.ok ? v.reason : "", /1 review round on record/);
  });

  it("refuses a curve whose last round still found something new", () => {
    const rounds = [round({ newFindings: 3, diff: OLD }), round({ cold: true, newFindings: 1 })];
    const v = validate(converged({ rounds }), HASH);
    assert.equal(v.ok, false);
    assert.match(!v.ok ? v.reason : "", /has not converged/);
  });

  // Earlier rounds SHOULD be against older diffs — that is what fixing findings looks like.
  // Keying the whole receipt to one hash orphaned the curve on every fix, making a review that
  // changed nothing the only route through the gate.
  it("allows earlier rounds on older diffs but requires the last on the current one", () => {
    assert.deepEqual(validate(converged(), HASH), { ok: true }, "an older first round is normal");
    const stale = converged({ rounds: [round({ newFindings: 2, diff: OLD }), round({ cold: true, diff: OLD })] });
    const v = validate(stale, HASH);
    assert.equal(v.ok, false);
    assert.match(!v.ok ? v.reason : "", /changed after the last review round/);
  });

  // "Nothing NEW" is not "nothing wrong". Re-reporting the same unfixed must-fix scores zero
  // new — and the freshness rule makes that the CHEAPER path, since fixing it costs a round.
  it("refuses when the last round still has a blocking finding standing, however old it is", () => {
    const open = round({ cold: true, findings: [{ id: "f.ts::boom", severity: "must" }] });
    const v = validate(converged({ rounds: [round({ newFindings: 1, diff: OLD }), open] }), HASH);
    assert.equal(v.ok, false);
    assert.match(!v.ok ? v.reason : "", /unresolved blocking finding/);
  });

  // Checking only the LAST round made silence the cheapest exit: the cold round reports a
  // must, the next round simply does not mention it, and the gate opens with nothing fixed.
  // Dropping a finding is distinguishable from fixing one, because a fix moves the diff.
  it("refuses a blocking finding an earlier round raised against this same diff and no one answered", () => {
    const raised = round({ cold: true, findings: [{ id: "f.ts::auth bypass", severity: "must" }], newFindings: 1 });
    const silent = round({ lens: "second-look" });
    const v = validate(converged({ rounds: [raised, silent] }), HASH);
    assert.equal(v.ok, false);
    assert.match(!v.ok ? v.reason : "", /f\.ts::auth bypass/);
  });

  // The hole this replaced: `open` was computed only from rounds at the CURRENT diff, justified
  // by "a fix is why the hash moved". Every edit moves the hash — including the fix for a
  // different finding in the same round — so a `must` raised at one diff was cleared by any
  // later edit, and a cold round that never mentioned it read as convergence.
  it("keeps a blocking finding open when the diff moves under it and nobody answers it", () => {
    const raised = round({ cold: true, findings: [{ id: "f.ts::auth bypass", severity: "must" }], newFindings: 1, diff: OLD });
    const silent = round({ lens: "after-some-other-fix", cold: true });
    const v = validate(converged({ rounds: [raised, silent] }), HASH);
    assert.equal(v.ok, false, "an edit elsewhere is not an answer to this finding");
    assert.match(!v.ok ? v.reason : "", /f\.ts::auth bypass/);
  });

  // The other direction, and the one that would make this net negative if it broke: an author
  // who genuinely fixed it must converge by saying so, not by adding rounds.
  it("counts it answered when a later round on changed code records it resolved", () => {
    const raised = round({ cold: true, findings: [{ id: "f.ts::auth bypass", severity: "must" }], newFindings: 1, diff: OLD });
    // The round after the fix is cold too — which the freshness rule below requires, since the
    // fix moved the hash the first cold round reviewed.
    const fixed = round({ lens: "after-the-fix", cold: true, resolved: ["f.ts::auth bypass"] });
    assert.deepEqual(validate(converged({ rounds: [raised, fixed] }), HASH), { ok: true });
  });

  // "Resolved" has to mean something the receipt can check, and the only thing it can check is
  // that the code moved after the finding was raised. A round resolving what it is itself
  // looking at has fixed nothing, and would make a `must` cost one line of JSON.
  it("ignores a resolution from a round that reviewed the same code the finding was raised against", () => {
    const raised = round({ cold: true, findings: [{ id: "f.ts::boom", severity: "must" }], newFindings: 1, diff: OLD });
    const sameCode = round({ lens: "same-diff", cold: true, diff: OLD, resolved: ["f.ts::boom"] });
    const v = validate(converged({ rounds: [raised, sameCode, round({ lens: "last", cold: true })] }), HASH);
    assert.equal(v.ok, false);
    assert.match(!v.ok ? v.reason : "", /f\.ts::boom/);
  });

  // Ceremony must not scale with rounds: five findings fixed and recorded once must stay
  // recorded, or every later round would have to re-list them and the honest path gets longer
  // the more carefully you review.
  it("carries a resolution forward, so later rounds need not repeat it", () => {
    const MID = "c".repeat(64);
    const raised = round({ cold: true, findings: [{ id: "f.ts::boom", severity: "must" }], newFindings: 1, diff: OLD });
    const fixed = round({ lens: "after-the-fix", diff: MID, resolved: ["f.ts::boom"] });
    assert.deepEqual(validate(converged({ rounds: [raised, fixed, round({ lens: "last", cold: true })] }), HASH), { ok: true });
  });

  // A resolution answers the report it came after, not one that came later. Re-reporting a
  // finding the author already called fixed is exactly the case worth catching.
  it("does not let an earlier resolution answer a later re-report of the same finding", () => {
    const boom = { id: "f.ts::boom", severity: "must" as const };
    const rounds = [
      round({ cold: true, findings: [boom], newFindings: 1, diff: OLD }),
      round({ lens: "after-the-fix", diff: "c".repeat(64), resolved: ["f.ts::boom"] }),
      round({ lens: "cold-again", cold: true, findings: [boom] }),
    ];
    const v = validate(converged({ rounds }), HASH);
    assert.equal(v.ok, false, "the fix did not hold, and the receipt must say so");
    assert.match(!v.ok ? v.reason : "", /f\.ts::boom/);
  });

  // The bypass this rule replaced, reproduced end to end through the CLI in a throwaway repo:
  // `diff` folds in the untracked file list, so `touch scratch.tmp` moves it without moving a byte
  // of code. Raise a must, touch, record `resolved`, and the resolving round sits at a different
  // diff — which was the whole of the old rule — while the code is exactly what the must was
  // about. Leaving the scratch file in place is the shape that survives comparing the RAISING
  // round to the current diff, and it is why the comparison is on `code`.
  it("ignores a resolution recorded while only an untracked file moved the hash", () => {
    const CODE = "d".repeat(64);
    const raised = round({ cold: true, diff: "e".repeat(64), code: CODE, findings: [{ id: "f.ts::auth bypass", severity: "must" }], newFindings: 1 });
    const shuffled = round({ lens: "touched-a-file", diff: OLD, code: CODE, resolved: ["f.ts::auth bypass"] });
    const v = validate(converged({ rounds: [raised, shuffled, round({ lens: "cold-again", cold: true, code: CODE })] }), HASH);
    assert.equal(v.ok, false, "no code moved between those rounds, so nothing was fixed");
    assert.match(!v.ok ? v.reason : "", /f\.ts::auth bypass/);
  });

  // Rounds recorded before `code` existed fall back to their `diff`, so the same trick has to stay
  // refused on a receipt already in flight — there, "raised against the code as it stands" is the
  // only reading available and it is the one that blocks.
  it("ignores that same shuffle on a receipt whose rounds predate the code hash", () => {
    const raised = round({ cold: true, findings: [{ id: "f.ts::auth bypass", severity: "must" }], newFindings: 1 });
    const shuffled = round({ lens: "touched-a-file", diff: OLD, resolved: ["f.ts::auth bypass"] });
    const v = validate(converged({ rounds: [raised, shuffled, round({ lens: "cold-again", cold: true })] }), HASH);
    assert.equal(v.ok, false);
    assert.match(!v.ok ? v.reason : "", /f\.ts::auth bypass/);

    // The mixed receipt is the one a live branch actually has: rounds from before this rule, then
    // rounds from after it. The two fallbacks live in different hash spaces, so "the code moved"
    // is trivially true across the boundary and only "raised against the code as it stands" is
    // left to refuse it.
    const CODE = "d".repeat(64);
    const mixed = [raised, { ...shuffled, code: CODE }, round({ lens: "cold-again", cold: true, code: CODE })];
    const m = validate(converged({ rounds: mixed }), HASH);
    assert.equal(m.ok, false, "a legacy round raised against the current code cannot be resolved by a newer one");
    assert.match(!m.ok ? m.reason : "", /f\.ts::auth bypass/);
  });

  // A resolution is a claim about code that moved on from the bug, so it expires when the code
  // moves back — by a revert as much as by the untracked shuffle. Without the second half of the
  // rule it is a one-way ratchet: fix, record, revert, and the record still reads "resolved".
  it("expires a resolution when the code returns to what the finding was raised against", () => {
    const BUGGY = "d".repeat(64);
    const FIXED = "c".repeat(64);
    const raised = round({ cold: true, diff: OLD, code: BUGGY, findings: [{ id: "f.ts::boom", severity: "must" }], newFindings: 1 });
    const fixed = round({ lens: "after-the-fix", cold: true, diff: "e".repeat(64), code: FIXED, resolved: ["f.ts::boom"] });
    assert.deepEqual(
      validate(converged({ rounds: [raised, { ...fixed, diff: HASH }] }), HASH),
      { ok: true },
      "the honest fix must still converge in two rounds and no extra ceremony",
    );
    const reverted = round({ lens: "cold-after-revert", cold: true, code: BUGGY });
    const v = validate(converged({ rounds: [raised, fixed, reverted] }), HASH);
    assert.equal(v.ok, false, "the bug is back in the code the branch ships");
    assert.match(!v.ok ? v.reason : "", /f\.ts::boom/);
  });

  // The bypass that made resolutions per-file, reproduced end to end through the CLI: with the
  // reported line still in the shipping tree, `chmod +x src/f.ts && git commit -qam "mode bit
  // only"` printed "1 file changed, 0 insertions(+), 0 deletions(-)", moved the tracked-diff hash
  // — which was the whole of the old rule — and the next round's `resolved` closed a `must` about
  // code nobody had touched. A blank line, an unrelated tracked file and a one-way rename are the
  // same bypass in other clothes: every one of them moves the diff text and none of them moves the
  // bytes the finding names.
  it("ignores a resolution when the diff text moved but the file the finding names did not", () => {
    const BUG = { "src/f.ts": "returns-true", "src/other.ts": "one" };
    const raised = round({
      cold: true,
      diff: OLD,
      code: "d".repeat(64),
      files: BUG,
      findings: [{ id: "src/f.ts::auth always returns true", severity: "must" }],
      newFindings: 1,
    });
    // Each of these moved BOTH whole-diff hashes and left `src/f.ts` byte-identical.
    for (const [what, files] of [
      ["a mode bit", BUG],
      ["an unrelated tracked file", { ...BUG, "src/other.ts": "two" }],
      ["a one-way rename", { "src/renamed.ts": "returns-true", "src/other.ts": "one" }],
    ] as const) {
      const claimed = round({ lens: "after", cold: true, code: "e".repeat(64), files, resolved: ["src/f.ts::auth always returns true"] });
      const v = validate(converged({ rounds: [raised, claimed] }), HASH);
      assert.equal(v.ok, false, `${what} is not a fix`);
      assert.match(!v.ok ? v.reason : "", /auth always returns true/);
    }
  });

  // The other direction, and the one that decides whether this is worth having: the honest
  // sequence must still converge in raise → fix → resolve, with no extra round and no new field.
  it("accepts a resolution when the file the finding names holds different bytes", () => {
    const raised = round({
      cold: true,
      diff: OLD,
      code: "d".repeat(64),
      files: { "src/f.ts": "returns-true" },
      findings: [{ id: "src/f.ts::auth always returns true", severity: "must" }],
      newFindings: 1,
    });
    const fixed = round({
      lens: "cold-after-the-fix",
      cold: true,
      code: "e".repeat(64),
      files: { "src/f.ts": "checks-the-token" },
      resolved: ["src/f.ts::auth always returns true"],
    });
    assert.deepEqual(validate(converged({ rounds: [raised, fixed] }), HASH), { ok: true });
  });

  // A finding about a caller is often fixed in the callee. Refusing that would push honest reviews
  // toward waivers, which cost less — so the fix can name where it landed, and that path is
  // checked exactly as hard: the file it names has to have moved.
  it("accepts a resolution that names another file as where the fix landed, if that file moved", () => {
    const raised = round({
      cold: true,
      diff: OLD,
      code: "d".repeat(64),
      files: { "a.ts": "caller", "b.ts": "callee" },
      findings: [{ id: "a.ts::the token is never checked", severity: "must" }],
      newFindings: 1,
    });
    const elsewhere = { "a.ts": "caller", "b.ts": "callee-now-checks" };
    const named = round({
      lens: "cold-after-the-fix",
      cold: true,
      code: "e".repeat(64),
      files: elsewhere,
      resolved: [{ id: "a.ts::the token is never checked", file: "b.ts" }],
    });
    assert.deepEqual(validate(converged({ rounds: [raised, named] }), HASH), { ok: true });
    const lying = round({ ...named, resolved: [{ id: "a.ts::the token is never checked", file: "a.ts" }] });
    const v = validate(converged({ rounds: [raised, lying] }), HASH);
    assert.equal(v.ok, false, "naming a file that did not move must buy nothing");
  });

  it("accepts that same finding once it is waived with a reason and read past", () => {
    const open = round({ cold: true, findings: [{ id: "f.ts::boom", severity: "must" }] });
    const receipt = converged({
      rounds: [round({ newFindings: 1, diff: OLD }), open],
      // Recorded with round 0, so the cold round at the current diff came after it.
      waived: [{ finding: "f.ts::boom", why: "by design: the platform gives no way to detect this", round: 0 }],
    });
    assert.deepEqual(validate(receipt, HASH), { ok: true });
  });

  // Waiving was exempt from every rule except a 20-character reason — traced, then reproduced
  // through the CLI: `{"finding": "src/f.ts::auth always returns true", "why":
  // "aaaaaaaaaaaaaaaaaaaaaaaa"}` cleared a `must` with the working tree untouched and no commit.
  // Raising that finding had cost the author a round; writing it off cost less than raising it.
  it("refuses a waiver recorded after the last cold round, so writing a finding off costs a round", () => {
    const raised = round({ cold: true, findings: [{ id: "f.ts::boom", severity: "must" }], newFindings: 1 });
    const waivedAt1 = converged({
      rounds: [raised, round({ lens: "the-waiving-round" })],
      waived: [{ finding: "f.ts::boom", why: "accepted: nothing downstream can act on it anyway", round: 1 }],
    });
    const v = validate(waivedAt1, HASH);
    assert.equal(v.ok, false, "nobody has read the branch with that decision standing");
    assert.match(!v.ok ? v.reason : "", /f\.ts::boom/);
    assert.match(!v.ok ? v.reason : "", /costs\s+what raising one costs|one more cold round/);
    // The way through is the round, not a longer sentence: one cold round after the decision.
    const readPast = converged({
      rounds: [...waivedAt1.rounds, round({ lens: "cold-after-the-waiver", cold: true })],
      waived: waivedAt1.waived,
    });
    assert.deepEqual(validate(readPast, HASH), { ok: true });
  });

  // A cold round that came BEFORE the decision has not read the branch with it standing, and a
  // cold round on older code has not read this branch at all.
  it("counts only a cold round after the waiver, on the code as it ships", () => {
    const rounds = [round({ cold: true, newFindings: 1, diff: OLD }), round({ cold: true })];
    assert.equal(waiverAnswered({ round: 1 }, rounds, HASH), false, "the cold round is the one the waiver arrived with");
    assert.equal(waiverAnswered({ round: 0 }, rounds, HASH), true);
    assert.equal(waiverAnswered({ round: -1 }, [rounds[0]!], HASH), false, "that cold round reviewed older code");
    // Receipts written before waivers carried a round fall back to the older rule, where a reason
    // was the whole price — there is no migration for a gitignored file.
    assert.equal(waiverAnswered({}, rounds, HASH), true, "a legacy waiver keeps the rule it was written under");
  });

  // Reporting a blocking finding demands `evidence`; waiving one demanded nothing, so `why: ""`
  // cleared a `must` and dismissing a bug was cheaper than reporting it. Enforced where the
  // receipt is READ as well as where it is written, because anything that can write the file can
  // write any shape.
  it("ignores a waiver with no reason, so silence cannot clear a must", () => {
    const open = round({ cold: true, findings: [{ id: "f.ts::boom", severity: "must" }] });
    for (const why of ["", "   ", "wontfix"]) {
      const receipt = converged({ rounds: [round({ newFindings: 1, diff: OLD }), open], waived: [{ finding: "f.ts::boom", why }] });
      const v = validate(receipt, HASH);
      assert.equal(v.ok, false, `a waiver reading "${why}" must not count`);
      assert.match(v.ok ? "" : v.reason, /unresolved blocking/);
    }
  });

  it("does not let a leftover nit hold the gate open", () => {
    const nitty = round({ cold: true, findings: [{ id: "f.ts::naming", severity: "nit" }] });
    assert.deepEqual(validate(converged({ rounds: [round({ newFindings: 1, diff: OLD }), nitty] }), HASH), { ok: true });
  });

  it("refuses when every round was run by the session that wrote the code", () => {
    const v = validate(converged({ rounds: [round({ newFindings: 1, diff: OLD }), round()] }), HASH);
    assert.equal(v.ok, false);
    assert.match(!v.ok ? v.reason : "", /cold round is required/);
  });

  // A cold round somewhere in the history is not a cold round on this code: the cheap path was
  // one cold look early, then change whatever you like under warm rounds only.
  it("refuses when the only cold round reviewed earlier code", () => {
    const v = validate(converged({ rounds: [round({ cold: true, newFindings: 2, diff: OLD }), round({ lens: "inline" })] }), HASH);
    assert.equal(v.ok, false);
    assert.match(!v.ok ? v.reason : "", /cold round reviewed earlier code/);
  });

  it("refuses gates that were never run, failed, or ran on another diff", () => {
    for (const gates of [
      undefined,
      { passed: false, command: "npm run ci", diff: HASH, clean: true },
      { passed: true, command: "npm run ci", diff: OLD, clean: true },
    ]) {
      assert.equal(validate(converged({ gates }), HASH).ok, false);
    }
  });

  // Green in place is not green in CI: your disk has files git never saw and a node_modules
  // that may have drifted from the lockfile. Those are the two reasons a PR goes red minutes
  // after it opens, and the only run that can see them is a clean one.
  it("refuses gates that passed in place rather than on a clean checkout", () => {
    const v = validate(converged({ gates: { passed: true, command: "npm run ci", diff: HASH, clean: false } }), HASH);
    assert.equal(v.ok, false);
    assert.match(!v.ok ? v.reason : "", /in place, not on a clean checkout/);
  });

  // `validate` is called straight from the CLI, so a throw here is a stack trace where the
  // agent needs a reason and an instruction — refusing mute is refusing badly.
  it("returns a verdict rather than throwing on a malformed receipt", () => {
    // Every one of these reached a field read one level in and threw. The first two got past
    // the top-level `Array.isArray(rounds)` check that was supposed to cover this class — which
    // is why the shapes are enumerated here rather than trusted to a single guard.
    for (const bad of [
      {},
      { rounds: "no" },
      { rounds: [{}] },
      { rounds: [{ newFindings: 0 }, { newFindings: 0 }] },
      // Written as JSON because that is how they arrive: the receipt is a file on disk, so the
      // types say nothing about what `validate` is actually handed.
      JSON.parse(`{"rounds":[null,${JSON.stringify(round({ cold: true }))}]}`),
      JSON.parse(JSON.stringify({ ...converged(), waived: "whatever" })),
      JSON.parse(JSON.stringify({ ...converged(), waived: [null] })),
      // The waiver rule reads `why` and calls `.trim()` on it, which threw a TypeError out of
      // `validate` for a number there — the same crash class, reintroduced by that rule.
      JSON.parse(`{"rounds":[${JSON.stringify(round({ newFindings: 1, diff: OLD }))},${JSON.stringify(round({ cold: true }))}],"waived":[{"finding":"f::x","why":12345}]}`),
      JSON.parse(`{"rounds":[${JSON.stringify(round({ newFindings: 1, diff: OLD }))},{"lens":"cold","cold":true,"diff":"${HASH}","newFindings":0,"findings":[null]}]}`),
      // `resolved` is walked to decide whether a blocking finding is answered, so a non-list or
      // a list of non-strings is the same crash class one field along.
      JSON.parse(JSON.stringify({ ...converged(), rounds: [round({ newFindings: 1, diff: OLD }), { ...round({ cold: true }), resolved: "f::x" }] })),
      JSON.parse(JSON.stringify({ ...converged(), rounds: [round({ newFindings: 1, diff: OLD }), { ...round({ cold: true }), resolved: [12345] }] })),
      // The object form of a resolution is walked for an id AND a path, and `files` is walked for
      // its values — three more fields read off a file on disk, so three more of the same class.
      JSON.parse(JSON.stringify({ ...converged(), rounds: [round({ newFindings: 1, diff: OLD }), { ...round({ cold: true }), resolved: [{ id: "f::x" }] }] })),
      JSON.parse(JSON.stringify({ ...converged(), rounds: [round({ newFindings: 1, diff: OLD }), { ...round({ cold: true }), resolved: [{ file: "f.ts" }] }] })),
      JSON.parse(JSON.stringify({ ...converged(), rounds: [round({ newFindings: 1, diff: OLD }), { ...round({ cold: true }), files: "f.ts" }] })),
      JSON.parse(JSON.stringify({ ...converged(), rounds: [round({ newFindings: 1, diff: OLD }), { ...round({ cold: true }), files: { "f.ts": 12345 } }] })),
      // `round` on a waiver decides which cold rounds come after it, so a string there would
      // compare as a string against every index.
      JSON.parse(JSON.stringify({ ...converged(), waived: [{ finding: "f::x", why: "a reason long enough to count", round: "1" }] })),
    ]) {
      const v = validate(bad as unknown as Receipt, HASH);
      assert.equal(v.ok, false, `expected a refusal for ${JSON.stringify(bad)}`);
    }
  });

  // Fail closed: with no merge base every branch in every state hashes to one constant, so the
  // freshness check would be comparing a constant to itself.
  it("refuses when the diff cannot be resolved at all", () => {
    assert.equal(validate(converged({ gates: { passed: true, command: "x", diff: UNRESOLVABLE_DIFF, clean: true } }), UNRESOLVABLE_DIFF).ok, false);
  });
});

describe("counting what is new", () => {
  it("does not count a finding an earlier round already reported", () => {
    const first = appendRound({ branch: "b", rounds: [], conversions: [], waived: [] }, { lens: "a", cold: false, diff: HASH, findings: [{ id: "x", severity: "must" }] });
    const second = appendRound(first, { lens: "b", cold: true, diff: HASH, findings: [{ id: "x", severity: "must" }] });
    assert.equal(second.rounds[0]!.newFindings, 1);
    assert.equal(second.rounds[1]!.newFindings, 0);
  });

  // Filing something as a nit early and raising it later must not launder it into "nothing
  // new" — that is the cheap way to defuse a finding you do not want to fix.
  it("counts a nit later raised to a blocking severity as new", () => {
    const first = appendRound({ branch: "b", rounds: [], conversions: [], waived: [] }, { lens: "a", cold: false, diff: HASH, findings: [{ id: "x", severity: "nit" }] });
    const second = appendRound(first, { lens: "b", cold: true, diff: HASH, findings: [{ id: "x", severity: "must" }] });
    assert.equal(second.rounds[1]!.newFindings, 1);
  });

  it("never counts a nit as new", () => {
    const r = appendRound({ branch: "b", rounds: [], conversions: [], waived: [] }, { lens: "a", cold: false, diff: HASH, findings: [{ id: "x", severity: "nit" }] });
    assert.equal(r.rounds[0]!.newFindings, 0);
  });

  // `fingerprint` is lossy on purpose, so a collision within one file is a case it creates
  // rather than a freak accident. Last-wins would silently downgrade the must-fix.
  it("keeps the highest severity when two findings in one round collide", () => {
    const r = appendRound(
      { branch: "b", rounds: [], conversions: [], waived: [] },
      { lens: "a", cold: false, diff: HASH, findings: [{ id: "x", severity: "must" }, { id: "x", severity: "nit" }] },
    );
    assert.deepEqual(r.rounds[0]!.findings, [{ id: "x", severity: "must" }]);
    assert.equal(r.rounds[0]!.newFindings, 1);
  });

  it("ignores the line number, so fixing one finding does not make the next look new", () => {
    assert.equal(fingerprint("a.ts", "the `logout` call drops it"), fingerprint("a.ts", "The logout call drops it."));
    assert.notEqual(fingerprint("a.ts", "x"), fingerprint("b.ts", "x"));
  });
});

describe("recording a round", () => {
  it("rejects a round with no lens, so the floor cannot be padded with anonymous rounds", () => {
    assert.throws(() => recordRound({ lens: "  " }, snap(), "feature/x", dir), /needs a `lens`/);
  });

  // A blocking finding costs the author a round, so it has to be checkable — the cheapest
  // defence against a confident claim about code that does not say what the reviewer thinks.
  it("rejects a blocking finding with no evidence, and names which one", () => {
    assert.throws(
      () => recordRound({ lens: "a", findings: [{ file: "f.ts", claim: "boom" }] }, snap(), "feature/x", dir),
      /needs `evidence`.*f\.ts: boom/s,
    );
  });

  it("lets a nit through without evidence", () => {
    const r = recordRound({ lens: "a", findings: [{ file: "f.ts", claim: "naming", severity: "nit" }] }, snap(), "feature/x", dir);
    assert.equal(r.rounds.length, 1);
  });

  // Waiving is how a blocking finding leaves the record, so it costs at least what raising one
  // costs. It used to cost nothing: `why: ""` was accepted and cleared a `must`.
  it("refuses a waiver with no reason of its own", () => {
    for (const why of ["", "  ", "wontfix"]) {
      assert.throws(
        () => recordRound({ lens: "a", waived: [{ finding: "f.ts::boom", why }] }, snap(), "feature/x", dir),
        /every waiver needs .* REASON/s,
        `"${why}" must be refused`,
      );
    }
    assert.throws(
      () => recordRound({ lens: "a", waived: [{ finding: "  ", why: "a perfectly good reason, long enough" }] }, snap(), "feature/x", dir),
      /fingerprint/,
      "a waiver naming no finding waives nothing",
    );
    const ok = recordRound(
      { lens: "a", waived: [{ finding: "f.ts::boom", why: "not mechanisable: the platform exposes no hook for it" }] },
      snap(),
      "feature/x",
      dir,
    );
    assert.equal(ok.waived.length, 1);
  });

  // A resolution that matches nothing silently leaves the real finding open — the exact failure
  // the field exists to prevent — so a typo is an error where it is written, not an unexplained
  // refusal at handover.
  it("refuses a resolution no earlier round reported", () => {
    const buggy = snap({ diff: OLD, code: OLD, files: { "f.ts": "bug" } });
    const fixed = snap({ files: { "f.ts": "ok" } });
    recordRound({ lens: "one", findings: [{ file: "f.ts", claim: "boom", evidence: "f.ts:1" }] }, buggy, "feature/x", dir);
    assert.throws(() => recordRound({ lens: "two", resolved: ["f.ts::typo"] }, fixed, "feature/x", dir), /no earlier round reported/);
    assert.throws(() => recordRound({ lens: "two", resolved: ["  "] }, fixed, "feature/x", dir), /no earlier round reported/);
    const ok = recordRound({ lens: "two", resolved: ["f.ts::boom"] }, fixed, "feature/x", dir);
    assert.deepEqual(ok.rounds.at(-1)?.resolved, ["f.ts::boom"]);
  });

  // Every other claim here costs something; this one would cost one line of JSON if a round
  // could resolve what it is itself looking at. A fix moves the code, so the round after the fix
  // is the one that can say it.
  it("refuses to resolve a finding raised against the code as it stands", () => {
    const now = snap({ files: { "f.ts": "bug" } });
    recordRound({ lens: "one", findings: [{ file: "f.ts", claim: "boom", evidence: "f.ts:1" }] }, now, "feature/x", dir);
    assert.throws(() => recordRound({ lens: "two", resolved: ["f.ts::boom"] }, now, "feature/x", dir), /holds the same bytes/);
  });

  // ... and the diff moving is not the code moving. An untracked file appearing changes the hash
  // the round is stamped with and nothing else, so the write-time check has to ask the same
  // question the gate asks — otherwise the CLI records a resolution the handover will refuse, and
  // says so a round later than it could have.
  it("refuses to resolve one when only an untracked file moved the hash", () => {
    const CODE = "d".repeat(64);
    const before = snap({ code: CODE, files: { "f.ts": "bug" } });
    recordRound({ lens: "one", findings: [{ file: "f.ts", claim: "boom", evidence: "f.ts:1" }] }, before, "feature/x", dir);
    const shuffled = snap({ diff: OLD, code: CODE, files: { "f.ts": "bug" } });
    assert.throws(() => recordRound({ lens: "two", resolved: ["f.ts::boom"] }, shuffled, "feature/x", dir), /holds the same bytes/);
    const ok = recordRound({ lens: "two", resolved: ["f.ts::boom"] }, snap({ diff: OLD, files: { "f.ts": "ok" } }), "feature/x", dir);
    assert.deepEqual(ok.rounds.at(-1)?.resolved, ["f.ts::boom"], "a real code change still resolves it");
  });

  // The bypass that made this per-file: `chmod +x` on the very file the finding named printed
  // "1 file changed, 0 insertions(+), 0 deletions(-)", moved the tracked-diff hash, and bought the
  // resolution. The bytes are what the finding was about, and they did not move.
  it("refuses to resolve one when the file's mode moved but its bytes did not", () => {
    const before = snap({ code: "d".repeat(64), files: { "f.ts": "bug" } });
    recordRound({ lens: "one", findings: [{ file: "f.ts", claim: "auth always returns true", evidence: "f.ts:1" }] }, before, "feature/x", dir);
    // Everything a mode change moves: the diff text, and so both whole-diff hashes. Not the file.
    const chmodded = snap({ diff: OLD, code: "e".repeat(64), files: { "f.ts": "bug" } });
    assert.throws(
      () => recordRound({ lens: "two", resolved: ["f.ts::auth always returns true"] }, chmodded, "feature/x", dir),
      /holds the same bytes/,
    );
  });

  // An edit ANYWHERE used to answer any finding. The refusal has to name the file and the way out,
  // because the honest case it also refuses — a fix that landed in the callee — looks identical
  // from here and the author needs to be told what to write instead.
  it("refuses a resolution when some other file moved, and says how to name where the fix landed", () => {
    const before = snap({ code: "d".repeat(64), files: { "f.ts": "bug", "g.ts": "one" } });
    recordRound({ lens: "one", findings: [{ file: "f.ts", claim: "boom", evidence: "f.ts:1" }] }, before, "feature/x", dir);
    const elsewhere = snap({ diff: OLD, code: "e".repeat(64), files: { "f.ts": "bug", "g.ts": "two" } });
    assert.throws(() => recordRound({ lens: "two", resolved: ["f.ts::boom"] }, elsewhere, "feature/x", dir), /"file": "<path you changed>"/);
    const ok = recordRound({ lens: "two", resolved: [{ id: "f.ts::boom", file: "g.ts" }] }, elsewhere, "feature/x", dir);
    assert.deepEqual(ok.rounds.at(-1)?.resolved, [{ id: "f.ts::boom", file: "g.ts" }], "the claim about where it landed is on the record");
    // ... and naming a file that did not move buys nothing, so the object form is a claim, not a
    // key that switches the check off.
    assert.throws(
      () => recordRound({ lens: "three", resolved: [{ id: "f.ts::boom", file: "f.ts" }] }, elsewhere, "feature/x", dir),
      /holds the same bytes/,
    );
    assert.throws(
      () => recordRound({ lens: "three", resolved: [{ id: "f.ts::boom", file: "  " }] }, elsewhere, "feature/x", dir),
      /names an empty file/,
    );
  });

  it("stamps each round with the code and the files it reviewed, not only the diff", () => {
    const r = recordRound({ lens: "one" }, snap({ code: "d".repeat(64), files: { "f.ts": "x" } }), "feature/x", dir);
    assert.equal(r.rounds.at(-1)?.code, "d".repeat(64));
    assert.deepEqual(r.rounds.at(-1)?.files, { "f.ts": "x" });
  });

  // A waiver is answered by a cold round recorded AFTER it, so the index it was recorded at is
  // what makes that checkable. Off by one and the round it arrived with would answer it.
  it("stamps a waiver with the round it was recorded alongside", () => {
    recordRound({ lens: "one", findings: [{ file: "f.ts", claim: "boom", evidence: "f.ts:1" }] }, snap(), "feature/x", dir);
    const r = recordRound({ lens: "two", waived: [{ finding: "f.ts::boom", why: "accepted: it costs more to mechanise than it saves" }] }, snap(), "feature/x", dir);
    assert.equal(r.waived.at(-1)?.round, 1, "the waiver arrived with round index 1, not with the round before it");
  });

  // Rounds happen in different sessions, so the curve has to accumulate on disk or round 4
  // re-reports what round 2 found and the gate never converges.
  it("extends a receipt written by an earlier session rather than restarting it", () => {
    recordRound({ lens: "one", findings: [{ file: "f.ts", claim: "boom", evidence: "f.ts:1" }] }, snap(), "feature/x", dir);
    const second = recordRound({ lens: "two", cold: true, findings: [{ file: "f.ts", claim: "boom", evidence: "f.ts:1" }] }, snap(), "feature/x", dir);
    assert.deepEqual(second.rounds.map((r) => r.newFindings), [1, 0]);
  });

  it("keeps two branches' receipts apart even when a name would collide as a filename", () => {
    recordRound({ lens: "a" }, snap(), "feature/x", dir);
    recordRound({ lens: "b" }, snap(), "feature-x", dir);
    assert.equal(readReceipt("feature/x", dir)?.rounds[0]?.lens, "a");
    assert.equal(readReceipt("feature-x", dir)?.rounds[0]?.lens, "b", "a slash and a dash must not share a receipt");
  });

  it("treats a corrupt receipt as a missing one rather than trusting half a file", () => {
    writeReceipt(converged({ branch: "feature/x" }), dir);
    assert.ok(readReceipt("feature/x", dir), "the fixture must be readable before it is broken");
    writeFileSync(receiptPath("feature/x", dir), "{not json");
    assert.equal(readReceipt("feature/x", dir), null);
  });
});

describe("the handover to a human", () => {
  const file = () => join(dir, "pr-body.md");
  const BRANCH = "feature/x";

  // The whole shape of the gate: the artefact needed to open a PR does not exist until the
  // review converged. Skipping the review produces no handover at all, rather than a PR someone
  // has to catch.
  it("writes nothing when the review has not converged", () => {
    const v = handover(converged({ rounds: [round({ cold: true })] }), HASH, "a body", BRANCH, file());
    assert.equal(v.ok, false);
    assert.throws(() => readFileSync(file(), "utf8"), /ENOENT/, "no body file may exist when the gate is red");
  });

  it("writes nothing when there is no receipt at all", () => {
    assert.equal(handover(null, HASH, "a body", BRANCH, file()).ok, false);
    assert.throws(() => readFileSync(file(), "utf8"), /ENOENT/);
  });

  it("writes the body once the gate passes", () => {
    assert.deepEqual(handover(converged(), HASH, "## What was wrong\n…", BRANCH, file()), { ok: true });
    assert.match(readFileSync(file(), "utf8"), /What was wrong/);
  });

  it("refuses an empty body, so the human is never handed a blank PR", () => {
    assert.equal(handover(converged(), HASH, "   \n", BRANCH, file()).ok, false);
  });

  // The path is fixed and gitignored, so a body outlives the branch that earned it unless
  // something removes it. A refusal that leaves the previous body standing hands the caller the
  // artefact it just declined to write, and `--body-file` cannot tell the two apart.
  it("removes an existing body when it refuses, so a refusal leaves nothing to open a PR with", () => {
    assert.deepEqual(handover(converged(), HASH, "an earned body", BRANCH, file()), { ok: true });
    assert.equal(handover(converged({ rounds: [round({ cold: true })] }), HASH, "a body", BRANCH, file()).ok, false);
    assert.throws(() => readFileSync(file(), "utf8"), /ENOENT/, "the earlier body must not survive a refusal");
  });

  // The receipt is gitignored, so the person opening the PR cannot see it. A body claiming a
  // converged review with nothing behind it is exactly what AGENTS.md says this exists to avoid:
  // "explicit, attributable and readable afterwards" has to mean readable to THEM.
  it("embeds the curve, since the receipt itself never leaves this machine", () => {
    assert.deepEqual(handover(converged(), HASH, "## What was wrong\nA thing.", BRANCH, file()), { ok: true });
    const written = readFileSync(file(), "utf8");
    assert.match(written, /^## What was wrong/, "the author's reasoning stays first");
    assert.match(written, /rounds →/, "and the curve travels with it");
  });

  // The other half of what a waiver costs (the first is the round `waiverAnswered` demands): the
  // human opening the PR cannot see the receipt, which is gitignored, so a decision to ship a
  // known defect travelled to them as the digit in "waived: 1". Now it travels as the finding and
  // the reason, in the rendered body.
  it("spells out every waived finding, since the receipt never reaches whoever reads the PR", () => {
    const receipt = converged({
      rounds: [round({ newFindings: 1, diff: OLD }), round({ cold: true, findings: [{ id: "src/f.ts::auth always returns true", severity: "must" }] })],
      waived: [{ finding: "src/f.ts::auth always returns true", why: "accepted: the caller is trusted and this ships behind a flag", round: 0 }],
    });
    assert.deepEqual(validate(receipt, HASH), { ok: true }, "the fixture must be one the gate accepts");
    assert.deepEqual(handover(receipt, HASH, "body", BRANCH, file()), { ok: true });
    const rendered = readFileSync(file(), "utf8").replace(/<!--[\s\S]*?-->/g, "");
    assert.match(rendered, /1 known finding waived/);
    assert.match(rendered, /auth always returns true/, "which finding");
    assert.match(rendered, /the caller is trusted/, "and the reason given for shipping it");
  });

  // Pruning cannot reach a body someone names by hand, so the last defence is a human reading
  // the PR: the branch and the diff are IN the body, in words, not only in the stamp.
  it("names the branch and the diff it attests to, so a stale body reads as stale", () => {
    assert.deepEqual(handover(converged(), HASH, "body", BRANCH, file()), { ok: true });
    // With the HTML comments stripped: what GitHub RENDERS. Matching the raw file passed on the
    // machine-readable stamp alone, which no reader of the PR ever sees — the assertion looked
    // like it covered the visible line and did not.
    const rendered = readFileSync(file(), "utf8").replace(/<!--[\s\S]*?-->/g, "");
    assert.match(rendered, new RegExp(BRANCH), "whoever reads the PR must see which branch was reviewed");
    assert.match(rendered, new RegExp(HASH.slice(0, 12)), "and which diff");
  });
});

// The hole this closes, in one sentence: land branch A, cut branch B, and
// `gh pr create --body-file .claude/pr-body.md` succeeds on B with A's converged body. The
// receipts are branch-keyed (`receiptPath`); the body file is one fixed, gitignored path that
// nothing used to clean up.
describe("a body file that has outlived what it attests to", () => {
  const file = () => join(dir, "pr-body.md");

  const bodyFor = (branch: string, hash: string) => {
    handover({ ...converged({ branch }), gates: { passed: true, command: "npm run ci", diff: hash, clean: true },
      rounds: [round({ newFindings: 3, diff: OLD }), round({ lens: "cold-subagent", cold: true, diff: hash })] },
      hash, "an earned body", branch, file());
  };

  it("does not satisfy the next branch", () => {
    bodyFor("feature/a", HASH);
    assert.equal(pruneStaleHandover("feature/b", HASH, file()), true, "another branch's body must be removed");
    assert.throws(() => readFileSync(file(), "utf8"), /ENOENT/);
  });

  it("does not survive the code changing under it on the same branch", () => {
    bodyFor("feature/a", HASH);
    assert.equal(pruneStaleHandover("feature/a", OLD, file()), true);
    assert.throws(() => readFileSync(file(), "utf8"), /ENOENT/);
  });

  // The other half, and the one that would make this net negative if it broke: an agent that
  // genuinely converged must still get its body in one command. Every CLI command prunes, so a
  // prune that could not recognise a FRESH body would delete the handover between writing it
  // and reading it.
  it("leaves the body for this branch and this diff alone", () => {
    bodyFor("feature/a", HASH);
    assert.equal(pruneStaleHandover("feature/a", HASH, file()), false);
    assert.match(readFileSync(file(), "utf8"), /an earned body/);
  });

  it("removes a body it cannot read a stamp from at all", () => {
    writeFileSync(file(), "a hand-written body with no stamp\n");
    assert.equal(pruneStaleHandover("feature/a", HASH, file()), true);
    assert.throws(() => readFileSync(file(), "utf8"), /ENOENT/);
  });

  // "Unreadable counts as stale" was a comment with nothing behind it: making the read failure
  // KEEP the file instead left every test green. The body here is otherwise perfectly current,
  // so only the unreadability can remove it.
  it("removes a body it cannot read AT ALL, even one stamped for this branch and diff", () => {
    bodyFor("feature/a", HASH);
    assert.equal(pruneStaleHandover("feature/a", HASH, file()), false, "readable and current: the premise of this test");
    chmodSync(file(), 0o000);
    assert.throws(() => readFileSync(file(), "utf8"), /EACCES/, "the file must actually be unreadable, or this test asserts nothing");
    assert.equal(pruneStaleHandover("feature/a", HASH, file()), true);
    assert.throws(() => readFileSync(file(), "utf8"), /ENOENT/);
  });

  it("reports nothing to prune when there is no body", () => {
    assert.equal(pruneStaleHandover("feature/a", HASH, file()), false);
  });
});

// AGENTS.md promises that EVERY `review:*` command prunes a stale body, and nothing exercised
// the CLI at all — the prune call could be deleted, or moved under one command, with the suite
// green. So this RUNS the commands as package.json configures them rather than reading them: a
// test that checks the wiring by reading it is a test of the string, not of the behaviour.
describe("the commands a human actually runs", () => {
  const scripts = () => (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts;

  /** A throwaway repo with an `origin/main` to hash against, so the CLI runs for real. */
  const repoWithStaleBody = (): string => {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    const git = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "a");
    git("add", "a.txt");
    git("commit", "-qm", "one");
    // `diffHash` refuses to answer without one, and a refusal would prune nothing.
    assert.equal(git("update-ref", "refs/remotes/origin/main", "HEAD").status, 0);
    writeFileSync(join(repo, ".claude", "pr-body.md"), `earned elsewhere\n<!-- deckhand-handover branch=feature/other diff=${HASH} -->\n`);
    return repo;
  };

  // Every refusal `recordRound` raises names the fingerprint, the file and what to write instead —
  // and thrown from the entry point it reached the caller as a stack trace with the instruction
  // buried in it, which reads as a broken tool rather than as a state to fix.
  it("`npm run review:round` refuses with the instruction, not with a stack trace", () => {
    const repo = repoWithStaleBody();
    const cmd = scripts()["review:round"]!.replace("scripts/review-receipt.ts", join(process.cwd(), "scripts/review-receipt.ts"));
    for (const [body, expected] of [
      ['{"lens":"  "}', /needs a `lens`/],
      ["not json at all", /./],
    ] as const) {
      const run = spawnSync("sh", ["-c", cmd], {
        cwd: repo,
        input: body,
        encoding: "utf8",
        env: { ...process.env, PATH: `${join(process.cwd(), "node_modules/.bin")}:${process.env.PATH ?? ""}` },
      });
      assert.equal(run.status, 1, `expected a refusal for ${body}: ${run.stderr}`);
      assert.match(run.stderr ?? "", /✗ /, `expected a stated refusal for ${body}: ${run.stderr}`);
      assert.match(run.stderr ?? "", expected);
      assert.doesNotMatch(run.stderr ?? "", /^\s+at .*\(/m, `the refusal arrived as a crash: ${run.stderr}`);
    }
  });

  for (const verb of ["review:show", "review:check", "review:hash"]) {
    it(`\`npm run ${verb}\` deletes a body written for another branch`, () => {
      const configured = scripts()[verb]!;
      assert.match(configured, /scripts\/review-receipt\.ts/, `${verb} must still run this script`);
      const repo = repoWithStaleBody();
      // The configured command, with only the paths relocated to the throwaway repo — the verb
      // and the entry point come from package.json, which is the part that can drift.
      const cmd = configured.replace("scripts/review-receipt.ts", join(process.cwd(), "scripts/review-receipt.ts"));
      const run = spawnSync("sh", ["-c", cmd], {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, PATH: `${join(process.cwd(), "node_modules/.bin")}:${process.env.PATH ?? ""}` },
      });
      // The prune NOTICE, not a guess at what a failure would look like. Pruning happens before
      // the verb is dispatched, so a command that crashes on every input still leaves the body
      // deleted and the assertion below green — and grepping stderr for "Cannot find|not found"
      // sees a module error but not a TypeError. What proves the command ran is its own output,
      // and it says the thing this test is about. (`review:check` exits 1 here by design — there
      // is no receipt in a throwaway repo — so the exit code cannot be the signal.)
      assert.match(run.stderr ?? "", /removed \.claude\/pr-body\.md/, `${verb} did not run its prune step: ${run.stderr}`);
      assert.doesNotMatch(run.stderr ?? "", /^\s+at .*\(/m, `${verb} crashed after pruning: ${run.stderr}`);
      assert.equal(existsSync(join(repo, ".claude", "pr-body.md")), false, `${verb} left another branch's body in place: ${run.stderr}`);
    });
  }
});

// The comment on RECEIPT_DIR states this, and the whole mechanism rests on it: `diffHash`
// folds the untracked-file list in, so a receipt git can see changes the diff it attests to.
// Every round would be instantly stale and `review:gates` would call the tree dirty forever —
// a wedge with no honest way out, and no red test to explain it.
describe("the receipt must be invisible to git", () => {
  it("keeps the receipt dir and the PR body ignored", () => {
    for (const path of [`${RECEIPT_DIR}/feature-x.json`, HANDOVER_FILE]) {
      const check = spawnSync("git", ["check-ignore", "-q", path], { cwd: process.cwd() });
      assert.equal(check.status, 0, `${path} is not gitignored — writing one would change the diff it attests to`);
    }
  });
});

describe("what a quick gate run may overwrite", () => {
  // The skill sells the quick run as the loop command. If one sanity check on unchanged code
  // voided the expensive clean run, the honest path would cost a full `npm ci` again for no
  // new information — and the gate would refuse until it was paid.
  it("leaves a clean pass standing when it passes on the same diff", () => {
    assert.equal(keepsCleanRun(converged(), HASH, true), true);
  });

  // The nastier direction, and the one the first version of this got wrong: not downgrading a
  // pass, but UPGRADING a failure. `review:gates` goes red on the worktree, `review:gates:quick`
  // goes green in place, and the receipt reads "green on a clean checkout".
  it("never promotes a red clean run to a green one", () => {
    const red = converged({ gates: { passed: false, command: "npm run ci", diff: HASH, clean: true } });
    assert.equal(keepsCleanRun(red, HASH, true), false);
    assert.equal(validate({ ...red, gates: { ...red.gates!, passed: true, clean: keepsCleanRun(red, HASH, true) } }, HASH).ok, false);
  });

  it("does not launder a clean pass on other code, or one that has just gone red", () => {
    assert.equal(keepsCleanRun(converged(), OLD, true), false, "a clean run on another diff says nothing about this one");
    assert.equal(keepsCleanRun(converged(), HASH, false), false, "a failure is new information and it stands");
    assert.equal(keepsCleanRun(converged({ gates: undefined }), HASH, true), false, "nothing clean to keep");
    const inPlace = converged({ gates: { passed: true, command: "npm run ci", diff: HASH, clean: false } });
    assert.equal(keepsCleanRun(inPlace, HASH, true), false, "an in-place run cannot promote itself");
  });
});

describe("where the clean gate runs", () => {
  // In a LINKED worktree `<toplevel>/.git` is a file, so `git worktree add` under it fails and
  // the clean gate — the only one that satisfies the handover — could not run at all. Agents
  // work in worktrees here, so that was a working mode with no honest route to a PR. Built as
  // a real repo with a real linked worktree, because the bug was in which git question is
  // asked and a stubbed answer would have agreed with the wrong one.
  it("puts the throwaway checkout in the common git dir, so it works from a linked worktree too", () => {
    const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
    const main = join(dir, "repo");
    mkdirSync(main);
    git(main, "init", "-q");
    git(main, "config", "user.email", "t@example.com");
    git(main, "config", "user.name", "t");
    writeFileSync(join(main, "a.txt"), "a");
    git(main, "add", "-A");
    git(main, "commit", "-qm", "one");
    const linked = join(dir, "linked");
    assert.equal(git(main, "worktree", "add", "--detach", linked, "HEAD").status, 0);
    assert.ok(statSync(join(linked, ".git")).isFile(), "a linked worktree's .git is a file — the premise of this test");

    const inLinked = (args: string[]) => spawnSync("git", args, { cwd: linked, encoding: "utf8" }).stdout ?? "";
    const target = gatesWorktree(inLinked)!;
    assert.ok(statSync(dirname(target)).isDirectory(), `${dirname(target)} must be a directory git can create a worktree under`);
    assert.equal(spawnSync("git", ["worktree", "add", "--detach", target, "HEAD"], { cwd: linked }).status, 0);

    // …and one NAME per caller, not per repo. The common dir is shared by every linked
    // worktree, and a run's first act is `worktree remove --force` on that path — so with one
    // shared name a second agent deletes the first's checkout mid-`npm ci`.
    assert.equal(gatesWorktree(inLinked), target, "stable per caller — the next run reclaims the last one's leftovers by name");

    const inMain = (args: string[]) => spawnSync("git", args, { cwd: main, encoding: "utf8" }).stdout ?? "";
    const fromMain = gatesWorktree(inMain)!;
    assert.equal(dirname(fromMain), dirname(target), "both still live under the shared common git dir");
    assert.notEqual(fromMain, target, "two worktrees must not share one gates checkout");
    assert.equal(spawnSync("git", ["worktree", "add", "--detach", fromMain, "HEAD"], { cwd: main }).status, 0, "both can exist at once");

    for (const [cwd, path] of [
      [linked, target],
      [main, fromMain],
    ] as const) {
      spawnSync("git", ["worktree", "remove", "--force", path], { cwd });
    }
  });
});

// Per-caller names fixed one leak and opened another: a run killed during `npm ci` leaves a
// registered worktree and a full node_modules that only a later run from the SAME path would
// clear — and `.worktrees/` paths are exactly the ones that get deleted and never reused.
describe("gates checkouts left behind by a killed run", () => {
  const plant = (name: string, owner?: string) => {
    const path = join(dir, name);
    mkdirSync(path);
    if (owner !== undefined) writeFileSync(`${path}.owner`, `${owner}\n`);
    return path;
  };

  it("reclaims one whose owner is gone, and leaves a live one alone", () => {
    const live = plant("review-gates-live", dir);
    const dead = plant("review-gates-dead", join(dir, "worktree-that-was-deleted"));
    const unmarked = plant("review-gates-unmarked");
    const other = plant("node_modules");

    const removed: string[] = [];
    reclaimAbandonedGates(dir, (p) => removed.push(p));
    assert.deepEqual(removed.sort(), [dead, unmarked].sort());
    assert.ok(!removed.includes(live), "a concurrent run in another worktree is the case per-caller names exist to protect");
    assert.ok(!removed.includes(other), "only this function's own directories");
  });

  it("does nothing when the git dir does not exist", () => {
    const removed: string[] = [];
    reclaimAbandonedGates(join(dir, "nope"), (p) => removed.push(p));
    assert.deepEqual(removed, []);
  });
});

describe("the summary a human reads", () => {
  // It runs on the SUCCESS path, after `handover` has already written the body file. Throwing
  // there hands a human a nonzero exit and no printed command for a review that passed.
  it("does not throw on a receipt the gate accepted but that omits an optional key", () => {
    const receipt = JSON.parse(JSON.stringify({ ...converged(), conversions: undefined, waived: undefined })) as Receipt;
    assert.deepEqual(validate(receipt, HASH), { ok: true }, "the gate accepts it, so the summary must survive it");
    assert.match(summarize(receipt), /rounds →/);
  });

  it("shows the curve, which round was cold, the checks added and the nits", () => {
    const nitty = round({ lens: "cold-subagent", cold: true, findings: [{ id: "x", severity: "nit" }] });
    const s = summarize(converged({ rounds: [round({ lens: "inline", newFindings: 3, diff: OLD }), nitty] }));
    assert.match(s, /inline: 3/);
    assert.match(s, /cold-subagent \(cold\): 0/);
    assert.match(s, /checks added: 1/);
    assert.match(s, /nits \(non-blocking\): 1/);
  });

  // A curve that converged by FIXING things and one that converged by writing them off are
  // different reviews, and this line is where a human tells them apart afterwards.
  it("distinguishes what was fixed from what was waived", () => {
    const s = summarize(
      converged({
        rounds: [round({ newFindings: 2, diff: OLD }), round({ cold: true, resolved: ["f.ts::boom", "f.ts::boom"] })],
        waived: [{ finding: "g.ts::x", why: "not mechanisable: the platform exposes no hook" }],
      }),
    );
    assert.match(s, /resolved: 1/, "counted per finding, not per mention");
    assert.match(s, /waived: 1/);
  });
});

describe("what counts as the code under review", () => {
  // `--name-only` is a second `git diff` with a different question, so the fake has to tell the
  // two apart — keying on `args[0]` alone answered the file list with the diff text.
  const fake = (parts: Record<string, string>) => (args: string[]) =>
    args.includes("--name-only") ? (parts.names ?? "") : (parts[args[0]!] ?? "");

  it("is one hash over the merge-base diff plus the untracked file list", () => {
    const a = diffHash("origin/main", fake({ "merge-base": "abc\n", diff: "D", "ls-files": "u.txt" }));
    const b = diffHash("origin/main", fake({ "merge-base": "abc\n", diff: "D", "ls-files": "u.txt" }));
    assert.equal(a, b, "the same code must hash the same");
    assert.notEqual(a, diffHash("origin/main", fake({ "merge-base": "abc\n", diff: "D2", "ls-files": "u.txt" })));
    assert.notEqual(a, diffHash("origin/main", fake({ "merge-base": "abc\n", diff: "D", "ls-files": "" })));
  });

  // The domain separator: without it a change that merely moves bytes across the diff/untracked
  // boundary hashes identically, and a stale round reads as fresh.
  it("does not let the diff and the untracked list trade bytes", () => {
    const one = diffHash("origin/main", fake({ "merge-base": "abc\n", diff: "AB", "ls-files": "C" }));
    const two = diffHash("origin/main", fake({ "merge-base": "abc\n", diff: "A", "ls-files": "BC" }));
    assert.notEqual(one, two);
  });

  it("fails closed when there is no merge base", () => {
    assert.equal(diffHash("origin/main", fake({})), UNRESOLVABLE_DIFF);
    assert.equal(diffHashes("origin/main", fake({})).code, UNRESOLVABLE_DIFF, "the code half must fail closed too");
  });

  // The half a resolution rests on. If it moved when an untracked file appeared, `touch
  // scratch.tmp` would buy a `must` its way off the record — which it did, until it had its own
  // hash.
  it("hashes the code without the untracked file list, so a scratch file is not a fix", () => {
    const code = (untracked: string) => diffHashes("origin/main", fake({ "merge-base": "abc\n", diff: "D", "ls-files": untracked })).code;
    assert.equal(code(""), code("scratch.tmp"), "an untracked file is not a code change");
    assert.notEqual(code(""), diffHashes("origin/main", fake({ "merge-base": "abc\n", diff: "D2", "ls-files": "" })).code);
    const both = diffHashes("origin/main", fake({ "merge-base": "abc\n", diff: "D", "ls-files": "scratch.tmp" }));
    assert.notEqual(both.diff, diffHashes("origin/main", fake({ "merge-base": "abc\n", diff: "D", "ls-files": "" })).diff, "the identity half still sees it");
  });

  // The part a resolution actually rests on: bytes per path. It hashes the FILE, not that file's
  // slice of the diff text — a mode change, a rebase, or an edit above a hunk all rewrite the diff
  // text of a file whose content is exactly what it was.
  it("hashes the content of each changed file, and reads it from the repository root", () => {
    const read: string[] = [];
    const files = (contents: Record<string, string>) =>
      diffHashes("origin/main", fake({ "merge-base": "abc\n", diff: "D", names: "src/f.ts\nsrc/gone.ts\n", "rev-parse": "/repo\n" }), (p) => {
        read.push(p);
        const key = p.replace("/repo/", "");
        return key in contents ? Buffer.from(contents[key]!) : null;
      }).files;
    const one = files({ "src/f.ts": "auth" });
    assert.deepEqual(Object.keys(one), ["src/f.ts"], "a deleted file has no content to match, so it is absent");
    assert.deepEqual(read, ["/repo/src/f.ts", "/repo/src/gone.ts"], "paths are joined to the toplevel, not read against the cwd");
    assert.equal(one["src/f.ts"], files({ "src/f.ts": "auth" })["src/f.ts"], "the same bytes hash the same");
    assert.notEqual(one["src/f.ts"], files({ "src/f.ts": "auth " })["src/f.ts"]);
  });

  it("fails closed on the file map too when there is no merge base", () => {
    assert.deepEqual(diffHashes("origin/main", fake({})).files, {}, "no map means every resolution is refused, not accepted");
  });
});

// The predicate every resolution now rests on. Its comment claims exactly two things — the bytes
// at that path differ, and they have not merely been relabelled — and these are them.
describe("whether the bytes at a path moved", () => {
  it("is false when the content is identical, whatever else changed around it", () => {
    assert.equal(contentMoved({ "f.ts": "x", "g.ts": "1" }, { "f.ts": "x", "g.ts": "2" }, "f.ts"), false);
    assert.equal(contentMoved({ "f.ts": "x" }, { "f.ts": "x", "new.ts": "n" }, "f.ts"), false);
  });

  it("is false for a rename, since the bytes came across intact", () => {
    assert.equal(contentMoved({ "f.ts": "x" }, { "g.ts": "x" }, "f.ts"), false, "same code, new label");
    assert.equal(contentMoved({ "f.ts": "x" }, { "g.ts": "y" }, "f.ts"), true, "renamed AND rewritten is a change");
  });

  it("is true when the file is edited, added or emptied out of the diff", () => {
    assert.equal(contentMoved({ "f.ts": "x" }, { "f.ts": "y" }, "f.ts"), true);
    assert.equal(contentMoved({}, { "f.ts": "x" }, "f.ts"), true, "a file the branch did not touch before");
    assert.equal(contentMoved({ "f.ts": "x" }, {}, "f.ts"), true, "reverted to what main has");
  });

  it("is symmetric enough to expire a resolution when the code goes back", () => {
    assert.equal(contentMoved({ "f.ts": "bug" }, { "f.ts": "fixed" }, "f.ts"), true);
    assert.equal(contentMoved({ "f.ts": "bug" }, { "f.ts": "bug" }, "f.ts"), false, "a revert puts the finding back");
  });
});

// `git branch --show-current` prints nothing on a detached HEAD, so every detached run shares one
// receipt file. That is a stated limit in `currentBranch` rather than a bug — it fails closed,
// since `validate` pins the last round and the gates to the current diff, and a detached HEAD
// cannot be pushed or handed over. The test is here so the comment cannot quietly stop being true.
describe("a detached HEAD has no branch", () => {
  it("returns an empty name, and so one shared receipt path", () => {
    const repo = join(dir, "detached");
    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "a");
    git("add", "a.txt");
    git("commit", "-qm", "one");
    const run = (args: string[]) => {
      const p = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      return p.status === 0 ? (p.stdout ?? "") : "";
    };
    assert.equal(currentBranch(run), git("rev-parse", "--abbrev-ref", "HEAD").stdout.trim(), "on a branch it is the branch");
    assert.equal(git("checkout", "-q", "--detach", "HEAD").status, 0);
    assert.equal(currentBranch(run), "", "detached: no name to key a receipt to");
    // One name, so one file for every detached run — but not a file any named branch would use,
    // which is the part that would actually be dangerous.
    assert.ok(!["feature/x", "main", "-"].some((b) => receiptPath(b, dir) === receiptPath("", dir)));
  });
});
