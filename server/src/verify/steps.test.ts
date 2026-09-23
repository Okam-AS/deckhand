import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { UiAction } from "../testing/control.ts";
import { parseScenario } from "./scenario.ts";
import { runSteps, waitForSettle, type VerifyControl } from "./steps.ts";

function fakeControl(opts: { answer?: (a: UiAction) => unknown; trees?: unknown[] } = {}) {
  const actions: UiAction[] = [];
  const files = new Map<string, Buffer | string>();
  let shots = 0;
  let treeAt = 0;
  const control: VerifyControl = {
    action: async (a) => {
      actions.push(a);
      return opts.answer ? opts.answer(a) : { ok: true };
    },
    describe: async () => {
      const trees = opts.trees ?? [{ roots: [{ label: "Home" }] }];
      return trees[Math.min(treeAt++, trees.length - 1)];
    },
    screenshot: async () => Buffer.from(`png-${++shots}`),
  };
  return { control, actions, files, out: { write: (n: string, d: Buffer | string) => void files.set(n, d) } };
}

let clock = 0;
const tick = () => (clock += 5);

describe("runSteps", () => {
  it("drives each step through the SimDeck action it means, and records what it saw", async () => {
    const s = parseScenario(`
steps:
  - openUrl: app://x
  - tap: "#go"
  - type: hi
  - scroll: up
  - scrollUntilVisible: text=End
  - waitFor: { absent: text=Busy, timeoutMs: 900 }
  - assert: "#done"
  - assertNot: text=Error
  - sleep: 10
  - screenshot: home
`);
    const f = fakeControl();
    const r = await runSteps(s.steps, f.control, f.out, tick);
    assert.equal(r.passed, true);
    assert.deepEqual(f.actions, [
      { type: "openUrl", url: "app://x" },
      { type: "tapElement", selector: { id: "go" }, waitTimeoutMs: 15_000 },
      { type: "type", text: "hi" },
      { type: "gesture", preset: "scroll-up" },
      { type: "scrollUntilVisible", selector: { text: "End" } },
      { type: "waitForNot", selector: { text: "Busy" }, timeoutMs: 900 },
      { type: "assert", selector: { id: "done" } },
      { type: "assertNot", selector: { text: "Error" } },
      { type: "sleep", ms: 10 },
    ]);
    assert.deepEqual(
      r.steps.map((x) => x.action),
      ["openUrl app://x", "tap #go", 'type "hi"', "scroll up", "scrollUntilVisible text=End", "waitFor absent text=Busy", "assert #done", "assert absent text=Error", "sleep 10", "screenshot home"],
    );
    assert.ok(r.steps.every((x) => x.ok && x.ms === 5));
    assert.equal(String(f.files.get("home.png")), "png-1");
    assert.deepEqual(JSON.parse(String(f.files.get("home.ax.json"))), { roots: [{ label: "Home" }] });
    assert.match(r.steps.at(-1)!.observed, /1 labels/);
  });

  it("stops at the first failure and leaves the screen it failed on", async () => {
    const s = parseScenario("steps:\n  - tap: '#missing'\n  - screenshot: never");
    const f = fakeControl({
      answer: () => {
        throw new Error("no element matches #missing");
      },
    });
    const r = await runSteps(s.steps, f.control, f.out, tick);
    assert.equal(r.passed, false);
    assert.equal(r.steps.length, 1);
    assert.deepEqual(r.steps[0], { action: "tap #missing", ok: false, observed: "no element matches #missing", ms: 5 });
    assert.ok(f.files.has("failure.png"));
    assert.ok(f.files.has("failure.ax.json"));
    assert.ok(!f.files.has("never.png"));
  });

  it("treats a 2xx answer carrying ok:false as a failed assertion", async () => {
    const s = parseScenario("steps:\n  - assert: text=Paid");
    const f = fakeControl({ answer: () => ({ ok: false, message: "expected text=Paid" }) });
    const r = await runSteps(s.steps, f.control, f.out, tick);
    assert.equal(r.passed, false);
    assert.equal(r.steps[0]!.observed, "expected text=Paid");
  });
});

describe("waitForSettle", () => {
  const noSleep = async () => {};
  it("waits out a loading banner and an empty tree, then needs three identical polls", async () => {
    let t = 0;
    const trees = [{ roots: [] }, { roots: [{ label: "Bundling 40%" }] }, { roots: [{ label: "Home" }] }, { roots: [{ label: "Home" }] }, { roots: [{ label: "Home" }] }];
    const f = fakeControl({ trees });
    const r = await waitForSettle(f.control, { timeoutMs: 10_000, sleep: noSleep, now: () => (t += 100) });
    assert.deepEqual(r, { settled: true, labels: 1 });
  });

  it("gives up at the deadline on a screen that never stops changing", async () => {
    let t = 0;
    let n = 0;
    const control: VerifyControl = { action: async () => ({}), describe: async () => ({ roots: [{ label: `tick ${n++}` }] }), screenshot: async () => Buffer.alloc(0) };
    const r = await waitForSettle(control, { timeoutMs: 1000, sleep: noSleep, now: () => (t += 100) });
    assert.equal(r.settled, false);
  });
});
