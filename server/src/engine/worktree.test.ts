import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseRefSpec,
  refDescription,
  fetchRefspec,
  isCommitSha,
  cloneUrl,
  worktreeKey,
  RefError,
  WorktreeManager,
  type GitRunner,
  type GitResult,
} from "./worktree.ts";
import { paths } from "../paths.ts";
import { CredentialsMissingError } from "../github/credentials.ts";
import type { App } from "../config.ts";

const app: App = {
  id: "my-app",
  repo: "github.com/ainfrastructure/my-app",
  type: "expo",
  defaultBranch: "main",
 
  env: {},
};

describe("parseRefSpec", () => {
  it("accepts branches and PRs", () => {
    assert.deepEqual(parseRefSpec({ ref: "main" }), { kind: "branch", branch: "main" });
    assert.deepEqual(parseRefSpec({ ref: "feature/onboarding" }), {
      kind: "branch",
      branch: "feature/onboarding",
    });
    assert.deepEqual(parseRefSpec({ pr: 42 }), { kind: "pr", number: 42 });
  });

  it("rejects injection-ish and malformed refs", () => {
    for (const bad of ["", "-x", "a..b", "a b", "foo~1", "bar^", "with:colon", "ends/", "x.lock"]) {
      assert.throws(() => parseRefSpec({ ref: bad }), (e) => e instanceof RefError, `expected reject: ${bad}`);
    }
    assert.throws(() => parseRefSpec({ pr: 0 }), (e) => e instanceof RefError);
    assert.throws(() => parseRefSpec({ pr: -3 }), (e) => e instanceof RefError);
  });
});

describe("ref helpers", () => {
  it("describes refs", () => {
    assert.equal(refDescription({ kind: "branch", branch: "main" }), "main");
    assert.equal(refDescription({ kind: "pr", number: 7 }), "pr/7");
  });

  it("builds fetch refspecs", () => {
    assert.deepEqual(fetchRefspec({ kind: "branch", branch: "dev" }), {
      refspec: "+refs/heads/dev:refs/remotes/origin/dev",
      localRef: "refs/remotes/origin/dev",
    });
    assert.deepEqual(fetchRefspec({ kind: "pr", number: 9 }), {
      refspec: "+refs/pull/9/head:refs/remotes/origin/pr-9",
      localRef: "refs/remotes/origin/pr-9",
    });
  });

  it("recognizes commit SHAs", () => {
    assert.equal(isCommitSha("deadbeef"), true);
    assert.equal(isCommitSha("f00dfeedf00dfeedf00dfeedf00dfeedf00dfeed"), true);
    assert.equal(isCommitSha("main"), false);
    assert.equal(isCommitSha("feature/abc123"), false);
    assert.equal(isCommitSha("abc12"), false); // too short to be unambiguous
  });

  it("builds an https clone url", () => {
    assert.equal(cloneUrl(app), "https://github.com/ainfrastructure/my-app.git");
  });
});

/** A scripted fake git runner: matches on the leading args, records calls. */
function fakeGit(handlers: Array<{ match: (a: string[]) => boolean; result: Partial<GitResult> }>) {
  const calls: string[][] = [];
  const envs: Array<NodeJS.ProcessEnv | undefined> = [];
  const runner: GitRunner = async (args, opts) => {
    calls.push(args);
    envs.push(opts?.env);
    const h = handlers.find((x) => x.match(args));
    return { stdout: "", stderr: "", code: 0, ...(h?.result ?? {}) };
  };
  return { runner, calls, envs };
}

describe("WorktreeManager.prepareRef", () => {
  let home: string;
  before(() => {
    home = mkdtempSync(join(tmpdir(), "deckhand-wt-"));
    process.env.DECKHAND_HOME = home;
    // Pre-create the base clone so ensureBaseClone short-circuits (no clone,
    // no token) — isolating whether *ref resolution* uses a token.
    mkdirSync(join(paths.repo(app.id), ".git"), { recursive: true });
  });
  after(() => {
    delete process.env.DECKHAND_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it("always fetches a named branch, even when a stale local ref resolves", async () => {
    // The old local-first shortcut made a repeat preview of a branch build the
    // previous push. Named refs are mutable: they must fetch every time.
    const { runner, calls } = fakeGit([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: "deadbeef\n" } }, // stale ref resolves
      { match: (a) => a[0] === "fetch", result: { code: 0 } },
    ]);
    const mgr = new WorktreeManager({ tokenResolver: async () => "tok", git: runner });
    const res = await mgr.prepareRef(app, parseRefSpec({ ref: "main" }));
    assert.equal(res.usedToken, true);
    assert.equal(res.localRef, "refs/remotes/origin/main");
    assert.ok(calls.some((a) => a[0] === "fetch"), "named branches must always fetch");
  });

  it("resolves a commit SHA local-first without fetching or minting a token", async () => {
    let tokenCalls = 0;
    const { runner, calls } = fakeGit([
      { match: (a) => a[0] === "rev-parse", result: { code: 0, stdout: "deadbeef\n" } },
    ]);
    const mgr = new WorktreeManager({
      tokenResolver: async () => {
        tokenCalls++;
        return "tok";
      },
      git: runner,
    });
    const res = await mgr.prepareRef(app, parseRefSpec({ ref: "deadbeefdeadbeefdead" }));
    assert.equal(res.usedToken, false);
    assert.equal(res.localRef, "deadbeefdeadbeefdead");
    assert.equal(tokenCalls, 0, "an already-local SHA must not mint a token");
    assert.equal(calls.some((a) => a[0] === "fetch"), false);
  });

  it("rejects a SHA that is not present locally (SHAs cannot be fetched by refspec)", async () => {
    const { runner } = fakeGit([{ match: (a) => a[0] === "rev-parse", result: { code: 1 } }]);
    const mgr = new WorktreeManager({ tokenResolver: async () => "tok", git: runner });
    await assert.rejects(
      () => mgr.prepareRef(app, parseRefSpec({ ref: "deadbeefdeadbeefdead" })),
      (e) => e instanceof RefError && /not present/.test((e as Error).message),
    );
  });

  it("fetches with a token when no candidate resolves locally", async () => {
    let tokenCalls = 0;
    const { runner, calls } = fakeGit([
      { match: (a) => a[0] === "rev-parse", result: { code: 1 } }, // nothing resolves locally
      { match: (a) => a[0] === "fetch", result: { code: 0 } },
    ]);
    const mgr = new WorktreeManager({
      tokenResolver: async () => {
        tokenCalls++;
        return "tok";
      },
      git: runner,
    });
    const res = await mgr.prepareRef(app, parseRefSpec({ pr: 12 }));
    assert.equal(res.usedToken, true);
    assert.equal(res.localRef, "refs/remotes/origin/pr-12");
    const fetchCall = calls.find((a) => a[0] === "fetch");
    assert.ok(fetchCall);
    assert.ok(fetchCall!.includes("+refs/pull/12/head:refs/remotes/origin/pr-12"));
    assert.ok(tokenCalls >= 1);
  });

  it("falls back to an anonymous fetch when no credential exists and public repos are allowed", async () => {
    const { runner, calls, envs } = fakeGit([
      { match: (a) => a[0] === "rev-parse", result: { code: 1 } },
      { match: (a) => a[0] === "fetch", result: { code: 0 } },
    ]);
    const mgr = new WorktreeManager({
      tokenResolver: async () => {
        throw new CredentialsMissingError("ainfrastructure", "no credential");
      },
      allowAnonymous: true,
      git: runner,
    });
    const res = await mgr.prepareRef(app, parseRefSpec({ ref: "main" }));
    assert.equal(res.localRef, "refs/remotes/origin/main");
    const i = calls.findIndex((a) => a[0] === "fetch");
    assert.ok(i >= 0, "the fetch must still happen, unauthenticated");
    assert.equal(envs[i]?.GIT_ASKPASS, undefined, "anonymous ops must not carry an askpass");
    assert.equal(envs[i]?.GIT_TERMINAL_PROMPT, "0", "anonymous ops must fail fast, never prompt");
  });

  it("propagates the credential error when public repos are not allowed", async () => {
    const { runner } = fakeGit([{ match: (a) => a[0] === "rev-parse", result: { code: 1 } }]);
    const mgr = new WorktreeManager({
      tokenResolver: async () => {
        throw new CredentialsMissingError("ainfrastructure", "no credential");
      },
      git: runner,
    });
    await assert.rejects(
      () => mgr.prepareRef(app, parseRefSpec({ ref: "main" })),
      (e) => e instanceof CredentialsMissingError,
    );
  });

  it("updateWorktree fetches and hard-resets the existing worktree to the new tip", async () => {
    mkdirSync(paths.worktree(worktreeKey(app.id, parseRefSpec({ ref: "main" }))), { recursive: true });
    const seen: { args: string[]; cwd?: string }[] = [];
    const runner: GitRunner = async (args, opts) => {
      seen.push({ args, cwd: opts?.cwd });
      return { stdout: "", stderr: "", code: 0 };
    };
    const mgr = new WorktreeManager({ tokenResolver: async () => "tok", git: runner });
    const res = await mgr.updateWorktree(app, "pv-upd", parseRefSpec({ ref: "main" }));
    assert.equal(res.path, paths.worktree(worktreeKey(app.id, parseRefSpec({ ref: "main" }))));
    assert.ok(seen.some((c) => c.args[0] === "fetch"));
    const reset = seen.find((c) => c.args[0] === "reset");
    assert.ok(reset, "must hard-reset the worktree");
    assert.deepEqual(reset!.args, ["reset", "--hard", "refs/remotes/origin/main"]);
    assert.equal(reset!.cwd, paths.worktree(worktreeKey(app.id, parseRefSpec({ ref: "main" }))));
  });

  it("widens the repo-scoped token to same-org submodules declared in .gitmodules", async () => {
    // The installation token covers only the previewed repo, so a legitimate
    // private submodule in the same org would 404 under it.
    const wt = paths.worktree(worktreeKey(app.id, parseRefSpec({ ref: "main" })));
    mkdirSync(wt, { recursive: true });
    writeFileSync(
      join(wt, ".gitmodules"),
      `[submodule "shared"]\n\turl = https://github.com/ainfrastructure/shared.git\n` +
        `[submodule "rel"]\n\turl = ../design-system.git\n` +
        `[submodule "elsewhere"]\n\turl = https://gitlab.example/other/thing.git\n` +
        `[submodule "otherorg"]\n\turl = https://github.com/someone-else/tool.git\n`,
    );
    const scopes: (string[] | undefined)[] = [];
    const runner: GitRunner = async () => ({ stdout: "", stderr: "", code: 0 });
    const mgr = new WorktreeManager({
      tokenResolver: async (_o, _r, extra) => {
        scopes.push(extra);
        return "tok";
      },
      git: runner,
    });
    await mgr.updateWorktree(app, "pv-sub", parseRefSpec({ ref: "main" }));
    // Only same-host, same-owner (and relative) urls; never another org or host.
    assert.deepEqual(scopes.at(-1), ["shared", "design-system"]);
  });

  it("surfaces a failing submodule checkout instead of swallowing it", async () => {
    const wt = paths.worktree(worktreeKey(app.id, parseRefSpec({ ref: "main" })));
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, ".gitmodules"), `[submodule "priv"]\n\turl = https://github.com/ainfrastructure/priv.git\n`);
    const runner: GitRunner = async (args) =>
      args[0] === "submodule"
        ? { stdout: "", stderr: "fatal: repository not found", code: 128 }
        : { stdout: "", stderr: "", code: 0 };
    const mgr = new WorktreeManager({ tokenResolver: async () => "tok", git: runner });
    await assert.rejects(
      () => mgr.updateWorktree(app, "pv-subfail", parseRefSpec({ ref: "main" })),
      (e) => e instanceof RefError && /submodule checkout failed/.test((e as Error).message) && /private/.test((e as Error).message),
    );
  });
  it("reuses one checkout per app+ref instead of one per preview", async () => {
    // A per-preview directory made every build cold: Xcode keys DerivedData on
    // the project PATH, so a new path meant a full npm ci + pod install + ~600
    // pod source files (~15 min) and a fresh 3.6 GB DerivedData tree each time.
    const seen: string[][] = [];
    const runner: GitRunner = async (args) => {
      seen.push(args);
      return { stdout: "", stderr: "", code: 0 };
    };
    const mgr = new WorktreeManager({ tokenResolver: async () => "tok", git: runner });
    const a = await mgr.createWorktree(app, "preview-one", parseRefSpec({ ref: "main" }));
    const b = await mgr.createWorktree(app, "preview-two", parseRefSpec({ ref: "main" }));
    assert.equal(a.path, b.path, "the same app+ref must share one checkout");
    assert.match(a.path, /dh-my-app-main-[0-9a-f]{8}$/);

    // ...and a different ref must NOT share it.
    const other = await mgr.createWorktree(app, "preview-three", parseRefSpec({ ref: "dev" }));
    assert.notEqual(other.path, a.path);
  });

  it("prunes checkouts no live preview is using, and keeps the live ones", async () => {
    const keep = worktreeKey(app.id, parseRefSpec({ ref: "main" }));
    mkdirSync(paths.worktree(keep), { recursive: true });
    mkdirSync(paths.worktree("my-app-gone-deadbeef"), { recursive: true });
    const mgr = new WorktreeManager({ tokenResolver: async () => "tok", git: async () => ({ stdout: "", stderr: "", code: 0 }) });
    const removed = await mgr.pruneWorktrees(new Set([keep]), 0);
    assert.deepEqual(removed, ["dh-my-app-gone-deadbeef"]);
    assert.equal(existsSync(paths.worktree(keep)), true, "a live checkout must survive");
  });

  it("keeps a recently used checkout even when no preview is live (warm-cache grace)", async () => {
    // Boot is the case that matters: the live set is empty by definition there,
    // so an ungraced prune deleted every warm checkout on the machine.
    mkdirSync(paths.worktree("my-app-warm-deadbeef"), { recursive: true });
    const mgr = new WorktreeManager({ tokenResolver: async () => "tok", git: async () => ({ stdout: "", stderr: "", code: 0 }) });
    const removed = await mgr.pruneWorktrees(new Set());
    assert.deepEqual(removed, []);
    assert.equal(existsSync(paths.worktree("my-app-warm-deadbeef")), true);
  });

  it("caps the warm cache: past the budget, the oldest idle checkouts go anyway", async () => {
    // The grace window bounds AGE, not COUNT — a week of PR previews mints a
    // multi-GB checkout per ref long before the first is old enough to reclaim.
    rmSync(paths.worktreesDir(), { recursive: true, force: true }); // only this test's checkouts count
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      const dir = paths.worktree(`my-app-ref${i}-deadbee${i}`);
      mkdirSync(dir, { recursive: true });
      const at = new Date(now - i * 10 * 60_000); // ref0 newest; all past the in-use window but inside the grace
      utimesSync(dir, at, at);
    }
    const mgr = new WorktreeManager({ tokenResolver: async () => "tok", git: async () => ({ stdout: "", stderr: "", code: 0 }) });
    // All five are well inside the grace window; only the budget overflow goes.
    const removed = await mgr.pruneWorktrees(new Set(), 60 * 60_000, 2);
    assert.deepEqual(removed.sort(), ["dh-my-app-ref2-deadbee2", "dh-my-app-ref3-deadbee3", "dh-my-app-ref4-deadbee4"]);
    assert.equal(existsSync(paths.worktree("my-app-ref0-deadbee0")), true, "the two most recent stay warm");
    assert.equal(existsSync(paths.worktree("my-app-ref1-deadbee1")), true);
  });

  it("teardown leaves the checkout in place (it is the next build's warm cache)", async () => {
    const key = worktreeKey(app.id, parseRefSpec({ ref: "main" }));
    mkdirSync(paths.worktree(key), { recursive: true });
    const mgr = new WorktreeManager({ tokenResolver: async () => "tok", git: async () => ({ stdout: "", stderr: "", code: 0 }) });
    await mgr.removeWorktree(app, "preview-one");
    assert.equal(existsSync(paths.worktree(key)), true);
  });
});
