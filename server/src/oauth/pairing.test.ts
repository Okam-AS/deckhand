import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PairingStore, CODE_TTL_MS, MAX_ATTEMPTS } from "./pairing.ts";

/** A clock the test moves by hand: waiting ten real minutes is not a test. */
function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe("the pairing code", () => {
  it("mints a code a person can read off one screen and type on another", () => {
    const { code, expiresMs } = new PairingStore({ now: () => 1_000 }).mint();
    assert.match(code, /^[ACDEFGHJKLMNPQRTUVWXY2346789]{3}-[ACDEFGHJKLMNPQRTUVWXY2346789]{3}$/);
    assert.doesNotMatch(code, /[O0I1S5B8]/, "characters that get misread cost a retry the operator cannot diagnose");
    assert.equal(expiresMs, 1_000 + CODE_TTL_MS);
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
  // left, and it has to be bounded or ~4.8e8 possibilities is just a slow afternoon.
  it("destroys the code after a handful of wrong guesses", () => {
    const store = new PairingStore();
    const { code } = store.mint();
    for (let i = 0; i < MAX_ATTEMPTS; i++) assert.equal(store.claim("AAA-AAA"), false);
    assert.equal(store.claim(code), false, "the real code must die too — otherwise the burst simply continues");
    assert.equal(store.outstanding(), null);
  });

  it("counts guesses against the code, so minting again gives a fresh budget", () => {
    const store = new PairingStore();
    store.mint();
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) store.claim("AAA-AAA");
    const { code } = store.mint();
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) store.claim("AAA-AAA");
    assert.equal(store.claim(code), true, "a retry is not the previous attempt's leftovers");
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
