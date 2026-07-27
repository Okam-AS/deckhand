import { watch, statSync, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { loadApps, type App } from "./config.ts";
import { paths } from "./paths.ts";

/** Coalesce the burst of events an atomic write produces into one reload. */
const DEBOUNCE_MS = 150;
/** Backstop for a dropped fs.watch event (see below). */
const POLL_MS = 2_000;

export interface WatchAppsOptions {
  file?: string;
  /** Called after a successful reload, with the app ids that changed. */
  onReload?: (apps: App[], changed: { added: string[]; removed: string[] }) => void;
  /** Called when the file is unreadable or invalid; the previous list is kept. */
  onError?: (err: unknown) => void;
  debounceMs?: number;
  pollMs?: number;
}

/**
 * Keep the shared `apps` array in step with apps.yaml.
 *
 * Registering an app used to mean restarting the server, because the list was
 * read exactly once at boot — and a restart tears down every booted simulator,
 * so adding an app cost every running preview on the machine.
 *
 * The array is mutated in place rather than replaced: `createApp` and the MCP
 * add_app/remove_app tools all hold this same reference. A running preview
 * keeps its own `App` snapshot, so a removed app's preview finishes unharmed.
 *
 * Watches the *directory*, not the file: writeApps() writes a temp file and
 * renames it over the target, which swaps the inode and would leave a
 * file-level watcher listening to something nobody writes to again.
 *
 * A cheap mtime poll backs the watcher up. fs.watch drops events under load,
 * and a dropped event here is silent: the app looks registered on disk but
 * start_preview keeps answering "no such app", with nothing to tell the user
 * that a restart is what they need. The poll bounds that to `pollMs`.
 */
export function watchApps(apps: App[], opts: WatchAppsOptions = {}): () => void {
  const file = opts.file ?? paths.apps();
  const name = basename(file);
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
  const pollMs = opts.pollMs ?? POLL_MS;

  let timer: NodeJS.Timeout | null = null;
  let watcher: FSWatcher;
  const stamp = (): string => {
    try {
      const s = statSync(file);
      return `${s.mtimeMs}:${s.size}:${s.ino}`;
    } catch {
      return "";
    }
  };
  let lastStamp = stamp();

  const reload = (): void => {
    lastStamp = stamp();
    let next: App[];
    try {
      next = loadApps(file);
    } catch (err) {
      // A partial write or a hand-edited typo: keep serving what we have.
      opts.onError?.(err);
      return;
    }
    const before = new Set(apps.map((a) => a.id));
    const after = new Set(next.map((a) => a.id));
    const added = [...after].filter((id) => !before.has(id));
    const removed = [...before].filter((id) => !after.has(id));
    const same = added.length === 0 && removed.length === 0 && JSON.stringify(apps) === JSON.stringify(next);
    // add_app writes the file it just mutated in memory; don't announce our own echo.
    if (same) return;
    apps.splice(0, apps.length, ...next);
    opts.onReload?.(apps, { added, removed });
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(reload, debounceMs);
    timer.unref?.();
  };

  const poll = setInterval(() => {
    if (stamp() !== lastStamp) schedule();
  }, pollMs);
  poll.unref?.();

  try {
    watcher = watch(dirname(file), (_event, changed) => {
      if (changed != null && basename(changed) !== name) return;
      schedule();
    });
  } catch (err) {
    // No watch support (or the dir vanished): the poll alone still picks
    // changes up, just a couple of seconds later. Not worth failing startup.
    opts.onError?.(err);
    return () => {
      if (timer) clearTimeout(timer);
      clearInterval(poll);
    };
  }
  watcher.on("error", (err) => opts.onError?.(err));
  watcher.unref?.();

  return () => {
    if (timer) clearTimeout(timer);
    clearInterval(poll);
    watcher.close();
  };
}
