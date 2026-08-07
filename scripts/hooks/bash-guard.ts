/**
 * PreToolUse hook (Bash): ONE rule — a human opens the pull request.
 *
 * Exit 2 blocks the command and feeds stderr back to the agent; exit 0 allows. `gh pr create`
 * is refused, and so are the other forms of the same act — a POST to the `pulls` collection via
 * `gh api` or `curl`, the `createPullRequest` mutation — with NO override, and failing CLOSED if
 * the guard itself throws. Everything before it — review to convergence, the gates on a clean
 * checkout — is what earns the handover; the handover itself is a person's decision, and a gate
 * the agent can talk its way past is not one.
 *
 * It deliberately guards nothing else. It used to also refuse commits and pushes at `main` and a
 * `launchctl kickstart` of the server, and both were dropped: a text matcher over a shell cannot
 * enumerate the spellings of a command, so each review round found another one and the file grew
 * a regex per round. Those two rules are also enforced elsewhere — `main` is a protected branch
 * server-side, so a push at it is refused by GitHub whatever this file thinks. What remains here
 * is the one act with no other backstop, and it does not claim to catch every route either (see
 * {@link opensAPullRequest}): the rule is AGENTS.md's, and this makes reaching for the obvious
 * tool fail. The restart rule now lives only in AGENTS.md § "Deploy after merging, not before".
 *
 * The policy is {@link decide}, a pure function; the process plumbing at the bottom runs only
 * when this file is the entry point, so the rule is covered by `bash-guard.test.ts` rather than
 * by hand-run probes.
 */

import { existsSync } from "node:fs";
import { currentBranch, diffHash, readReceipt, validate } from "../review-receipt.ts";

/** What the hook should do with a command. */
export type Verdict = { blocked: false } | { blocked: true; reason: string };

const ALLOW: Verdict = { blocked: false };

/**
 * The spellings a shell accepts for one word, collapsed onto that word.
 *
 * A rule asking "does this RUN git commit" has to see `git 'commit'`, `git com'mit'`,
 * `git \commit`, `git${IFS}commit` and a `git commit` split over a line continuation as the
 * same command, because bash does. Every one of them WAS a live bypass before this existed:
 * quoting the verb walked past the rule that used to block a commit on `main`, and `${IFS}` walked
 * past this one, verified against a stub `gh` on PATH.
 *
 * Escaping is undone BEFORE quoted spans are considered, so `$'pr'` becomes `'pr'` and then
 * `pr`. The blanking in {@link withoutQuotedText} still decides what is data.
 */
export function shellSpelling(cmd: string): string {
  return cmd
    .replace(/\\\n/g, " ") // a line continuation joins two words into one command
    .replace(/\$\{IFS\}|\$IFS\b/g, " ") // the shell's own word separator, spelt as a variable
    .replace(/\$(?=['"])/g, "") // ANSI-C quoting: $'pr' is 'pr'
    .replace(/\\(?=\w)/g, ""); // \pr is pr
}

/**
 * The command with quoted spans and heredoc bodies blanked out, so the rule can ask "does this
 * command RUN x" rather than "does this text mention x".
 *
 * Matching raw text would block a commit whose MESSAGE quotes the command, and writing about this
 * gate is routine while working on it. Anchoring to command position fixes that case and opens
 * eight worse ones — `(gh pr create)`, `env gh pr create`, `bash -c "…"`, a loop body — because a
 * shell has more command positions than a regex can enumerate. Blanking the quotes keeps the
 * match permissive where it should be and blind only where the text is data.
 */
/** A heredoc is written somewhere, not run: its body is data however the rest of the line reads. */
export function withoutHeredocs(cmd: string): string {
  return cmd.replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?^\s*\2\s*$/gm, " ");
}

export function withoutQuotedText(cmd: string): string {
  return withoutHeredocs(cmd)
    // A quoted span with no whitespace in it is shell ESCAPING, not data: `gh 'pr' create` and
    // `gh pr crea'te'` run exactly what `gh pr create` runs, and blanking them let four
    // spellings of the one rule with no override straight through. So those are unquoted, and
    // only spans that cross a space — a message, a pattern, a body — are blanked.
    .replace(/'([^'\s]*)'/g, "$1")
    .replace(/"([^"\\\s]*)"/g, "$1")
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
  // Asked twice. Once of the command as written, with quoted spans blanked so DATA cannot decide
  // anything — and once of the payload an interpreter is standing by to run, where the quotes are
  // the shell's own and what is inside them is code. Wrapping the api form in `bash -c "..."`
  // really opens a pull request, and the first version only re-checked the porcelain there.
  if (opensIn(withoutQuotedText(shellSpelling(cmd)), cmd)) return true;
  const interpreter = /(?:^|\s)(?:(?:ba|z|k)?sh\s+-c|eval)\b|\|\s*(?:(?:ba|z|k)?sh|bash)\b/;
  if (!interpreter.test(cmd)) return false;
  // Heredoc bodies stay blanked even here. A heredoc is being WRITTEN somewhere, not executed, so
  // its contents are data whatever else the line does — and reading them as code refused this
  // repo's own review notes and probe scripts, which is how a guard gets switched off wholesale.
  const payload = withoutHeredocs(shellSpelling(cmd)).replace(/['"]/g, " ");
  return opensIn(payload, payload);
}

/**
 * The three routes, over one piece of text.
 *
 * `text` is what may decide; `raw` is consulted only where quoting is the ordinary way to write
 * the thing (a URL, a GraphQL body) and blanking it would hide the target rather than the mention.
 */
function opensIn(text: string, raw: string): boolean {
  if (/\bgh\s+pr\s+create\b/.test(text)) return true;
  // The GraphQL mutation. The body is normally quoted, so it is matched raw — but only when the
  // blanked text shows a `gh … graphql` call standing by to send it. Matching the name alone
  // blocked this file's own review notes: data, not a command, and this rule has no override to
  // fall back on when it is wrong.
  if (/\bgh\b/.test(text) && /\bgraphql\b/i.test(text) && /\bcreatePullRequest\b/.test(raw)) return true;

  // A named method settles it, because `gh` sends what you named: `-X GET .../pulls -F state=open`
  // is paging through PRs, and refusing that under the rule with no override is the one over-block
  // this file cannot afford. EVERY named method must be POST-free, not just the first.
  const methods = [...text.matchAll(/(?:^|\s)(?:-X|--request|--method)[= ]?\s*([A-Za-z]+)/g)].map((m) => m[1]!.toUpperCase());
  // With no method named, a parameter flag IS the method: `gh api` switches to POST the moment one
  // appears. Every spelling of one counts, which took two goes to get right — the long forms and
  // the attached short form were all missed, and each was confirmed against real `gh` POSTing to a
  // stub server on loopback.
  const paramFlag = /(?:^|\s)-[fFd](?:[\s=]|\S)|(?:^|\s)--(?:field|raw-field|input|data\S*)\b/.test(text);
  const posts = methods.length > 0 ? methods.includes("POST") : paramFlag;
  // The COLLECTION, not a sub-resource: the collection opens one, while `/pulls/12/comments` and
  // `/pulls/12/reviews` are how you talk about one that exists — including this repo's own
  // review-comment path. Blocking those under a rule with no override is the over-block this file
  // cannot afford, since the way past it is meant to be asking a person.
  return /\/pulls(?![\w/])/.test(raw) && /\b(?:gh\s+api|curl)\b/.test(text) && posts;
}

/** The state of the review, for the handover message. Injected so tests need no real receipt. */
export type ReviewStatus = () => { ok: boolean; detail: string };

const receiptStatus: ReviewStatus = () => {
  // The receipt path is relative to the repo and the branch comes from `git` in the cwd, so
  // reading it from a hook fired elsewhere reported the review state of nowhere — telling an
  // agent whose review HAD converged to go and do one.
  //
  // Scoped to this read, and restored: a hook fires with the caller's cwd, and leaving the
  // process chdir'd would silently re-base every relative path in the command about to run.
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

export function decide(cmd: string, reviewStatus: ReviewStatus = receiptStatus): Verdict {
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
    // uninstalled, and the rule is also stated in AGENTS.md.
    process.exit(0);
  }
  // A crash anywhere in the policy exits non-2, which the harness reads as "the hook errored"
  // and runs the command — so the one rule here would be switched off by its own bug. Fail
  // CLOSED on the pull request, and open on anything this guard does not claim.
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
