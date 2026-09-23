import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { UiAction } from "../testing/control.ts";
import type { JevChooser, JevQuestion, JevResult } from "./jev.ts";
import { navigate, type NavigateRequest } from "./loop.ts";
import { candidatesFor, MAX_OPTIONS, readScreen } from "./screen.ts";

const home = { roots: [{ children: [{ role: "Heading", label: "Home" }, { role: "Button", label: "Settings", id: "settings" }, { role: "Button", label: "Profile" }] }] };
const settings = { roots: [{ children: [{ role: "Heading", label: "Settings" }, { role: "Button", label: "About" }] }] };
const login = { roots: [{ children: [{ role: "TextField", label: "Email" }, { role: "Button", label: "Sign in" }] }] };

interface Asked {
  state: { goal: string; history: string[]; screen: string[] };
  questions: Record<string, JevQuestion>;
}

/** Answers from a script: each entry picks an option (by key or by the label it taps) at a confidence. */
function scriptedJev(script: Array<{ pick: string; confidence?: number; reached?: number }>): JevChooser & { asked: Asked[] } {
  const asked: Asked[] = [];
  return {
    asked,
    async ask(state, questions): Promise<JevResult> {
      asked.push({ state: state as Asked["state"], questions });
      const s = script[asked.length - 1] ?? script[script.length - 1]!;
      const q = questions.next;
      assert.ok(q && q.type === "choice");
      const key = Object.keys(q.criteria).find((k) => k === s.pick || q.criteria[k]?.includes(`"${s.pick}"`));
      assert.ok(key, `no option for ${s.pick} in ${Object.keys(q.criteria).join(",")}`);
      const probabilities = Object.fromEntries(Object.keys(q.criteria).map((k) => [k, k === key ? (s.confidence ?? 0.99) : 0]));
      return {
        model: "jev-test",
        answers: {
          next: { type: "choice", choice: key, probabilities, confidence: s.confidence ?? 0.99 },
          reached: { type: "noul", noul: s.reached ?? (s.pick === "done" ? 0.95 : 0.05) },
        },
        usage: { input_tokens: 10 },
      };
    },
  };
}

function device(screens: unknown[]) {
  let i = 0;
  const acted: UiAction[] = [];
  return {
    acted,
    describe: async () => screens[Math.min(i, screens.length - 1)],
    act: async (a: UiAction) => {
      acted.push(a);
      if (a.type !== "type") i++;
      return { ok: true };
    },
  };
}

const req = (over: Partial<NavigateRequest> = {}): NavigateRequest => ({ goal: "Open About", maxSteps: 10, minConfidence: 0.7, text: {}, ...over });

describe("navigate loop", () => {
  it("stops with done when the model picks done, having performed each chosen tap", async () => {
    const dev = device([home, settings, { roots: [{ label: "About", role: "Heading" }] }]);
    const jev = scriptedJev([{ pick: "Settings" }, { pick: "About" }, { pick: "done" }]);
    const r = await navigate(req(), { ...dev, jev });
    assert.equal(r.outcome, "done");
    assert.equal(r.steps.length, 3);
    assert.deepEqual(dev.acted, [
      { type: "tapElement", selector: { id: "settings" } },
      { type: "tapElement", selector: { label: "About" } },
    ]);
    assert.deepEqual(jev.asked[2]!.state.history, ['tapped Button "Settings"', 'tapped Button "About"']);
  });

  it("hands back on low confidence without acting", async () => {
    const dev = device([home]);
    const r = await navigate(req(), { ...dev, jev: scriptedJev([{ pick: "Profile", confidence: 0.4 }]) });
    assert.equal(r.outcome, "escalated");
    assert.equal(r.reason, "low_confidence");
    assert.equal(dev.acted.length, 0);
    assert.ok(r.finalScreen.some((l) => l.includes('"Settings"')), "the caller gets the screen it must take over from");
  });

  it("stops after maxSteps actions", async () => {
    const dev = device([home, home, home, home]);
    let n = 0;
    const jev = scriptedJev([{ pick: "Settings" }, { pick: "Profile" }, { pick: "scroll_down" }, { pick: "back" }]);
    const r = await navigate(req({ maxSteps: 2 }), { ...dev, jev, settle: async () => void n++ });
    assert.equal(r.outcome, "limit");
    assert.equal(dev.acted.length, 2);
    assert.equal(n, 2);
  });

  it("hands back when it repeats a move on a screen that did not change", async () => {
    let calls = 0;
    const r = await navigate(req(), {
      describe: async () => home,
      act: async () => void calls++,
      jev: scriptedJev([{ pick: "Profile" }]),
    });
    assert.equal(r.reason, "repeating");
    assert.equal(calls, 1);
  });

  it("does not trust done when the goal check disagrees", async () => {
    const r = await navigate(req(), { ...device([home]), jev: scriptedJev([{ pick: "done", reached: 0.1 }]) });
    assert.equal(r.outcome, "escalated");
    assert.equal(r.reason, "done_disputed");
  });

  it("hands back on stuck and on an empty tree", async () => {
    assert.equal((await navigate(req(), { ...device([home]), jev: scriptedJev([{ pick: "stuck" }]) })).reason, "stuck");
    const empty = await navigate(req(), { ...device([{ roots: [] }]), jev: scriptedJev([{ pick: "done" }]) });
    assert.equal(empty.reason, "empty_screen");
  });

  it("turns a failed action and a failed decider into a hand-back with the trace so far", async () => {
    const failing = await navigate(req(), {
      describe: async () => home,
      act: async () => {
        throw new Error("No accessibility element matched.");
      },
      jev: scriptedJev([{ pick: "Settings" }]),
    });
    assert.equal(failing.reason, "action_failed");
    assert.equal(failing.steps.length, 1);
    const broken = await navigate(req(), {
      ...device([home]),
      jev: { ask: async () => Promise.reject(new Error("TypeSafe API 401: bad key")) },
    });
    assert.equal(broken.reason, "decider_error");
  });

  it("types a supplied value by name and never shows the value to the model", async () => {
    const dev = device([login, login, { roots: [{ role: "Heading", label: "Welcome" }] }]);
    const jev = scriptedJev([{ pick: "fill_e1_0" }, { pick: "Sign in" }, { pick: "done" }]);
    const r = await navigate(req({ goal: "Sign in", text: { email: "secret-address@example.no" } }), { ...dev, jev });
    assert.equal(r.outcome, "done");
    assert.deepEqual(dev.acted.slice(0, 2), [
      { type: "tapElement", selector: { label: "Email" } },
      { type: "type", text: "secret-address@example.no" },
    ]);
    const sent = JSON.stringify(jev.asked);
    const first = jev.asked[0]!.questions.next;
    assert.ok(first?.type === "choice" && first.criteria.fill_e1_0?.includes('"email"'), "the name is offered");
    assert.ok(!sent.includes("secret-address"), "the value is not");
    assert.ok(!JSON.stringify(r).includes("secret-address"), "nor is it in the trace");
  });
});

describe("candidate actions", () => {
  it("caps the options at the Choice limit and says how many it dropped", () => {
    const many = { roots: Array.from({ length: 400 }, (_, i) => ({ role: "Button", label: `Row ${i}` })) };
    const { candidates, dropped } = candidatesFor(readScreen(many), []);
    assert.equal(candidates.length, MAX_OPTIONS);
    assert.equal(dropped, 400 - (MAX_OPTIONS - 5));
    assert.equal(new Set(candidates.map((c) => c.key)).size, candidates.length, "option keys are unique");
    for (const k of ["done", "stuck", "back"]) assert.ok(candidates.some((c) => c.key === k), `${k} survives the cap`);
  });

  it("reads the AX-keyed endpoint shape too", () => {
    const s = readScreen({ roots: [{ AXRole: "AXButton", AXLabel: "Continue", AXUniqueId: "go" }] });
    assert.equal(s.elements[0]?.interactive, true);
    assert.deepEqual(candidatesFor(s, []).candidates.at(-1)?.actions, [{ type: "tapElement", selector: { id: "go" } }]);
  });
});
