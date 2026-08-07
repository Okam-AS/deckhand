import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decide, opensAPullRequest, withoutQuotedText, type ReviewStatus } from "./bash-guard.ts";

/** The review has converged — so the block message should hand over, not scold. */
const converged: ReviewStatus = () => ({ ok: true, detail: "the review has converged" });
/** The review has not — the message should say why as well as refusing. */
const unconverged: ReviewStatus = () => ({ ok: false, detail: "only 1 review round on record ([0])" });

const blocked = (cmd: string, review = converged): string => {
  const v = decide(cmd, review);
  assert.equal(v.blocked, true, `expected to be blocked: ${cmd}`);
  return v.blocked ? v.reason : "";
};
const allowed = (cmd: string, review = converged): void => {
  assert.equal(decide(cmd, review).blocked, false, `expected to be allowed: ${cmd}`);
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

  // The shell strips these quotes before `gh` ever sees them, so all four run the command —
  // and blanking quoted spans wholesale allowed every one of them. A quoted span with no
  // whitespace is escaping; only one that crosses a space is data.
  it("blocks the command with its own words quoted", () => {
    for (const cmd of [`gh 'pr' create --title x`, `gh pr 'create' --fill`, `gh "pr" "create"`, `gh pr crea'te'`]) {
      assert.match(blocked(cmd), /a human's call/);
    }
  });

  // Quoting is not the only spelling a shell accepts. Each of these was run against a stub `gh`
  // on PATH and printed `pr create` — they are the command, spelt to miss a matcher.
  it("blocks the escaped spellings too", () => {
    for (const cmd of [`gh $'pr' create`, "gh \\pr create", "gh pr cre\\ate", "gh pr \\\n  create", "gh${IFS}pr${IFS}create"]) {
      assert.match(blocked(cmd), /a human's call/);
    }
  });

  // Rule 1 has no override, so an over-block here has no way out but asking a person about
  // something they did not need to be asked. `/pulls` opens one; `/pulls/12/...` is how you
  // talk about one that already exists, which is what this repo's own review tooling does.
  it("leaves the endpoints that talk about an existing PR alone", () => {
    allowed("gh api repos/Okam-AS/deckhand/pulls/12/comments -f body=nit -f path=x.ts -f line=3");
    allowed("gh api repos/Okam-AS/deckhand/pulls/12/reviews -X POST -f event=COMMENT -f body=ok");
    allowed("gh api -X PATCH repos/Okam-AS/deckhand/pulls/12 -f title=x");
  });

  // Writing ABOUT the gate is routine — a commit message, a doc, a grep. Matching raw text
  // blocked exactly that, which is how a guard teaches people to work around it.
  it("allows a command that merely mentions it", () => {
    allowed(`git commit -m "block gh pr create for agents"`);
    allowed(`grep -rn 'gh pr create' .claude/`);
    allowed(`cat <<'EOF' > notes.md\nrun gh pr create yourself\nEOF`);
    // This one is not hypothetical: writing the review round up blocked itself, because the
    // notes name `createPullRequest` and a `pulls` URL. Data, not a command.
    allowed(`cat <<'EOF' > round.json\nthe createPullRequest mutation and curl -d @pr.json .../pulls are allowed\nEOF`);
    allowed(`git commit -m "cover the createPullRequest mutation"`);
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
    assert.match(blocked("gh pr create", converged), /review:handover/);
    const notReady = blocked("gh pr create", unconverged);
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
      // `gh api` switches to POST on its own the moment a parameter flag appears, so `-f`/`-F`
      // with no method at all is the shortest way to open one.
      "gh api repos/Okam-AS/deckhand/pulls -F title=t -F head=f -F base=main",
      "gh api repos/Okam-AS/deckhand/pulls --input pr.json",
      "gh api --method=POST repos/Okam-AS/deckhand/pulls",
      "gh api -XPOST repos/Okam-AS/deckhand/pulls",
      "curl -X POST https://api.github.com/repos/Okam-AS/deckhand/pulls -d @body.json",
      "curl -d @pr.json https://api.github.com/repos/Okam-AS/deckhand/pulls",
      // Quoting a URL is the ordinary way to write one — blanking it would hide the target.
      `curl -X POST -d @pr.json "https://api.github.com/repos/Okam-AS/deckhand/pulls"`,
      `gh api graphql -f query='mutation { createPullRequest(input: {}) { pullRequest { url } } }'`,
      "echo 'gh pr create --fill' | bash",
    ]) {
      assert.match(blocked(cmd), /a human's call/);
    }
  });

  it("leaves reading the same endpoint alone", () => {
    allowed("gh api repos/Okam-AS/deckhand/pulls --jq '.[].number'");
    allowed("curl https://api.github.com/repos/Okam-AS/deckhand/pulls/84");
    allowed("gh api graphql -f query='query { repository(owner: \"o\", name: \"n\") { name } }'");
  });

  // The receipt is a JSON file an agent writes, so it can be any shape. When reading it threw,
  // the hook exited 1 — which the harness reads as "the guard errored" and runs the command.
  // The one rule with no override was the one a malformed file could switch off.
  it("still blocks when the review status cannot be read at all", () => {
    const exploded: ReviewStatus = () => {
      throw new TypeError("receipt.waived?.map is not a function");
    };
    const reason = blocked("gh pr create --base main", exploded);
    assert.match(reason, /a human's call/);
    assert.match(reason, /could not be read/);
  });
});

describe("the quote blanking the rule rests on", () => {
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

describe("listing pull requests is not opening one", () => {
  // Rule 1 has no override, so an over-block costs a person an interruption they did not need.
  // `gh api` switches to POST on its own when a parameter flag appears, which is why `-f`/`-F`
  // count — but a NAMED method settles the question, and paging through PRs is `-X GET … -F`.
  it("allows a GET to the pulls collection even with parameter flags", () => {
    allowed("gh api -X GET repos/Okam-AS/deckhand/pulls -F state=open -F per_page=100");
    allowed("gh api --method GET repos/Okam-AS/deckhand/pulls -f state=open");
    allowed("gh api repos/Okam-AS/deckhand/pulls --paginate");
  });

  it("still blocks the POST it exists for", () => {
    assert.match(blocked("gh api repos/Okam-AS/deckhand/pulls -X POST -f base=main"), /a human's call/);
    assert.match(blocked("gh api repos/Okam-AS/deckhand/pulls -F title=t -F head=f"), /a human's call/);
  });

  // The first version of the method check read the RAW command anywhere in it, so DATA could name
  // the method: a title mentioning `-X GET` cleared the POST indicator on a real create-a-PR call.
  // A quoted argument may add nothing to this decision, only the command itself may.
  it("does not let a quoted argument name the method", () => {
    for (const cmd of [
      `gh api repos/Okam-AS/deckhand/pulls -f body="see -X GET note" -f head=b -f base=main -X POST`,
      `gh api repos/Okam-AS/deckhand/pulls -f title="Support -X GET in the bash guard" -f head=b -f base=main`,
      // No boundary before the flag matched `-X` mid-word, which did the same thing unquoted.
      "gh api repos/Okam-AS/deckhand/pulls -f title=Fix-XY -f head=b -f base=main",
      // Case is not a way out either.
      "gh api repos/Okam-AS/deckhand/pulls -X Post --input b.json",
    ]) {
      assert.match(blocked(cmd), /a human's call/);
    }
  });
});
