/**
 * PreToolUse hook (Bash): the mechanical backstop for the rules AGENTS.md states in prose.
 * Exit 2 blocks the command and feeds stderr back to the agent; exit 0 allows.
 *
 *   1. A human opens the pull request. `gh pr create` is refused for the agent, and so are the
 *      other forms of the same act — a POST to the `pulls` endpoint via `gh api` or `curl`,
 *      the `createPullRequest` mutation — with NO override, and failing CLOSED if the guard
 *      itself throws. It does not claim to catch every route (see {@link opensAPullRequest});
 *      the rule is AGENTS.md's, and this is what makes reaching for the obvious tool fail.
 *      Everything before it — review to convergence, the gates on a clean checkout — is what
 *      earns the handover; the handover itself is a person's decision, and a gate the agent
 *      can talk its way past is not one.
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
import { existsSync } from "node:fs";
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

/**
 * Does this command RUN something that opens a pull request, as opposed to containing the
 * words? `gh pr create` is the porcelain; a POST to the `pulls` endpoint through `gh api` or
 * `curl`, and the `createPullRequest` GraphQL mutation, do the same thing, and a rule that
 * knows only the porcelain reserves nothing.
 *
 * It does NOT claim to enumerate every route — a text matcher over a shell cannot, and saying
 * otherwise would invite trust it has not earned. A script file that opens one, an unmatched
 * new `gh` alias, a Python client: all pass. What it covers is every form an agent reaching
 * for the obvious tool would type, which is what the rule is for. The rule itself is stated in
 * AGENTS.md, where it binds whether or not the regex matched.
 */
export function opensAPullRequest(cmd: string): boolean {
  const bare = withoutQuotedText(cmd);
  if (/\bgh\s+pr\s+create\b/.test(bare)) return true;
  // The GraphQL mutation. The mutation body is normally quoted, so it is matched raw — but
  // only when the blanked text shows a `gh … graphql` call standing by to send it. Matching
  // the name alone blocked this file's own review notes, which is the failure mode the header
  // reserves for rules 2–3 and not for this one.
  if (/\bgh\b/.test(bare) && /\bgraphql\b/i.test(bare) && /\bcreatePullRequest\b/.test(cmd)) return true;
  // The endpoint is matched against the RAW command: quoting a URL is the ordinary way to
  // write one, so blanking it here would hide the target rather than the mention. A POST
  // indicator is still required, so reading the same endpoint stays allowed — and `gh api`
  // switches to POST on its own the moment any parameter flag is present, which is why `-f`,
  // `-F` and `--input` count as one.
  const posts = /(?:-X|--request)[= ]?\s*POST|--method[= ]\s*POST|(?:^|\s)-(?:f|F|d)\s|(?:^|\s)--(?:input|data\S*)\b/;
  if (/\/pulls\b/.test(cmd) && /\b(?:gh\s+api|curl)\b/.test(bare) && posts.test(cmd)) return true;
  // One place quoted text is code rather than data: an interpreter standing by to run it —
  // whether the script arrives as an argument or down a pipe.
  const interpreter = /(?:^|\s)(?:(?:ba|z|k)?sh\s+-c|eval)\b|\|\s*(?:(?:ba|z|k)?sh|bash)\b/;
  return interpreter.test(cmd) && /\bgh\s+pr\s+create\b/.test(cmd);
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
  // The receipt path is relative to the repo and the branch comes from `git` in the cwd, so
  // reading it from a hook fired elsewhere reported the review state of nowhere — telling an
  // agent whose review HAD converged to go and do one.
  //
  // Scoped to this read, and restored, because rule 2 deliberately resolves branches against
  // the CALLER's cwd: `git -C <relative>` and a preceding `cd` are relative to where the
  // command will actually run. A process-wide chdir here silently re-based both, which
  // false-allowed a commit onto main from one worktree while blocking one on a feature branch
  // from another.
  const from = process.cwd();
  const project = process.env.CLAUDE_PROJECT_DIR;
  if (project && existsSync(project)) process.chdir(project);
  try {
    const verdict = validate(readReceipt(currentBranch()), diffHash());
    return verdict.ok ? { ok: true, detail: "the review has converged" } : { ok: false, detail: verdict.reason };
  } finally {
    process.chdir(from);
  }
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
    // The block does not depend on the receipt being readable — only the wording does. A
    // throw here used to exit the hook 1, which the harness reads as "the guard errored, carry
    // on": the one rule with no override was the one a malformed JSON file could switch off.
    let review: { ok: boolean; detail: string };
    try {
      review = reviewStatus();
    } catch (err) {
      review = { ok: false, detail: `the review receipt could not be read (${(err as Error).message}). Re-run the review.` };
    }
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
  //
  // "Commit" is every verb that LANDS one, not just `git commit`: a merge, a cherry-pick and a
  // revert all write to the branch, and blocking only the porcelain leaves the rule stating
  // more than it enforces. Global options are skipped, `-C <dir>` is also read for the branch.
  //
  // `(?![-\w])` rather than `\b`, because `\b` matches before a hyphen: `git merge-base` is
  // what THIS repo's own receipt runs, and blocking it would make the guard break the tooling
  // it guards. The abort/skip flags are excluded for the same reason — they unwind a landing
  // rather than perform one. `--continue` is deliberately NOT in that list: it finishes the
  // commit.
  const commit = /\bgit\s+(?:-[cC]\s+\S+\s+|--\S+\s+)*?(?:-C\s+(\S+)\s+)?(?:-[cC]\s+\S+\s+|--\S+\s+)*(commit|merge|cherry-pick|revert)(?![-\w])/.exec(cmd);
  if (commit && !/--(?:abort|quit|skip|dry-run)\b/.test(cmd)) {
    // A `git switch main` earlier in the same command line moves the target before the verb
    // runs, so the branch we are on now is the wrong thing to ask about.
    const switched = /(?:^|[;&|]\s*)git\s+(?:switch|checkout)\s+(?:-\S+\s+)*main(?:\s|$|[;&|])/.test(cmd.slice(0, commit.index));
    const branch = switched ? "main" : resolveBranch(commit[1] ?? cdTarget(cmd, commit.index));
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
  //
  // The ref is matched against the RAW text, quotes and all — `git push origin "main"` is the
  // same push — but only within the SEGMENT that runs the push. Testing the whole line blocked
  // `git push origin feature/x; git diff main`, where the two mentions of main have nothing to
  // do with each other; over-blocking is acceptable for a quoted ref and not for a second
  // command. `:main` counts: deleting main is not a gentler way of writing to it.
  const pushesAtMain = cmd
    .split(/[;&|]|\n/)
    .some(
      (part) =>
        /\bgit\s+(?:-\S+(?:\s+\S+)?\s+)*push\b/.test(part) &&
        /(?:^|\s|['":+])(?:HEAD:)?[+:]?(?:refs\/heads\/)?main(?::(?:refs\/heads\/)?\S+)?(?:\s|$|['"])/.test(part),
    );
  if (pushesAtMain) {
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
  // A crash anywhere in the policy exits non-2, which the harness reads as "the hook errored"
  // and runs the command. That is tolerable for rules 2–3, where the cost is a commit the
  // author can undo — and not for rule 1, whose whole value is that it cannot be got past. So
  // the fallback is per-rule: fail CLOSED on the pull request, open on everything else.
  let verdict: Verdict;
  try {
    verdict = decide(command);
  } catch (err) {
    verdict = opensAPullRequest(command)
      ? {
          blocked: true,
          reason:
            `Blocked: opening a pull request is a human's call, not yours, and the guard could not check the review ` +
            `(${(err as Error).message}). Fix that, then hand the command to the user.`,
        }
      : ALLOW;
  }
  if (verdict.blocked) {
    console.error(verdict.reason);
    process.exit(2);
  }
  process.exit(0);
}
