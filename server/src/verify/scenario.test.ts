import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_DEVICE, parseScenario, parseSelector, ScenarioError } from "./scenario.ts";

describe("parseSelector", () => {
  it("reads #id, key=value and bare text", () => {
    assert.deepEqual(parseSelector("#save"), { id: "save" });
    assert.deepEqual(parseSelector("label=Close"), { label: "Close" });
    assert.deepEqual(parseSelector("text=a=b"), { text: "a=b" });
    assert.deepEqual(parseSelector("Sign in"), { text: "Sign in" });
    assert.deepEqual(parseSelector({ id: "row", index: 2 }), { id: "row", index: 2 });
  });
});

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
  - assert: { absent: "#error" }
  - assertNot: label=Retry
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
      { action: "assert", selector: { text: "Paid" }, absent: false },
      { action: "assert", selector: { id: "error" }, absent: true },
      { action: "assert", selector: { label: "Retry" }, absent: true },
      { action: "sleep", ms: 250 },
      { action: "screenshot", name: "paid" },
    ]);
  });

  it("reads JSON as well, and defaults the device to the iPad 9th generation in landscape", () => {
    const s = parseScenario(JSON.stringify({ steps: [{ screenshot: "first" }] }), "from-file");
    assert.equal(s.name, "from-file");
    assert.deepEqual(s.device, { model: "iPad (9th generation)", runtime: "iOS 26.5", orientation: "landscape" });
    assert.deepEqual(s.steps, [{ action: "screenshot", name: "first" }]);
  });

  it("names the step and the problem when a step is wrong", () => {
    assert.throws(() => parseScenario("steps:\n  - swipe: up"), /step 1: unknown action "swipe"/);
    assert.throws(() => parseScenario("steps:\n  - { tap: '#a', type: x }"), /step 1: one action per step/);
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
