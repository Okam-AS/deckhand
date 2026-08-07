import { randomInt, timingSafeEqual } from "node:crypto";

/**
 * The pairing code: minted at the machine, typed into the browser.
 *
 * The connector URL cannot be a secret — a connector added in a Claude team or Enterprise
 * organisation is visible to everyone in it — so the URL decides nothing and the operator
 * does. The DIRECTION is the whole design, and this is the second attempt at it.
 *
 * The first version parked incoming requests and asked the operator to approve one by its
 * code. That inverts under load: parking is unauthenticated, so a stranger can park five
 * requests a second and the operator's own request is evicted before they can read the code
 * and walk to the Mac. Bounding the queue does not help — the queue is the wrong place to
 * solve it, because anything a stranger can create, a stranger can create enough of.
 *
 * So nothing incoming is stored at all. The operator MINTS a code here (`deckhand pair`) and a
 * request completes only if it carries that code. A flood has nothing to fill: no list, no slot
 * to take, no request for the operator to pick out of a crowd. The only move left is guessing,
 * which is a number, and {@link MAX_ATTEMPTS} bounds it PER SOURCE — see there for why the
 * budget cannot belong to the code.
 */

/** How long a minted code stays usable. Long enough to get to the browser, short enough that a
 *  code left on a screen is not a standing offer. */
export const CODE_TTL_MS = 10 * 60 * 1000;

/**
 * Wrong guesses a single SOURCE gets before it is locked out for {@link LOCKOUT_MS}.
 *
 * Not "wrong guesses before the code dies", which is what this was first. Submitting is
 * unauthenticated, so destroying the code on five misses handed every stranger a way to burn
 * every code the operator mints, as fast as they can loop — the operator would re-mint into a
 * shredder, forever, and the earlier comment's "which they notice" badly understated it.
 *
 * Locking out the SOURCE keeps both properties: a guesser gets nowhere, and the code survives
 * for the person the operator is actually talking to. The budget is per source and per code, so
 * a fresh mint is a fresh start and one bad actor cannot spend somebody else's tries.
 */
export const MAX_ATTEMPTS = 5;

/** How long a source that has spent its guesses is refused. Long against a search, short
 *  against a typo — and a person who really did mistype five times can be re-minted to. */
export const LOCKOUT_MS = 60 * 1000;

/** Letters that cannot be misread aloud or on a screen: no O/0, I/1, S/5, B/8. */
const ALPHABET = "ACDEFGHJKLMNPQRTUVWXY234679";

export interface MintedCode {
  code: string;
  expiresMs: number;
}

export interface PairingStoreOptions {
  now?: () => number;
  /** Injected so a test gets a known code instead of hoping for one. */
  pick?: (n: number) => number;
  ttlMs?: number;
  maxAttempts?: number;
}

export class PairingStore {
  private active: { code: string; expiresMs: number; attempts: Map<string, { count: number; until: number }> } | null = null;
  private readonly now: () => number;
  private readonly pick: (n: number) => number;
  private readonly ttlMs: number;
  private readonly maxAttempts: number;

  constructor(opts: PairingStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.pick = opts.pick ?? ((n) => randomInt(n));
    this.ttlMs = opts.ttlMs ?? CODE_TTL_MS;
    this.maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  }

  /**
   * Mint a code, replacing whatever was outstanding.
   *
   * ONE at a time, because the operator is one person doing one thing: a second `deckhand pair`
   * means the first attempt is being retried, and leaving the old code alive keeps a window
   * open that nobody is watching any more.
   */
  mint(): MintedCode {
    const take = (n: number): string => Array.from({ length: n }, () => ALPHABET[this.pick(ALPHABET.length)]!).join("");
    // Two groups: a single run of six is read back wrong often enough to matter when the whole
    // job of the string is surviving a trip between two screens.
    const code = `${take(3)}-${take(3)}`;
    this.active = { code, expiresMs: this.now() + this.ttlMs, attempts: new Map() };
    return { code, expiresMs: this.active.expiresMs };
  }

  /** Whether a code is outstanding, for `doctor` and for the CLI's wording. Never the code. */
  outstanding(): { expiresMs: number } | null {
    this.expire();
    return this.active ? { expiresMs: this.active.expiresMs } : null;
  }

  /**
   * Spend the code, or refuse.
   *
   * Single-use: a connector that completes must not leave the door open behind it. Compared in
   * constant time and case-insensitively — it crosses from one screen to another by hand, and
   * the comparison must not leak how much of a guess was right.
   */
  claim(candidate: string, source = "unknown"): boolean {
    this.expire();
    if (!this.active) return false;
    const record = this.active.attempts.get(source) ?? { count: 0, until: 0 };
    if (record.until > this.now()) return false; // locked out: not even a correct code counts
    const want = Buffer.from(this.active.code, "utf8");
    const got = Buffer.from(String(candidate ?? "").trim().toUpperCase(), "utf8");
    if (got.length === want.length && timingSafeEqual(got, want)) {
      this.active = null;
      return true;
    }
    // Counted before returning, so a burst cannot outrun the counter.
    record.count += 1;
    if (record.count >= this.maxAttempts) record.until = this.now() + LOCKOUT_MS;
    this.active.attempts.set(source, record);
    return false;
  }

  /** Forget a code nobody used. Called on every read, so an idle machine needs no timer. */
  private expire(): void {
    if (this.active && this.active.expiresMs <= this.now()) this.active = null;
  }
}
