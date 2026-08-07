import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendRound,
  diffHash,
  fingerprint,
  handover,
  MIN_ROUNDS,
  readReceipt,
  receiptPath,
  recordRound,
  summarize,
  UNRESOLVABLE_DIFF,
  validate,
  writeReceipt,
  type Receipt,
  type Round,
} from "./review-receipt.ts";

const HASH = "a".repeat(64);
const OLD = "b".repeat(64);

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
    assert.match(!v.ok ? v.reason : "", /unresolved finding/);
  });

  it("accepts that same finding once it is waived with a reason", () => {
    const open = round({ cold: true, findings: [{ id: "f.ts::boom", severity: "must" }] });
    const receipt = converged({ rounds: [round({ newFindings: 1, diff: OLD }), open], waived: [{ finding: "f.ts::boom", why: "by design" }] });
    assert.deepEqual(validate(receipt, HASH), { ok: true });
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

  // A crash in the guard OPENS the gate it exists to close: a PreToolUse hook that throws is
  // reported as a non-blocking error and the command runs.
  it("returns a verdict rather than throwing on a malformed receipt", () => {
    for (const bad of [{}, { rounds: "no" }, { rounds: [{}] }, { rounds: [{ newFindings: 0 }, { newFindings: 0 }] }]) {
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
    assert.throws(() => recordRound({ lens: "  " }, HASH, "feature/x", dir), /needs a `lens`/);
  });

  // A blocking finding costs the author a round, so it has to be checkable — the cheapest
  // defence against a confident claim about code that does not say what the reviewer thinks.
  it("rejects a blocking finding with no evidence, and names which one", () => {
    assert.throws(
      () => recordRound({ lens: "a", findings: [{ file: "f.ts", claim: "boom" }] }, HASH, "feature/x", dir),
      /needs `evidence`.*f\.ts: boom/s,
    );
  });

  it("lets a nit through without evidence", () => {
    const r = recordRound({ lens: "a", findings: [{ file: "f.ts", claim: "naming", severity: "nit" }] }, HASH, "feature/x", dir);
    assert.equal(r.rounds.length, 1);
  });

  // Rounds happen in different sessions, so the curve has to accumulate on disk or round 4
  // re-reports what round 2 found and the gate never converges.
  it("extends a receipt written by an earlier session rather than restarting it", () => {
    recordRound({ lens: "one", findings: [{ file: "f.ts", claim: "boom", evidence: "f.ts:1" }] }, HASH, "feature/x", dir);
    const second = recordRound({ lens: "two", cold: true, findings: [{ file: "f.ts", claim: "boom", evidence: "f.ts:1" }] }, HASH, "feature/x", dir);
    assert.deepEqual(second.rounds.map((r) => r.newFindings), [1, 0]);
  });

  it("keeps two branches' receipts apart even when a name would collide as a filename", () => {
    recordRound({ lens: "a" }, HASH, "feature/x", dir);
    recordRound({ lens: "b" }, HASH, "feature-x", dir);
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

  // The whole shape of the human gate: the agent cannot run `gh pr create`, and the artefact
  // the human needs does not exist until the review converged. Skipping the review produces no
  // handover at all, rather than a PR someone has to catch.
  it("writes nothing when the review has not converged", () => {
    const v = handover(converged({ rounds: [round({ cold: true })] }), HASH, "a body", file());
    assert.equal(v.ok, false);
    assert.throws(() => readFileSync(file(), "utf8"), /ENOENT/, "no body file may exist when the gate is red");
  });

  it("writes nothing when there is no receipt at all", () => {
    assert.equal(handover(null, HASH, "a body", file()).ok, false);
    assert.throws(() => readFileSync(file(), "utf8"), /ENOENT/);
  });

  it("writes the body once the gate passes", () => {
    assert.deepEqual(handover(converged(), HASH, "## What was wrong\n…", file()), { ok: true });
    assert.match(readFileSync(file(), "utf8"), /What was wrong/);
  });

  it("refuses an empty body, so the human is never handed a blank PR", () => {
    assert.equal(handover(converged(), HASH, "   \n", file()).ok, false);
  });
});

describe("the summary a human reads", () => {
  it("shows the curve, which round was cold, the checks added and the nits", () => {
    const nitty = round({ lens: "cold-subagent", cold: true, findings: [{ id: "x", severity: "nit" }] });
    const s = summarize(converged({ rounds: [round({ lens: "inline", newFindings: 3, diff: OLD }), nitty] }));
    assert.match(s, /inline: 3/);
    assert.match(s, /cold-subagent \(cold\): 0/);
    assert.match(s, /checks added: 1/);
    assert.match(s, /nits \(non-blocking\): 1/);
  });
});

describe("what counts as the code under review", () => {
  const fake = (parts: Record<string, string>) => (args: string[]) => parts[args[0]!] ?? "";

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
  });
});
