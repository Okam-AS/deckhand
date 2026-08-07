import { createHash } from "node:crypto";
import { loadTokens, type TokenEntry } from "./config.ts";
import { paths } from "./paths.ts";
import { watchFileForChanges } from "./watchFile.ts";
import type { TokenAuthenticator } from "./auth.ts";

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
 *   setup starts the server (LaunchAgent), then mints the token. `loadTokens()` had
 *   already run. So the server did not know the only token that exists, every request to the
 *   MCP endpoint was refused, and claude.ai — finding no MCP server — fell back to OAuth
 *   discovery and reported "Couldn't register with Deckhand's sign-in service".
 *
 * A brand-new install therefore looked broken at the one step that cannot be skipped. Observed
 * on a real machine; the fix at the time was a restart nobody would have guessed at. (The OAuth
 * error message was misleading THEN. Since 2026-08-07 deckhand does serve OAuth, so a failure
 * here and a real sign-in failure look alike — `deckhand doctor`'s `connector auth` check is
 * what tells them apart.)
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
  let lastFingerprint = "";

  const reload = (): void => {
    let next: TokenEntry[];
    try {
      next = loadTokens(file);
    } catch (err) {
      // A partial write or a hand-edited typo: keep authenticating with what we have rather
      // than locking everyone out mid-session.
      opts.onError?.(err);
      return;
    }
    // Fingerprint the CONTENT, not the names. Comparing names made rotation a no-op: `token add`
    // refuses a duplicate name, so replacing a leaked credential means writing a new value under
    // the same name — the one case this early-return swallowed. The file changed, the operator
    // believed the old URL was dead, and it kept working until the next restart.
    // Hashed so a token value never sits in a long-lived string in this process. JSON, not a
    // hand-rolled separator: a name may hold any character, so two different lists could
    // concatenate to identical bytes and make a real change look like an echo.
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(next.map((t) => [t.name, t.token])))
      .digest("hex");
    if (fingerprint === lastFingerprint) return; // our own echo, or an unrelated touch
    lastFingerprint = fingerprint;
    auth.replace(next);
    opts.onReload?.(next.map((t) => t.name));
  };

  return watchFileForChanges(file, {
    onChange: reload,
    onError: opts.onError,
    debounceMs: opts.debounceMs,
    pollMs: opts.pollMs,
  });
}
