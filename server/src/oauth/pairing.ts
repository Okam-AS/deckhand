import { randomBytes, randomInt } from "node:crypto";

/**
 * Connection requests waiting for the operator to say yes.
 *
 * The connector URL cannot be a secret: a connector added in a Claude team or Enterprise
 * organisation is visible to everyone in it. So the URL decides nothing, and the operator
 * does — once, per client, at the machine. A colleague who pastes the same URL gets a parked
 * request and a code on their screen; nothing is issued until somebody runs `deckhand approve`
 * on the Mac and matches that code.
 *
 * That makes the secret "a person's hand on their own machine" rather than "a string nobody
 * pasted anywhere". It is the one secret a shared URL cannot leak.
 *
 * Everything here is in memory on purpose. A pending request is worth seconds, and surviving a
 * restart would mean an approval could outlive the browser that asked for it — the operator
 * would be approving a request they can no longer see.
 */

/** How long a parked request stays approvable. Long enough to walk to the Mac, short enough
 * that an unattended screen is not a standing offer. */
export const PENDING_TTL_MS = 5 * 60 * 1000;

/**
 * How many requests may wait at once, and what happens to the surplus.
 *
 * The URL is public, so anyone who has it can make this machine show a prompt. Uncapped, that
 * is a nuisance channel: fill the list and the operator cannot find their own request among
 * the noise, which is precisely when people start approving without reading.
 *
 * The full queue EVICTS THE OLDEST rather than refusing the newcomer. Refusing was the first
 * instinct — don't let a flood push away the request the operator is reading — and it inverts
 * into something worse: hold five slots and refresh them, and the operator can never park a
 * request of their own again. That is a lockout of the one person the mechanism is for, caused
 * by strangers, and it needs no credential to mount.
 *
 * Evicting the oldest keeps the newest request always parkable, which is the operator's:
 * theirs is the one just created, by the person standing at the machine. A flood loses its own
 * stale entries first. The operator's request can still be evicted — but only by five newer
 * arrivals, and a code they cannot match is one they must not approve anyway.
 */
export const MAX_PENDING = 5;

export type PendingStatus = "pending" | "approved" | "denied" | "expired";

export interface PendingRequest {
  /** Unguessable handle the waiting browser polls with. Never shown on the Mac: knowing it
   *  proves only that you opened the page, which the whole organisation can do. */
  id: string;
  /** The short code shown in the BROWSER and confirmed on the Mac. Approving is by this code,
   *  so with two requests waiting the operator can tell which one is theirs. */
  code: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  createdMs: number;
  status: PendingStatus;
  /** Set when approved: the authorization code to hand back to the waiting browser. */
  authCode?: string;
}

export interface PendingSummary {
  code: string;
  clientName: string;
  waitingMs: number;
}

/** Letters that cannot be misread aloud or on a screen: no O/0, I/1, S/5, B/8. */
const ALPHABET = "ACDEFGHJKLMNPQRTUVWXY2346789";

function humanCode(pick: (n: number) => number): string {
  const take = (n: number): string =>
    Array.from({ length: n }, () => ALPHABET[pick(ALPHABET.length)]!).join("");
  // Two groups, because a single run of six is read back wrong often enough to matter when
  // the whole point is comparing two screens.
  return `${take(3)}-${take(3)}`;
}

export interface PairingStoreOptions {
  now?: () => number;
  /** Injected so a test can force a collision instead of hoping for one. */
  pick?: (n: number) => number;
  ttlMs?: number;
  maxPending?: number;
}

export class PairingStore {
  private readonly requests = new Map<string, PendingRequest>();
  private readonly now: () => number;
  private readonly pick: (n: number) => number;
  private readonly ttlMs: number;
  private readonly maxPending: number;

  constructor(opts: PairingStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.pick = opts.pick ?? ((n) => randomInt(n));
    this.ttlMs = opts.ttlMs ?? PENDING_TTL_MS;
    this.maxPending = opts.maxPending ?? MAX_PENDING;
  }

  /**
   * Park a request, evicting the oldest if the queue is full (see {@link MAX_PENDING}).
   *
   * Returns `null` only when no distinct code could be drawn — a state this endpoint renders
   * rather than throwing on, because a full queue is ordinary and a server error is not.
   */
  park(req: Omit<PendingRequest, "id" | "code" | "createdMs" | "status" | "authCode">): PendingRequest | null {
    this.sweep();
    while (this.pendingOnly().length >= this.maxPending) {
      const oldest = this.pendingOnly().sort((a, b) => a.createdMs - b.createdMs)[0]!;
      this.requests.delete(oldest.id);
    }
    let code = humanCode(this.pick);
    // A duplicate code would make the operator's "which one is mine" question unanswerable,
    // which is the entire job of the code.
    for (let i = 0; i < 100 && this.pendingOnly().some((p) => p.code === code); i++) code = humanCode(this.pick);
    if (this.pendingOnly().some((p) => p.code === code)) return null;
    const parked: PendingRequest = { ...req, id: randomBytes(32).toString("base64url"), code, createdMs: this.now(), status: "pending" };
    this.requests.set(parked.id, parked);
    return parked;
  }

  /** Clients with a request still waiting. They are mid-flow, so nothing may evict them. */
  busyClientIds(): ReadonlySet<string> {
    this.sweep();
    return new Set(this.pendingOnly().map((p) => p.clientId));
  }

  /** What the operator sees on the Mac. No id, no redirect URI, no challenge — nothing that
   *  would let a shoulder-surfing screenshot stand in for being at the machine. */
  pending(): PendingSummary[] {
    this.sweep();
    return this.pendingOnly()
      .sort((a, b) => a.createdMs - b.createdMs)
      .map((p) => ({ code: p.code, clientName: p.clientName, waitingMs: this.now() - p.createdMs }));
  }

  /**
   * Approve by code, minting the authorization code through the caller's own OAuth store.
   *
   * The mint is a callback rather than a dependency so this file never learns how codes are
   * made — and so approving twice cannot mint twice: the status flips first.
   */
  approve(code: string, mint: (req: PendingRequest) => string): PendingRequest | null {
    const found = this.byCode(code);
    if (!found) return null;
    found.status = "approved";
    found.authCode = mint(found);
    return found;
  }

  deny(code: string): PendingRequest | null {
    const found = this.byCode(code);
    if (!found) return null;
    found.status = "denied";
    return found;
  }

  /** What the waiting browser polls. Unknown ids read as expired: a request swept out and one
   *  that never existed are the same fact to the page, and saying so avoids leaking which. */
  poll(id: string): { status: PendingStatus } {
    this.sweep();
    return { status: this.requests.get(id)?.status ?? "expired" };
  }

  /**
   * Claim an approved request, once.
   *
   * Removed as it is read, so a replayed `/oauth/resume` cannot deliver the same authorization
   * code to the redirect URI twice — one approval, one code, one arrival.
   */
  take(id: string): PendingRequest | null {
    this.sweep();
    const found = this.requests.get(id);
    if (!found) return null;
    this.requests.delete(id);
    return found;
  }

  /** Drop what a poll or an approval can no longer act on. Called on every read so a machine
   *  nobody is using does not need a timer to stay correct. */
  private sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, req] of this.requests) {
      if (req.createdMs <= cutoff) {
        // Kept, marked, for one more TTL so a browser polling at the moment it lapses is told
        // "expired" rather than being handed the same answer as an unknown id.
        if (req.status === "pending") req.status = "expired";
        if (req.createdMs <= cutoff - this.ttlMs) this.requests.delete(id);
      }
    }
  }

  private pendingOnly(): PendingRequest[] {
    return [...this.requests.values()].filter((r) => r.status === "pending");
  }

  /** Case-insensitive: the code is read off one screen and typed on another. */
  private byCode(code: string): PendingRequest | null {
    this.sweep();
    const want = code.trim().toUpperCase();
    return this.pendingOnly().find((p) => p.code === want) ?? null;
  }
}
