import { createSign, type KeyLike } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// GitHub App auth: App JWT → installation access token. Deckhand's only GitHub
// credential is the App private key; installation tokens are short-lived
// (≈1 h) and minted per repo owner, then injected into git via an ephemeral
// GIT_ASKPASS script so they never touch argv, URLs, or .git/config.
// ---------------------------------------------------------------------------

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export interface AppJwtParams {
  appId: number;
  privateKey: KeyLike;
  /** Unix seconds; injectable for tests. */
  now?: number;
}

/**
 * Build a signed GitHub App JWT (RS256). Claims: `iat` backdated 60 s to
 * tolerate clock skew, `exp` 9 minutes out (under GitHub's 10-minute cap),
 * `iss` = app id.
 */
export function buildAppJwt({ appId, privateKey, now }: AppJwtParams): string {
  const iat = (now ?? Math.floor(Date.now() / 1000)) - 60;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat, exp: iat + 60 + 9 * 60, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = signer.sign(privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

type FetchLike = typeof fetch;

interface Installation {
  id: number;
  account: { login: string } | null;
}

interface AccessTokenResponse {
  token: string;
  expires_at: string;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

export interface GitHubAppAuthOptions {
  appId: number;
  privateKey: KeyLike;
  apiBase?: string;
  fetchImpl?: FetchLike;
  now?: () => number; // ms
}

/** Thrown when GitHub declines an app/installation request, with a hint. */
export class GitHubAuthError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "GitHubAuthError";
  }
}

/** Mint at least this long before expiry to avoid handing out a nearly-dead token. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export class GitHubAppAuth {
  private readonly appId: number;
  private readonly privateKey: KeyLike;
  private readonly apiBase: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly cache = new Map<string, CachedToken>(); // key: owner (lowercased)
  private installations: Installation[] | null = null;

  constructor(opts: GitHubAppAuthOptions) {
    this.appId = opts.appId;
    this.privateKey = opts.privateKey;
    this.apiBase = (opts.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
  }

  private jwt(): string {
    return buildAppJwt({ appId: this.appId, privateKey: this.privateKey, now: Math.floor(this.now() / 1000) });
  }

  private async api<T>(path: string, method: "GET" | "POST", jwt: string): Promise<T> {
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "deckhand",
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 404) {
        throw new GitHubAuthError(
          `GitHub ${method} ${path} → ${res.status}`,
          "check the App ID and private key, and that the App is installed on the org",
        );
      }
      throw new GitHubAuthError(`GitHub ${method} ${path} → ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  /** Refresh (and cache) the list of installations this App has. */
  async listInstallations(force = false): Promise<Installation[]> {
    if (this.installations && !force) return this.installations;
    const installs = await this.api<Installation[]>("/app/installations?per_page=100", "GET", this.jwt());
    this.installations = installs;
    return installs;
  }

  private async installationIdForOwner(owner: string): Promise<number> {
    const wanted = owner.toLowerCase();
    const find = (list: Installation[]) =>
      list.find((i) => i.account?.login.toLowerCase() === wanted);
    let hit = find(await this.listInstallations());
    if (!hit) hit = find(await this.listInstallations(true)); // maybe just-installed
    if (!hit) {
      throw new GitHubAuthError(
        `no GitHub App installation for owner "${owner}"`,
        `install the deckhand GitHub App on the "${owner}" org and grant it the repo`,
      );
    }
    return hit.id;
  }

  /** A short-lived installation token for the given repo owner, cached until near expiry. */
  async installationToken(owner: string): Promise<string> {
    const key = owner.toLowerCase();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAtMs - this.now() > REFRESH_MARGIN_MS) return cached.token;

    const id = await this.installationIdForOwner(owner);
    const resp = await this.api<AccessTokenResponse>(
      `/app/installations/${id}/access_tokens`,
      "POST",
      this.jwt(),
    );
    this.cache.set(key, { token: resp.token, expiresAtMs: Date.parse(resp.expires_at) });
    return resp.token;
  }

  /** A resolver `(owner) => Promise<token>` for the worktree layer. */
  tokenResolver(): (owner: string) => Promise<string> {
    return (owner: string) => this.installationToken(owner);
  }
}

// ---------------------------------------------------------------------------
// Ephemeral GIT_ASKPASS injection
// ---------------------------------------------------------------------------

export interface AskpassHandle {
  /** Env to merge into the git child process. */
  env: Record<string, string>;
  /** Remove the temp script. Always call in a finally. */
  cleanup: () => void;
}

/**
 * Create an ephemeral GIT_ASKPASS script that answers git's credential prompts
 * with username `x-access-token` and the given token as password. The token
 * lives only in a mode-0700 file in a private temp dir — never in argv, the
 * remote URL, or `.git/config`. `GIT_TERMINAL_PROMPT=0` makes git fail fast
 * instead of hanging if the token is rejected.
 */
export function createAskpass(token: string): AskpassHandle {
  const dir = mkdtempSync(join(tmpdir(), "deckhand-askpass-"));
  const script = join(dir, "askpass.sh");
  // The prompt text arrives as $1; "Username" prompts get the sentinel user,
  // everything else (the password prompt) gets the token.
  const contents = `#!/bin/sh\ncase "$1" in\n  Username*) printf '%s' 'x-access-token' ;;\n  *) printf '%s' '${token.replace(/'/g, "'\\''")}' ;;\nesac\n`;
  writeFileSync(script, contents, { mode: 0o700 });
  chmodSync(script, 0o700);
  return {
    env: { GIT_ASKPASS: script, GIT_TERMINAL_PROMPT: "0" },
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}
