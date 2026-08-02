import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { devMenuOpen, devMenuHint, DEV_MENU_RECOVERY, DEV_MENU_PREFLIGHT } from "./devMenu.ts";

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
    assert.match(hint, /not an app bug/i, "the conclusion to avoid comes first");
    assert.match(hint, /Tools button/, "and it still names the switch for the manual path");
    assert.match(hint, /scroll DOWN/i, "the switch is below the fold");
    assert.match(hint, /hits the text, not the switch/i, "why selecting it by text cannot work");
    assert.match(hint, /not.*app bug/i, "and what NOT to conclude");
  });
});

describe("saying it before the first tap, not after the first surprise", () => {
  it("names both overlays and the order they have to be cleared in", () => {
    // Principle 10: a working answer that lives only in an agent's head is not finished
    // work. This one was rediscovered three times in a single session, twice reported as
    // an app bug, before it was written anywhere a fresh agent would read it.
    // Corrected: deckhand switches these off itself now, so the preflight says what to
    // EXPECT rather than handing out chores. And it draws the line that matters — a
    // permission alert is the app's own behaviour, not deckhand's packaging.
    assert.match(DEV_MENU_PREFLIGHT, /EXDevMenuShowsAtLaunch/, "it must name what deckhand actually did");
    assert.match(DEV_MENU_PREFLIGHT, /permission alert is different|dismiss it the way a user would/i);
    assert.ok(!/scroll DOWN to TOOLS, switch off/.test(DEV_MENU_PREFLIGHT), "it must not hand out steps deckhand already took");
  });

  it("stays short enough to survive being read", () => {
    // It rides preview_status beside the drive contract and the link footer. A paragraph
    // here competes for the same attention and loses — the full recovery is one describe away.
    assert.ok(DEV_MENU_PREFLIGHT.length < 600, `preflight must stay short, was ${DEV_MENU_PREFLIGHT.length}`);
    assert.ok(DEV_MENU_PREFLIGHT.length < DEV_MENU_RECOVERY.length, "and shorter than the full recovery");
  });
});
