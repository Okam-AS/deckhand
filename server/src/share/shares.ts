import { scryptSync, randomBytes, timingSafeEqual, createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// Share PIN + unlock-cookie helpers (auto-mate-learnings.md §6). Pure and
// dependency-free so they're unit-testable; the gate that uses them lives in
// proxy.ts (`createPinGate`).
// ---------------------------------------------------------------------------

const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;

export interface PasswordHash {
  salt: string; // hex
  hash: string; // hex
}

export function hashPassword(password: string): PasswordHash {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS).toString("hex");
  return { salt, hash };
}

export function verifyPassword(password: string, stored: PasswordHash): boolean {
  let candidate: Buffer;
  try {
    candidate = scryptSync(password, stored.salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  } catch {
    return false;
  }
  const expected = Buffer.from(stored.hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/** A share PIN is 4–6 numeric digits (drives the viewer's fixed-length pad). */
export function isValidPin(s: string): boolean {
  return /^\d{4,6}$/.test(s);
}

// --- signed unlock cookie ---------------------------------------------------

/**
 * An opaque, secret-keyed fingerprint of the PIN currently in force for a share
 * (or of "no PIN"). Bound into every unlock cookie so changing the PIN
 * invalidates cookies issued under the old one.
 *
 * Without it, an unlock cookie was valid for its full 12-hour TTL no matter
 * what: setting a PIN to lock someone out did nothing until it expired, and
 * because shareIds are stable per app and reused across stop/restart, the old
 * cookie kept working into the app's NEXT preview. The stored scrypt hash is
 * never put in the cookie directly — a 4–6 digit keyspace cracks offline in
 * under a second — so it goes through the HMAC first.
 */
export function pinFingerprint(secret: string, stored: PasswordHash | null | undefined): string {
  const material = stored ? `${stored.salt}:${stored.hash}` : "none";
  return createHmac("sha256", secret).update(`pinv1:${material}`).digest("base64url").slice(0, 16);
}

/** Sign an unlock token for a share, valid until `expiresAtMs`, bound to the PIN in force. */
export function signUnlockCookie(secret: string, shareId: string, expiresAtMs: number, pinFp: string): string {
  const payload = `${shareId}.${expiresAtMs}.${pinFp}`;
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/**
 * Verify an unlock cookie for a share: correct share, unexpired, signed by us,
 * and issued under the PIN that is in force RIGHT NOW (`pinFp`).
 */
export function verifyUnlockCookie(
  secret: string,
  shareId: string,
  cookie: string,
  nowMs: number,
  pinFp: string,
): boolean {
  const parts = cookie.split(".");
  if (parts.length !== 4) return false;
  const [cookieShare, expStr, cookieFp, sig] = parts as [string, string, string, string];
  if (cookieShare !== shareId) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < nowMs) return false;
  // Constant-time on the fingerprint too: it is derived from the PIN record.
  const fpA = Buffer.from(cookieFp);
  const fpB = Buffer.from(pinFp);
  if (fpA.length !== fpB.length || !timingSafeEqual(fpA, fpB)) return false;
  const expected = createHmac("sha256", secret).update(`${cookieShare}.${expStr}.${cookieFp}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
