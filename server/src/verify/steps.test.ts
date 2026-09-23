import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { UiAction } from "../testing/control.ts";
import { parseScenario } from "./scenario.ts";
import { confirmOpenPrompt, runSteps, waitForSettle, type VerifyControl } from "./steps.ts";

const APP_ROOT = { role: "Application", label: "Mobile", frame: { x: 0, y: 0, width: 1080, height: 810 } };

function appTree(children: unknown[]) {
  return { roots: [{ ...APP_ROOT, children }] };
}

function fakeControl(opts: { answer?: (a: UiAction) => unknown; trees?: unknown[]; quarterTurns?: number } = {}) {
  const actions: UiAction[] = [];
  const files = new Map<string, Buffer | string>();
  let shots = 0;
  let treeAt = 0;
  const control: VerifyControl = {
    quarterTurns: opts.quarterTurns ?? 0,
    action: async (a) => {
      actions.push(a);
      return opts.answer ? opts.answer(a) : { ok: true };
    },
    describe: async () => {
      const trees = opts.trees ?? [appTree([{ label: "Home", frame: { x: 0, y: 0, width: 10, height: 10 } }])];
      return trees[Math.min(treeAt++, trees.length - 1)];
    },
    screenshot: async () => Buffer.from(`png-${++shots}`),
  };
  return { control, actions, files, out: { write: (n: string, d: Buffer | string) => void files.set(n, d) } };
}

let clock = 0;
const tick = () => (clock += 5);
const noSleep = async () => {};

describe("runSteps", () => {
  it("drives each SimDeck-side step through the action it means, and records what it saw", async () => {
    const s = parseScenario(`
steps:
  - type: hi
  - waitFor: { absent: text=Busy, timeoutMs: 900 }
  - assert: { present: "#done" }
  - assertNot: text=Error
  - sleep: 10
  - screenshot: home
`);
    const f = fakeControl();
    const r = await runSteps(s.steps, f.control, f.out, tick, noSleep);
    assert.equal(r.passed, true);
    assert.deepEqual(f.actions, [
      { type: "type", text: "hi" },
      { type: "waitForNot", selector: { text: "Busy" }, timeoutMs: 900 },
      { type: "assert", selector: { id: "done" } },
      { type: "assertNot", selector: { text: "Error" } },
    ]);
    assert.deepEqual(
      r.steps.map((x) => x.action),
      ["type (2 chars)", "waitFor absent text=Busy", "assert present #done", "assert absent text=Error", "sleep 10", "screenshot home"],
    );
    assert.ok(r.steps.every((x) => x.ok && x.ms === 5));
    assert.equal(String(f.files.get("home.png")), "png-1");
    assert.match(r.steps.at(-1)!.observed, /2 labels/);
  });

  it("taps a selector at its own centre, turned into the unrotated screen's coordinates", async () => {
    const tree = appTree([{ label: "Innstillinger", frame: { x: 540, y: 0, width: 108, height: 64 } }]);
    const flat = fakeControl({ trees: [tree] });
    await runSteps(parseScenario("steps:\n  - tap: label=Innstillinger").steps, flat.control, flat.out, tick, noSleep);
    assert.deepEqual(flat.actions, [{ type: "tap", x: 0.55, y: 0.0395 }]);
    const turned = fakeControl({ trees: [tree], quarterTurns: 1 });
    await runSteps(parseScenario("steps:\n  - tap: label=Innstillinger").steps, turned.control, turned.out, tick, noSleep);
    assert.deepEqual(turned.actions, [{ type: "tap", x: 0.9605, y: 0.55 }]);
  });

  it("asserts on-screen by default, and says so when the match is scrolled away", async () => {
    const offscreen = appTree([{ label: "Levert av factory", frame: { x: 147, y: 2356, width: 640, height: 22 } }]);
    const f = fakeControl({ trees: [offscreen] });
    const r = await runSteps(parseScenario("steps:\n  - assert: text=Levert av factory").steps, f.control, f.out, tick, noSleep);
    assert.equal(r.passed, false);
    assert.match(r.steps[0]!.observed, /off screen/);
    const present = fakeControl({ trees: [offscreen] });
    const p = await runSteps(parseScenario("steps:\n  - assert: { present: text=Levert av factory }").steps, present.control, present.out, tick, noSleep);
    assert.equal(p.passed, true);
  });

  it("scrolls a landscape pane by dragging up in the rotated UI until the match is on screen", async () => {
    const at = (y: number) => appTree([{ label: "Levert av factory", frame: { x: 147, y, width: 640, height: 22 } }]);
    const f = fakeControl({ trees: [at(2356), at(1600), at(400)], quarterTurns: 1 });
    const r = await runSteps(parseScenario("steps:\n  - scrollUntilVisible: text=Levert av factory").steps, f.control, f.out, tick, noSleep);
    assert.equal(r.passed, true);
    assert.equal(r.steps[0]!.observed, "visible after 2 scroll(s)");
    const swipe = f.actions[0] as Extract<UiAction, { type: "swipe" }>;
    assert.equal(f.actions.length, 2);
    assert.equal(swipe.type, "swipe");
    assert.equal(swipe.startY, swipe.endY, "an upward drag in landscape is a horizontal one on the unrotated screen");
    assert.ok(swipe.startX < swipe.endX);
    assert.equal(swipe.startY, 0.4324, "the drag runs through the pane that holds the match");
  });

  it("does not stop with the match on the screen's edge, where a card can still clip it", async () => {
    const at = (y: number) => appTree([{ label: "Levert av factory", frame: { x: 147, y, width: 640, height: 22 } }]);
    const f = fakeControl({ trees: [at(2356), at(760), at(360)], quarterTurns: 1 });
    const r = await runSteps(parseScenario("steps:\n  - scrollUntilVisible: text=Levert av factory").steps, f.control, f.out, tick, noSleep);
    assert.equal(r.steps[0]!.observed, "visible after 1 scroll(s) and 1 nudge(s) towards the middle");
    const nudge = f.actions[1] as Extract<UiAction, { type: "swipe" }>;
    assert.ok(Math.abs(nudge.endX - nudge.startX) < 0.5, "a nudge is shorter than a page");
  });

  it("gives up when scrolling stops moving the match", async () => {
    const stuck = appTree([{ label: "Far", frame: { x: 0, y: 3000, width: 10, height: 10 } }]);
    const f = fakeControl({ trees: [stuck] });
    const r = await runSteps(parseScenario("steps:\n  - scrollUntilVisible: text=Far").steps, f.control, f.out, tick, noSleep);
    assert.equal(r.passed, false);
    assert.match(r.steps[0]!.observed, /does not move it into view/);
  });

  it("stops at the first failure and leaves the screen it failed on", async () => {
    const s = parseScenario("steps:\n  - tap: '#missing'\n  - screenshot: never");
    let t = 0;
    const f = fakeControl();
    const r = await runSteps(s.steps, f.control, f.out, () => (t += 1000), noSleep);
    assert.equal(r.passed, false);
    assert.equal(r.steps.length, 1);
    assert.equal(r.steps[0]!.observed, "no element matches #missing");
    assert.ok(f.files.has("failure.png"));
    assert.ok(f.files.has("failure.ax.json"));
    assert.ok(!f.files.has("never.png"));
  });

  it("treats a 2xx answer carrying ok:false as a failed step", async () => {
    const s = parseScenario("steps:\n  - assert: { present: text=Paid }");
    const f = fakeControl({ answer: () => ({ ok: false, message: "expected text=Paid" }) });
    const r = await runSteps(s.steps, f.control, f.out, tick, noSleep);
    assert.equal(r.passed, false);
    assert.equal(r.steps[0]!.observed, "expected text=Paid");
  });
});

describe("confirmOpenPrompt", () => {
  const prompt = {
    roots: [
      {
        role: "Application",
        frame: { x: 0, y: 0, width: 1080, height: 810 },
        children: [
          { role: "StaticText", label: "Open in “Okam POS”?", frame: { x: 409.5, y: 410, width: 20.5, height: 260 } },
          { role: "Button", label: "Cancel", frame: { x: 342, y: 396, width: 48, height: 140 } },
          { role: "Button", label: "Open", frame: { x: 342, y: 544, width: 48, height: 140 } },
        ],
      },
    ],
  };

  it("taps Open where it really is: SpringBoard reports the prompt in the unrotated screen's points", async () => {
    const f = fakeControl({ trees: [prompt], quarterTurns: 1 });
    assert.equal(await confirmOpenPrompt(f.control, { sleep: noSleep, now: tick }), true);
    assert.deepEqual(f.actions, [{ type: "tap", x: 0.4519, y: 0.5685 }]);
  });

  it("taps nothing when there is no prompt, and does not mistake an app's own Open button for one", async () => {
    let t = 0;
    const f = fakeControl({
      trees: [
        appTree([
          { label: "Open in “Okam POS”?", frame: { x: 0, y: 0, width: 50, height: 20 } },
          { label: "Open", frame: { x: 0, y: 30, width: 50, height: 50 } },
        ]),
      ],
    });
    assert.equal(await confirmOpenPrompt(f.control, { sleep: noSleep, now: () => (t += 500) }), false);
    assert.deepEqual(f.actions, []);
  });

  it("confirms the prompt after an openUrl step", async () => {
    const f = fakeControl({ trees: [prompt], quarterTurns: 1 });
    const r = await runSteps(parseScenario("steps:\n  - openUrl: app://x").steps, f.control, f.out, tick, noSleep);
    assert.equal(r.steps[0]!.observed, "confirmed the system's open prompt");
    assert.deepEqual(f.actions[0], { type: "openUrl", url: "app://x" });
  });
});

describe("waitForSettle", () => {
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
    const control: VerifyControl = { quarterTurns: 0, action: async () => ({}), describe: async () => ({ roots: [{ label: `tick ${n++}` }] }), screenshot: async () => Buffer.alloc(0) };
    const r = await waitForSettle(control, { timeoutMs: 1000, sleep: noSleep, now: () => (t += 100) });
    assert.equal(r.settled, false);
  });
});
