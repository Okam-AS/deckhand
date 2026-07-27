import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";

/**
 * All Deckhand runtime state lives under one home directory. Defaults to
 * `~/.deckhand`; `DECKHAND_HOME` overrides it (tests point it at a temp dir).
 * Nothing else in the codebase should hardcode `~/.deckhand`.
 */
export function deckhandHome(): string {
  const override = process.env.DECKHAND_HOME;
  if (override && override.trim() !== "") return expandTilde(override);
  return join(homedir(), ".deckhand");
}

/** Expand a leading `~` to the user's home directory. Absolute/relative paths pass through. */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Resolve a config-supplied path: expand `~`, then resolve relative paths against the home dir. */
export function resolveUnderHome(p: string): string {
  const expanded = expandTilde(p);
  return isAbsolute(expanded) ? expanded : join(deckhandHome(), expanded);
}

export const paths = {
  home: deckhandHome,
  config: () => join(deckhandHome(), "config.yaml"),
  apps: () => join(deckhandHome(), "apps.yaml"),
  tokens: () => join(deckhandHome(), "tokens.yaml"),
  state: () => join(deckhandHome(), "state.json"),
  audit: () => join(deckhandHome(), "audit.jsonl"),
  /** HMAC key for signing share unlock cookies (auto-generated on first boot if absent). */
  shareSecret: () => join(deckhandHome(), "share-secret"),
  secretsDir: () => join(deckhandHome(), "secrets"),
  secretsEnv: (appId: string) => join(deckhandHome(), "secrets", `${appId}.env`),
  reposDir: () => join(deckhandHome(), "repos"),
  repo: (appId: string) => join(deckhandHome(), "repos", appId),
  worktreesDir: () => join(deckhandHome(), "worktrees"),
  // The worktree dir name becomes the build's project name. NativeScript's
  // Android build rejects a project name that begins with a digit ("Project name
  // must not begin with a number"), and previewIds are random hex that can start
  // with 0-9 — so prefix with a letter. (Xcode doesn't care; Gradle does.)
  worktree: (previewId: string) => join(deckhandHome(), "worktrees", `dh-${previewId}`),
  logsDir: () => join(deckhandHome(), "logs"),
} as const;
