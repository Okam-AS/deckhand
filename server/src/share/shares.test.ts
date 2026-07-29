import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isValidPin, hashPassword, verifyPassword, signUnlockCookie, verifyUnlockCookie, pinFingerprint } from "./shares.ts";

describe("isValidPin", () => {
  it("accepts 4–6 digit numeric codes", () => {
    for (const ok of ["1234", "12345", "123456", "0000"]) assert.equal(isValidPin(ok), true, ok);
  });
  it("rejects wrong length or non-numeric", () => {
    for (const bad of ["123", "1234567", "12a4", "12 4", "", "abcd", "-123"]) assert.equal(isValidPin(bad), false, bad);
  });
});

describe("hashPassword / verifyPassword", () => {
  it("verifies the right PIN and rejects wrong ones (salted, so hashes differ)", () => {
    const a = hashPassword("4821");
    const b = hashPassword("4821");
    assert.notEqual(a.salt, b.salt);
    assert.notEqual(a.hash, b.hash); // different salt → different hash
    assert.equal(verifyPassword("4821", a), true);
    assert.equal(verifyPassword("4820", a), false);
    assert.equal(verifyPassword("", a), false);
  });
});

describe("unlock cookie", () => {
  const secret = "s3cr3t";
  const pinA = hashPassword("1234");
  const fpA = pinFingerprint(secret, pinA);
  it("round-trips a signed, unexpired cookie for the right share", () => {
    const now = 1_000_000;
    const cookie = signUnlockCookie(secret, "share-x", now + 10_000, fpA);
    assert.equal(verifyUnlockCookie(secret, "share-x", cookie, now, fpA), true);
  });
  it("rejects a wrong share, expired, tampered, or wrong-secret cookie", () => {
    const now = 1_000_000;
    const cookie = signUnlockCookie(secret, "share-x", now + 10_000, fpA);
    assert.equal(verifyUnlockCookie(secret, "share-y", cookie, now, fpA), false); // different share
    assert.equal(verifyUnlockCookie(secret, "share-x", cookie, now + 20_000, fpA), false); // expired
    assert.equal(verifyUnlockCookie("other", "share-x", cookie, now, fpA), false); // wrong secret
    assert.equal(verifyUnlockCookie(secret, "share-x", cookie.slice(0, -2) + "xx", now, fpA), false); // tampered sig
    assert.equal(verifyUnlockCookie(secret, "share-x", "garbage", now, fpA), false);
  });
  it("stops working when the PIN changes or is removed", () => {
    // Setting a PIN to lock someone out used to leave their cookie valid for the
    // full 12h TTL — and, because shareIds are stable per app, into the app's
    // next preview.
    const now = 1_000_000;
    const cookie = signUnlockCookie(secret, "share-x", now + 10_000, fpA);
    assert.equal(verifyUnlockCookie(secret, "share-x", cookie, now, pinFingerprint(secret, hashPassword("9999"))), false);
    assert.equal(verifyUnlockCookie(secret, "share-x", cookie, now, pinFingerprint(secret, null)), false);
    // Same PIN value, re-hashed with a fresh salt, is still a new fingerprint —
    // re-setting the same digits revokes too. That is the safe direction.
    assert.equal(verifyUnlockCookie(secret, "share-x", cookie, now, pinFingerprint(secret, hashPassword("1234"))), false);
    // Unchanged record → still valid.
    assert.equal(verifyUnlockCookie(secret, "share-x", cookie, now, pinFingerprint(secret, pinA)), true);
  });
  it("does not leak the stored hash into the cookie", () => {
    const cookie = signUnlockCookie(secret, "share-x", 2_000_000, fpA);
    assert.equal(cookie.includes(pinA.hash), false);
    assert.equal(cookie.includes(pinA.salt), false);
  });
});
