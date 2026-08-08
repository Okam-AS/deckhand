/**
 * The files a whole-repo guardrail is allowed to see: what git tracks, plus what git
 * would offer to track — never what it ignores.
 *
 * A hand-rolled `readdirSync` walk of the repo reads ignored files too, and one of them is
 * `.claude/pr-body.md` — written by `npm run review:handover` as the LAST step before every
 * PR. It names the paths the change touched, so a branch that deletes a file makes the doc
 * checks fail on a file that is not in the diff, is not tracked, and cannot be fixed by
 * changing the branch. `npm run review:gates` runs on a clean checkout, so CI stayed green
 * and the failure reproduced only for whoever followed the documented procedure. The other
 * ignored trees (`.worktrees/`, `tmp/`, `.deckhand/`) are the same trap waiting.
 *
 * `--others --exclude-standard` keeps an uncommitted new file in scope, so writing a doc and
 * not committing it yet does not exempt it from the checks that read it.
 *
 * Symlinks are skipped rather than followed, for the same reason the walks used to die: a git
 * worktree carries a dangling `server/node_modules` symlink, and reading it throws ENOENT —
 * a guardrail failing for a reason nobody can act on.
 *
 * If git is not available this throws. That is deliberate: the alternative is a walk that
 * quietly returns nothing and a check that passes because it examined no files. Callers also
 * assert a plausible minimum count, so a walk that goes empty for any other reason is loud.
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";

/** Repo-relative paths of every non-ignored file, sorted. Absent and symlinked entries dropped. */
export function repoFiles(repo: string): string[] {
  const out = execFileSync("git", ["-C", repo, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split("\0")
    .filter((p) => p.length > 0)
    .filter((p) => {
      // `--cached` lists a file deleted from the working tree but still in the index, and a
      // tracked symlink is still a symlink. Both would throw on read.
      const full = join(repo, p);
      return existsSync(full) && !lstatSync(full).isSymbolicLink();
    })
    .sort();
}

/** The subset of `repoFiles` whose path ends with one of `suffixes`. */
export function repoFilesEndingWith(repo: string, ...suffixes: string[]): string[] {
  return repoFiles(repo).filter((p) => suffixes.some((s) => p.endsWith(s)));
}
