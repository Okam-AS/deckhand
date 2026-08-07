import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "../paths.ts";

// ---------------------------------------------------------------------------
// The credential store behind the connector (PLAN §11).
//
// Deckhand's connector URL is pasted into a Claude organisation, where everyone
// can see it. That is the whole reason this file exists: the URL can no longer BE
// the credential. What authenticates is a per-CLIENT grant, issued only after the
// operator approved that client at the machine (`pairing.ts`).
//
// Nothing here stores a token in the clear. Disk holds sha256 hashes, the same
// shape `auth.ts` compares — so a leaked oauth.json cannot be replayed, and a
// grant is looked up in constant time.
// ---------------------------------------------------------------------------

/** How long an issued access token is good for. A refresh mints from the stored grant, so a
 *  revoked client stops at its next refresh at the latest — and immediately on `revokeClient`. */
const ACCESS_TTL_MS = 12 * 60 * 60 * 1000;
/** Authorization codes are handed over in a redirect and redeemed immediately. */
const CODE_TTL_MS = 60 * 1000;
/**
 * Ceiling on registered clients. `/oauth/register` is unauthenticated by design (RFC 7591), so
 * without a cap anyone who can reach the tunnel can grow oauth.json without limit — a disk-fill
 * on a machine that needs its free space for simulators and builds. Far above any real number
 * of clients one operator has.
 */
const MAX_CLIENTS = 64;

/**
 * Every registered client is in use, so there is no room and nobody may be displaced. The
 * caller answers 503: it is a capacity condition that clears on its own, not a bad request.
 */
export class RegistryFullError extends Error {
  constructor() {
    super("the client registry is full and every client is mid-flow or holds a grant");
  }
}
/**
 * Ceiling on pending authorization codes, for the same reason: each authorize that reaches the
 * end mints one, and they only leave on redemption or TTL.
 */
const MAX_PENDING_CODES = 256;

export interface OAuthClient {
  clientId: string;
  redirectUris: string[];
  name: string;
  createdMs: number;
}

export interface Grant {
  /** sha256 of the access token, hex. */
  accessHash: string;
  /** sha256 of the refresh token, hex. */
  refreshHash: string;
  /** What the operator approved: the client's own name, e.g. "Claude". Not a person —
   *  deckhand never learns one, and does not need to (see `pairing.ts`). */
  label: string;
  clientId: string;
  createdMs: number;
  accessExpiresMs: number;
}

interface Persisted {
  clients: OAuthClient[];
  grants: Grant[];
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  label: string;
  codeChallenge: string;
  createdMs: number;
}

/** What a bearer token names: an approved client, not a person. */
export interface GrantIdentity {
  label: string;
  clientId: string;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
}

const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const randomToken = (): string => randomBytes(32).toString("hex");

/** Constant-time compare of two hex digests of equal length. */
function hashEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function atomicWrite600(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, file);
}

export interface OAuthStoreOptions {
  file?: string;
  now?: () => number;
  /** Injected for tests; production uses crypto.randomBytes. */
  genToken?: () => string;
  /** Set false in tests that must not touch disk. */
  persist?: boolean;
}

export class OAuthStore {
  private clients = new Map<string, OAuthClient>();
  private grants: Grant[] = [];
  private codes = new Map<string, PendingCode>();
  private readonly file: string;
  private readonly now: () => number;
  private readonly genToken: () => string;
  private readonly persistEnabled: boolean;

  constructor(opts: OAuthStoreOptions = {}) {
    this.file = opts.file ?? paths.oauth();
    this.now = opts.now ?? (() => Date.now());
    this.genToken = opts.genToken ?? randomToken;
    this.persistEnabled = opts.persist ?? true;
    this.load();
  }

  private load(): void {
    if (!this.persistEnabled) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Persisted>;
      for (const c of raw.clients ?? []) if (c && typeof c.clientId === "string") this.clients.set(c.clientId, c);
      this.grants = (raw.grants ?? []).filter((g) => g && typeof g.accessHash === "string");
    } catch {
      // No file yet, or an unreadable one. Starting empty costs a re-authorization
      // and nothing else — and refusing to boot would strand the operator with no
      // way in, since the only repair path runs through this same server.
    }
  }

  private save(): void {
    if (!this.persistEnabled) return;
    const data: Persisted = { clients: [...this.clients.values()], grants: this.grants };
    try {
      atomicWrite600(this.file, JSON.stringify(data, null, 2) + "\n");
    } catch {
      // Keep serving from memory; the next write may succeed. A grant that does
      // not survive a restart is a re-login, not a lockout.
    }
  }

  // -- Dynamic client registration (RFC 7591) --------------------------------

  /**
   * Register a public client.
   *
   * `/oauth/register` is UNAUTHENTICATED, as RFC 7591 dynamic registration is — a client has
   * no credential yet, which is the point. Registering buys nothing on its own: a client_id
   * still cannot obtain a grant until a pairing code the operator minted is spent on it.
   *
   * What it does buy is a row on disk, and an unbounded number of them is a disk-fill on a
   * machine whose whole job needs free space for simulators and builds. So the set is capped
   * and the oldest client holding no grant is evicted. Evicting a client with a live grant, or
   * one mid-flow, would break that person's pairing — so those are kept, and when NONE is
   * evictable the registration is REFUSED.
   *
   * Refused, not overshot. "Exceed the cap rather than kick someone" reads gentler and is not a
   * bound at all: `busy` is filled by an unauthenticated GET of the authorize page, so two
   * anonymous requests per client made the ceiling advisory — 2000 clients and a 440 kB
   * oauth.json in 1.4 seconds, measured against the real router, each register rewriting the
   * whole file. Refusing costs a stranger nothing they cannot already do by holding the in-flight
   * slots, and that jam lapses on the in-flight TTL; the disk did not lapse.
   */
  registerClient(input: { redirectUris: string[]; name?: string }, busy: ReadonlySet<string> = new Set()): OAuthClient {
    const client: OAuthClient = {
      clientId: this.genToken(),
      redirectUris: [...input.redirectUris],
      name: input.name ?? "unnamed client",
      createdMs: this.now(),
    };
    this.clients.set(client.clientId, client);
    this.evictIdleClients(busy, client.clientId);
    if (this.clients.size > MAX_CLIENTS) {
      this.clients.delete(client.clientId);
      throw new RegistryFullError();
    }
    this.save();
    return client;
  }

  /**
   * `busy` names clients that must survive eviction beyond those holding a grant.
   *
   * "Holds no grant" looked like "idle" and is not: a client is grant-less from the moment it
   * registers until its token exchange completes, which spans the whole human step — reading a
   * code off one screen and typing it into another. Registration is unauthenticated, so a
   * stranger can register past the cap and evict the client mid-flow: the pairing code is spent,
   * the authorization code is issued, and `/token` then answers `invalid_client`. Reproduced
   * end to end before this argument existed, and repeatable indefinitely, so pairing never
   * completes.
   */
  private evictIdleClients(busy: ReadonlySet<string> = new Set(), keep?: string): void {
    if (this.clients.size <= MAX_CLIENTS) return;
    // `keep` is the client this registration just created. Without it, a registry where every
    // other client is in use makes the newcomer the only evictable one — so `/register` answers
    // 201 with a client_id it has already deleted, and the caller's next request is
    // "unknown client" with nothing having gone visibly wrong.
    const inUse = new Set([...this.grants.map((g) => g.clientId), ...busy, ...(keep ? [keep] : [])]);
    const evictable = [...this.clients.values()].filter((c) => !inUse.has(c.clientId)).sort((a, b) => a.createdMs - b.createdMs);
    for (const c of evictable) {
      if (this.clients.size <= MAX_CLIENTS) return;
      this.clients.delete(c.clientId);
    }
  }

  getClient(clientId: string): OAuthClient | null {
    return this.clients.get(clientId) ?? null;
  }

  // -- Authorization codes ---------------------------------------------------

  /**
   * Mint a single-use code for a request the operator has already approved.
   *
   * `codeChallenge` is PKCE S256 and mandatory: the redirect that carries the
   * code lands in a browser, and without a verifier anything that observes it can
   * redeem it.
   */
  mintCode(input: { clientId: string; redirectUri: string; label: string; codeChallenge: string }): string {
    this.pruneCodes();
    const code = this.genToken();
    this.codes.set(code, { ...input, createdMs: this.now() });
    return code;
  }

  /** Redeem a code once. Returns null when it is unknown, expired, already used, or the client/redirect/verifier does not match. */
  redeemCode(code: string, check: { clientId: string; redirectUri: string; codeVerifier: string }): { label: string } | null {
    const pending = this.codes.get(code);
    if (!pending) return null;
    // Delete FIRST: a code is single-use even when the redemption then fails, so
    // a wrong verifier cannot be retried against the same code.
    this.codes.delete(code);
    if (this.now() - pending.createdMs > CODE_TTL_MS) return null;
    if (pending.clientId !== check.clientId) return null;
    if (pending.redirectUri !== check.redirectUri) return null;
    const derived = createHash("sha256").update(check.codeVerifier, "utf8").digest("base64url");
    if (derived.length !== pending.codeChallenge.length) return null;
    if (!timingSafeEqual(Buffer.from(derived, "utf8"), Buffer.from(pending.codeChallenge, "utf8"))) return null;
    return { label: pending.label };
  }

  private pruneCodes(): void {
    for (const [code, pending] of this.codes) {
      if (this.now() - pending.createdMs > CODE_TTL_MS) this.codes.delete(code);
    }
    // Insertion-ordered, so the first keys are the oldest. Dropping the oldest costs
    // whoever holds it one retry; letting the map grow costs memory with no bound.
    while (this.codes.size >= MAX_PENDING_CODES) {
      const oldest = this.codes.keys().next();
      if (oldest.done) return;
      this.codes.delete(oldest.value);
    }
  }

  // -- Grants ----------------------------------------------------------------

  issueGrant(input: { label: string; clientId: string }): IssuedTokens {
    const accessToken = this.genToken();
    const refreshToken = this.genToken();
    this.grants.push({
      accessHash: sha256Hex(accessToken),
      refreshHash: sha256Hex(refreshToken),
      label: input.label,
      clientId: input.clientId,
      createdMs: this.now(),
      accessExpiresMs: this.now() + ACCESS_TTL_MS,
    });
    this.save();
    return { accessToken, refreshToken, expiresInSec: Math.floor(ACCESS_TTL_MS / 1000) };
  }

  /**
   * The identity a bearer access token names, or null.
   *
   * Compares against EVERY grant with no early return, so response timing does
   * not reveal which grant (if any) matched — the same reason `auth.ts` does.
   */
  authenticate(token: string): GrantIdentity | null {
    if (typeof token !== "string" || token.length === 0) return null;
    const hash = sha256Hex(token);
    const nowMs = this.now();
    let matched: GrantIdentity | null = null;
    for (const g of this.grants) {
      if (!hashEquals(hash, g.accessHash)) continue;
      if (g.accessExpiresMs <= nowMs) continue;
      matched = { label: g.label, clientId: g.clientId };
    }
    return matched;
  }

  /** Exchange a refresh token for a fresh pair, rotating both. Null when unknown or the client does not match. */
  refresh(refreshToken: string, check: { clientId: string }): (IssuedTokens & { label: string }) | null {
    const hash = sha256Hex(refreshToken);
    let found: Grant | null = null;
    for (const g of this.grants) {
      if (hashEquals(hash, g.refreshHash) && g.clientId === check.clientId) found = g;
    }
    if (!found) return null;
    this.grants = this.grants.filter((g) => g !== found);
    const issued = this.issueGrant({ label: found.label, clientId: found.clientId });
    return { ...issued, label: found.label };
  }

  /**
   * Drop every grant a client holds — `deckhand revoke`, and the undo for an approval given in
   * haste. Keyed by client because that is what was approved: revoking one connector must not
   * disturb another the same person authorized separately.
   */
  revokeClient(clientId: string): number {
    const before = this.grants.length;
    this.grants = this.grants.filter((g) => g.clientId !== clientId);
    if (this.grants.length !== before) this.save();
    return before - this.grants.length;
  }

  /** How many clients are registered. Exists so the eviction cap is testable rather than asserted in a comment. */
  clientCount(): number {
    return this.clients.size;
  }

  /** Clients that currently hold at least one grant, for `deckhand connections` and doctor. */
  activeClients(): { clientId: string; label: string }[] {
    const byId = new Map(this.grants.map((g) => [g.clientId, g.label]));
    return [...byId].map(([clientId, label]) => ({ clientId, label })).sort((a, b) => a.label.localeCompare(b.label));
  }
}
