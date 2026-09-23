import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_DEVICE, lintScenario, parseScenario, ScenarioError, type Diagnostic } from "./scenario.ts";

function problems(text: string): Diagnostic[] {
  const r = lintScenario(text);
  assert.equal(r.ok, false, "expected the scenario to be refused");
  return r.diagnostics;
}

describe("parseScenario", () => {
  const yaml = `
name: checkout
device: { orientation: portrait }
env: { EXPO_PUBLIC_FLAG: 1 }
ready: "#home"
steps:
  - openUrl: myapp://cart
  - tap: "#pay"
  - type: "4242"
  - scroll: down
  - scrollUntilVisible: text=Total
  - waitFor: { selector: "#receipt", timeoutMs: 5000 }
  - waitFor: { absent: text=Loading }
  - assert: text=Paid
  - assert: { present: text=Receipt }
  - assert: { absent: "#error" }
  - assertNot: label=Retry
  - tap: { id: row, index: 2 }
  - waitFor: { text: "a=b" }
  - assert: { visible: value=3 }
  - tap: id=plain
  - sleep: 250
  - screenshot: paid
`;

  it("parses every step kind in order, with selectors and options", () => {
    const s = parseScenario(yaml);
    assert.equal(s.name, "checkout");
    assert.deepEqual(s.device, { ...DEFAULT_DEVICE, orientation: "portrait" });
    assert.deepEqual(s.env, { EXPO_PUBLIC_FLAG: "1" });
    assert.deepEqual(s.ready, { id: "home" });
    assert.deepEqual(s.steps, [
      { action: "openUrl", url: "myapp://cart" },
      { action: "tap", selector: { id: "pay" } },
      { action: "type", text: "4242" },
      { action: "scroll", direction: "down" },
      { action: "scrollUntilVisible", selector: { text: "Total" } },
      { action: "waitFor", selector: { id: "receipt" }, absent: false, timeoutMs: 5000 },
      { action: "waitFor", selector: { text: "Loading" }, absent: true, timeoutMs: undefined },
      { action: "assert", selector: { text: "Paid" }, mode: "visible" },
      { action: "assert", selector: { text: "Receipt" }, mode: "present" },
      { action: "assert", selector: { id: "error" }, mode: "absent" },
      { action: "assert", selector: { label: "Retry" }, mode: "absent" },
      { action: "tap", selector: { id: "row", index: 2 } },
      { action: "waitFor", selector: { text: "a=b" }, absent: false },
      { action: "assert", selector: { value: "3" }, mode: "visible" },
      { action: "tap", selector: { id: "plain" } },
      { action: "sleep", ms: 250 },
      { action: "screenshot", name: "paid" },
    ]);
  });

  it("reads JSON as well, and defaults the device to the iPad 9th generation in landscape", () => {
    const s = parseScenario(JSON.stringify({ steps: [{ screenshot: "first" }, { tap: "text=a=b" }] }), "from-file");
    assert.equal(s.name, "from-file");
    assert.deepEqual(s.device, { model: "iPad (9th generation)", runtime: "iOS 26.5", orientation: "landscape" });
    assert.deepEqual(s.steps, [{ action: "screenshot", name: "first" }, { action: "tap", selector: { text: "a=b" } }]);
  });

  it("names the step and the problem when a step is wrong", () => {
    assert.throws(() => parseScenario("steps:\n  - swipe: up"), /step 1 \(swipe\): unknown action "swipe"/);
    assert.throws(() => parseScenario("steps:\n  - { tap: '#a', type: x }"), /step 1 \(step\): one action per step/);
    assert.throws(() => parseScenario("steps:\n  - screenshot: ok\n  - scroll: sideways"), /step 2 \(scroll\)/);
    assert.throws(() => parseScenario("steps:\n  - waitFor: { timeoutMs: 5 }"), ScenarioError);
    assert.throws(() => parseScenario("steps:\n  - tap: { index: 1 }"), /step 1 \(tap\)/);
  });

  it("refuses a screenshot name that is not a plain file name, or one used twice", () => {
    assert.throws(() => parseScenario("steps:\n  - screenshot: ../escape"), /file names/);
    assert.throws(() => parseScenario("steps:\n  - screenshot: a\n  - screenshot: a"), /taken twice/);
  });

  it("refuses a scenario with no steps or unknown top-level keys", () => {
    assert.throws(() => parseScenario("steps: []"), ScenarioError);
    assert.throws(() => parseScenario("steps:\n  - sleep: 1\nextra: true"), /extra|Unrecognized/);
    assert.throws(() => parseScenario("{ not yaml"), ScenarioError);
  });
});

describe("strict selectors", () => {
  it("refuses a JSON object written as a string where a selector belongs — the factory's live defect", () => {
    const d = problems(JSON.stringify({ steps: [{ tap: "#a" }, { waitFor: { selector: '{"present": "#settings-diagnostics-delivered-by"}' } }] }));
    assert.equal(d.length, 1);
    assert.equal(d[0]!.step, 2);
    assert.equal(d[0]!.field, "waitFor.selector");
    assert.match(d[0]!.message, /JSON\/YAML written inside a string/);
    assert.match(d[0]!.allowed!, /"#id", "id=…", "text=…", "label=…", "value=…"/);
  });

  it("refuses a list written as a string, an empty selector, and a lone #", () => {
    assert.match(problems("steps:\n  - tap: '[1, 2]'")[0]!.message, /JSON\/YAML written inside a string/);
    assert.match(problems("steps:\n  - tap: ''")[0]!.message, /empty selector/);
    assert.match(problems("steps:\n  - tap: '   '")[0]!.message, /empty selector/);
    assert.match(problems("steps:\n  - tap: '#'")[0]!.message, /not an id/);
    assert.match(problems("steps:\n  - tap: '#two words'")[0]!.message, /not an id/);
  });

  it("refuses an unknown prefix and bare text instead of guessing text", () => {
    assert.match(problems("steps:\n  - tap: role=button")[0]!.message, /unknown selector prefix "role="/);
    assert.match(problems("steps:\n  - tap: 'text='")[0]!.message, /"text=" needs a value after it/);
    assert.match(problems("steps:\n  - assert: Sign in")[0]!.message, /bare text is refused — did you mean "text=Sign in"/);
    assert.equal(problems("ready: Home\nsteps:\n  - sleep: 1")[0]!.field, "ready");
  });

  it("refuses unknown keys in a selector, a waitFor or an assert object", () => {
    const wait = problems("steps:\n  - waitFor: { present: '#a' }")[0]!;
    assert.equal(wait.field, "waitFor");
    assert.match(wait.message, /unknown key\(s\) present/);
    assert.match(problems("steps:\n  - waitFor: { selector: '#a', present: '#b' }")[0]!.message, /unknown key\(s\) present/);
    assert.match(problems("steps:\n  - assert: { present: '#a', timeoutMs: 5 }")[0]!.message, /unknown key\(s\) timeoutMs/);
    assert.match(problems("steps:\n  - tap: { id: a, role: button }")[0]!.message, /unknown selector key\(s\) role/);
    assert.match(problems("steps:\n  - assert: { present: '#a', absent: '#b' }")[0]!.message, /exactly one of visible, present or absent/);
    assert.match(problems("steps:\n  - waitFor: { selector: { present: '#a' } }")[0]!.message, /unknown selector key\(s\) present/);
  });

  it("reports every problem in one pass, each with its own step", () => {
    const d = problems("steps:\n  - tap: nope\n  - sleep: 1\n  - scroll: sideways\n  - waitFor: '{\"a\":1}'");
    assert.deepEqual(d.map((x) => [x.step, x.field]), [[1, "tap"], [3, "scroll"], [4, "waitFor"]]);
  });

  it("lints a good scenario clean", () => {
    assert.deepEqual(lintScenario(yamlOk), { ok: true, steps: 2, diagnostics: [] });
  });
});

const yamlOk = "steps:\n  - tap: '#a'\n  - assert: { present: text=Done }\n";
