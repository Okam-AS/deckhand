import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { paths } from "../paths.ts";

// ---------------------------------------------------------------------------
// Xcode DerivedData reclamation.
//
// Xcode keys DerivedData on the project's PATH, so every checkout deckhand
// builds gets its own multi-GB tree (~3.6 GB for a mid-size Expo app), and
// nothing ever deletes them: they live under the user's Library, not under
// ~/.deckhand. Six abandoned builds of one app were holding 22 GB on the dev
// Mac before this existed.
//
// Each tree records the project it belongs to in `info.plist` → WorkspacePath.
// When that path is gone, the tree can never be reused by anything and is safe
// to delete. Trees for projects that still exist (including the developer's own
// work, which shares this directory) are never touched.
// ---------------------------------------------------------------------------

export function derivedDataDir(): string {
  return join(homedir(), "Library", "Developer", "Xcode", "DerivedData");
}

/** Read a DerivedData info.plist → its WorkspacePath. */
export type WorkspacePathReader = (infoPlist: string) => Promise<string | null>;

/**
 * `plutil -convert xml1`, not `json`: Xcode's info.plist carries a `<date>`
 * (LastAccessedDate), which has no JSON representation — plutil refuses the
 * whole file with "Invalid object in plist for JSON format", every tree reads
 * as unknown, and nothing is ever reclaimed.
 */
const WORKSPACE_PATH_RE = /<key>WorkspacePath<\/key>\s*<string>([^<]*)<\/string>/;

const defaultReader: WorkspacePathReader = (infoPlist) =>
  new Promise((resolve) => {
    execFile("plutil", ["-convert", "xml1", "-o", "-", infoPlist], { timeout: 10_000 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = WORKSPACE_PATH_RE.exec(stdout.toString());
      // XML entities are legal in plist strings; paths rarely contain them, but
      // decoding costs nothing and a wrong path here means a wrong deletion.
      const path = m?.[1]
        ?.replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&");
      resolve(path && path.length > 0 ? path : null);
    });
  });

export interface PruneDerivedDataOptions {
  dir?: string;
  readWorkspacePath?: WorkspacePathReader;
  exists?: (path: string) => boolean;
  remove?: (path: string) => void | Promise<void>;
  /**
   * Only reclaim trees whose project lived under one of these directories.
   * DerivedData is SHARED with everything the user builds in Xcode, and "the
   * project path is gone" is true for every repo they ever deleted or moved —
   * deckhand has no business deleting those. Defaults to deckhand's worktrees.
   */
  ownedRoots?: string[];
  /**
   * Checkouts that are live right now — never reclaimed, even if their workspace
   * momentarily reads as missing. `ns prepare ios` / `expo prebuild` regenerate
   * `platforms/ios/<app>.xcworkspace` (and `ios/`) IN PLACE, so there is a window
   * during an active build where the WorkspacePath does not exist while the tree
   * is still under an owned root. The janitor runs every 60s; without this it can
   * delete the multi-GB DerivedData of the very project being built.
   */
  livePaths?: string[];
}

/**
 * Delete DerivedData trees whose project no longer exists AND lived under a
 * directory deckhand owns. Returns the names removed. Anything without a
 * readable WorkspacePath is LEFT ALONE — an unreadable plist is not evidence of
 * an orphan, and this deletes gigabytes.
 */
export async function pruneDerivedData(opts: PruneDerivedDataOptions = {}): Promise<string[]> {
  const dir = opts.dir ?? derivedDataDir();
  const readWorkspacePath = opts.readWorkspacePath ?? defaultReader;
  const exists = opts.exists ?? existsSync;
  // Async delete: these trees are multi-GB / hundreds of thousands of inodes,
  // and this runs on the janitor tick as well as at boot — a synchronous unlink
  // would stall every live stream and MCP call on the server for its duration.
  const remove = opts.remove ?? ((p: string) => rm(p, { recursive: true, force: true }));
  const owned = (opts.ownedRoots ?? [paths.worktreesDir()]).map((r) => (r.endsWith(sep) ? r : r + sep));
  const live = (opts.livePaths ?? []).filter(Boolean).map((p) => (p.endsWith(sep) ? p : p + sep));

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of entries) {
    // Shared caches, not per-project trees.
    if (name.startsWith(".") || name.endsWith(".noindex")) continue;
    const plist = join(dir, name, "info.plist");
    if (!exists(plist)) continue;
    const workspace = await readWorkspacePath(plist);
    if (!workspace || exists(workspace)) continue;
    // A live checkout's workspace can be absent mid-`prepare`/`prebuild`; that
    // is a build in flight, not an orphan.
    if (live.some((dir) => (workspace + sep).startsWith(dir))) continue;
    // Gone — but only ours to delete.
    if (!owned.some((root) => workspace.startsWith(root))) continue;
    await remove(join(dir, name));
    removed.push(name);
  }
  return removed;
}
