/**
 * Review receipts: the record that a branch was actually reviewed to convergence, and the
 * thing the handover to a human is gated on.
 *
 * The problem this solves is not "did a review run" — that is one boolean, and an agent can
 * write it without doing the work. It is "was the review DEEP ENOUGH", and the only honest
 * evidence for that is the shape of what it found over repeated rounds:
 *
 *   rounds: [7, 3, 1, 0]      ← converged; the last round turned up nothing new
 *   rounds: [0]               ← "I found nothing on the first try", a different claim entirely
 *
 * So a receipt stores the curve, not a flag. Five properties are enforced by {@link validate}:
 *
 *   1. It converged — at least {@link MIN_ROUNDS} rounds, the last finding nothing new.
 *   2. That last round, and the gates, ran against the code as it stands now. Each round
 *      records the {@link diffHash} it reviewed, so stale evidence is visible, not assumed.
 *   3. At least one round was cold — a reviewer starting from the diff alone, carrying none
 *      of the context the code was written in. Repeating one lens re-finds one lens's bugs.
 *   4. Nothing blocking is left standing against the current diff — in any round that reviewed
 *      it, not just the last one, since fixing a finding is what moves the diff and dropping
 *      one silently would otherwise be the cheapest way out. Fixed, or waived on the record.
 *   5. `npm run ci` passed, on a clean checkout, recorded by RUNNING it rather than by being
 *      told. Deckhand's CI is exactly `npm run ci`, and the pre-commit hook runs the same
 *      command, so there is one definition of green and this is it.
 *
 * WHAT IT DOES NOT DO, stated plainly because the gap is the interesting part: it cannot tell
 * a review from a claim about one. Two empty rounds and a `cold: true` satisfy every check
 * here, and nothing in this file distinguishes that from a diligent reviewer who genuinely
 * found nothing. What it buys is that the claim becomes explicit, attributable and durable —
 * a curve a human can read afterwards and compare against what the branch turned out to
 * contain. It raises the floor and the cost. It does not manufacture diligence, and
 * pretending otherwise would make it worse than nothing by inviting trust it has not earned.
 *
 * Which is exactly why the LAST step is not in here at all: `gh pr create` is blocked
 * outright for the agent (`scripts/hooks/bash-guard.ts`), and a human runs it. This file
 * decides when the agent is allowed to hand that command over; it never opens a PR.
 *
 * The part that compounds is `conversions`: each finding turned into a check that fires next
 * time (AGENTS.md § "The guardrails"). A receipt with findings and no conversions is a review
 * whose value expires with the PR.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Rounds required before convergence can be claimed at all.
 *
 * The terminal zero is the convergence signal, but a lone `[0]` is not a curve — it is one
 * reviewer saying they found nothing on the first look, which is the exact claim this whole
 * mechanism exists to distrust. Two is the floor at which "it stopped finding things"
 * describes the code rather than the reviewer.
 *
 * A guess, named rather than inlined so it can be tuned from real curves instead of argued
 * about: run it for a few PRs, read the recorded rounds, then move the number. A gate on
 * invented thresholds is theatre if nobody revisits it.
 */
export const MIN_ROUNDS = 2;

/** Gitignored: a receipt attests to a diff, so committing one would change that diff. */
export const RECEIPT_DIR = ".claude/review-receipts";

/** Where `handover` writes the PR body for a human to pass to `gh pr create --body-file`. */
export const HANDOVER_FILE = ".claude/pr-body.md";

/**
 * Returned by {@link diffHash} when git cannot answer. Deliberately not a hash: it must never
 * equal a value a receipt could have been written with, so an unresolvable repo blocks.
 */
export const UNRESOLVABLE_DIFF = "unresolvable";

/**
 * The gate command. One string, because deckhand already has exactly one: CI runs
 * `npm run ci` and so does the pre-commit hook, and there is a guardrail that fails if the
 * two ever diverge. Nothing to keep in sync here, so nothing to drift.
 */
export const GATES_ARGV = ["npm", "run", "ci"] as const;
export const GATES_COMMAND = GATES_ARGV.join(" ");

/**
 * Severities from the report in `reviewing-deckhand`. Only `must` and `should` hold the gate
 * open; a `nit` is explicitly droppable there, so it is explicitly non-blocking here.
 */
export type Severity = "must" | "should" | "nit";

const SEVERITY_RANK: Record<Severity, number> = { nit: 0, should: 1, must: 2 };

/** One pass of review over the diff. */
export interface Round {
  /** Which review ran — e.g. "shipping-a-change:inline", "cold-subagent", "reviewing-deckhand:pass3". */
  lens: string;
  /**
   * True when the reviewer did not write the code and carries none of the context it was
   * written in — it saw the diff and the repo, not the reasoning that produced them.
   *
   * That independence is the property worth having: an authoring session's blind spots are
   * structural, so re-reading with the same lens re-confirms the same conclusions. Anything
   * that starts from the diff alone qualifies — a fresh session, a colleague, a subagent
   * spawned for exactly this.
   *
   * What does NOT qualify is the authoring agent re-reading its own work and calling the
   * round cold. That is the one line this file cannot enforce; see the header.
   */
  cold: boolean;
  /** The {@link diffHash} this round actually reviewed. */
  diff: string;
  /**
   * Everything this round reported — not just what was new, and not just what blocks.
   *
   * Stored rather than counted because rounds happen in DIFFERENT sessions: a cold round runs
   * outside the session that recorded rounds 1–3, and usually after them. Without the earlier
   * fingerprints on disk, round 4 re-reports what round 2 found, counts it as new, and the
   * curve never converges — or the reviewer eyeballs the dedup and errs generously.
   */
  findings: { id: string; severity: Severity; evidence?: string }[];
  /**
   * New BLOCKING findings: not reported by any earlier round, and not a nit.
   *
   * Nits are excluded deliberately. A good reviewer can always produce one more naming
   * quibble, so counting them means the curve never reaches zero and the gate becomes
   * something to override rather than satisfy. They are still recorded, so they stay visible
   * and so re-reporting one does not read as new — they just do not hold the PR open.
   */
  newFindings: number;
}

/**
 * Keyed to the BRANCH, with each round carrying the diff it reviewed.
 *
 * Keying the whole file to the diff hash is wrong in a way only using it reveals: fixing a
 * finding changes the diff, which orphans the very curve that found the bug. Every fix would
 * reset the history to zero rounds, and the only reachable route through the gate would be a
 * review that changed nothing — precisely backwards.
 *
 * So history accumulates per branch and freshness is checked per round: {@link validate}
 * requires the LAST round and the gates to be against the current diff, while earlier rounds
 * stay on record at the hash they actually reviewed. Fix, re-review once, converge.
 */
export interface Receipt {
  branch: string;
  /** Chronological, across sessions and across fixes. */
  rounds: Round[];
  /** Findings that became a mechanical check — the half of the work that outlives the PR. */
  conversions: { finding: string; check: string }[];
  /** Findings deliberately left unmechanised, each with the reason it cannot be. */
  waived: { finding: string; why: string }[];
  /**
   * Whether {@link GATES_COMMAND} passed, and on which diff. Written only by the gate
   * runners, which run the command and read its exit code — never supplied by the caller,
   * because "the gates were green" is the easiest thing in the world to assert and the
   * cheapest to check.
   */
  gates?: {
    passed: boolean;
    command: string;
    diff: string;
    /**
     * True when the run was a fresh worktree at `HEAD` with a clean install, i.e. what CI
     * actually does. False means it ran in place, where uncommitted files, a drifted
     * `node_modules` and uncommitted build output can all make a red branch look green.
     */
    clean?: boolean;
  };
}

export type Verdict = { ok: true } | { ok: false; reason: string };

/**
 * Stable identity for a finding, so the same problem reported twice in different words counts
 * once. `file` plus a normalized claim; the line number is deliberately excluded — fixing an
 * earlier finding shifts every line below it, and a finding that moved is the same finding.
 *
 * Normalization is lossy on purpose. It will occasionally merge two genuinely different
 * findings in one file, which costs a round of convergence — the safe direction. The opposite
 * error, splitting one finding into two, inflates `newFindings` and loops forever on one bug.
 */
export function fingerprint(file: string, claim: string): string {
  const normalized = claim
    .toLowerCase()
    .replace(/[`'"]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return `${file.trim()}::${normalized}`;
}

/**
 * Add a round and compute how much of it was actually new.
 *
 * The counting lives here rather than with whoever writes the receipt because "new since all
 * earlier rounds" is precisely the claim the gate rests on, and a reviewer counting it by
 * hand — across sessions, against findings they never saw — is the step that would quietly
 * decide whether the curve converges. Returns a new receipt; does not mutate.
 */
export function appendRound(receipt: Receipt, round: Omit<Round, "newFindings">): Receipt {
  // Seen AT A BLOCKING SEVERITY — not merely seen. Keying on the id alone launders a finding:
  // file it as a nit early, and a later round raising it to must-fix counts as nothing new,
  // which is exactly backwards.
  const seen = new Set(receipt.rounds.flatMap((r) => r.findings.filter((f) => f.severity !== "nit").map((f) => f.id)));
  // Collapsing duplicates keeps the HIGHEST severity, not the last written. Last-wins
  // silently downgrades a must-fix to a nit whenever the two share a fingerprint — and
  // `fingerprint` is lossy, so a collision inside one file is a case it creates rather than a
  // freak accident. Merging may cost a round; it must never drop a blocking finding.
  const worst = new Map<string, Round["findings"][number]>();
  for (const f of round.findings) {
    const prev = worst.get(f.id);
    if (!prev || SEVERITY_RANK[f.severity] > SEVERITY_RANK[prev.severity]) worst.set(f.id, f);
  }
  const unique = [...worst.values()];
  const newFindings = unique.filter((f) => !seen.has(f.id) && f.severity !== "nit").length;
  return { ...receipt, rounds: [...receipt.rounds, { ...round, findings: unique, newFindings }] };
}

/** Run a command, returning stdout ("" if it fails). Injected in tests. */
export type Run = (args: string[]) => string;

const runGit: Run = (args) => {
  const p = spawnSync("git", args, { encoding: "utf8" });
  return p.status === 0 ? (p.stdout ?? "") : "";
};

/**
 * Identity of "the code under review": one diff from the merge base to the WORKING TREE.
 *
 * Keyed on content rather than on `HEAD` so the ordinary tidy-up before a PR — amending a
 * message, rebasing onto a moved main, squashing, or committing work that was reviewed while
 * uncommitted — does not void a round that still describes the same code. Editing one line
 * does void it, which is the behaviour we want.
 *
 * Deliberately ONE diff against the merge base rather than `base...HEAD` plus `HEAD`: two
 * hashed separately makes committing the reviewed change produce a different hash, and two
 * hashed by concatenation collides on any change that merely moves bytes across the boundary.
 * Untracked files never appear in a diff, so their names are folded in — that catches a new
 * file appearing or going away, though not an edit to one that was already untracked.
 */
export function diffHash(base = "origin/main", run: Run = runGit): string {
  const mergeBase = run(["merge-base", base, "HEAD"]).trim();
  // No merge base means git failed, or there is no `origin/main`. Either way the diff below
  // would be empty too, so every branch in every state would hash to one constant and the
  // freshness check would be comparing a constant to itself. Fail closed with a value no
  // receipt can hold.
  if (!mergeBase) return UNRESOLVABLE_DIFF;
  const diff = run(["diff", mergeBase]);
  const untracked = run(["ls-files", "--others", "--exclude-standard"]);
  return createHash("sha256")
    .update(diff)
    .update(" ") // domain separator, so the two fields cannot trade bytes
    .update(untracked)
    .digest("hex");
}

export function currentBranch(run: Run = runGit): string {
  return run(["branch", "--show-current"]).trim();
}

/**
 * `feature/oauth-x` → `feature-oauth-x.<8 hex>.json`.
 *
 * Slashes cannot be in a filename, but replacing them makes `feature/x` and `feature-x`
 * collide — and two branches at the same commit have the same diff hash, so the second would
 * inherit the first's converged receipt. The suffix hashes the RAW name, so the readable part
 * stays readable and distinct branches stay distinct.
 */
export function receiptPath(branch: string, dir = RECEIPT_DIR): string {
  const digest = createHash("sha256").update(branch).digest("hex").slice(0, 8);
  return join(dir, `${branch.replace(/[^a-zA-Z0-9._-]/g, "-")}.${digest}.json`);
}

export function writeReceipt(receipt: Receipt, dir = RECEIPT_DIR): string {
  mkdirSync(dir, { recursive: true });
  const path = receiptPath(receipt.branch, dir);
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
  return path;
}

export function readReceipt(branch: string, dir = RECEIPT_DIR): Receipt | null {
  const path = receiptPath(branch, dir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Receipt;
  } catch {
    // A corrupt receipt is a missing receipt: better to re-review than to trust half a file.
    return null;
  }
}

/** The receipt to append to: this branch's history, or a fresh one. */
function loadOrCreate(branch: string, dir = RECEIPT_DIR): Receipt {
  return readReceipt(branch, dir) ?? { branch, rounds: [], conversions: [], waived: [] };
}

/**
 * The gate. Pure, so the hook, the CLI and the tests share one definition of "reviewed
 * enough" — and so the thresholds are covered by tests rather than by trying it on a real PR.
 */
export function validate(receipt: Receipt | null, hash: string): Verdict {
  if (!receipt) {
    return {
      ok: false,
      reason: "no review receipt for this branch. Run the `shipping-a-change` skill — it reviews to convergence and writes one.",
    };
  }
  // A receipt is a JSON file an agent can write, so it can be any shape at all. Reading a
  // field off a malformed one used to throw, which took the PreToolUse hook down with a
  // non-blocking error — a crash in the guard OPENS the gate it exists to close. Checking the
  // top-level array was not enough: `rounds: [null]` and `waived: "x"` both still threw, one
  // level in. Every field this function walks is checked before it is walked.
  // Junk is REFUSED rather than skipped over. Filtering a null finding out and carrying on
  // would make the most permissive reading of a broken file the one the gate acts on, which is
  // the same failure in slower motion.
  const isObject = (v: unknown): boolean => !!v && typeof v === "object";
  if (
    !Array.isArray(receipt.rounds) ||
    receipt.rounds.some((r) => !isObject(r) || !Array.isArray(r.findings) || r.findings.some((f) => !isObject(f)))
  ) {
    return { ok: false, reason: "the receipt is malformed (rounds are not a list of rounds with findings). Re-run the review." };
  }
  if (receipt.waived !== undefined && (!Array.isArray(receipt.waived) || receipt.waived.some((w) => !isObject(w)))) {
    return { ok: false, reason: "the receipt is malformed (`waived` is not a list of waivers). Re-run the review." };
  }
  if (hash === UNRESOLVABLE_DIFF) {
    return {
      ok: false,
      reason: "cannot determine what this branch changes (no merge base with origin/main), so no receipt can be checked against it.",
    };
  }

  const curve = receipt.rounds.map((r) => r?.newFindings).join(", ");
  if (receipt.rounds.length < MIN_ROUNDS) {
    return {
      ok: false,
      reason:
        `only ${receipt.rounds.length} review round on record ([${curve}]) — ${MIN_ROUNDS} is the floor. ` +
        `A single round finding nothing is a claim about the reviewer, not about the code.`,
    };
  }

  const last = receipt.rounds.at(-1)!;
  if (last.newFindings !== 0) {
    return {
      ok: false,
      reason:
        `the review has not converged — rounds found [${curve}] new findings, and the last must be 0. ` +
        `Review again; the next round needs a different lens or it re-finds the same things.`,
    };
  }
  // Earlier rounds may be against older diffs — that is what fixing findings looks like. The
  // LAST one cannot be: it is the round claiming there is nothing left.
  if (last.diff !== hash) {
    return {
      ok: false,
      reason: "the code changed after the last review round, so nothing has looked at it as it stands. One more round on the current diff.",
    };
  }

  // "Nothing NEW" is not "nothing wrong": a round re-reporting the same three unfixed
  // must-fixes scores zero new and would sail through. Worse, the freshness rule makes that
  // the CHEAPER path, because fixing them changes the diff and costs another round. So the
  // last round must have nothing blocking left standing — fixed, or waived on the record.
  //
  // "Left standing" spans rounds, not just the last one. Checking only the last round made
  // SILENCE the cheapest exit: a cold round reports a must, the next round simply does not
  // mention it, and the gate opens with nothing fixed. Dropping it is distinguishable from
  // fixing it, because fixing it changes the diff — so a blocking finding counts as open when
  // the round that raised it reviewed the code AS IT STANDS and no later round cleared it.
  const waived = new Set((receipt.waived ?? []).map((w) => w.finding));
  const open = new Set<string>();
  for (const round of receipt.rounds) {
    if (round.diff !== hash) continue; // reviewed older code; a fix is why the hash moved
    for (const f of round.findings) if (f.severity !== "nit" && !waived.has(f.id)) open.add(f.id);
  }
  if (open.size) {
    return {
      ok: false,
      reason:
        `the review still has ${open.size} unresolved blocking ${open.size === 1 ? "finding" : "findings"} against this diff ` +
        `(${[...open].join("; ")}). Fix them and review again, or waive each one with a reason ` +
        `(\`waived\` takes the fingerprint).`,
    };
  }

  if (!receipt.rounds.some((r) => r.cold)) {
    return {
      ok: false,
      reason:
        "every round was run by the session that wrote the code. At least one cold round is required — a reviewer starting " +
        "from the diff alone: a fresh session, a colleague, or a subagent spawned for exactly this.",
    };
  }

  // Last, because a red gate is the cheapest thing to fix and the least interesting thing to
  // be told first — but still blocking: CI would catch it, after someone else's time.
  if (!receipt.gates || receipt.gates.diff !== hash) {
    return { ok: false, reason: `the gates have not been run on this diff — \`npm run review:gates\` (runs \`${GATES_COMMAND}\`).` };
  }
  if (!receipt.gates.passed) {
    return { ok: false, reason: `\`${receipt.gates.command}\` failed on this diff. Fix it, then re-run.` };
  }
  // Green in place is not green in CI. `npm run ci` on your own machine runs against files
  // git has never seen, a `node_modules` that may have drifted from the lockfile, and build
  // output nobody committed — the three things a clean checkout removes and the three reasons
  // a PR goes red minutes after it is opened.
  if (!receipt.gates.clean) {
    return {
      ok: false,
      reason:
        "the gates passed in place, not on a clean checkout — which is what CI runs, and where uncommitted files and " +
        "lockfile drift show up. Run `npm run review:gates`.",
    };
  }

  return { ok: true };
}

/** Human-readable summary for the block message and the handover. */
export function summarize(receipt: Receipt): string {
  const curve = receipt.rounds.map((r) => `${r.lens}${r.cold ? " (cold)" : ""}: ${r.newFindings}`);
  // Nits do not block, but they should not vanish either — a count keeps them a visible
  // choice the author made rather than something the gate quietly swallowed.
  const nits = new Set(receipt.rounds.flatMap((r) => r.findings.filter((f) => f.severity === "nit").map((f) => f.id)));
  return [
    `rounds → ${curve.join(" · ")}`,
    `checks added: ${receipt.conversions.length}`,
    nits.size ? `nits (non-blocking): ${nits.size}` : null,
    receipt.waived.length ? `waived: ${receipt.waived.length}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** What `review:round` accepts on stdin. Note there is no `newFindings` field — see below. */
export interface RoundInput {
  lens: string;
  cold?: boolean;
  /**
   * `severity` defaults to `should` — the safe direction is counting a finding, not dropping
   * it. `evidence` is required for anything blocking: see {@link recordRound}.
   */
  findings?: { file: string; claim: string; severity?: Severity; evidence?: string }[];
  conversions?: { finding: string; check: string }[];
  waived?: { finding: string; why: string }[];
}

/**
 * Fold one round into the branch's receipt.
 *
 * A command rather than something left to whoever runs the review, because the caller writing
 * the JSON by hand is the caller deciding what counts as new — the one number the gate rests
 * on. Here it is derived from the fingerprints of every earlier round, so a second review in a
 * new session extends the curve instead of restarting it.
 */
export function recordRound(input: RoundInput, hash: string, branch: string, dir = RECEIPT_DIR): Receipt {
  // A round with no lens is one nobody can audit later, and it would still count toward the
  // floor — so it is rejected rather than recorded as `undefined`.
  if (!input.lens?.trim()) throw new Error("a round needs a `lens` naming the review that ran");
  // A blocking finding costs the author a round, so it has to be checkable. Requiring the
  // evidence is the cheapest defence against a confident-sounding claim about code that does
  // not say what the reviewer thinks it says: a `file:line`, or the command that showed it.
  // Nits are exempt — "I'd have named this differently" has no evidence to give.
  const unevidenced = (input.findings ?? []).filter((f) => (f.severity ?? "should") !== "nit" && !f.evidence?.trim());
  if (unevidenced.length) {
    throw new Error(
      `every must/should finding needs \`evidence\` — a file:line or the command output that shows it. ` +
        `Missing on: ${unevidenced.map((f) => `${f.file}: ${f.claim}`).join("; ")}`,
    );
  }
  const base = loadOrCreate(branch, dir);
  const next = appendRound(base, {
    lens: input.lens,
    cold: input.cold ?? false,
    diff: hash,
    findings: (input.findings ?? []).map((f) => ({
      id: fingerprint(f.file, f.claim),
      severity: f.severity ?? "should",
      evidence: f.evidence,
    })),
  });
  next.conversions = [...base.conversions, ...(input.conversions ?? [])];
  next.waived = [...base.waived, ...(input.waived ?? [])];
  writeReceipt(next, dir);
  return next;
}

/**
 * Run the gates in place and record the result against this diff.
 *
 * Fast, and explicitly NOT enough to satisfy the gate: see {@link validate}'s `clean` check.
 * It exists for the loop, where you want to know within a minute whether you broke something.
 */
export function runGates(branch: string, dir = RECEIPT_DIR): Receipt {
  const proc = spawnSync(GATES_ARGV[0], GATES_ARGV.slice(1), { stdio: "inherit" });
  // Hashed AFTER the run: a build step can touch a tracked file, so a hash taken up front can
  // already be stale by the time the gates finish, and the receipt would attest to a diff that
  // no longer exists.
  const next: Receipt = {
    ...loadOrCreate(branch, dir),
    gates: { passed: proc.status === 0, command: GATES_COMMAND, diff: diffHash(), clean: false },
  };
  writeReceipt(next, dir);
  return next;
}

/**
 * Run the gates the way CI will: a throwaway worktree at `HEAD`, dependencies from the
 * committed lockfile, nothing from this machine.
 *
 * Green locally and red in CI is not bad luck, it is a structural difference — your disk has
 * files git has never seen, a `node_modules` that stopped matching `package-lock.json` some
 * installs ago, and build output nobody committed. `npm run ci` in place cannot see any of
 * that, because all of it is present. This can, because none of it is.
 *
 * Costs a full install, so it is the last thing you run rather than something in the loop.
 */
export function runGatesClean(branch: string, dir = RECEIPT_DIR): Receipt | { dirty: string } {
  // A clean checkout of HEAD says nothing about uncommitted work, and reporting it as if it
  // did is the exact false confidence this exists to remove. CI tests what you push.
  const dirty = runGit(["status", "--porcelain"]).trim();
  if (dirty) return { dirty };

  const root = runGit(["rev-parse", "--show-toplevel"]).trim();
  if (!root) return { dirty: "not a git repository" };
  const worktree = join(root, ".git", "review-gates");
  spawnSync("git", ["worktree", "remove", "--force", worktree]);
  const added = spawnSync("git", ["worktree", "add", "--detach", worktree, "HEAD"], { stdio: "inherit" });
  try {
    if (added.status !== 0) throw new Error("could not create a clean worktree");
    const opts = { cwd: worktree, stdio: "inherit" as const };
    // `npm ci`, not `npm install`: it installs exactly the lockfile and fails if the two have
    // drifted, which is the drift this whole function exists to surface.
    const install = spawnSync("npm", ["ci"], opts);
    let passed = install.status === 0;
    if (passed) passed = spawnSync(GATES_ARGV[0], GATES_ARGV.slice(1), opts).status === 0;
    const next: Receipt = {
      ...loadOrCreate(branch, dir),
      gates: { passed, command: GATES_COMMAND, diff: diffHash(), clean: true },
    };
    writeReceipt(next, dir);
    return next;
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", worktree]);
    // `worktree remove` leaves the directory behind if the install wrote files git does not
    // know about, which is every run — node_modules. Otherwise the next run's `worktree add`
    // fails on a path that already exists, and the gate becomes "it worked once".
    rmSync(worktree, { recursive: true, force: true });
  }
}

/**
 * The handover: what a HUMAN pastes to open the PR.
 *
 * This is the whole shape of the human gate. The agent cannot run `gh pr create` — the
 * PreToolUse hook refuses it with no override — so the last step is always a person's. What
 * this command adds is that the artefact that person needs only EXISTS once the review
 * converged: it refuses to write the body file unless {@link validate} passes.
 *
 * So skipping the review does not produce a PR the human has to catch; it produces no
 * handover at all, and an agent with nothing to hand over has to say so.
 */
export function handover(receipt: Receipt | null, hash: string, body: string, file = HANDOVER_FILE): Verdict {
  const verdict = validate(receipt, hash);
  if (!verdict.ok) return verdict;
  if (!body.trim()) return { ok: false, reason: "the PR body is empty — pipe the filled-in body in on stdin." };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body.endsWith("\n") ? body : `${body}\n`);
  return { ok: true };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const isEntryPoint = process.argv[1]?.endsWith("review-receipt.ts") ?? false;

if (isEntryPoint) {
  const [cmd] = process.argv.slice(2);
  const hash = diffHash();
  const branch = currentBranch();
  const receipt = readReceipt(branch);

  if (cmd === "check") {
    const verdict = validate(receipt, hash);
    if (!verdict.ok) {
      console.error(`✗ ${verdict.reason}`);
      process.exit(1);
    }
    console.log(`✓ reviewed — ${receipt ? summarize(receipt) : ""}`);
  } else if (cmd === "hash") {
    console.log(hash);
  } else if (cmd === "show") {
    // The curve first, because that is what the docs promise `show` prints and what a reader
    // wants; the raw receipt after it, for the fingerprints a waiver has to quote.
    console.log(receipt ? `${summarize(receipt)}\n\n${JSON.stringify(receipt, null, 2)}` : `no receipt for ${branch}`);
  } else if (cmd === "gates" || cmd === "gates:quick") {
    const next = cmd === "gates" ? runGatesClean(branch) : runGates(branch);
    if ("dirty" in next) {
      console.error(
        `✗ the working tree is dirty, so a clean checkout of HEAD would not be the code you mean:\n${next.dirty}\n\n` +
          `Commit first — CI tests what you push. \`npm run review:gates:quick\` runs them in place instead, ` +
          `but does not satisfy the gate.`,
      );
      process.exit(1);
    }
    const label = next.gates?.clean ? "on a clean checkout" : "in place (does NOT satisfy the gate)";
    console.log(next.gates?.passed ? `✓ gates green ${label}` : `✗ gates RED ${label}`);
    if (!next.gates?.passed) process.exit(1);
  } else if (cmd === "round") {
    const next = recordRound(JSON.parse(await readStdin()) as RoundInput, hash, branch);
    const last = next.rounds.at(-1);
    console.log(`recorded ${last?.lens}: ${last?.newFindings} new of ${last?.findings.length}`);
    console.log(summarize(next));
    const verdict = validate(next, hash);
    console.log(verdict.ok ? "✓ gate satisfied" : `still blocked — ${verdict.reason}`);
  } else if (cmd === "handover") {
    const verdict = handover(receipt, hash, await readStdin());
    if (!verdict.ok) {
      console.error(`✗ no handover: ${verdict.reason}`);
      process.exit(1);
    }
    console.log(`✓ ${receipt ? summarize(receipt) : ""}`);
    console.log(`\nPR body written to ${HANDOVER_FILE}.`);
    console.log(`\nA HUMAN runs this — the agent is blocked from it, deliberately:\n`);
    console.log(`  gh pr create --base main --title "<title>" --body-file ${HANDOVER_FILE}\n`);
  } else {
    console.error("usage: tsx scripts/review-receipt.ts <check|hash|show|round|gates|gates:quick|handover>");
    process.exit(2);
  }
}
