import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { JevChooser, JevQuestion, JevResult } from "./jev.ts";
import { encodePng } from "../verify/png.ts";
import { DEFAULT_THRESHOLDS, TOKEN_BUDGET, estimateTokens, navigate, type LoopAction, type NavigateRequest } from "./loop.ts";

const VP = { x: 0, y: 0, width: 400, height: 800 };
/** A screen whose rows sit one per 80pt, so row i's centre is at y = (i * 80 + 140) / 800. */
function screen(heading: string, rows: Array<string | { role: string; label?: string; value?: string }>) {
  return {
    roots: [
      {
        role: "Application",
        frame: VP,
        children: [
          { role: "Heading", label: heading, frame: { x: 0, y: 40, width: 400, height: 40 } },
          ...rows.map((r, i) => ({ ...(typeof r === "string" ? { role: "Button", label: r } : r), frame: { x: 0, y: 100 + i * 80, width: 400, height: 80 } })),
        ],
      },
    ],
  };
}
const home = screen("Home", ["Settings", "Profile"]);
const settings = screen("Settings", ["About"]);
const about = screen("About", []);
const login = screen("Sign in", [{ role: "TextField", label: "Email" }, "Sign in"]);

interface Asked {
  state: { goal: string; actions_taken: string[]; screen: string[]; ui_language?: string };
  questions: Record<string, JevQuestion>;
}

/** Answers from a script: each entry picks the option whose key starts with, or names, `pick`. */
function scriptedJev(script: Array<{ pick: string; confidence?: number; reached?: number }>): JevChooser & { asked: Asked[] } {
  const asked: Asked[] = [];
  return {
    asked,
    async ask(state, questions): Promise<JevResult> {
      asked.push({ state: state as Asked["state"], questions });
      const s = script[asked.length - 1] ?? script[script.length - 1]!;
      const q = questions.next;
      assert.ok(q && q.type === "choice");
      const key = Object.keys(q.criteria).find((k) => k.startsWith(`${s.pick}:`) || k.startsWith(`${s.pick} `) || k.includes(`"${s.pick}"`));
      assert.ok(key, `no option for ${s.pick} in ${Object.keys(q.criteria).join(" | ")}`);
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

/** A device that moves to the next screen on every action except typing. */
function device(screens: unknown[]) {
  let i = 0;
  const acted: LoopAction[] = [];
  return {
    acted,
    describe: async () => screens[Math.min(i, screens.length - 1)],
    act: async (a: LoopAction) => {
      acted.push(a);
      if (a.type !== "type") i++;
      return { ok: true };
    },
  };
}

const row = (i: number) => ({ type: "tap", x: 0.5, y: (100 + i * 80 + 40) / 800 });
const req = (over: Partial<NavigateRequest> = {}): NavigateRequest => ({ goal: "Open About", maxSteps: 10, text: {}, ...over });

describe("navigate loop", () => {
  it("stops with done, having tapped the centre of each element it chose", async () => {
    const dev = device([home, settings, about]);
    const jev = scriptedJev([{ pick: "Settings" }, { pick: "About" }, { pick: "done" }]);
    const r = await navigate(req(), { ...dev, jev });
    assert.equal(r.outcome, "done");
    assert.equal(r.steps.length, 3);
    assert.deepEqual(dev.acted, [row(0), row(0)]);
    assert.deepEqual(jev.asked[2]!.state.actions_taken, ['tapped Button "Settings"', 'tapped Button "About"']);
  });

  it("gates each kind of action at its own confidence: a tap acts where a done hands back", async () => {
    const tap = await navigate(req(), { ...device([home, about]), jev: scriptedJev([{ pick: "Settings", confidence: 0.55 }, { pick: "done" }]) });
    assert.equal(tap.outcome, "done", "a tap at 0.55 clears the tap threshold");
    const done = await navigate(req(), { ...device([about]), jev: scriptedJev([{ pick: "done", confidence: 0.55, reached: 0.6 }]) });
    assert.equal(done.reason, "low_confidence", "a done at 0.55 does not");
    assert.ok(DEFAULT_THRESHOLDS.done > DEFAULT_THRESHOLDS.tap);
  });

  it("accepts a done under its threshold only when the goal check agrees strongly", async () => {
    const agreed = await navigate(req(), { ...device([about]), jev: scriptedJev([{ pick: "done", confidence: 0.65, reached: 0.9 }]) });
    assert.equal(agreed.outcome, "done");
    const floor = await navigate(req({ minConfidence: 0.8 }), { ...device([about]), jev: scriptedJev([{ pick: "done", confidence: 0.65, reached: 0.9 }]) });
    assert.equal(floor.reason, "low_confidence", "a caller's own floor is not bent");
  });

  it("hands back below a caller's minConfidence without acting", async () => {
    const dev = device([home]);
    const r = await navigate(req({ minConfidence: 0.9 }), { ...dev, jev: scriptedJev([{ pick: "Profile", confidence: 0.8 }]) });
    assert.equal(r.reason, "low_confidence");
    assert.equal(dev.acted.length, 0);
    assert.ok(r.finalScreen.some((l) => l.includes('"Settings"')), "the caller gets the screen it must take over from");
  });

  it("stops after maxSteps actions", async () => {
    const dev = device([home, settings, home, settings]);
    const jev = scriptedJev([{ pick: "Settings" }, { pick: "back" }, { pick: "Profile" }, { pick: "back" }]);
    const r = await navigate(req({ maxSteps: 2 }), { ...dev, jev });
    assert.equal(r.outcome, "limit");
    assert.equal(dev.acted.length, 2);
  });

  it("hands back when it repeats a move on a screen that did not change", async () => {
    let calls = 0;
    const r = await navigate(req(), { describe: async () => home, act: async () => void calls++, jev: scriptedJev([{ pick: "Profile" }]) });
    assert.equal(r.reason, "repeating");
    assert.equal(calls, 1);
  });

  it("does not trust done when the goal check disagrees", async () => {
    const r = await navigate(req(), { ...device([home]), jev: scriptedJev([{ pick: "done", reached: 0.1 }]) });
    assert.equal(r.reason, "done_disputed");
  });

  it("hands back on stuck and on a tree with nothing to read", async () => {
    assert.equal((await navigate(req(), { ...device([home]), jev: scriptedJev([{ pick: "stuck" }]) })).reason, "stuck");
    const empty = await navigate(req(), { ...device([{ roots: [] }]), jev: scriptedJev([{ pick: "done" }]) });
    assert.equal(empty.reason, "empty_screen");
  });

  it("turns a failed action and a failed decider into a hand-back with the trace so far", async () => {
    const failing = await navigate(req(), {
      describe: async () => home,
      act: async () => {
        throw new Error("SimDeck refused the tap");
      },
      jev: scriptedJev([{ pick: "Settings" }]),
    });
    assert.equal(failing.reason, "action_failed");
    assert.equal(failing.steps.length, 1);
    const broken = await navigate(req(), { ...device([home]), jev: { ask: async () => Promise.reject(new Error("TypeSafe API 401: bad key")) } });
    assert.equal(broken.reason, "decider_error");
  });

  it("types a supplied value by name and never shows the value to the model", async () => {
    const dev = device([login, login, about]);
    const jev = scriptedJev([{ pick: 'type the "email" value' }, { pick: "Sign in" }, { pick: "done" }]);
    const r = await navigate(req({ goal: "Sign in", text: { email: "secret-address@example.no" } }), { ...dev, jev });
    assert.equal(r.outcome, "done", r.message);
    assert.deepEqual(dev.acted.slice(0, 2), [row(0), { type: "type", text: "secret-address@example.no" }]);
    assert.ok(!JSON.stringify(jev.asked).includes("secret-address"), "the value is not sent");
    assert.ok(!JSON.stringify(r).includes("secret-address"), "nor is it in the trace");
  });

  it("sends the device's UI language when it is known", async () => {
    const jev = scriptedJev([{ pick: "done" }]);
    await navigate(req({ locale: "nb-NO" }), { ...device([about]), jev });
    assert.equal(jev.asked[0]!.state.ui_language, "nb-NO");
  });

  it("reports every request's size before sending it", async () => {
    const seen: number[] = [];
    let sent = 0;
    const jev = scriptedJev([{ pick: "Settings" }, { pick: "done" }]);
    const counting: JevChooser = {
      ask: (s, q) => {
        assert.equal(seen.length, sent + 1, "the egress was reported before the request went out");
        sent++;
        assert.equal(seen[seen.length - 1], Buffer.byteLength(JSON.stringify({ state: s, questions: q })));
        return jev.ask(s, q);
      },
    };
    await navigate(req(), { ...device([home, about]), jev: counting, onEgress: (e) => void seen.push(e.bytes) });
    assert.equal(seen.length, 2);
  });

  it("keeps state plus the Choice under Jev's token limit on a huge screen", async () => {
    const huge = screen("Big", Array.from({ length: 3000 }, (_, i) => `Row number ${i} with a fairly long label here`));
    const jev = scriptedJev([{ pick: "done" }]);
    const r = await navigate(req(), { ...device([huge]), jev });
    assert.equal(r.stateTruncated, true);
    const asked = jev.asked[0]!;
    assert.ok(estimateTokens(asked.state) + estimateTokens(asked.questions.next) <= TOKEN_BUDGET);
    assert.ok(Object.keys((asked.questions.next as { criteria: object }).criteria).length <= 255);
  });
});

describe("navigate waits for a still screen", () => {
  /** A fake clock that advances by `step` ms on every read. */
  function clock(step = 50) {
    let t = 0;
    return () => (t += step);
  }
  const shot = (n: number) => Buffer.from(`frame-${n}`);

  it("does not read the tree while the screen is still moving", async () => {
    let frames = 0;
    const describedAt: number[] = [];
    const dev = device([home, about]);
    const r = await navigate(req(), {
      ...dev,
      describe: async () => {
        describedAt.push(frames);
        return dev.describe();
      },
      // Moving for the first six frames after every action, then still.
      frame: async () => shot(frames++ % 20 < 6 ? frames : 999),
      jev: scriptedJev([{ pick: "Settings" }, { pick: "done" }]),
      now: clock(),
    });
    assert.equal(r.outcome, "done", r.message);
    assert.ok(describedAt[0]! > 6, `described after frame ${describedAt[0]}, while it was still moving`);
    assert.ok(r.steps.every((s) => s.settled));
  });

  it("waits out a transition that starts only after the tap has returned", async () => {
    let frames = 0;
    let described = -1;
    const r = await navigate(req(), {
      describe: async () => {
        described = frames;
        return about;
      },
      act: async () => {},
      // Two identical frames first, as a push animation has not begun yet, then motion, then still.
      frame: async () => {
        const i = frames++;
        return shot(i < 2 ? 0 : i < 7 ? i : 99);
      },
      jev: scriptedJev([{ pick: "done" }]),
      now: clock(),
    });
    assert.equal(r.outcome, "done");
    assert.ok(described >= 7, `read the tree at frame ${described}, mid-transition`);
  });

  it("does not act when the screen changed between reading it and acting", async () => {
    let described = 0;
    const dev = device([home, about]);
    const r = await navigate(req(), {
      ...dev,
      describe: async () => {
        described++;
        return dev.describe();
      },
      // Still while it settles, then a different screen by the time it would tap.
      frame: async () => shot(described === 0 ? 1 : 2),
      jev: scriptedJev([{ pick: "Settings" }, { pick: "Settings" }, { pick: "done" }]),
      now: clock(),
    });
    assert.equal(r.steps[0]!.did.startsWith("not run"), true, r.steps[0]!.did);
    assert.equal(dev.acted.length, 1, "it re-read the screen and acted once, on the one it had read");
  });

  it("guards the tapped element's own pixels, so an animation elsewhere does not stop every tap", async () => {
    // 40x80 px screen over the 400x800 tree: "Settings" (row 0) is pixel rows 10-17.
    const png = (paint: (x: number, y: number) => number) => {
      const data = Buffer.alloc(40 * 80 * 4, 255);
      for (let y = 0; y < 80; y++) for (let x = 0; x < 40; x++) data.fill(paint(x, y), (y * 40 + x) * 4, (y * 40 + x) * 4 + 3);
      return encodePng({ width: 40, height: 80, data });
    };
    const run = async (moving: (x: number, y: number) => boolean) => {
      let described = 0;
      const dev = device([home, about]);
      const r = await navigate(req(), {
        ...dev,
        describe: async () => {
          described++;
          return dev.describe();
        },
        frame: async () => png((x, y) => (described > 0 && moving(x, y) ? 0 : 255)),
        jev: scriptedJev([{ pick: "Settings" }, { pick: "Settings" }, { pick: "done" }]),
        now: clock(),
      });
      return r.steps.filter((s) => s.did.startsWith("not run")).length;
    };
    assert.equal(await run((_x, y) => y >= 60), 0, "a change far from the target does not hold the tap back");
    assert.equal(await run((_x, y) => y >= 10 && y < 18), 1, "a change on the target holds it back once, until it is still");
    let heldBack = false;
    const dev = device([home, about]);
    let described = 0;
    const r = await navigate(req(), {
      ...dev,
      describe: async () => {
        described++;
        return dev.describe();
      },
      frame: async () => png((_x, y) => (described === 1 && y >= 10 && y < 18 ? 0 : 255)),
      jev: scriptedJev([{ pick: "Settings" }, { pick: "Settings" }, { pick: "done" }]),
      now: clock(),
    });
    heldBack = r.steps[0]!.did.startsWith("not run");
    assert.ok(heldBack, `a change inside the target's frame holds the tap back: ${JSON.stringify(r.steps.map((s) => s.did))}`);
  });

  it("measures the screen from the screenshot when a dialog's root is all the tree has", async () => {
    const dialog = { roots: [{ type: "FrameLayout", frame: { x: 0, y: 20, width: 40, height: 40 }, children: [{ type: "Button", text: "Allow", frame: { x: 0, y: 50, width: 40, height: 10 } }] }] };
    const shot = encodePng({ width: 40, height: 80, data: Buffer.alloc(40 * 80 * 4, 255) });
    const dev = device([dialog, about]);
    await navigate(req(), { ...dev, frame: async () => shot, jev: scriptedJev([{ pick: "Allow" }, { pick: "done" }]), now: clock() });
    assert.deepEqual(dev.acted, [{ type: "tap", x: 0.5, y: 0.6875 }]);
  });

  it("hands back when the screen changed but the tree did not", async () => {
    let acted = false;
    const r = await navigate(req(), {
      describe: async () => home,
      act: async () => void (acted = true),
      frame: async () => shot(acted ? 2 : 1),
      jev: scriptedJev([{ pick: "Settings" }, { pick: "Profile" }]),
      now: clock(),
    });
    assert.equal(r.reason, "stale_tree", r.message);
  });
});
