import { createPublicKey, createVerify, timingSafeEqual, type JsonWebKey } from "node:crypto";

// ---------------------------------------------------------------------------
// Cloudflare Access identity, verified rather than trusted.
//
// Access puts the authenticated user's email in TWO places: the header
// `Cf-Access-Authenticated-User-Email`, and a signed JWT in
// `Cf-Access-Jwt-Assertion`. Only the second one is evidence. A header is just a
// header — anything that can reach the origin can set it, and deckhand's origin is
// reachable from the loopback interface that every process on this Mac shares,
// including a simulator running a build we did not write (PLAN §11 item 7: builds
// are RCE by design). So the header is never read here, and there is a test that
// fails if it starts being.
//
// The JWT is RS256 over Access's per-team JWKS. Verified with node:crypto — an
// off-the-shelf JWT library would be a new dependency for ~60 lines (PLAN §2).
// ---------------------------------------------------------------------------

export interface AccessIdentity {
  /** The address Cloudflare authenticated, lowercased. */
  email: string;
}

/**
 * What `/oauth/authorize` needs from Access. An interface rather than the class
 * so a test substitutes a complete implementation instead of casting a literal —
 * `as unknown as X` turns off missing-property checking, which is how four fakes
 * in this repo silently fell behind their real classes.
 */
export interface AccessIdentityVerifier {
  verify(assertion: string | undefined): Promise<AccessIdentity | null>;
}

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  [k: string]: unknown;
}

const JWKS_TTL_MS = 60 * 60 * 1000;
/** Floor between JWKS fetches triggered by an unknown `kid`, so a stream of forged kids can't drive one fetch each. */
const JWKS_REFETCH_FLOOR_MS = 60 * 1000;

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
}

/** Case-insensitive constant-time compare of two audience tags. */
function audMatches(claim: unknown, expected: string): boolean {
  const list = Array.isArray(claim) ? claim : [claim];
  const want = Buffer.from(expected, "utf8");
  let ok = false;
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const got = Buffer.from(entry, "utf8");
    if (got.length === want.length && timingSafeEqual(got, want)) ok = true;
  }
  return ok;
}

export interface AccessVerifierOptions {
  /** The Zero Trust team domain, e.g. `acme.cloudflareaccess.com`. */
  teamDomain: string;
  /** The Access application's AUD tag. An Access JWT for a DIFFERENT app on the same team must not be accepted here. */
  aud: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Verifies `Cf-Access-Jwt-Assertion` against the team's JWKS.
 *
 * Returns null for every failure — expired, wrong audience, unknown key, bad
 * signature, no email. The caller turns that into a refusal with no detail: which
 * check failed is not the user's business and telling them is a probing aid.
 */
export class AccessVerifier implements AccessIdentityVerifier {
  private keys = new Map<string, Jwk>();
  private fetchedAtMs = 0;
  private inFlight: Promise<void> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: AccessVerifierOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
  }

  private get issuer(): string {
    return `https://${this.opts.teamDomain}`;
  }

  private async loadKeys(force: boolean): Promise<void> {
    const age = this.now() - this.fetchedAtMs;
    if (!force && this.keys.size > 0 && age < JWKS_TTL_MS) return;
    if (force && age < JWKS_REFETCH_FLOOR_MS && this.keys.size > 0) return;
    // Collapse concurrent misses onto one request: a burst of authorize calls
    // during a restart would otherwise each fetch the JWKS.
    this.inFlight ??= (async () => {
      try {
        const res = await this.fetchImpl(`${this.issuer}/cdn-cgi/access/certs`);
        if (!res.ok) return;
        const body = (await res.json()) as { keys?: Jwk[] };
        if (!Array.isArray(body.keys)) return;
        const next = new Map<string, Jwk>();
        for (const k of body.keys) if (typeof k.kid === "string") next.set(k.kid, k);
        if (next.size > 0) {
          this.keys = next;
          this.fetchedAtMs = this.now();
        }
      } catch {
        // Keep the keys we have. A JWKS fetch that fails must not turn every
        // in-flight login into a rejection while the cached keys are still valid.
      } finally {
        this.inFlight = null;
      }
    })();
    await this.inFlight;
  }

  async verify(assertion: string | undefined): Promise<AccessIdentity | null> {
    if (typeof assertion !== "string") return null;
    const parts = assertion.split(".");
    if (parts.length !== 3) return null;
    const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];

    let header: { alg?: unknown; kid?: unknown };
    let payload: { aud?: unknown; iss?: unknown; exp?: unknown; nbf?: unknown; email?: unknown };
    try {
      header = decodeSegment(rawHeader) as typeof header;
      payload = decodeSegment(rawPayload) as typeof payload;
    } catch {
      return null;
    }

    // Pinned, not read from the token: `alg` is attacker-chosen, and accepting
    // whatever it names is how "alg: none" and HS256-with-the-public-key work.
    if (header.alg !== "RS256") return null;
    if (typeof header.kid !== "string") return null;

    await this.loadKeys(false);
    let jwk = this.keys.get(header.kid);
    if (!jwk) {
      // Access rotates signing keys. An unrecognised kid is a rotation before it
      // is a forgery, so refetch once (rate-limited) before refusing.
      await this.loadKeys(true);
      jwk = this.keys.get(header.kid);
    }
    if (!jwk || jwk.kty !== "RSA") return null;

    let verified: boolean;
    try {
      const key = createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
      verified = createVerify("RSA-SHA256")
        .update(`${rawHeader}.${rawPayload}`)
        .verify(key, Buffer.from(rawSignature, "base64url"));
    } catch {
      return null;
    }
    if (!verified) return null;

    if (payload.iss !== this.issuer) return null;
    if (!audMatches(payload.aud, this.opts.aud)) return null;
    const nowSec = Math.floor(this.now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp <= nowSec) return null;
    if (typeof payload.nbf === "number" && payload.nbf > nowSec + 60) return null;
    if (typeof payload.email !== "string" || payload.email === "") return null;

    return { email: payload.email.toLowerCase() };
  }
}
