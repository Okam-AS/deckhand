import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdVerify, parseVerifyArgs } from "./verify.ts";

describe("deckhand verify arguments", () => {
  it("keeps every --env, not just the last", () => {
    const a = parseVerifyArgs(["app", "--scenario", "s.yaml", "--env", "A=1", "--ref", "main", "--env", "B=2", "--max-diff-ratio", "0.01"]);
    assert.deepEqual(a, { appId: "app", scenario: "s.yaml", ref: "main", env: ["A=1", "B=2"], "max-diff-ratio": "0.01" });
  });

  it("refuses an unknown flag or a flag without its value", () => {
    assert.throws(() => parseVerifyArgs(["app", "--scenarios", "s.yaml"]), /unknown flag --scenarios/);
    assert.throws(() => parseVerifyArgs(["app", "--scenario"]), /needs a value/);
    assert.throws(() => parseVerifyArgs(["app", "other"]), /unexpected argument/);
  });
});

describe("deckhand verify exit code 3", () => {
  let home: string;
  before(() => {
    home = mkdtempSync(join(tmpdir(), "verify-cli-"));
    process.env.DECKHAND_HOME = home;
    writeFileSync(join(home, "config.yaml"), "hostname: example.test\nstreaming: { serveSim: { version: 1.0.0 } }\n");
    writeFileSync(join(home, "apps.yaml"), "apps:\n  - id: mobile\n    type: expo\n    path: /nowhere/mobile\n");
    writeFileSync(join(home, "bad.yaml"), "steps:\n  - swipe: up\n");
  });
  after(() => {
    delete process.env.DECKHAND_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it("is what bad input gets, before anything is built", async () => {
    assert.equal(await cmdVerify(["mobile", "--scenario", join(home, "bad.yaml")]), 3);
    assert.equal(await cmdVerify(["mobile", "--bogus", "x"]), 3);
    assert.equal(await cmdVerify(["nobody", "--scenario", join(home, "bad.yaml")]), 3);
    assert.equal(await cmdVerify(["mobile", "--scenario", join(home, "bad.yaml"), "--max-diff-ratio", "2"]), 3);
  });
});
