import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync } from "node:fs";
import { rm } from "node:fs/promises";
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

/**
 * HTTPS clone URL for an app's repo (token supplied out-of-band via GIT_ASKPASS).
 * The host is lowercased so it matches the host the askpass script is pinned to
 * verbatim — DNS is case-insensitive, git's prompt text is not.
 */
export function cloneUrl(app: App): string {
  const { host, owner, name } = parseRepo(requireRepo(app));
  return `https://${host.toLowerCase()}/${owner}/${name}.git`;
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
  /** `(owner, repoName) => Promise<installation token>`; only called for network fetches. */
  tokenResolver: (owner: string, repoName?: string, extraRepos?: string[]) => Promise<string>;
  /**
   * When no credential is configured at all, retry network ops unauthenticated
   * (public repos). Wired from config `allowPublicRepos` so operators who bound
   * deckhand to their own org keep that boundary.
   */
  allowAnonymous?: boolean;
  git?: GitRunner;
}

/**
 * The directory key for an app at a ref: `<appId>-<ref slug>-<hash>`.
 *
 * Keyed by app+ref rather than by preview so the SAME code reuses one warm
 * checkout — node_modules, Pods and (because Xcode keys DerivedData on the
 * project path) the compiled objects. A per-preview path made every start a
 * cold ~15-minute build and stacked up a 3.6 GB DerivedData tree per attempt.
 * The hash keeps refs that slugify alike ("feat/a-b" vs "feat/a/b") apart, and
 * the leading app id keeps the directory readable in `ls`.
 */
export function worktreeKey(appId: string, spec: RefSpec): string {
  const ref = spec.kind === "pr" ? `pr-${spec.number}` : spec.branch;
  const slug = `${appId}-${ref}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const hash = createHash("sha256").update(`${appId}\n${ref}`).digest("hex").slice(0, 8);
  return `${slug.slice(0, 48)}-${hash}`;
}

/**
 * How long a checkout no live preview is using survives a prune.
 *
 * The point of keying checkouts by app+ref is that the NEXT preview of that ref
 * reuses the warm node_modules/Pods/DerivedData — so "delete everything not
 * live" would throw that away the moment any prune ran after a stop (at boot,
 * where the live set is empty by definition, it deleted every checkout on the
 * machine). Idle time is the real signal: keep what was used recently, reclaim
 * what wasn't. It doubles as the race guard — a checkout created seconds ago by
 * a start_preview the pruner hasn't seen yet is far inside the window.
 */
export const WORKTREE_IDLE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How many idle checkouts the warm cache is allowed to hold. The grace window
 * bounds AGE but not COUNT, and a busy week of PR previews mints a checkout per
 * ref — each one a node_modules + Pods + platforms tree — so without a budget
 * the cache grows to tens of GB before anything is old enough to reclaim.
 */
export const MAX_IDLE_WORKTREES = 6;

/**
 * A checkout touched this recently is being used right now, whatever the prune
 * decided a moment ago. Only consulted inside the per-key lock, to catch a
 * checkout that a queued-ahead create finished with while we waited.
 */
const CHECKOUT_IN_USE_MS = 5 * 60 * 1000;

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

/**
 * Mark a checkout as used *now*, so the idle prune keeps it.
 *
 * Directory mtime, not a marker file: these are real git worktrees, and an
 * untracked file dropped inside one is exactly what a `git add -A` in an agent
 * session would sweep up. Best-effort — a failure here only means the checkout
 * looks older than it is, and the worst case is one cold rebuild.
 */
function touchWorktree(wtPath: string): void {
  try {
    const now = new Date();
    utimesSync(wtPath, now, now);
  } catch {
    // mtime is a hint, never a correctness requirement
  }
}

/**
 * How long ago a checkout was last created/reset, or Infinity if it can't be
 * read (unreadable = not warm, so it may be reclaimed). Clamped at zero: mtime
 * carries sub-millisecond precision, so a directory made moments ago can read
 * as marginally "in the future" and turn a zero grace into an infinite one.
 */
function worktreeIdleMs(wtPath: string, now: number): number {
  try {
    return Math.max(0, now - statSync(wtPath).mtimeMs);
  } catch {
    return Infinity;
  }
}

/** readdir that yields [] for a missing dir (the repos dir may not exist yet). */
function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export class WorktreeManager {
  private readonly git: GitRunner;
  /** One in-flight checkout operation per directory key (see createWorktree). */
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(private readonly opts: WorktreeManagerOptions) {
    this.git = opts.git ?? defaultRunner;
  }

  private serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(key) ?? Promise.resolve()).then(fn, fn);
    const settled = run.catch(() => {});
    this.locks.set(key, settled);
    // Drop the entry once nothing is queued behind it — this server is meant to
    // run for weeks, and a PR-per-checkout workload would otherwise leave one
    // resolved promise per app+ref ever seen for the life of the process.
    void settled.then(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    });
    return run;
  }

  private async runNetwork(app: App, args: string[], cwd: string, extraRepos?: string[]): Promise<GitResult> {
    const repo = parseRepo(requireRepo(app));
    let token: string;
    try {
      try {
        token = await this.opts.tokenResolver(repo.owner, repo.name, extraRepos);
      } catch (e) {
        // A widened token names sibling submodule repos, and GitHub rejects the
        // WHOLE request (422) if even one of them is outside the installation —
        // a public same-org submodule is enough. That must not take down a
        // checkout that worked before submodule widening existed: fall back to
        // the repo-only token. Public submodules need no token at all, and a
        // genuinely private one still fails later with the actionable
        // `submodule checkout failed …` message instead of a raw auth error.
        if (!extraRepos?.length || e instanceof CredentialsMissingError) throw e;
        token = await this.opts.tokenResolver(repo.owner, repo.name);
      }
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
    // Pinned to the app's own repo host: `submodule update --init --recursive`
    // below runs under this env against URLs the previewed repo chooses, and an
    // unpinned askpass handed the credential to whatever host they named.
    const askpass = createAskpass(token, repo.host.toLowerCase());
    try {
      return await this.git(args, { cwd, env: { ...process.env, ...askpass.env } });
    } finally {
      askpass.cleanup();
    }
  }

  /**
   * Sibling repos the worktree's `.gitmodules` points at, so the (repo-scoped)
   * installation token can be widened to cover them. Only same-host, same-owner
   * https URLs count: the token is an installation token for that org, and a
   * submodule anywhere else would either be public (no token needed) or outside
   * what deckhand may ask for. Relative URLs (`../shared.git`) are the same org
   * by definition.
   */
  /**
   * ACCEPTED RISK (audit 2026-07-29): this widens a repo-scoped token using
   * file content the previewed branch controls. Anyone who can push a branch or
   * open a PR can add a `.gitmodules` naming `../another-private-repo`, and the
   * minted token then covers it — the build script (RCE by design, PLAN §11
   * item 7) can read it. It is still strictly narrower than what it replaced (an
   * org-wide installation token, where the same build had everything), and it is
   * bounded to the same owner. Narrowing it properly means resolving submodules
   * from the app's DEFAULT branch rather than the previewed ref; not done, since
   * legitimate submodule changes then can't be previewed until they merge.
   */
  private submoduleRepoNames(wtPath: string, host: string, owner: string): string[] {
    let text: string;
    try {
      text = readFileSync(join(wtPath, ".gitmodules"), "utf8");
    } catch {
      return [];
    }
    const names = new Set<string>();
    for (const m of text.matchAll(/^\s*url\s*=\s*(\S+)\s*$/gm)) {
      const url = m[1]!;
      const rel = /^\.{1,2}\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(url);
      if (rel) {
        names.add(rel[1]!);
        continue;
      }
      const abs = /^https?:\/\/(?:[^/@]*@)?([^/:]+)(?::\d+)?\/([^/]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url);
      if (abs && abs[1]!.toLowerCase() === host.toLowerCase() && abs[2]!.toLowerCase() === owner.toLowerCase()) {
        names.add(abs[3]!);
      }
    }
    return [...names];
  }

  /**
   * `submodule update --init --recursive` under a token widened to the declared
   * submodule repos. Failures are surfaced: an unreadable private submodule used
   * to fail here silently and reappear as an incomprehensible build error.
   */
  private async initSubmodules(app: App, wtPath: string): Promise<void> {
    if (!existsSync(join(wtPath, ".gitmodules"))) return;
    const repo = parseRepo(requireRepo(app));
    const extra = this.submoduleRepoNames(wtPath, repo.host, repo.owner);
    const res = await this.runNetwork(app, ["submodule", "update", "--init", "--recursive"], wtPath, extra);
    if (res.code !== 0) {
      throw new RefError(
        `submodule checkout failed for ${app.repo}: ${res.stderr.trim().slice(0, 300)} — ` +
          `if a submodule is private, grant deckhand's GitHub credential access to it too ` +
          `(nested submodules and submodules outside ${repo.owner} are not covered automatically)`,
      );
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
    // Serialized per directory: the checkout is SHARED by app+ref now, so two
    // previews of the same ref starting together would otherwise run `worktree
    // add` and `reset --hard` over each other's files mid-build.
    return this.serialize(worktreeKey(app.id, spec), () => this.createWorktreeLocked(app, spec));
  }

  private async createWorktreeLocked(app: App, spec: RefSpec): Promise<PreparedWorktree> {
    const base = await this.ensureBaseClone(app);
    const { localRef, usedToken } = await this.prepareRef(app, spec);
    const wtPath = paths.worktree(worktreeKey(app.id, spec));
    // Already checked out for this app+ref: reuse it (warm node_modules, Pods and
    // DerivedData) by resetting in place instead of throwing it away.
    if (existsSync(join(wtPath, ".git"))) {
      const reset = await this.git(["reset", "--hard", localRef], { cwd: wtPath });
      if (reset.code === 0) {
        touchWorktree(wtPath);
        await this.initSubmodules(app, wtPath);
        return { path: wtPath, ref: localRef, description: refDescription(spec), usedToken };
      }
      // A wedged checkout is not worth diagnosing — fall through and rebuild it.
      // Async: these trees are 100k+ inodes, and a sync delete here would stall
      // every live stream on the server for its duration.
      await rm(wtPath, { recursive: true, force: true });
    }
    mkdirSync(paths.worktreesDir(), { recursive: true });
    // Remove any stale worktree registration for this path before re-adding.
    await this.git(["worktree", "remove", "--force", wtPath], { cwd: base });
    const add = await this.git(["worktree", "add", "--detach", wtPath, localRef], { cwd: base });
    if (add.code !== 0) {
      throw new RefError(`worktree add failed: ${add.stderr.trim().slice(0, 300)}`);
    }
    touchWorktree(wtPath);
    await this.initSubmodules(app, wtPath);
    return { path: wtPath, ref: localRef, description: refDescription(spec), usedToken };
  }

  /**
   * Refresh an existing preview worktree to the current tip of its ref: fetch,
   * then hard-reset the (detached) worktree to the new commit. Untracked build
   * artifacts (node_modules, platforms/, Pods) survive, so the rebuild is warm.
   */
  async updateWorktree(app: App, previewId: string, spec: RefSpec): Promise<PreparedWorktree> {
    return this.serialize(worktreeKey(app.id, spec), () => this.updateWorktreeLocked(app, spec));
  }

  private async updateWorktreeLocked(app: App, spec: RefSpec): Promise<PreparedWorktree> {
    const { localRef, usedToken } = await this.prepareRef(app, spec);
    const wtPath = paths.worktree(worktreeKey(app.id, spec));
    if (!existsSync(wtPath)) throw new RefError(`the checkout for ${app.id} at ${refDescription(spec)} no longer exists`);
    const reset = await this.git(["reset", "--hard", localRef], { cwd: wtPath });
    if (reset.code !== 0) {
      throw new RefError(`worktree update failed: ${reset.stderr.trim().slice(0, 300)}`);
    }
    touchWorktree(wtPath);
    await this.initSubmodules(app, wtPath);
    return { path: wtPath, ref: localRef, description: refDescription(spec), usedToken };
  }

  /**
   * The repo's default branch (from `origin/HEAD`, set by clone), e.g. "master".
   * Null if it can't be determined. Ensures the base clone first (so it can hit
   * the same credential path as add_app and surface a missing-credential error).
   */
  /**
   * The branch a LOCAL (dev-mode) checkout is currently on, or null when it is
   * detached, not a repo, or unreadable.
   *
   * Read-only, and deliberately so: deckhand borrows a developer's working copy
   * and never writes to it (PLAN §11.4). This exists because "local" is a true
   * but useless thing to show a viewer — it names the SOURCE MODE, not what is
   * on screen. Two panes both reading "local" tell you nothing about which
   * branch each one is.
   */
  async localBranch(dir: string): Promise<string | null> {
    const r = await this.git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir });
    if (r.code !== 0) return null;
    const name = r.stdout.trim();
    // "HEAD" is git's answer for a detached checkout — not a branch name.
    return name && name !== "HEAD" ? name : null;
  }

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

  /**
   * Teardown no longer deletes the checkout: it is keyed by app+ref and shared,
   * so deleting it when ONE preview stops would throw away the warm node_modules
   * / Pods / DerivedData the next start of that same ref depends on — and could
   * pull the directory out from under a second preview still building in it.
   * Directories are reclaimed by `pruneWorktrees` instead, which knows which
   * keys are live.
   */
  async removeWorktree(_app: App, _previewId: string): Promise<void> {
    // intentionally empty — see pruneWorktrees
  }

  /**
   * Delete checkouts that no live preview is using and that are not worth
   * keeping warm: idle past `idleGraceMs` (see WORKTREE_IDLE_GRACE_MS), or —
   * once more than `maxIdle` of them have piled up — the oldest of the rest.
   * `keep` holds the keys of live previews (see worktreeKey). Returns what it
   * removed.
   *
   * Safe to call on a timer as well as at boot — that is the point. Teardown
   * deliberately keeps checkouts (removeWorktree is a no-op), so without a
   * recurring prune a long-lived server never reclaims the disk of a stopped
   * preview; and a boot-only prune both leaks between restarts and, because the
   * live set is empty at boot, deleted every warm checkout it was meant to keep.
   */
  async pruneWorktrees(
    keep: ReadonlySet<string>,
    idleGraceMs = WORKTREE_IDLE_GRACE_MS,
    maxIdle = MAX_IDLE_WORKTREES,
  ): Promise<string[]> {
    let entries: string[];
    try {
      entries = readdirSync(paths.worktreesDir());
    } catch {
      return [];
    }
    const now = Date.now();
    const idle = entries
      .filter((name) => name.startsWith("dh-") && !keep.has(name.slice(3)))
      .map((name) => ({ name, idleMs: worktreeIdleMs(join(paths.worktreesDir(), name), now) }))
      .sort((a, b) => b.idleMs - a.idleMs); // oldest first
    // The grace window alone is not a bound: a week of PR review can leave a
    // dozen checkouts of one RN app (node_modules + Pods + platforms, GBs each)
    // before the first is even eligible. So anything past the LRU budget goes
    // too, oldest first, regardless of how recent it is.
    const doomed = idle.filter((e, i) => e.idleMs >= idleGraceMs || i < idle.length - maxIdle);
    // Never longer than the caller's own grace: a zero grace means "reclaim
    // everything now" and must not be silently overridden by the in-use guard.
    const inUseMs = Math.min(CHECKOUT_IN_USE_MS, idleGraceMs);
    const removed: string[] = [];
    for (const { name } of doomed) {
      const wtPath = join(paths.worktreesDir(), name);
      // Under the same per-key lock as create/update, so a start_preview that
      // began after `keep` was computed can't have the directory pulled out from
      // under it mid-checkout.
      const gone = await this.serialize(name.slice(3), async () => {
        // Re-read inside the lock: a create that queued ahead of us has just
        // touched it, and a freshly touched checkout is by definition in use.
        if (worktreeIdleMs(wtPath, Date.now()) < inUseMs) return false;
        // `git worktree remove` needs the base clone it was registered against;
        // we don't know which app that was, so prune registrations repo-side after
        // deleting the directory (git prune drops registrations for missing dirs).
        // Async: these trees are 100k+ inodes, and this runs on the janitor tick
        // — a synchronous delete would stall every live stream for its duration.
        await rm(wtPath, { recursive: true, force: true });
        return true;
      });
      if (gone) removed.push(name);
    }
    if (removed.length) {
      for (const repo of safeReaddir(paths.reposDir())) {
        const base = join(paths.reposDir(), repo);
        if (existsSync(join(base, ".git"))) await this.git(["worktree", "prune"], { cwd: base });
      }
    }
    return removed;
  }
}
