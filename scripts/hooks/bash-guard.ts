/**
 * PreToolUse hook (Bash): the mechanical backstop for the rules AGENTS.md states in prose.
 * Exit 2 blocks the command and feeds stderr back to the agent; exit 0 allows.
 *
 *   1. A human opens the pull request. `gh pr create` is refused for the agent, with NO
 *      override — that is the point of it. Everything before it (review to convergence, the
 *      gates on a clean checkout) is what earns the handover; the handover itself is a
 *      person's decision, and a gate the agent can talk its way past is not one.
 *   2. Never commit or push to `main`, whether by being on it or pushing at it
 *      (AGENTS.md § "How work lands here").
 *   3. `launchctl kickstart` of the deckhand server tears down every booted simulator on the
 *      machine, so it is not a thing to do mid-session without saying so first.
 *
 * Text matching over-blocks by design: a command that merely QUOTES a banned pattern (a
 * heredoc, a grep) may be stopped too. That fails safe — rephrase — and is the accepted cost
 * of a backstop with no shell parser. Rule 1 is the exception and pays for it in
 * {@link opensAPullRequest}: writing ABOUT the command is routine while working on this file,
 * so it has to tell running it from mentioning it.
 *
 * The policy is {@link decide}, a pure function; the process plumbing at the bottom runs only
 * when this file is the entry point. That split exists so the rules are covered by
 * `bash-guard.test.ts` rather than by hand-run probes.
 */

import { spawnSync } from "node:child_process";
import { currentBranch, diffHash, readReceipt, validate } from "../review-receipt.ts";

/** What the hook should do with a command. */
export type Verdict = { blocked: false } | { blocked: true; reason: string };

const ALLOW: Verdict = { blocked: false };

/**
 * Resolve the branch a `git` invocation would actually run against — `git -C <path>` wins,
 * else the last `cd <path>` before the git call, else the hook's cwd. Injected so the policy
 * is testable without a real repo.
 */
export type BranchResolver = (dir: string | undefined) => string;

const gitBranch: BranchResolver = (dir) =>
  (spawnSync("git", [...(dir ? ["-C", dir] : []), "branch", "--show-current"], { encoding: "utf8" }).stdout ?? "").trim();

/**
 * The command with quoted spans and heredoc bodies blanked out, so a rule can ask "does this
 * command RUN x" rather than "does this text mention x".
 *
 * Rules 2–3 match raw text and accept the false positives. Rule 1 cannot: writing about the
 * gate is routine while working on it, and matching raw text blocks a commit whose message
 * quotes the command. Anchoring to command position fixes that case and opens eight worse ones
 * — `(gh pr create)`, `env gh pr create`, `bash -c "…"`, a loop body — because a shell has more
 * command positions than a regex can enumerate. Blanking the quotes keeps the match permissive
 * where it should be and blind only where the text is data.
 */
export function withoutQuotedText(cmd: string): string {
  return cmd
    .replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?^\s*\2\s*$/gm, " ") // heredoc bodies
    .replace(/'[^']*'/g, " ")
    .replace(/"(?:[^"\\]|\\.)*"/g, " ");
}

/** Does this command RUN `gh pr create`, as opposed to containing the words? */
export function opensAPullRequest(cmd: string): boolean {
  if (/\bgh\s+pr\s+create\b/.test(withoutQuotedText(cmd))) return true;
  // One place quoted text is code rather than data: an interpreter handed a script to run.
  // Blanking quotes is right everywhere else and wrong exactly here, so the quoted form counts
  // once something is standing by to execute it.
  return /(?:^|\s)(?:(?:ba|z|k)?sh\s+-c|eval)\b/.test(cmd) && /\bgh\s+pr\s+create\b/.test(cmd);
}

/** The last `cd <dir>` before a command, if any — the worktree-per-branch flow uses it. */
function cdTarget(cmd: string, before: number): string | undefined {
  const prefix = cmd.slice(0, before);
  const matches = [...prefix.matchAll(/(?:^|[;&|]\s*)cd\s+([^\s;&|]+)/g)];
  return matches.at(-1)?.[1];
}

/** The state of the review, for the handover message. Injected so tests need no real receipt. */
export type ReviewStatus = () => { ok: boolean; detail: string };

const receiptStatus: ReviewStatus = () => {
  const verdict = validate(readReceipt(currentBranch()), diffHash());
  return verdict.ok ? { ok: true, detail: "the review has converged" } : { ok: false, detail: verdict.reason };
};

export function decide(cmd: string, resolveBranch: BranchResolver = gitBranch, reviewStatus: ReviewStatus = receiptStatus): Verdict {
  // 1. A human opens the PR.
  //
  // No override, on purpose. Every other gate in this repo has one, because a gate with no way
  // past it gets switched off wholesale the first time it is wrong. This one is different in
  // kind: it is not asserting the work is good, it is reserving one decision for a person. An
  // override would hand that decision back to the agent, which is the entire thing being
  // prevented — so being "wrong" here is not possible in the way it is for the others. The way
  // past it is to ask the human, which is the intended behaviour rather than a workaround.
  if (opensAPullRequest(cmd)) {
    const review = reviewStatus();
    const readiness = review.ok
      ? `The review has converged, so you have something to hand over: run \`npm run review:handover\` (it writes the PR body) and give the printed command to the user.`
      : `And the review is not finished anyway — ${review.detail}`;
    return {
      blocked: true,
      reason:
        `Blocked: opening a pull request is a human's call, not yours. There is no override for this rule.\n\n` +
        `${readiness}\n\n` +
        `Then say, in one line, that they need to run it. Do not restate the diff at them — they can read the PR.`,
    };
  }

  // 2. Never commit or push to main — work lands via PRs from feature branches.
  const commit = /\bgit\s+(?:-C\s+(\S+)\s+)?commit\b/.exec(cmd);
  if (commit) {
    const branch = resolveBranch(commit[1] ?? cdTarget(cmd, commit.index));
    if (branch === "main") {
      return {
        blocked: true,
        reason:
          "Blocked: you are on `main`, and nothing lands there directly — not even a one-line fix " +
          "(AGENTS.md § How work lands here). `git switch -c feature/<short-name>` first.",
      };
    }
  }
  // Pushing AT main from a feature branch is the same rule, one indirection along: it is how a
  // branch-first workflow gets bypassed without ever checking main out.
  if (/\bgit\s+push\b/.test(cmd) && /(?:^|\s)(?:HEAD:)?(?:refs\/heads\/)?main(?:\s|$)/.test(withoutQuotedText(cmd))) {
    return {
      blocked: true,
      reason: "Blocked: this pushes at `main`. Work lands through a pull request from a feature branch (AGENTS.md § How work lands here).",
    };
  }

  // 3. Restarting the server drops every booted simulator on the machine, so someone may be
  //    mid-test on a preview you cannot see. AGENTS.md says to say so before doing it; this is
  //    the part that makes "say so" happen, by making the agent stop and ask.
  if (/launchctl\s+kickstart/.test(withoutQuotedText(cmd)) && /no\.deckhand\.server/.test(cmd)) {
    return {
      blocked: true,
      reason:
        "Blocked: `launchctl kickstart` of the deckhand server tears down EVERY booted simulator on this machine, " +
        "so whoever is watching a preview loses it and pays several minutes of rebuilding. Ask the user first, " +
        "then let them run it — or batch it with whatever else needs a restart.",
    };
  }

  return ALLOW;
}

const isEntryPoint = process.argv[1]?.endsWith("bash-guard.ts") ?? false;

if (isEntryPoint) {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  let command = "";
  try {
    command = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { tool_input?: { command?: string } }).tool_input?.command ?? "";
  } catch {
    // Unparseable input means the harness changed shape. Allow rather than block every Bash
    // call in the session: a guard that fails closed on its own plumbing is a guard that gets
    // uninstalled, and rule 1 is also stated in AGENTS.md.
    process.exit(0);
  }
  const verdict = decide(command);
  if (verdict.blocked) {
    console.error(verdict.reason);
    process.exit(2);
  }
  process.exit(0);
}
