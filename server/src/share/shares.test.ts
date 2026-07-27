import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isValidPin, hashPassword, verifyPassword, signUnlockCookie, verifyUnlockCookie } from "./shares.ts";

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
  it("round-trips a signed, unexpired cookie for the right share", () => {
    const now = 1_000_000;
    const cookie = signUnlockCookie(secret, "share-x", now + 10_000);
    assert.equal(verifyUnlockCookie(secret, "share-x", cookie, now), true);
  });
  it("rejects a wrong share, expired, tampered, or wrong-secret cookie", () => {
    const now = 1_000_000;
    const cookie = signUnlockCookie(secret, "share-x", now + 10_000);
    assert.equal(verifyUnlockCookie(secret, "share-y", cookie, now), false); // different share
    assert.equal(verifyUnlockCookie(secret, "share-x", cookie, now + 20_000), false); // expired
    assert.equal(verifyUnlockCookie("other", "share-x", cookie, now), false); // wrong secret
    assert.equal(verifyUnlockCookie(secret, "share-x", cookie.slice(0, -2) + "xx", now), false); // tampered sig
    assert.equal(verifyUnlockCookie(secret, "share-x", "garbage", now), false);
  });
});
