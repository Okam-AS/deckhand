import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { checkoutsOfBase } from "./tools.ts";

describe("checkoutsOfBase (remove_app --deleteCheckout)", () => {
  const setup = () => {
    const home = mkdtempSync(join(tmpdir(), "deckhand-rm-"));
    const wt = join(home, "worktrees");
    mkdirSync(wt, { recursive: true });
    const mk = (name: string, base: string) => {
      mkdirSync(join(wt, name), { recursive: true });
      writeFileSync(join(wt, name, ".git"), `gitdir: ${base}/.git/worktrees/${name}\n`);
    };
    return { home, wt, mk };
  };

  it("matches by the .git pointer, not by directory name", () => {
    const { home, wt, mk } = setup();
    try {
      const webBase = join(home, "repos", "web");
      const web2Base = join(home, "repos", "web-2");
      // `web-2`'s directory name starts with `dh-web-`, so a name-prefix match
      // would delete another app's multi-GB checkout.
      mk("dh-web-main-aaaaaaaa", webBase);
      mk("dh-web-2-main-bbbbbbbb", web2Base);
      mkdirSync(join(wt, "not-a-worktree"));
      assert.deepEqual(checkoutsOfBase(wt, webBase), [join(wt, "dh-web-main-aaaaaaaa")]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("finds the checkouts when DECKHAND_HOME is reached through a symlink", () => {
    // `git worktree add` records the REALPATH; matching an unresolved base found
    // nothing, and remove_app still reported the disk as freed.
    const { home, wt, mk } = setup();
    const link = mkdtempSync(join(tmpdir(), "deckhand-link-")) + "/home";
    try {
      symlinkSync(home, link);
      const realBase = join(realpathSync(home), "repos", "web");
      mk("dh-web-main-aaaaaaaa", realBase);
      assert.deepEqual(checkoutsOfBase(join(link, "worktrees"), join(link, "repos", "web")), []);
      assert.deepEqual(checkoutsOfBase(join(link, "worktrees"), realBase), [
        join(link, "worktrees", "dh-web-main-aaaaaaaa"),
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(link, { recursive: true, force: true });
    }
  });
});
