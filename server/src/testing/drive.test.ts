import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { UiAction } from "./control.ts";
import { drive, settle, type DriveDeps } from "./drive.ts";
import { RefError, ScreenBook } from "./screen.ts";

const tree = (...labels: string[]) => ({
  roots: [{ role: "Application", label: "App", frame: { x: 0, y: 0, width: 400, height: 800 }, children: labels.map((l, i) => ({ role: "Button", label: l, frame: { x: 0, y: i * 50, width: 400, height: 40 } })) }],
});

/** A device on a fake clock: each probe costs 100ms, and the screen is whatever `screens` says at that time. */
function fakeDevice(screens: (t: number) => unknown, platform: "ios" | "android" = "ios") {
  let t = 0;
  const acted: UiAction[] = [];
  const probes: number[] = [];
  const deps: DriveDeps = {
    platform,
    book: new ScreenBook(),
    act: async (a) => {
      acted.push(a);
      if ("selector" in a && a.selector.label === "missing") throw new Error("No accessibility element matched.");
      return { ok: true };
    },
    probe: async () => {
      probes.push(t);
      const s = screens(t);
      t += 100;
      return s;
    },
    observe: async () => screens(t),
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
  };
  return { deps, acted, probes, clock: () => t };
}

describe("settle", () => {
  it("returns once the screen has left its old shape and two probes agree", async () => {
    // The push transition starts 300ms after the tap returns and runs for 400ms.
    const { deps } = fakeDevice((t) => (t < 300 ? tree("Old") : t < 700 ? tree(`Moving ${t}`) : tree("New")));
    const before = (await import("./screen.ts")).shapeOf(tree("Old"));
    const r = await settle(deps, before, 1000);
    assert.ok(r.ms >= 700 && r.ms < 1200, `settled at ${r.ms}ms`);
  });

  it("gives an unchanged screen the full change wait before calling it settled", async () => {
    const { deps } = fakeDevice(() => tree("Same"));
    const before = (await import("./screen.ts")).shapeOf(tree("Same"));
    const r = await settle(deps, before, 1000);
    assert.ok(r.ms >= 1000 && r.ms < 1300, `settled at ${r.ms}ms`);
  });

  it("gives up on a screen that never stops moving", async () => {
    const { deps } = fakeDevice((t) => tree(`Spinner ${t}`));
    const r = await settle(deps, undefined, 1000);
    assert.ok(r.ms >= 4000 && r.ms < 4300, `gave up at ${r.ms}ms`);
  });

  it("does not poll Android, where every capture is a multi-second dump", async () => {
    const { deps, probes } = fakeDevice(() => tree("Same"), "android");
    await settle(deps, undefined, 1000);
    assert.equal(probes.length, 0);
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

  it("runs a list in order with one look at the end", async () => {
    const { deps, acted } = fakeDevice(() => tree("A"));
    let looks = 0;
    const observe = deps.observe;
    deps.observe = async () => {
      looks++;
      return observe();
    };
    const r = await drive(deps, [{ type: "tapElement", selector: { id: "x" } }, { type: "type", text: "hi" }, { type: "tapElement", selector: { id: "go" } }], "auto");
    assert.deepEqual(acted.map((a) => a.type), ["tapElement", "type", "tapElement"]);
    assert.equal(r.results.length, 3);
    assert.equal(looks, 1);
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
    const { deps, probes } = fakeDevice(() => tree("A"));
    const r = await drive(deps, [{ type: "assert", selector: { label: "A" } }], "none");
    assert.equal(r.screen, undefined);
    assert.equal(probes.length, 0);
  });

  it("returns the action's result when the look after it fails", async () => {
    const { deps } = fakeDevice(() => tree("A"));
    deps.observe = async () => {
      throw new Error("describe failed (500)");
    };
    deps.probe = async () => {
      throw new Error("tree failed (500)");
    };
    const r = await drive(deps, [{ type: "tap", x: 0.5, y: 0.5 }], "auto");
    assert.equal(r.failure, undefined);
    assert.equal(r.results.length, 1);
    assert.equal(r.screen, undefined);
    assert.match(r.screenError!, /describe failed/);
  });

  it("sends SimDeck a selector for a ref, and a point for a ref that has no unique name", async () => {
    const { deps, acted } = fakeDevice(() => tree("Mer", "Mer", "Innstillinger"));
    deps.book.record(tree("Mer", "Mer", "Innstillinger"));
    await drive(deps, [{ type: "tapElement", selector: { ref: "e4" } }], "none");
    await drive(deps, [{ type: "tapElement", selector: { ref: "e3" } }], "none");
    assert.deepEqual(acted[0], { type: "tapElement", selector: { label: "Innstillinger" } });
    assert.equal(acted[1]!.type, "tap", "a duplicate label is tapped at the element's centre");
  });

  it("re-reads the screen before tapping a ref's centre from a capture older than this call", async () => {
    const { deps, acted } = fakeDevice(() => tree("Mer", "Mer"));
    deps.book.record(tree("Mer", "Mer"));
    let looks = 0;
    const observe = deps.observe;
    deps.observe = async () => {
      looks++;
      return observe();
    };
    await drive(deps, [{ type: "tapElement", selector: { ref: "e3" } }], "none");
    assert.equal(looks, 1, "a capture from before the call was replaced before the tap");
    await drive(deps, [{ type: "back" }, { type: "tapElement", selector: { ref: "e3" } }], "none");
    assert.equal(looks, 2, "and so was one from before an action in the same list");
    assert.deepEqual(acted.map((a) => a.type), ["tap", "back", "tap"]);
  });

  it("fails a ref it cannot resolve without acting", async () => {
    const { deps, acted } = fakeDevice(() => tree("A"));
    const r = await drive(deps, [{ type: "tapElement", selector: { ref: "e42" } }], "none");
    assert.ok(r.failure?.error instanceof RefError);
    assert.equal(acted.length, 0);
  });
});
