import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SetupStore } from "./setupStore.ts";

describe("SetupStore", () => {
  it("mints a live nonce that peeks then consumes once", () => {
    let n = 0;
    const store = new SetupStore(1000, () => n, (() => {
      let i = 0;
      return () => `nonce-${i++}`;
    })());
    const nonce = store.mint("github-pat", "okam-as");
    const peeked = store.peek(nonce);
    assert.equal(peeked?.owner, "okam-as");
    assert.equal(peeked?.kind, "github-pat");

    const consumed = store.consume(nonce);
    assert.equal(consumed?.owner, "okam-as");
    // Single-use: gone after consume.
    assert.equal(store.peek(nonce), null);
    assert.equal(store.consume(nonce), null);
  });

  it("expires a nonce after its TTL", () => {
    let now = 0;
    const store = new SetupStore(1000, () => now, () => "fixed");
    const nonce = store.mint("github-pat");
    now = 999;
    assert.ok(store.peek(nonce), "live just before TTL");
    now = 1001;
    assert.equal(store.peek(nonce), null, "expired past TTL");
  });

  it("rejects unknown nonces", () => {
    const store = new SetupStore();
    assert.equal(store.peek("never-minted"), null);
    assert.equal(store.consume("never-minted"), null);
  });
});
