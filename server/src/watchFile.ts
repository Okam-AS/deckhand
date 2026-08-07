import { watch, statSync, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";

// ---------------------------------------------------------------------------
// "Notice when this file changes", with the three details that were each learned
// from a bug — extracted here so the next watcher does not learn them again.
//
// It is deliberately dumb: it says WHEN, never what. Deciding whether a reload is
// safe (keep the old list? honour an empty one?) belongs to the caller, because
// the answer differs per file — apps.yaml treats "suddenly empty" as a truncated
// write, tokens.yaml treats it as a revocation to honour at once.
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 150;
const POLL_MS = 2_000;

export interface WatchFileOptions {
  onChange: () => void;
  onError?: (err: unknown) => void;
  debounceMs?: number;
  pollMs?: number;
}

/**
 * Call `onChange` once now, and again (debounced) whenever `file` changes.
 * Returns a stop function.
 *
 * Three things this does that a bare `fs.watch(file)` does not:
 *
 * 1. **Watches the DIRECTORY.** Every writer here renames a temp file over the
 *    target, which swaps the inode out from under a file-level watcher.
 * 2. **Polls as a backstop.** `fs.watch` drops events under load, and a dropped
 *    one is silent — the change is on disk and the server never sees it.
 * 3. **Fires immediately.** Otherwise "watch this file" quietly means "watch
 *    changes made after this line": a file written a millisecond earlier is picked
 *    up only if an event happens to arrive, and the poll cannot help because its
 *    baseline stamp already includes that write. That surfaced as a CI-only test
 *    failure, which is the worst way to learn a component depends on its caller
 *    having done something first.
 */
export function watchFileForChanges(file: string, opts: WatchFileOptions): () => void {
  const name = basename(file);
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
  const pollMs = opts.pollMs ?? POLL_MS;

  let timer: NodeJS.Timeout | null = null;
  let watcher: FSWatcher | null = null;

  const stamp = (): string => {
    try {
      const s = statSync(file);
      return `${s.mtimeMs}:${s.size}:${s.ino}`;
    } catch {
      return "";
    }
  };
  let lastStamp = stamp();

  const fire = (): void => {
    lastStamp = stamp();
    opts.onChange();
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, debounceMs);
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
    watcher.on("error", (err) => opts.onError?.(err));
    watcher.unref?.();
  } catch (err) {
    opts.onError?.(err);
  }

  fire();

  return () => {
    if (timer) clearTimeout(timer);
    clearInterval(poll);
    watcher?.close();
  };
}
