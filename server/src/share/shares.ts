import { scryptSync, randomBytes, timingSafeEqual, createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// Share password + unlock-cookie helpers (auto-mate-learnings.md §6). Pure and
// dependency-free so they're unit-testable. Phase 1 uses public shares; the
// password gate is wired into the proxy in Phase 3, but the crypto lives here.
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

/** A human-friendly random password (for auto-generated password shares). */
export function generatePassword(): string {
  // base32-ish, no ambiguous chars; ~50 bits.
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(10);
  let out = "";
  for (let i = 0; i < 10; i++) out += alphabet[bytes[i]! % alphabet.length];
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

// --- signed unlock cookie ---------------------------------------------------

/** Sign an unlock token for a share, valid until `expiresAtMs`. */
export function signUnlockCookie(secret: string, shareId: string, expiresAtMs: number): string {
  const payload = `${shareId}.${expiresAtMs}`;
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/** Verify an unlock cookie for a share; returns true when valid and unexpired. */
export function verifyUnlockCookie(secret: string, shareId: string, cookie: string, nowMs: number): boolean {
  const parts = cookie.split(".");
  if (parts.length !== 3) return false;
  const [cookieShare, expStr, sig] = parts as [string, string, string];
  if (cookieShare !== shareId) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < nowMs) return false;
  const expected = createHmac("sha256", secret).update(`${cookieShare}.${expStr}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
