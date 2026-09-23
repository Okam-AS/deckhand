import { after, afterEach, before, beforeEach, describe, it } from "node:test";
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
    writeFileSync(join(home, "stringly.json"), JSON.stringify({ steps: [{ waitFor: { selector: '{"present": "#settings-diagnostics-delivered-by"}' } }] }));
    writeFileSync(join(home, "good.yaml"), "steps:\n  - tap: '#a'\n  - assert: { present: text=Done }\n");
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

  it("refuses a JSON string where a selector belongs, naming the step and the field, before anything is built", async () => {
    assert.equal(await cmdVerify(["mobile", "--scenario", join(home, "stringly.json")]), 3);
  });
});

describe("deckhand verify --lint", () => {
  let home: string;
  let printed: string[];
  const original = console.log;
  before(() => {
    home = mkdtempSync(join(tmpdir(), "verify-lint-"));
    writeFileSync(join(home, "stringly.json"), JSON.stringify({ steps: [{ tap: "#a" }, { waitFor: { selector: '{"present": "#x"}' } }] }));
    writeFileSync(join(home, "good.yaml"), "steps:\n  - tap: '#a'\n  - assert: { present: text=Done }\n");
  });
  beforeEach(() => {
    printed = [];
    console.log = (line: string) => void printed.push(line);
  });
  afterEach(() => {
    console.log = original;
  });
  after(() => rmSync(home, { recursive: true, force: true }));

  it("exits 0 with ok:true on a valid scenario, with no app and no config", async () => {
    assert.equal(await cmdVerify(["--lint", "--scenario", join(home, "good.yaml")]), 0);
    assert.deepEqual(JSON.parse(printed[0]!), { ok: true, scenario: join(home, "good.yaml"), steps: 2, diagnostics: [] });
  });

  it("exits 3 with the step, the field and the allowed forms on a bad one", async () => {
    assert.equal(await cmdVerify(["--lint", "--scenario", join(home, "stringly.json")]), 3);
    const out = JSON.parse(printed[0]!);
    assert.equal(out.ok, false);
    assert.equal(out.diagnostics.length, 1);
    assert.equal(out.diagnostics[0].step, 2);
    assert.equal(out.diagnostics[0].field, "waitFor.selector");
    assert.match(out.diagnostics[0].allowed, /text=/);
  });

  it("answers in JSON for a missing file, a missing --scenario, or flags it does not take", async () => {
    assert.equal(await cmdVerify(["--lint", "--scenario", join(home, "nope.yaml")]), 3);
    assert.equal(JSON.parse(printed[0]!).diagnostics[0].field, "scenario");
    assert.equal(await cmdVerify(["--lint"]), 3);
    assert.match(JSON.parse(printed[1]!).diagnostics[0].message, /needs --scenario/);
    assert.equal(await cmdVerify(["mobile", "--lint", "--scenario", join(home, "good.yaml"), "--ref", "main"]), 3);
    assert.match(JSON.parse(printed[2]!).diagnostics[0].message, /drop mobile, --ref/);
  });
});
