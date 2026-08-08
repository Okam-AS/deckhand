import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PairingStore, CODE_TTL_MS, LOCKOUT_MS, MAX_ATTEMPTS } from "./pairing.ts";

/** A clock the test moves by hand: waiting ten real minutes is not a test. */
function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe("the pairing code", () => {
  it("mints a code a person can read off one screen and type on another", () => {
    const { code, expiresMs } = new PairingStore({ now: () => 1_000 }).mint();
    assert.match(code, /^[ACDEFGHJKLMNPQRTUVWXY234679]{3}-[ACDEFGHJKLMNPQRTUVWXY234679]{3}$/);
    assert.equal(expiresMs, 1_000 + CODE_TTL_MS);
    // One code samples six characters out of the alphabet, so asserting on a single mint made
    // this a COIN FLIP: `8` sat in the alphabet while the rule below forbade it, and `npm run
    // ci` went red about one run in five — the shape of flake that gets a test deleted rather
    // than believed. Enough mints to see every character, so a confusable one fails every time.
    const store = new PairingStore({ now: () => 1_000 });
    for (let i = 0; i < 400; i += 1) {
      assert.doesNotMatch(store.mint().code, /[O0I1S5B8]/, "characters that get misread cost a retry the operator cannot diagnose");
    }
  });

  it("accepts the code once and never again", () => {
    const store = new PairingStore();
    const { code } = store.mint();
    assert.equal(store.claim(code), true);
    assert.equal(store.claim(code), false, "a connector that got in must not leave the door open behind it");
  });

  it("accepts it however it was typed back", () => {
    const store = new PairingStore();
    const { code } = store.mint();
    assert.equal(store.claim(`  ${code.toLowerCase()} `), true);
  });

  // The whole threat model: the URL is public, so anyone can submit. Guessing is the only move
  // left, and it has to be bounded or ~3.9e8 possibilities (27 characters over six positions)
  // is just a slow afternoon.
  it("locks a source out after a handful of wrong guesses", () => {
    const store = new PairingStore();
    const { code } = store.mint();
    for (let i = 0; i < MAX_ATTEMPTS; i++) assert.equal(store.claim("AAA-AAA", "1.2.3.4"), false);
    assert.equal(store.claim(code, "1.2.3.4"), false, "even the right code, once that source has spent its tries");
  });

  // Burning the CODE on wrong guesses was the first version, and it hands every stranger a way
  // to destroy every code the operator mints, as fast as they can loop.
  it("leaves the code usable by the person the operator is actually talking to", () => {
    const store = new PairingStore();
    const { code } = store.mint();
    for (let i = 0; i < MAX_ATTEMPTS * 4; i++) store.claim("AAA-AAA", "attacker");
    assert.ok(store.outstanding(), "a guesser must not be able to shred the operator's code");
    assert.equal(store.claim(code, "the-visitor"), true);
  });

  it("gives each source its own budget, and a fresh mint a fresh start", () => {
    const store = new PairingStore();
    store.mint();
    for (let i = 0; i < MAX_ATTEMPTS; i++) store.claim("AAA-AAA", "attacker");
    const { code } = store.mint();
    assert.equal(store.claim(code, "attacker"), true, "the lockout belongs to the code it was earned against");
  });

  it("forgets the lockout once it has served its time", () => {
    const c = clock();
    const store = new PairingStore({ now: c.now });
    const { code } = store.mint();
    for (let i = 0; i < MAX_ATTEMPTS; i++) store.claim("AAA-AAA", "typo-prone");
    c.advance(LOCKOUT_MS + 1);
    assert.equal(store.claim(code, "typo-prone"), true, "somebody who really did mistype five times is not banned");
  });

  it("expires", () => {
    const c = clock();
    const store = new PairingStore({ now: c.now });
    const { code } = store.mint();
    c.advance(CODE_TTL_MS + 1);
    assert.equal(store.outstanding(), null);
    assert.equal(store.claim(code), false, "a code left on a screen is not a standing offer");
  });

  // A second `deckhand pair` means the first attempt is being retried. Leaving the old code
  // alive would keep a window open that nobody is watching any more.
  it("replaces the outstanding code rather than keeping both", () => {
    const store = new PairingStore();
    const first = store.mint().code;
    const second = store.mint().code;
    assert.equal(store.claim(first), false);
    assert.equal(store.claim(second), true);
  });

  it("refuses everything when nothing was minted", () => {
    const store = new PairingStore();
    assert.equal(store.claim("ABC-123"), false);
    assert.equal(store.outstanding(), null);
  });

  // `outstanding` exists for doctor and for the CLI's wording, and neither needs the secret.
  it("never hands the code back out once minted", () => {
    const store = new PairingStore();
    store.mint();
    assert.deepEqual(Object.keys(store.outstanding()!), ["expiresMs"]);
  });
});
