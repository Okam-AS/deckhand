import { loadConfig, type Config } from "./config.ts";
import { paths } from "./paths.ts";
import { watchFileForChanges } from "./watchFile.ts";

export interface WatchAllowlistOptions {
  file?: string;
  onReload?: (emails: string[]) => void;
  onError?: (err: unknown) => void;
  debounceMs?: number;
  pollMs?: number;
}

/**
 * Keep `config.connector.allowedEmails` in step with config.yaml.
 *
 * Without this, `deckhand allow rm` is a lie. The config object is loaded once at boot and
 * closed over by `createApp`, so removing an address edited a file nobody was reading — the
 * revoked person kept connecting until someone restarted the server. And a restart is the one
 * repair with a real cost here: it tears down every booted simulator on the machine, so
 * "restart to revoke" means "interrupt whoever is mid-test to revoke".
 *
 * That gap was invisible three ways at once: the CLI printed "starting with their next call",
 * PLAN said the allowlist is re-checked per request, and the check in `server.ts` genuinely
 * ran on every request — it just kept re-reading the same stale array.
 *
 * Only the allowlist is adopted. Everything else in config.yaml (ports, limits, the streaming
 * config) is wired into objects built at boot, so pretending to hot-reload it would be worse
 * than not doing it — a half-applied config is harder to reason about than a stale one.
 *
 * An EMPTY list is honoured immediately, same direction as tokens.yaml: a revocation must take
 * effect when it is made. Erring the other way ("that looks like a truncated write, keep the
 * old list") would keep a deliberately-removed address working.
 */
export function watchAllowlist(config: Config, opts: WatchAllowlistOptions = {}): () => void {
  const file = opts.file ?? paths.config();
  let last = config.connector.allowedEmails.join(",");

  const reload = (): void => {
    let next: Config;
    try {
      next = loadConfig(file);
    } catch (err) {
      // A partial write or a typo. Keep the list we have: locking everyone out of a running
      // server because config.yaml was mid-save is a worse failure than a stale allowlist,
      // and the operator gets told.
      opts.onError?.(err);
      return;
    }
    const emails = next.connector.allowedEmails;
    const fingerprint = emails.join(",");
    if (fingerprint === last) return; // our own echo, or an unrelated edit
    last = fingerprint;
    // In place: `createApp` closed over this array through the config object, so replacing
    // the object would leave the running server on the old one.
    config.connector.allowedEmails.splice(0, config.connector.allowedEmails.length, ...emails);
    opts.onReload?.([...emails]);
  };

  return watchFileForChanges(file, {
    onChange: reload,
    onError: opts.onError,
    debounceMs: opts.debounceMs,
    pollMs: opts.pollMs,
  });
}
