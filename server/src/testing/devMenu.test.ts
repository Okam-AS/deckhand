import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { devMenuOpen, devMenuHint, DEV_MENU_RECOVERY } from "./devMenu.ts";

/**
 * Trimmed from real captures on iOS 26.5 / Expo runtime 4.0.0, taken during the
 * session that produced this module — an agent tapped the app's top-right filter
 * button, hit Expo's floating Tools button instead, and reported the app as
 * broken. Both node shapes appear because deckhand may hold either: the verbose
 * `/accessibility-tree` response, or the compact `describe` action snapshot.
 */
const DEV_MENU_AX_TREE = {
  roots: [
    {
      AXLabel: "Uno-X",
      children: [
        { AXLabel: "Close", role: "AXButton" },
        { AXLabel: "Reload", role: "AXButton" },
        { AXLabel: "Go home", role: "AXButton" },
        { AXLabel: "Source code explorer", role: "AXButton" },
        { AXLabel: "Toggle performance monitor", role: "AXButton" },
        { AXLabel: "Toggle element inspector", role: "AXButton" },
        { AXLabel: "Open DevTools", role: "AXButton" },
        // The Tools button toggle: no label at all, value "1" on / "0" off.
        { AXLabel: null, AXValue: "1", role: "AXCheckBox" },
        { AXLabel: null, AXValue: "0", role: "AXCheckBox" },
        { AXLabel: "Copy system info", role: "AXButton" },
        { AXLabel: "Open React Native dev menu", role: "AXButton" },
      ],
    },
  ],
};

const DEV_MENU_COMPACT = {
  snapshot: {
    roots: [
      {
        children: [
          { label: "Toggle element inspector", role: "Button" },
          { label: "Copy system info", role: "Button" },
          // Captured from the device: in the compact format the row carries a sibling
          // StaticText, while the switch itself is still an unlabelled checkbox.
          { label: "Fast refresh", role: "StaticText", frame: { x: 60, y: 810, width: 120, height: 20 } },
          { label: null, value: "1", role: "CheckBox", frame: { x: 250, y: 810, width: 50, height: 30 } },
          { label: "Tools button", role: "StaticText", frame: { x: 60, y: 868, width: 120, height: 20 } },
          { label: null, value: "1", role: "CheckBox", frame: { x: 250, y: 868, width: 50, height: 30 } },
        ],
      },
    ],
  },
};

/** The app's own map screen — the state the agent is in for most of a run. */
const APP_MAP_SCREEN = {
  roots: [
    {
      AXLabel: "Uno-X",
      children: [
        { AXUniqueId: "station-search", AXValue: "Søk etter stasjoner", role: "AXTextField" },
        { AXLabel: "Lynlading", role: "AXButton" },
        { AXLabel: "Drivstoff", role: "AXButton" },
        { AXLabel: "Vask", role: "AXButton" },
        { AXUniqueId: "station-filters-button", AXLabel: "Alle filtre", role: "AXButton" },
        { AXUniqueId: "station-row-36", AXLabel: "Uno-X Munkvoll", role: "AXButton" },
      ],
    },
  ],
};

describe("spotting the dev menu", () => {
  it("recognises it in the verbose accessibility tree", () => {
    assert.equal(devMenuOpen(DEV_MENU_AX_TREE), true);
  });

  it("recognises it in the compact snapshot too", () => {
    // The caller must not have to know which backend answered.
    assert.equal(devMenuOpen(DEV_MENU_COMPACT), true);
  });

  it("stays quiet on the app's own screens", () => {
    // A false positive sends the agent hunting for a switch that is not there,
    // which is worse than saying nothing.
    assert.equal(devMenuOpen(APP_MAP_SCREEN), false);
    assert.deepEqual(devMenuHint(APP_MAP_SCREEN), {});
  });

  it("is not fooled by one stray marker", () => {
    // "Reload" and "Go home" are in the dev menu but far too generic to key off,
    // so an app screen that happens to carry one must not trip it.
    const oneMarker = {
      roots: [{ children: [{ AXLabel: "Source code explorer" }, { AXLabel: "Reload" }, { AXLabel: "Go home" }] }],
    };
    assert.equal(devMenuOpen(oneMarker), false);
  });

  it("survives the shapes a broken capture actually returns", () => {
    // iOS AX capture degrades to an empty tree on complex screens (map-heavy ones
    // especially) — that must read as "no dev menu", never as a crash.
    for (const empty of [null, undefined, {}, { roots: [] }, "not a tree", 42]) {
      assert.equal(devMenuOpen(empty), false, `${JSON.stringify(empty)} must not throw or match`);
    }
  });

  it("describes the format that is actually the default, not the one it was written against", () => {
    // #57 said the toggle has "NO accessibility label". True of the verbose
    // /accessibility-tree response it was written against — and false by the end of the same
    // day, because the switch to the compact snapshot landed alongside it and that shape
    // carries a sibling StaticText "Tools button". Two PRs from one session that were never
    // read against each other.
    //
    // This test is the tie: the fixture is the compact shape, and the claim has to hold in it.
    const compactLabels: string[] = [];
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== "object") return;
      const node = n as { label?: unknown; role?: unknown; children?: unknown };
      if (typeof node.label === "string") compactLabels.push(node.label);
      walk(node.children);
    };
    walk(DEV_MENU_COMPACT.snapshot.roots);
    assert.ok(compactLabels.includes("Tools button"), "fixture must reflect the row being labelled here");

    const hint = DEV_MENU_RECOVERY;
    assert.ok(
      !/It has NO accessibility label/.test(hint),
      "the flat claim is false in the compact format — the ROW is labelled",
    );
    assert.match(hint, /UNLABELLED checkbox/, "what is unlabelled is the switch itself, and that is still true");
    assert.match(hint, /hits the text, not the switch/, "so it must say why selecting by text fails anyway");
    assert.match(hint, /x≈0\.67/, "and give the aim that works");
  });

  it("warns that a system alert sits above the dev menu", () => {
    // Measured: with a location permission alert up, scrolling the dev menu did nothing at
    // all. An agent that does not know this reads it as the menu being unresponsive — which
    // is exactly the false "the dialog is broken" conclusion this whole area exists to stop.
    assert.match(DEV_MENU_RECOVERY, /system permission alert sits ABOVE/i);
  });

  it("hands over instructions the agent can actually follow", () => {
    const hint = devMenuHint(DEV_MENU_AX_TREE).devMenu ?? "";
    assert.equal(hint, DEV_MENU_RECOVERY);
    // Each of these is a fact an agent cannot discover for itself, and every one
    // was verified on the device before it was written down.
    assert.match(hint, /Tools button/, "it must name the switch");
    assert.match(hint, /Fast refresh/, "and where to find it, since it has no label");
    assert.match(hint, /scroll DOWN/i, "the switch is below the fold");
    assert.match(hint, /hits the text, not the switch/i, "why selecting it by text cannot work");
    assert.match(hint, /not.*app bug/i, "and what NOT to conclude");
  });
});
