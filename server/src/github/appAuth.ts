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

  private async api<T>(path: string, method: "GET" | "POST", jwt: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "deckhand",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

  /**
   * A short-lived installation token for a repo, cached until near expiry.
   *
   * Scoped to the single repo when `repoName` is given: an unscoped token
   * covers every repo in the installation, so one leak (a hostile
   * `.gitmodules`, a build script reading the askpass answer) exposed the whole
   * org rather than the repo actually being previewed. Cached per owner/repo
   * accordingly.
   *
   * `extraRepos` widens the scope to named sibling repos in the same org — used
   * for a repo's own private submodules, which the previewed repo declares and
   * which the scoped token would otherwise fail to fetch.
   */
  async installationToken(owner: string, repoName?: string, extraRepos: string[] = []): Promise<string> {
    const repos = repoName ? [repoName, ...extraRepos.filter((r) => r.toLowerCase() !== repoName.toLowerCase())] : [];
    const key = repos.length ? `${owner.toLowerCase()}/${repos.map((r) => r.toLowerCase()).join(",")}` : owner.toLowerCase();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAtMs - this.now() > REFRESH_MARGIN_MS) return cached.token;

    const id = await this.installationIdForOwner(owner);
    const resp = await this.api<AccessTokenResponse>(
      `/app/installations/${id}/access_tokens`,
      "POST",
      this.jwt(),
      repos.length ? { repositories: repos } : undefined,
    );
    this.cache.set(key, { token: resp.token, expiresAtMs: Date.parse(resp.expires_at) });
    return resp.token;
  }

  /** A resolver `(owner, repoName, extraRepos) => Promise<token>` for the worktree layer. */
  tokenResolver(): (owner: string, repoName?: string, extraRepos?: string[]) => Promise<string> {
    return (owner: string, repoName?: string, extraRepos?: string[]) =>
      this.installationToken(owner, repoName, extraRepos);
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

/** Hostnames deckhand will pin a credential to (letters/digits/dot/dash, no shell metacharacters). */
const ASKPASS_HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/**
 * Create an ephemeral GIT_ASKPASS script that answers git's credential prompts
 * with username `x-access-token` and the given token as password. The token
 * lives only in a mode-0700 file in a private temp dir — never in argv, the
 * remote URL, or `.git/config`. `GIT_TERMINAL_PROMPT=0` makes git fail fast
 * instead of hanging if the token is rejected.
 *
 * The answer is **pinned to `host`**. git names the host it is authenticating
 * to in the prompt itself ("Username for 'https://github.com': "), and the old
 * branch-on-prompt-text-only script answered *any* host — so a previewed repo
 * with a `.gitmodules` pointing at an attacker's server, fetched by
 * `submodule update --init --recursive` under this same env, received
 * deckhand's GitHub credential as a Basic password. Anything but the app's own
 * repo host now gets an empty answer and a non-zero exit, which git surfaces as
 * a normal auth failure.
 */
export function createAskpass(token: string, host: string): AskpassHandle {
  if (!ASKPASS_HOST_RE.test(host)) {
    throw new GitHubAuthError(
      `refusing to pin a git credential to invalid host ${JSON.stringify(host)}`,
      "check the app's `repo` value in apps.yaml",
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "deckhand-askpass-"));
  const script = join(dir, "askpass.sh");
  // The prompt text arrives as $1; "Username" prompts get the sentinel user,
  // everything else (the password prompt) gets the token — but only once the
  // prompt has been confirmed to name the pinned host.
  //
  // The host is EXTRACTED and compared for equality, never substring-matched.
  // git quotes the URL in its prompt ("Username for 'https://github.com': "),
  // optionally with `user@` userinfo, a `:port`, and — when
  // `credential.useHttpPath` is set (a per-host org setting inherited from the
  // user's gitconfig) — the url-decoded repo path. A path is attacker-chosen
  // data: `https://attacker.example/x/%2F%2Fgithub.com%2Fy.git` in a hostile
  // `.gitmodules` renders a prompt that any delimiter-substring test ("//host/",
  // "@host/") accepts, handing the credential to the attacker's server. Parsing
  // instead: turn `'` into `/` (so the closing quote just terminates a segment),
  // drop the scheme, keep the FIRST path segment, then strip userinfo and port.
  // Everything after the first `/` — i.e. the whole attacker-controlled path —
  // is discarded before the comparison.
  const h = host.toLowerCase();
  // Compare case-insensitively: a base clone made from `repo: GitHub.com/o/n` keeps
  // that remote URL forever (ensureBaseClone early-returns), and its prompt would
  // never match a lowercase pin — every later fetch would fail as an auth error.
  const contents =
    `#!/bin/sh\n` +
    `u=$(printf '%s' "$1" | tr "'" '/' | tr 'A-Z' 'a-z')\n` +
    `case "$u" in *://*) ;; *) exit 1 ;; esac\n` +
    `u=\${u#*://}\n` +
    `u=\${u%%/*}\n` +
    `u=\${u##*@}\n` +
    `u=\${u%%:*}\n` +
    `[ "$u" = '${h}' ] || exit 1\n` +
    `case "$1" in\n  Username*) printf '%s' 'x-access-token' ;;\n  *) printf '%s' '${token.replace(/'/g, "'\\''")}' ;;\nesac\n`;
  writeFileSync(script, contents, { mode: 0o700 });
  chmodSync(script, 0o700);
  return {
    // Defence in depth behind the host pin: keep the repo path out of git's
    // credential prompts entirely, so attacker-chosen text never reaches the
    // script's input in the first place. Env-based config (not `-c`) so it
    // applies to submodule child processes too.
    env: {
      GIT_ASKPASS: script,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.useHttpPath",
      GIT_CONFIG_VALUE_0: "false",
      // Reset the helper list (an empty value is git's documented "forget
      // everything configured so far"). Git asks credential HELPERS before it
      // ever falls back to GIT_ASKPASS, so the host pin above is only worth
      // anything if no inherited helper answers first: with the operator's
      // usual `credential.helper = osxkeychain` in ~/.gitconfig, a hostile
      // `.gitmodules` naming another host would be served a stored credential
      // for it — under `submodule update --init --recursive`, which runs with
      // exactly this env — without the pinned script ever running.
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "",
    },
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}
