import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// "Am I running the latest deckhand?"
//
// The version IS the commit the running checkout sits on. Nothing is stored and
// nothing has to be bumped: a version number in package.json only tells the
// truth if somebody remembers to change it, and the discipline that fails is
// exactly the one this would depend on. A sha cannot drift from the code,
// because it is the code.
//
// `git describe --tags --always` gives a human-readable form for free
// (`v0.3.0-12-gab81f05`). Tag when you want a round number; nothing requires it.
//
// Deckhand never updates itself. Pulling means restarting, and a restart tears
// down every booted simulator on the machine — so this only ever reports, and
// the agent relays it to the person who gets to decide.
// ---------------------------------------------------------------------------

/** How long a remote answer is trusted. The remote moves on human timescales. */
const TTL_MS = 30 * 60_000;
/** Never let a slow network hold up a tool response or a boot. */
const GIT_TIMEOUT_MS = 10_000;

export interface UpdateStatus {
  /**
   * Short sha of the code THIS PROCESS is running — captured the first time the version is
   * measured, which is at boot, before anyone can pull under it.
   *
   * Not the same as the checkout's HEAD, and conflating them made the notice useless in the
   * one case that matters most. The server runs from source under tsx and loads its modules
   * once; `git pull` then updates the working tree while the process keeps running the old
   * code. Comparing the checkout to origin/main says "up to date" and the process is stale —
   * silently, for as long as nobody restarts it.
   */
  current: string;
  /** Short sha the checkout is on NOW. Differs from `current` after a pull with no restart. */
  checkout: string;
  /** True when the working tree has moved since this process loaded its code. */
  restartNeeded: boolean;
  /** `git describe` of the running checkout — a tag when there is one. */
  describe: string;
  /** Short sha of `origin/main`, or null when it could not be read. */
  latest: string | null;
  /** The branch the checkout is on, or null when detached. */
  branch: string | null;
  /** True only when this checkout is ON main and main has moved. */
  updateAvailable: boolean;
  /** Uncommitted changes in the running checkout — its code is not any commit. */
  dirty: boolean;
  /** One line meant to be relayed to a human verbatim. Absent when there is nothing to say. */
  note?: string;
  checkedAt: string;
}

function git(args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS }, (err, stdout) =>
      resolve(err ? null : stdout.toString().trim()),
    );
  });
}

/** The repo the RUNNING code came from — walked up from this file, not from cwd. */
export function repoRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** The commit this process loaded its code from. Set once, at the first measurement. */
let runningSha: string | null = null;
let cached: UpdateStatus | null = null;
let inFlight: Promise<UpdateStatus | null> | null = null;

/**
 * Read the local state, then ask the remote for main's head.
 *
 * `git ls-remote` rather than the GitHub API: it reuses whatever credential the
 * checkout already clones with, needs no token wiring, no new dependency, and
 * works the same for a private repo. It also touches nothing on disk — deckhand
 * must never fetch into, or otherwise mutate, its own checkout behind the
 * operator's back.
 */
async function measure(): Promise<UpdateStatus | null> {
  const root = repoRoot();
  if (!root) return null;
  const [sha, described, branch, status] = await Promise.all([
    git(["rev-parse", "--short", "HEAD"], root),
    git(["describe", "--tags", "--always"], root),
    git(["rev-parse", "--abbrev-ref", "HEAD"], root),
    // TRACKED modifications only. `git status --porcelain` also lists untracked files, so a
    // stray .DS_Store, an editor scratch file or a node_modules symlink made `dirty` true —
    // and dirty suppresses the update notice, permanently and silently. That is the exact
    // opposite of this module's job: the checkouts most likely to accumulate stray files are
    // the long-lived ones most likely to fall behind. An untracked file does not change which
    // code is running; a tracked edit does, and only that should mute the notice.
    git(["status", "--porcelain", "--untracked-files=no"], root),
  ]);
  if (!sha) return null;

  // The sha this PROCESS is running: whatever HEAD was the first time we looked, which is at
  // boot. Everything after that is the checkout moving, not the code moving.
  runningSha ??= sha;
  const remote = await git(["ls-remote", "origin", "refs/heads/main"], root);
  const latest = remote ? (remote.split(/\s+/)[0] ?? "").slice(0, sha.length) || null : null;
  const onMain = branch === "main";
  const dirty = Boolean(status);
  const restartNeeded = runningSha !== sha;
  // Only nag when this checkout is actually tracking main. A developer sitting on a feature
  // branch is not "out of date", and a tool that says so on every call gets tuned out —
  // which would cost us the one message that matters when it is real.
  const updateAvailable = onMain && !dirty && Boolean(latest) && latest !== sha;

  let note: string | undefined;
  // Restart first: it is the cheaper action, and the code is already on the machine. Telling
  // someone to pull when the pull already happened is how they conclude the notice is noise.
  if (restartNeeded) {
    note =
      `deckhand is RUNNING ${runningSha} but the checkout is on ${sha} — someone pulled and did not ` +
      `restart, so none of the newer code is live. Ask the user: "deckhand has been updated on disk ` +
      `but is still running the old code — restart it?" Restarting tears down every booted preview, ` +
      `so it is their call. The command is \`launchctl kickstart -k gui/$(id -u)/no.deckhand.server\`.`;
  } else if (updateAvailable) {
    note =
      `deckhand is not running the latest code (running ${sha}, origin/main is ${latest}). ` +
      `Ask the user: "there is a newer deckhand — pull and restart?" Both steps are needed, and ` +
      `restarting tears down every booted preview, so it is their call, not yours.`;
  } else if (onMain && dirty) {
    note = `deckhand is running main with uncommitted local changes (${sha} + edits), so its code is not any published commit.`;
  } else if (!onMain && branch) {
    note = `deckhand is running the branch "${branch}" (${sha}), not main.`;
  }

  return {
    current: runningSha,
    checkout: sha,
    restartNeeded,
    describe: described ?? sha,
    latest,
    branch: branch === "HEAD" ? null : branch,
    updateAvailable,
    dirty,
    ...(note ? { note } : {}),
    checkedAt: new Date().toISOString(),
  };
}

/**
 * The last known answer, refreshing in the background when stale.
 *
 * Never awaits the network: a tool response must not wait on `ls-remote`, and the
 * first call after boot legitimately has nothing to say. `refreshVersion()` at boot
 * makes that window small.
 */
export function versionStatus(): UpdateStatus | null {
  const age = cached ? Date.now() - Date.parse(cached.checkedAt) : Infinity;
  if (age > TTL_MS && !inFlight) void refreshVersion();
  return cached;
}

/** Force a refresh. Deduplicated — concurrent callers share one `ls-remote`. */
export function refreshVersion(): Promise<UpdateStatus | null> {
  if (inFlight) return inFlight;
  inFlight = measure()
    .then((s) => {
      if (s) cached = s;
      return s;
    })
    .catch(() => null)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Test seam: drop the cache so a test starts from a known state. */
export function resetVersionCache(): void {
  cached = null;
  inFlight = null;
  runningSha = null;
}
