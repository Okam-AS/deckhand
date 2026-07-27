import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../config.ts";
import { parseRepo } from "../config.ts";
import { paths } from "../paths.ts";
import { createAskpass } from "../github/appAuth.ts";
import { CredentialsMissingError } from "../github/credentials.ts";

// ---------------------------------------------------------------------------
// Git worktree mechanics (auto-mate-learnings.md §4). Base clone per app;
// detached per-preview worktree. Named branches/PRs ALWAYS fetch so a repeat
// preview builds the latest push (amended 2026-07-15 — the old local-first
// shortcut served stale commits); only commit SHAs resolve local-first, since
// a SHA is immutable and can't be fetched by refspec anyway.
// ---------------------------------------------------------------------------

export type RefSpec = { kind: "branch"; branch: string } | { kind: "pr"; number: number };

const BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*[~^:?*[\\\s])[^\s]{1,255}$/;

export class RefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefError";
  }
}

/** Validate + normalize an incoming ref request into a RefSpec (guards injection/garbage). */
export function parseRefSpec(input: { ref?: string; pr?: number }): RefSpec {
  if (input.pr != null) {
    if (!Number.isInteger(input.pr) || input.pr <= 0) throw new RefError(`invalid PR number: ${input.pr}`);
    return { kind: "pr", number: input.pr };
  }
  const branch = input.ref;
  if (!branch || !BRANCH_RE.test(branch) || branch.endsWith("/") || branch.endsWith(".lock")) {
    throw new RefError(`invalid branch name: ${JSON.stringify(branch)}`);
  }
  return { kind: "branch", branch };
}

/** Short human description, e.g. "main" or "pr/42". */
export function refDescription(spec: RefSpec): string {
  return spec.kind === "branch" ? spec.branch : `pr/${spec.number}`;
}

/** The fetch refspec and the local ref to check out for a spec. */
export function fetchRefspec(spec: RefSpec): { refspec: string; localRef: string } {
  if (spec.kind === "branch") {
    const b = spec.branch;
    return { refspec: `+refs/heads/${b}:refs/remotes/origin/${b}`, localRef: `refs/remotes/origin/${b}` };
  }
  const n = spec.number;
  return { refspec: `+refs/pull/${n}/head:refs/remotes/origin/pr-${n}`, localRef: `refs/remotes/origin/pr-${n}` };
}

/** Whether a branch-spec ref is really a commit SHA (immutable → safe to resolve locally). */
export function isCommitSha(ref: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(ref);
}

/** HTTPS clone URL for an app's repo (token supplied out-of-band via GIT_ASKPASS). */
export function cloneUrl(app: App): string {
  const { host, owner, name } = parseRepo(requireRepo(app));
  return `https://${host}/${owner}/${name}.git`;
}

/** The app's repo string, or a RefError for local-only apps (no git operations apply). */
export function requireRepo(app: App): string {
  if (!app.repo) {
    throw new RefError(`app "${app.id}" is local-only (no repo) — git previews don't apply; use its local source`);
  }
  return app.repo;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}
export type GitRunner = (args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) => Promise<GitResult>;

const defaultRunner: GitRunner = (args, opts) =>
  new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd: opts?.cwd, env: opts?.env ?? process.env, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0;
        resolve({ stdout: stdout.toString(), stderr: stderr.toString(), code: typeof code === "number" ? code : 1 });
      },
    );
  });

export interface WorktreeManagerOptions {
  /** `(owner) => Promise<installation token>`; only called for network fetches. */
  tokenResolver: (owner: string) => Promise<string>;
  /**
   * When no credential is configured at all, retry network ops unauthenticated
   * (public repos). Wired from config `allowPublicRepos` so operators who bound
   * deckhand to their own org keep that boundary.
   */
  allowAnonymous?: boolean;
  git?: GitRunner;
}

export interface PreparedWorktree {
  path: string;
  ref: string; // resolved local ref / commit checked out
  description: string; // "main" | "pr/42"
  usedToken: boolean;
}

/** Readers over a repo at a resolved ref, backed by the git object DB (no checkout). */
export interface RepoInspection {
  localRef: string;
  /** File contents at the ref, or null if the path doesn't exist there. */
  read: (path: string) => Promise<string | null>;
  /** Whether a tree entry (file or dir) exists at the ref. */
  hasEntry: (path: string) => Promise<boolean>;
}

export class WorktreeManager {
  private readonly git: GitRunner;
  constructor(private readonly opts: WorktreeManagerOptions) {
    this.git = opts.git ?? defaultRunner;
  }

  private async runNetwork(app: App, args: string[], cwd: string): Promise<GitResult> {
    let token: string;
    try {
      token = await this.opts.tokenResolver(parseRepo(requireRepo(app)).owner);
    } catch (e) {
      if (this.opts.allowAnonymous && e instanceof CredentialsMissingError) {
        // No credential anywhere — let git try unauthenticated. Any inherited
        // askpass (e.g. an IDE's) is stripped and prompts stay disabled, so a
        // private repo fails fast with an auth-shaped error that add_app turns
        // into the onboarding step.
        const { GIT_ASKPASS: _dropped, ...env } = process.env;
        return this.git(args, { cwd, env: { ...env, GIT_TERMINAL_PROMPT: "0" } });
      }
      throw e;
    }
    const askpass = createAskpass(token);
    try {
      return await this.git(args, { cwd, env: { ...process.env, ...askpass.env } });
    } finally {
      askpass.cleanup();
    }
  }

  /** Clone the app's repo into its base dir if absent. Returns the base dir. */
  async ensureBaseClone(app: App): Promise<string> {
    const base = paths.repo(app.id);
    if (existsSync(join(base, ".git"))) return base;
    mkdirSync(paths.reposDir(), { recursive: true });
    const res = await this.runNetwork(app, ["clone", "--no-checkout", cloneUrl(app), base], paths.reposDir());
    if (res.code !== 0) throw new RefError(`clone failed for ${app.repo}: ${res.stderr.trim().slice(0, 300)}`);
    return base;
  }

  private async resolvesLocally(base: string, candidate: string): Promise<boolean> {
    const res = await this.git(["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], { cwd: base });
    return res.code === 0 && res.stdout.trim().length > 0;
  }

  /**
   * Ensure the requested ref exists locally in the base clone and is CURRENT.
   * Named branches/PRs always fetch (a repeat preview must build the latest
   * push, not a stale remote-tracking ref); commit SHAs are immutable and
   * resolve local-first with no network and no token.
   */
  async prepareRef(app: App, spec: RefSpec): Promise<{ localRef: string; usedToken: boolean }> {
    const base = await this.ensureBaseClone(app);
    if (spec.kind === "branch" && isCommitSha(spec.branch)) {
      if (await this.resolvesLocally(base, spec.branch)) return { localRef: spec.branch, usedToken: false };
      throw new RefError(
        `commit ${spec.branch} is not present in the local clone of ${app.repo} — preview the branch that contains it instead`,
      );
    }
    const { refspec, localRef } = fetchRefspec(spec);
    const res = await this.runNetwork(app, ["fetch", "--force", "--prune", "origin", refspec], base);
    if (res.code !== 0) {
      throw new RefError(`could not fetch ${refDescription(spec)} for ${app.repo}: ${res.stderr.trim().slice(0, 300)}`);
    }
    return { localRef, usedToken: true };
  }

  /** Create a detached worktree for a preview at the resolved ref; init submodules. */
  async createWorktree(app: App, previewId: string, spec: RefSpec): Promise<PreparedWorktree> {
    const base = await this.ensureBaseClone(app);
    const { localRef, usedToken } = await this.prepareRef(app, spec);
    const wtPath = paths.worktree(previewId);
    mkdirSync(paths.worktreesDir(), { recursive: true });
    // Remove any stale worktree registration for this path before re-adding.
    await this.git(["worktree", "remove", "--force", wtPath], { cwd: base });
    const add = await this.git(["worktree", "add", "--detach", wtPath, localRef], { cwd: base });
    if (add.code !== 0) {
      throw new RefError(`worktree add failed: ${add.stderr.trim().slice(0, 300)}`);
    }
    if (existsSync(join(wtPath, ".gitmodules"))) {
      // Submodules may be private too — fetch them with the token.
      await this.runNetwork(app, ["submodule", "update", "--init", "--recursive"], wtPath);
    }
    return { path: wtPath, ref: localRef, description: refDescription(spec), usedToken };
  }

  /**
   * Refresh an existing preview worktree to the current tip of its ref: fetch,
   * then hard-reset the (detached) worktree to the new commit. Untracked build
   * artifacts (node_modules, platforms/, Pods) survive, so the rebuild is warm.
   */
  async updateWorktree(app: App, previewId: string, spec: RefSpec): Promise<PreparedWorktree> {
    const { localRef, usedToken } = await this.prepareRef(app, spec);
    const wtPath = paths.worktree(previewId);
    if (!existsSync(wtPath)) throw new RefError(`worktree for preview ${previewId} no longer exists`);
    const reset = await this.git(["reset", "--hard", localRef], { cwd: wtPath });
    if (reset.code !== 0) {
      throw new RefError(`worktree update failed: ${reset.stderr.trim().slice(0, 300)}`);
    }
    if (existsSync(join(wtPath, ".gitmodules"))) {
      await this.runNetwork(app, ["submodule", "update", "--init", "--recursive"], wtPath);
    }
    return { path: wtPath, ref: localRef, description: refDescription(spec), usedToken };
  }

  /**
   * The repo's default branch (from `origin/HEAD`, set by clone), e.g. "master".
   * Null if it can't be determined. Ensures the base clone first (so it can hit
   * the same credential path as add_app and surface a missing-credential error).
   */
  async defaultBranch(app: App): Promise<string | null> {
    const base = await this.ensureBaseClone(app);
    const r = await this.git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: base });
    if (r.code !== 0) return null;
    return /^origin\/(.+)$/.exec(r.stdout.trim())?.[1] ?? null;
  }

  /**
   * Ensure the base clone + requested ref exist, and return cheap readers over
   * the git object DB at that ref (no working-tree checkout, no submodule
   * fetch). Used by add_app to detect the app type/bundle id before registering.
   */
  async inspect(app: App, spec: RefSpec): Promise<RepoInspection> {
    const base = await this.ensureBaseClone(app);
    const { localRef } = await this.prepareRef(app, spec);
    return {
      localRef,
      read: async (p: string): Promise<string | null> => {
        const r = await this.git(["show", `${localRef}:${p}`], { cwd: base });
        return r.code === 0 ? r.stdout : null;
      },
      hasEntry: async (p: string): Promise<boolean> => {
        const r = await this.git(["ls-tree", "--name-only", localRef, p], { cwd: base });
        return r.code === 0 && r.stdout.trim().length > 0;
      },
    };
  }

  /** Remove a preview's worktree and its directory. Best-effort; safe to call twice. */
  async removeWorktree(app: App, previewId: string): Promise<void> {
    const base = paths.repo(app.id);
    const wtPath = paths.worktree(previewId);
    if (existsSync(join(base, ".git"))) {
      await this.git(["worktree", "remove", "--force", wtPath], { cwd: base });
    }
    rmSync(wtPath, { recursive: true, force: true });
  }
}
