import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { candidateTurns, hitMatches, nativeProbePoint, presetSwipe, probeNodes, selectorTarget, toNative, uiBounds } from "./orientation.ts";

const LANDSCAPE = { x: 0, y: 0, width: 1210, height: 834 };

const node = (extra: Record<string, unknown>, frame: { x: number; y: number; width: number; height: number }, children: unknown[] = []) => ({
  ...extra,
  frame,
  children,
});

describe("toNative", () => {
  // Measured on an iPad Pro 11 (M5), iOS 26.5, KDS demo: kitchen-menu at (1146,40,48,48) in a
  // 1210×834 UI opened from (0.923, 0.967) turned one way and (0.077, 0.033) the other.
  it("places the KDS menu button where it opened on the device, both landscape directions", () => {
    const u = (1146 + 24) / 1210;
    const v = (40 + 24) / 834;
    const q1 = toNative(u, v, 1);
    const q3 = toNative(u, v, 3);
    assert.deepEqual([q1.x.toFixed(3), q1.y.toFixed(3)], ["0.923", "0.967"]);
    assert.deepEqual([q3.x.toFixed(3), q3.y.toFixed(3)], ["0.077", "0.033"]);
  });

  it("is the identity upright and a half turn upside down", () => {
    assert.deepEqual(toNative(0.2, 0.7, 0), { x: 0.2, y: 0.7 });
    const p = toNative(0.2, 0.7, 2);
    assert.ok(Math.abs(p.x - 0.8) < 1e-9 && Math.abs(p.y - 0.3) < 1e-9);
  });

  it("is a rotation: four quarter turns of the same point come back to it", () => {
    let p = { x: 0.13, y: 0.71 };
    for (let i = 0; i < 4; i++) p = toNative(p.x, p.y, 1);
    assert.ok(Math.abs(p.x - 0.13) < 1e-9 && Math.abs(p.y - 0.71) < 1e-9);
  });

  it("is never the transpose SimDeck sends, in either landscape direction", () => {
    for (const t of [1, 3]) {
      const p = toNative(0.9, 0.1, t);
      assert.notDeepEqual([p.x, p.y], [0.1, 0.9]);
      assert.notDeepEqual([p.x, p.y], [0.9, 0.1]);
    }
  });
});

describe("turn probing", () => {
  it("offers 1 or 3 for a landscape screen and 0 or 2 for a portrait one", () => {
    assert.deepEqual(candidateTurns(LANDSCAPE), [1, 3]);
    assert.deepEqual(candidateTurns({ x: 0, y: 0, width: 834, height: 1210 }), [0, 2]);
  });

  it("probes small elements away from the centre, never a SpringBoard root's", () => {
    const tree = {
      roots: [
        node({ AXLabel: "Okam KDS" }, LANDSCAPE, [
          node({ AXLabel: "centre" }, { x: 580, y: 400, width: 40, height: 30 }),
          node({ AXLabel: "corner" }, { x: 1146, y: 40, width: 48, height: 48 }),
          node({ AXLabel: "huge" }, { x: 0, y: 0, width: 1000, height: 800 }),
        ]),
        node({ AXLabel: " " }, LANDSCAPE, [node({ AXLabel: "Åpne" }, { x: 366, y: 609, width: 48, height: 140 })]),
      ],
    };
    const probes = probeNodes(tree, uiBounds(tree)!);
    assert.deepEqual(probes, [{ x: 1146, y: 40, width: 48, height: 48 }]);
  });

  it("reads a hit as proof only when it holds the probe's centre and not its mirror", () => {
    const probe = { x: 1146, y: 40, width: 48, height: 48 };
    assert.equal(hitMatches(probe, probe, LANDSCAPE), true);
    // The wrong turn hits whatever sits at the mirrored point.
    assert.equal(hitMatches({ x: 10, y: 750, width: 48, height: 48 }, probe, LANDSCAPE), false);
    // A row spanning the screen holds both points and proves nothing.
    assert.equal(hitMatches({ x: 0, y: 0, width: 1210, height: 834 }, probe, LANDSCAPE), false);
    // So does a full-width bar through both, though it is small: the right turn and the wrong one both hit it.
    const level = { x: 1000, y: 400, width: 40, height: 30 };
    assert.equal(hitMatches({ x: 0, y: 390, width: 1210, height: 60 }, level, LANDSCAPE), false);
    // SimDeck answers a miss with a screen-sized node in portrait axes.
    assert.equal(hitMatches({ x: 0, y: 0, width: 834, height: 1210 }, { x: 26, y: 87, width: 288, height: 44 }, LANDSCAPE), false);
    assert.equal(hitMatches(null, probe, LANDSCAPE), false);
  });

  it("probes in the unrotated screen's points", () => {
    const p = nativeProbePoint({ x: 1146, y: 40, width: 48, height: 48 }, LANDSCAPE, 1);
    assert.equal(Math.round(p.x), Math.round((1 - 64 / 834) * 834));
    assert.equal(Math.round(p.y), Math.round((1170 / 1210) * 1210));
  });
});

describe("selectorTarget — SimDeck's pick", () => {
  const tree = {
    roots: [
      node({ AXLabel: "Okam POS", type: "Application" }, LANDSCAPE, [
        node({ AXLabel: "Slett", type: "StaticText" }, { x: 0, y: 0, width: 100, height: 20 }),
        node({ AXLabel: "Slett", type: "Button" }, { x: 600, y: 400, width: 100, height: 40 }),
        node({ AXLabel: "Slett", type: "Button" }, { x: 600, y: 2000, width: 100, height: 40 }),
        node({ AXUniqueId: "kitchen-menu", AXLabel: "Meny", type: "Button" }, { x: 1146, y: 40, width: 48, height: 48 }),
      ]),
    ],
  };

  it("prefers a tappable role on screen, like SimDeck's rank", () => {
    const t = selectorTarget(tree, { label: "Slett" })!;
    assert.equal(t.native, false);
    assert.equal(t.u, 650 / 1210);
    assert.equal(t.v, 420 / 834);
  });

  it("takes the index-th match in document order", () => {
    const t = selectorTarget(tree, { label: "Slett", index: 0 })!;
    assert.equal(t.u, 50 / 1210);
  });

  it("matches id, text and regex the way SimDeck does", () => {
    assert.ok(selectorTarget(tree, { id: "kitchen-menu" }));
    assert.ok(selectorTarget(tree, { text: "Meny" }));
    assert.ok(selectorTarget(tree, { label: "^Me", regex: true }));
    assert.equal(selectorTarget(tree, { label: "Me" }), null);
    assert.equal(selectorTarget(tree, { id: "kitchen-menu", label: "Slett" }), null);
  });

  it("reads a SpringBoard prompt in the portrait screen's points, under the turned root frame", () => {
    const prompt = { roots: [node({ AXLabel: " " }, LANDSCAPE, [node({ AXLabel: "Åpne", type: "Button" }, { x: 366.5, y: 609, width: 48, height: 140 })])] };
    const t = selectorTarget(prompt, { label: "Åpne" })!;
    assert.equal(t.native, true);
    assert.equal(t.u, (366.5 + 24) / 834);
    assert.equal(t.v, (609 + 70) / 1210);
  });
});

describe("presetSwipe", () => {
  it("is SimDeck's own preset geometry", () => {
    assert.deepEqual(presetSwipe("scroll-down"), [0.5, 0.725, 0.5, 0.275]);
    assert.throws(() => presetSwipe("spin"));
  });
});
