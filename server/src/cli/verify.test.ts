import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseVerifyArgs } from "./verify.ts";

describe("deckhand verify arguments", () => {
  it("keeps every --env, not just the last", () => {
    const a = parseVerifyArgs(["app", "--scenario", "s.yaml", "--env", "A=1", "--ref", "main", "--env", "B=2"]);
    assert.deepEqual(a, { appId: "app", scenario: "s.yaml", ref: "main", env: ["A=1", "B=2"] });
  });

  it("refuses an unknown flag or a flag without its value", () => {
    assert.throws(() => parseVerifyArgs(["app", "--scenarios", "s.yaml"]), /unknown flag --scenarios/);
    assert.throws(() => parseVerifyArgs(["app", "--scenario"]), /needs a value/);
    assert.throws(() => parseVerifyArgs(["app", "other"]), /unexpected argument/);
  });
});
