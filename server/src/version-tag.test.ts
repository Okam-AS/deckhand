import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Auto-tagging on merge to main.
 *
 * The version number is derived, never stored: `git rev-list --count HEAD`. Nothing to bump,
 * so nothing to forget — a version somebody has to remember to change is a version that lies.
 *
 * This is tested by RUNNING the script CI runs, in a throwaway git repo with a known history,
 * rather than by reading the workflow YAML and hoping. Logic buried in CI configuration is
 * logic nobody checks until it is wrong in production, which is exactly why the number lives
 * in `ops/next-version-tag.sh` and not in an inline `run:` expression.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO, "ops", "next-version-tag.sh");

/** A throwaway repo with `commits` commits on `main`. */
function repoWith(commits: number): string {
  const dir = mkdtempSync(join(tmpdir(), "deckhand-tag-"));
  const git = (...args: string[]): string =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
  git("init", "-q", "-b", "main");
  for (let i = 0; i < commits; i++) {
    writeFileSync(join(dir, "f"), String(i));
    git("add", "-A");
    git("commit", "-q", "-m", `c${i}`);
  }
  return dir;
}

const run = (cwd: string, env: Record<string, string> = {}): string =>
  execFileSync("sh", [SCRIPT], { cwd, encoding: "utf8", env: { ...process.env, ...env } }).trim();

describe("ops/next-version-tag.sh", () => {
  it("numbers by commit count, so it needs no stored state", () => {
    const dir = repoWith(3);
    try {
      assert.equal(run(dir), "v0.1.3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("advances by exactly one per merge, and never repeats", () => {
    // main requires linear history and forbids force-push, so the count only ever grows —
    // which is what makes "count" safe as a version without any bookkeeping.
    const dir = repoWith(3);
    try {
      const before = run(dir);
      execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "one more"], {
        cwd: dir,
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
      });
      const after = run(dir);
      assert.equal(before, "v0.1.3");
      assert.equal(after, "v0.1.4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the series is configurable without touching the script", () => {
    const dir = repoWith(2);
    try {
      assert.equal(run(dir, { DECKHAND_VERSION_SERIES: "v2.0" }), "v2.0.2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("produces a tag `git describe --tags` then reports — the whole point of tagging", () => {
    // End to end: tag with what the script prints, then ask git the question version.ts asks.
    // Without this, the script could be right and the tag still invisible to the update
    // notice, which is the only reason any of this exists.
    const dir = repoWith(5);
    try {
      const tag = run(dir);
      const git = (...args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
      git("tag", tag);
      assert.equal(git("describe", "--tags", "--always"), tag, "a human-readable version, not a sha");

      // And a clone sees it, because that is how anyone else gets it.
      const clone = mkdtempSync(join(tmpdir(), "deckhand-tag-clone-"));
      try {
        execFileSync("git", ["clone", "-q", dir, clone]);
        assert.equal(
          execFileSync("git", ["describe", "--tags", "--always"], { cwd: clone, encoding: "utf8" }).trim(),
          tag,
          "git clone fetches tags by default, so a user's checkout reports the version too",
        );
      } finally {
        rmSync(clone, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the tag job is wired the way it has to be", () => {
  const ci = readFileSync(join(REPO, ".github", "workflows", "ci.yml"), "utf8");

  /**
   * The tag job with whole-line comments removed.
   *
   * Stripping is not optional hygiene here: commenting a line OUT leaves its text in the
   * file, so an assertion over the raw YAML still matches and the check passes while the
   * setting is gone. Caught by mutation — disabling `fetch-depth: 0` broke nothing until
   * this existed. Every assertion below reads this, so none of them can forget.
   */
  const tagJob = ci
    .slice(ci.indexOf("\n  tag:"))
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

  it("tags only after the checks pass", () => {
    // A red main must not be tagged, or the tag stops meaning "this is a version you can run".
    assert.match(tagJob, /needs:\s*check/, "the tag job must depend on the check job");
  });

  it("tags only main, and only on a push", () => {
    assert.match(tagJob, /github\.ref == 'refs\/heads\/main'/);
    assert.match(tagJob, /github\.event_name == 'push'/, "a pull_request run must not tag anything");
  });

  it("runs the same script this test runs, rather than restating the logic inline", () => {
    assert.match(tagJob, /ops\/next-version-tag\.sh/);
    assert.doesNotMatch(tagJob, /rev-list --count/, "the number is computed in one place only");
  });

  it("checks out the full history, because a shallow clone cannot count commits", () => {
    assert.match(tagJob, /fetch-depth:\s*0/, "actions/checkout defaults to depth 1, which would number every commit v0.1.1");
  });
});
