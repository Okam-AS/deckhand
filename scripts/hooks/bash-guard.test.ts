import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decide, opensAPullRequest, withoutQuotedText, type ReviewStatus } from "./bash-guard.ts";

/** The review has converged — so the block message should hand over, not scold. */
const converged: ReviewStatus = () => ({ ok: true, detail: "the review has converged" });
/** The review has not — the message should say why as well as refusing. */
const unconverged: ReviewStatus = () => ({ ok: false, detail: "only 1 review round on record ([0])" });

const onBranch = (name: string) => () => name;

const verdict = (cmd: string, branch = "feature/x", review = converged) => decide(cmd, onBranch(branch), review);
const blocked = (cmd: string, branch = "feature/x", review = converged): string => {
  const v = verdict(cmd, branch, review);
  assert.equal(v.blocked, true, `expected to be blocked: ${cmd}`);
  return v.blocked ? v.reason : "";
};
const allowed = (cmd: string, branch = "feature/x", review = converged): void => {
  assert.equal(verdict(cmd, branch, review).blocked, false, `expected to be allowed: ${cmd}`);
};

describe("a human opens the pull request", () => {
  it("blocks the plain command", () => {
    assert.match(blocked("gh pr create --base main"), /a human's call/);
  });

  // A regex over command position cannot enumerate a shell's command positions. Blanking
  // quoted text instead is what makes these all reachable.
  it("blocks the forms that hide the command from a naive matcher", () => {
    for (const cmd of [
      "(gh pr create --base main)",
      "env FOO=1 gh pr create",
      "git push && gh pr create --fill",
      "for x in 1; do gh pr create; done",
      `bash -c "gh pr create --base main"`,
      `eval 'gh pr create'`,
    ]) {
      blocked(cmd);
    }
  });

  // Writing ABOUT the gate is routine — a commit message, a doc, a grep. Matching raw text
  // blocked exactly that, which is how a guard teaches people to work around it.
  it("allows a command that merely mentions it", () => {
    allowed(`git commit -m "block gh pr create for agents"`);
    allowed(`grep -rn 'gh pr create' .claude/`);
    allowed(`cat <<'EOF' > notes.md\nrun gh pr create yourself\nEOF`);
  });

  // There is no override for this rule, unlike every other gate in the repo. An override would
  // hand the reserved decision back to the agent, which is the entire thing being prevented.
  it("has no override, however the caller asks", () => {
    for (const cmd of [
      `REVIEW_RECEIPT_OVERRIDE="urgent" gh pr create`,
      "gh pr create --base main # approved by the user",
      "FORCE=1 gh pr create",
    ]) {
      blocked(cmd);
    }
  });

  it("points at the handover when the review converged, and at the reason when it did not", () => {
    assert.match(blocked("gh pr create", "feature/x", converged), /review:handover/);
    const notReady = blocked("gh pr create", "feature/x", unconverged);
    assert.match(notReady, /only 1 review round on record/);
    assert.doesNotMatch(notReady, /review:handover/, "do not offer a handover that would refuse to write anything");
  });

  it("leaves the other gh pr subcommands alone", () => {
    for (const cmd of ["gh pr view 84", "gh pr diff 84", "gh pr list", "gh pr checks"]) allowed(cmd);
  });

  // The porcelain is not the act. A POST to the pulls endpoint opens the same PR, and a rule
  // that only knows `gh pr create` reserves nothing from an agent that reads the API docs.
  it("blocks opening a PR through the API as well as the porcelain", () => {
    for (const cmd of [
      "gh api repos/Okam-AS/deckhand/pulls -X POST -f base=main -f head=feature/x -f title=t",
      "gh api --method POST repos/Okam-AS/deckhand/pulls -f title=t",
      "curl -X POST https://api.github.com/repos/Okam-AS/deckhand/pulls -d @body.json",
    ]) {
      assert.match(blocked(cmd), /a human's call/);
    }
  });

  it("leaves reading the same endpoint alone", () => {
    allowed("gh api repos/Okam-AS/deckhand/pulls --jq '.[].number'");
    allowed("curl https://api.github.com/repos/Okam-AS/deckhand/pulls/84");
  });

  // The receipt is a JSON file an agent writes, so it can be any shape. When reading it threw,
  // the hook exited 1 — which the harness reads as "the guard errored" and runs the command.
  // The one rule with no override was the one a malformed file could switch off.
  it("still blocks when the review status cannot be read at all", () => {
    const exploded: ReviewStatus = () => {
      throw new TypeError("receipt.waived?.map is not a function");
    };
    const reason = blocked("gh pr create --base main", "feature/x", exploded);
    assert.match(reason, /a human's call/);
    assert.match(reason, /could not be read/);
  });
});

describe("nothing lands on main directly", () => {
  it("blocks a commit made while on main", () => {
    assert.match(blocked(`git commit -m "fix"`, "main"), /nothing lands there directly/);
  });

  it("allows the same commit on a feature branch", () => {
    allowed(`git commit -m "fix"`, "feature/x");
  });

  // `git -C <dir>` and a preceding `cd` both change which branch the command runs against, so
  // reading the hook's own cwd would miss both.
  it("resolves the branch the command would actually run in", () => {
    const resolver = (dir: string | undefined) => (dir === "/tmp/wt" ? "main" : "feature/x");
    assert.equal(decide(`git -C /tmp/wt commit -m "x"`, resolver, converged).blocked, true);
    assert.equal(decide(`cd /tmp/wt && git commit -m "x"`, resolver, converged).blocked, true);
    assert.equal(decide(`cd /tmp/other && git commit -m "x"`, resolver, converged).blocked, false);
  });

  // A merge, a cherry-pick and a revert all land a commit. Blocking only `git commit` states
  // the rule and enforces a third of it.
  it("blocks the other verbs that land a commit on main", () => {
    for (const cmd of ["git merge --no-ff feature/x", "git cherry-pick abc123", "git revert abc123", "git -c user.name=x commit -m y"]) {
      assert.match(blocked(cmd, "main"), /nothing lands there directly/);
    }
  });

  // The branch was resolved as of BEFORE the command ran, so switching to main inside the same
  // line landed the commit exactly where the rule forbids.
  it("blocks a commit that switches to main first", () => {
    assert.match(blocked("git switch main && git commit -m y", "feature/x"), /nothing lands there directly/);
    assert.match(blocked("git checkout main && git cherry-pick abc123", "feature/x"), /nothing lands there directly/);
  });

  it("blocks a push AT main from a feature branch", () => {
    for (const cmd of [
      "git push origin main",
      "git push origin HEAD:main",
      "git push origin HEAD:refs/heads/main",
      // Quoting it is the same push. Rule 2 matches raw text for exactly this reason — the
      // quote-blanking that rule 1 needs is what let these three through.
      `git push origin "main"`,
      `git push origin 'main'`,
      "git push origin main:main",
      "git push origin +main",
    ]) {
      assert.match(blocked(cmd), /pushes at `main`/);
    }
  });

  it("allows pushing the feature branch itself, including one that merely contains the word", () => {
    allowed("git push -u origin feature/x");
    allowed("git push origin feature/mainline-cleanup");
    allowed(`git commit -m "push origin main is blocked"`);
  });
});

describe("restarting the server is not a quiet operation", () => {
  // It tears down every booted simulator on the machine, so someone may be mid-test on a
  // preview the agent cannot see. AGENTS.md says to say so first; this makes that happen.
  it("blocks a kickstart of the deckhand server and says what it costs", () => {
    const reason = blocked("launchctl kickstart -k gui/501/no.deckhand.server");
    assert.match(reason, /EVERY booted simulator/);
  });

  it("leaves other launchctl work alone", () => {
    allowed("launchctl list | grep deckhand");
    allowed("launchctl kickstart -k gui/501/com.example.other");
  });
});

describe("the quote blanking the rules rest on", () => {
  it("blanks heredoc bodies and both quote styles", () => {
    assert.doesNotMatch(withoutQuotedText(`echo "gh pr create"`), /pr create/);
    assert.doesNotMatch(withoutQuotedText(`echo 'gh pr create'`), /pr create/);
    assert.doesNotMatch(withoutQuotedText("cat <<EOF\ngh pr create\nEOF"), /pr create/);
  });

  it("keeps the command itself visible", () => {
    assert.match(withoutQuotedText(`gh pr create --title "x"`), /gh pr create/);
  });

  // The one place quoted text is code rather than data: something is standing by to run it.
  it("still sees the command inside an interpreter's argument", () => {
    assert.equal(opensAPullRequest(`sh -c "gh pr create"`), true);
    assert.equal(opensAPullRequest(`echo "gh pr create"`), false);
  });
});
