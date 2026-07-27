import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { createPrivateKey } from "node:crypto";
import { githubPatPath, githubPrivateKeyPath, type Config } from "../config.ts";
import { GitHubAppAuth } from "./appAuth.ts";

// ---------------------------------------------------------------------------
// Credential resolution for git network operations (PLAN §2/§6). The ladder:
// fine-grained PAT file → GitHub App installation token → (if `githubAmbient`)
// the deckhand user's `gh` CLI session → typed error, which add_app turns into
// the last-resort onboarding step (local checkout hint + one-time setup URL).
// Explicit credentials always win: ambient is only consulted when neither a
// PAT nor an App is configured, so an App's installation set stays the repo
// allowlist. The resolver is re-evaluated per call so a PAT pasted through the
// setup URL takes effect immediately — no server restart. Ambient tokens are
// treated exactly like installation tokens: in memory only, handed to git via
// GIT_ASKPASS, never in argv/URLs/logs.
// ---------------------------------------------------------------------------

/** Thrown when no GitHub credential is configured (distinct from a rejected one). */
export class CredentialsMissingError extends Error {
  constructor(
    public readonly owner: string,
    message: string,
  ) {
    super(message);
    this.name = "CredentialsMissingError";
  }
}

function readPat(config: Config): string | null {
  try {
    const pat = readFileSync(githubPatPath(config), "utf8").trim();
    return pat.length > 0 ? pat : null;
  } catch {
    return null;
  }
}

/** The deckhand user's `gh` CLI session token, or null (gh absent/logged out). */
export function ghCliToken(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("gh", ["auth", "token"], { timeout: 5_000 }, (err, stdout) => {
      const token = err ? "" : String(stdout).trim();
      resolve(token.length > 0 ? token : null);
    });
  });
}

export interface TokenResolverDeps {
  /** Ambient-credential lookup; injectable for tests. Defaults to `gh auth token`. */
  ghToken?: () => Promise<string | null>;
}

/**
 * Build a `(owner) => Promise<token>` resolver for the worktree layer. Prefers
 * a PAT (checked fresh each call), else a GitHub App installation token, else
 * the ambient gh CLI session (unless `githubAmbient: false`), else throws
 * CredentialsMissingError. The App auth object is cached across owners.
 */
export function buildTokenResolver(config: Config, deps: TokenResolverDeps = {}): (owner: string) => Promise<string> {
  let appAuth: GitHubAppAuth | null | undefined; // undefined = not yet attempted

  const getAppAuth = (): GitHubAppAuth | null => {
    if (appAuth !== undefined) return appAuth;
    const pemPath = githubPrivateKeyPath(config);
    if (!pemPath || !config.githubApp) return (appAuth = null);
    try {
      const pem = readFileSync(pemPath, "utf8");
      return (appAuth = new GitHubAppAuth({ appId: config.githubApp.appId, privateKey: createPrivateKey(pem) }));
    } catch {
      return (appAuth = null);
    }
  };

  const ambient = deps.ghToken ?? ghCliToken;

  return async (owner: string): Promise<string> => {
    const pat = readPat(config);
    if (pat) return pat;
    const auth = getAppAuth();
    if (auth) return auth.installationToken(owner);
    if (config.githubAmbient) {
      const gh = await ambient();
      if (gh) return gh;
    }
    throw new CredentialsMissingError(
      owner,
      `no GitHub credential configured to read ${owner}'s repos — no PAT, no GitHub App` +
        (config.githubAmbient ? ", and no gh CLI session on the deckhand machine" : "") +
        ` — paste a fine-grained PAT via the setup URL, or run \`deckhand init\` with a GitHub App`,
    );
  };
}

/** Whether a git/credential error looks like an auth problem (missing or rejected token). */
export function isAuthProblem(e: unknown): boolean {
  if (e instanceof CredentialsMissingError) return true;
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    /authentication failed|could not read username|terminal prompts disabled|invalid username or password|403|401|no github app installation|could not read password|permission denied|access denied/.test(
      msg,
    )
  );
}
