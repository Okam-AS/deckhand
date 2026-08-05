import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TokenAuthenticator } from "./auth.ts";
import type { TokenEntry } from "./config.ts";

const tokenA = "a".repeat(64);
const tokenB = "b".repeat(64);

const tokens: TokenEntry[] = [
  { name: "audun", token: tokenA },
  { name: "laptop", token: tokenB },
];

describe("TokenAuthenticator", () => {
  it("authenticates a known token to its principal", () => {
    const auth = new TokenAuthenticator(tokens);
    assert.equal(auth.authenticate(tokenA)?.name, "audun");
    assert.equal(auth.authenticate(tokenB)?.name, "laptop");
  });

  it("returns null for unknown, empty, and wrong-length tokens", () => {
    const auth = new TokenAuthenticator(tokens);
    assert.equal(auth.authenticate("c".repeat(64)), null);
    assert.equal(auth.authenticate(""), null);
    assert.equal(auth.authenticate("short"), null);
    assert.equal(auth.authenticate(tokenA.slice(0, 63) + "0"), null);
  });

  it("carries nothing but the name — there is no authority to differentiate", () => {
    // The regression this guards: a principal that grows a capability field is a
    // permission system reappearing, and every gate that reads it has to be
    // re-derived. One Mac, one operator: authenticating IS the authorization.
    const p = new TokenAuthenticator(tokens).authenticate(tokenA);
    assert.deepEqual(Object.keys(p ?? {}), ["name"]);
  });

  it("replace() swaps the token set in place", () => {
    const auth = new TokenAuthenticator(tokens);
    auth.replace([{ name: "rotated", token: tokenB }]);
    assert.equal(auth.authenticate(tokenA), null);
    assert.equal(auth.authenticate(tokenB)?.name, "rotated");
  });
});
