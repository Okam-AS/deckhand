import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { UiAction } from "./control.ts";
import { drive, settle, type DriveDeps } from "./drive.ts";
import { RefError, ScreenBook, shapeOf } from "./screen.ts";

const tree = (...labels: string[]) => ({
  roots: [{ role: "Application", label: "App", frame: { x: 0, y: 0, width: 400, height: 800 }, children: labels.map((l, i) => ({ role: "Button", label: l, frame: { x: 0, y: i * 50, width: 400, height: 40 } })) }],
});

/** A device on a fake clock: each capture costs 800ms (SimDeck's compact describe, measured), and shows `screens(t)`. */
function fakeDevice(screens: (t: number) => unknown, platform: "ios" | "android" = "ios") {
  let t = 0;
  const acted: UiAction[] = [];
  let looks = 0;
  const deps: DriveDeps = {
    platform,
    book: new ScreenBook(),
    act: async (a) => {
      acted.push(a);
      if ("selector" in a && a.selector.label === "missing") throw new Error("No accessibility element matched.");
      return { ok: true };
    },
    observe: async () => {
      looks++;
      const s = screens(t);
      t += 800;
      return s;
    },
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
  };
  return { deps, acted, looks: () => looks };
}

describe("settle", () => {
  it("returns the first capture that a second one agrees with, once the screen has left its old shape", async () => {
    // The push starts 0.6s after the tap returns and runs until 2.0s.
    const { deps } = fakeDevice((t) => (t < 600 ? tree("Old") : t < 2000 ? tree(`Moving ${t}`) : tree("New")));
    const r = await settle(deps, shapeOf(tree("Old")), 1000);
    assert.equal(shapeOf(r.tree), shapeOf(tree("New")));
  });

  it("does not take an unchanged screen for the result before the change wait has run out", async () => {
    const { deps, looks } = fakeDevice((t) => (t < 1600 ? tree("Old") : tree("New")));
    const r = await settle(deps, shapeOf(tree("Old")), 2000);
    assert.equal(shapeOf(r.tree), shapeOf(tree("New")));
    assert.ok(looks() >= 3);
  });

  it("returns an unchanged screen once the change wait has run out", async () => {
    const { deps, looks } = fakeDevice(() => tree("Same"));
    await settle(deps, shapeOf(tree("Same")), 1000);
    assert.equal(looks(), 2);
  });

  it("gives up on a screen that never stops moving", async () => {
    const { deps } = fakeDevice((t) => tree(`Spinner ${t}`));
    const r = await settle(deps, undefined, 1000);
    assert.ok(r.ms >= 5000 && r.ms < 6000, `gave up at ${r.ms}ms`);
  });

  it("does not poll Android, where every capture is a multi-second dump", async () => {
    const { deps, looks } = fakeDevice(() => tree("Same"), "android");
    await settle(deps, undefined, 1000);
    assert.equal(looks(), 1);
  });
});

describe("drive", () => {
  it("returns the screen after one action, as what changed", async () => {
    let tapped = false;
    const { deps } = fakeDevice(() => (tapped ? tree("A", "B", "C", "D", "Toast") : tree("A", "B", "C", "D")));
    deps.book.record(tree("A", "B", "C", "D"));
    deps.book.full();
    const act = deps.act;
    deps.act = async (a) => {
      tapped = true;
      return act(a);
    };
    const r = await drive(deps, [{ type: "tap", x: 0.5, y: 0.5 }], "auto");
    assert.equal(r.failure, undefined);
    assert.match(r.screen!, /\+ e6 Button "Toast"/);
  });

  it("runs a list in order and settles once, after the last step", async () => {
    const { deps, acted, looks } = fakeDevice(() => tree("A"));
    const r = await drive(deps, [{ type: "tapElement", selector: { id: "x" } }, { type: "type", text: "hi" }, { type: "tapElement", selector: { id: "go" } }], "auto");
    assert.deepEqual(acted.map((a) => a.type), ["tapElement", "type", "tapElement"]);
    assert.equal(r.results.length, 3);
    assert.equal(looks(), 2, "two agreeing captures after the last step, none between steps");
  });

  it("lets a step's effect begin before the next step acts", async () => {
    const { deps } = fakeDevice(() => tree("A"));
    const at: number[] = [];
    const act = deps.act;
    deps.act = async (a) => {
      at.push(deps.now!());
      return act(a);
    };
    await drive(deps, [{ type: "tapElement", selector: { id: "field" } }, { type: "type", text: "99999999" }], "none");
    assert.ok(at[1]! - at[0]! >= 250, `typed ${at[1]! - at[0]!}ms after the tap that focused the field`);
  });

  it("gives a later tap in a list time for its element to render, and leaves an explicit wait alone", async () => {
    const { deps, acted } = fakeDevice(() => tree("A"));
    await drive(deps, [{ type: "tapElement", selector: { id: "a" } }, { type: "tapElement", selector: { id: "b" } }, { type: "tapElement", selector: { id: "c" }, waitTimeoutMs: 50 }], "none");
    assert.deepEqual(acted.map((a) => (a as { waitTimeoutMs?: number }).waitTimeoutMs), [undefined, 3000, 50]);
  });

  it("stops at the first failure and still shows where it stopped", async () => {
    const { deps, acted } = fakeDevice(() => tree("A"));
    const r = await drive(deps, [{ type: "tapElement", selector: { id: "a" } }, { type: "tapElement", selector: { label: "missing" } }, { type: "back" }], "auto");
    assert.equal(r.failure?.index, 1);
    assert.equal(r.failure?.searched, "missing");
    assert.equal(acted.length, 2, "nothing after the failure runs");
    assert.match(r.screen!, /Screen r1/);
  });

  it("takes no look for a verifier", async () => {
    const { deps, looks } = fakeDevice(() => tree("A"));
    const r = await drive(deps, [{ type: "assert", selector: { label: "A" } }], "none");
    assert.equal(r.screen, undefined);
    assert.equal(looks(), 0);
  });

  it("returns the action's result when the look after it fails", async () => {
    const { deps } = fakeDevice(() => tree("A"));
    deps.observe = async () => {
      throw new Error("describe failed (500)");
    };
    const r = await drive(deps, [{ type: "tap", x: 0.5, y: 0.5 }], "auto");
    assert.equal(r.failure, undefined);
    assert.equal(r.results.length, 1);
    assert.equal(r.screen, undefined);
    assert.match(r.screenError!, /describe failed/);
  });

  it("sends SimDeck a selector for a ref, and a point for a ref that has no unique name", async () => {
    const { deps, acted } = fakeDevice(() => tree("Mer", "Mer", "Innstillinger"));
    const s = deps.book.record(tree("Mer", "Mer", "Innstillinger"));
    const refOf = (label: string, nth = 0) => [...s.nodes].filter(([, n]) => n.label === label)[nth]![0];
    await drive(deps, [{ type: "tapElement", selector: { ref: refOf("Innstillinger") } }], "none");
    assert.deepEqual(acted[0], { type: "tapElement", selector: { label: "Innstillinger" } });
    const fresh = deps.book.snapshot!;
    await drive(deps, [{ type: "tapElement", selector: { ref: [...fresh.nodes].filter(([, n]) => n.label === "Mer")[1]![0] } }], "none");
    assert.equal(acted[1]!.type, "tap", "a duplicate label is tapped at the element's centre");
  });

  it("re-reads the screen before tapping a ref's centre from a capture older than this call", async () => {
    const { deps, acted } = fakeDevice(() => tree("Only"));
    // A ref with no name at all: only its centre can hit it.
    const unnamed = { roots: [{ role: "Application", frame: { x: 0, y: 0, width: 400, height: 800 }, children: [{ role: "Image", value: "1", frame: { x: 0, y: 0, width: 40, height: 40 } }] }] };
    const ref = [...deps.book.record(unnamed).nodes.keys()][0]!;
    let reads = 0;
    deps.observe = async () => {
      reads++;
      return unnamed;
    };
    await drive(deps, [{ type: "tapElement", selector: { ref } }], "none");
    assert.equal(reads, 1, "a capture from before the call was replaced before the tap");
    await drive(deps, [{ type: "back" }, { type: "tapElement", selector: { ref } }], "none");
    assert.equal(reads, 2, "and so was one from before an action in the same list");
    assert.deepEqual(acted.map((a) => a.type), ["tap", "back", "tap"]);
  });

  it("fails a ref it cannot resolve without acting", async () => {
    const { deps, acted } = fakeDevice(() => tree("A"));
    const r = await drive(deps, [{ type: "tapElement", selector: { ref: "e42" } }], "none");
    assert.ok(r.failure?.error instanceof RefError);
    assert.equal(acted.length, 0);
  });
});
