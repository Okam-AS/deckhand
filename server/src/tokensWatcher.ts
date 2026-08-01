import { watch, statSync, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { loadTokens, type TokenEntry } from "./config.ts";
import { paths } from "./paths.ts";
import type { TokenAuthenticator } from "./auth.ts";

const DEBOUNCE_MS = 150;
const POLL_MS = 2_000;

export interface WatchTokensOptions {
  file?: string;
  onReload?: (names: string[]) => void;
  onError?: (err: unknown) => void;
  debounceMs?: number;
  pollMs?: number;
}

/**
 * Keep the authenticator in step with tokens.yaml.
 *
 * apps.yaml has been watched since the day registering an app cost every running preview a
 * restart. tokens.yaml was not, and that is worse, because it breaks the FIRST thing a new
 * user does:
 *
 *   setup starts the server (LaunchAgent), then mints the admin token. `loadTokens()` had
 *   already run. So the server did not know the only token that exists, every request to
 *   `/mcp/<token>` answered 404, and claude.ai — finding no MCP server — fell back to OAuth
 *   discovery and reported "Couldn't register with Deckhand's sign-in service".
 *
 * A brand-new install therefore looked broken at the one step that cannot be skipped, with an
 * error message pointing at OAuth, which deckhand does not use. Observed on a real machine;
 * the fix at the time was a restart nobody would have guessed at.
 *
 * The authenticator is updated in place, because `createApp` closed over that instance.
 *
 * Unlike apps, an EMPTY token list is honoured immediately. There, dropping every entry is
 * treated as a truncated write; here the safe direction is the opposite — a revoked token
 * must stop working the moment it is revoked, and erring towards "keep the old list" would
 * mean a token someone deliberately removed still opens the door until a restart.
 */
export function watchTokens(auth: TokenAuthenticator, opts: WatchTokensOptions = {}): () => void {
  const file = opts.file ?? paths.tokens();
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
  let lastNames = "";

  const reload = (): void => {
    lastStamp = stamp();
    let next: TokenEntry[];
    try {
      next = loadTokens(file);
    } catch (err) {
      // A partial write or a hand-edited typo: keep authenticating with what we have rather
      // than locking everyone out mid-session.
      opts.onError?.(err);
      return;
    }
    const names = next.map((t) => t.name).join(",");
    if (names === lastNames) return; // our own echo, or an unrelated touch
    lastNames = names;
    auth.replace(next);
    opts.onReload?.(next.map((t) => t.name));
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(reload, debounceMs);
    timer.unref?.();
  };

  // The poll is the backstop fs.watch needs: it drops events under load, and a dropped one
  // here is silent — the token exists on disk and the connector still 404s.
  const poll = setInterval(() => {
    if (stamp() !== lastStamp) schedule();
  }, pollMs);
  poll.unref?.();

  try {
    // The directory, not the file: writeTokens renames a temp file over the target, which
    // swaps the inode out from under a file-level watcher.
    watcher = watch(dirname(file), (_event, changed) => {
      if (changed != null && basename(changed) !== name) return;
      schedule();
    });
    watcher.on("error", (err) => opts.onError?.(err));
    watcher.unref?.();
  } catch (err) {
    opts.onError?.(err);
  }

  return () => {
    if (timer) clearTimeout(timer);
    clearInterval(poll);
    watcher?.close();
  };
}
