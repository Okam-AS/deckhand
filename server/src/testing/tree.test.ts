import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { treeLabels, treeIds, selectorMissHint } from "./tree.ts";

/** The compact `describe` action snapshot — the default since the switch to it. */
const COMPACT = {
  snapshot: {
    roots: [
      {
        children: [
          { id: "station-search", role: "TextField", value: "Søk etter stasjoner" },
          { label: "Alle filtre", role: "Button", id: "station-filters-button" },
          { label: "Uno-X Munkvoll", role: "Button", id: "station-row-36" },
          { label: "Alle filtre", role: "Button" }, // duplicate label, one id — must not double-count
        ],
      },
    ],
  },
};

/** The verbose `/accessibility-tree` response, still used when a source or depth is asked for. */
const VERBOSE = {
  roots: [
    {
      AXLabel: "Uno-X",
      children: [
        { AXUniqueId: "station-search", AXValue: "Søk etter stasjoner", role: "AXTextField" },
        { AXLabel: "Alle filtre", AXUniqueId: "station-filters-button", role: "AXButton" },
        { AXLabel: null, AXValue: "1", role: "AXCheckBox" },
      ],
    },
  ],
};

describe("reading a tree whichever backend produced it", () => {
  it("finds the same labels and ids in both shapes", () => {
    for (const [name, tree] of [
      ["compact", COMPACT],
      ["verbose", VERBOSE],
    ] as const) {
      assert.ok(treeLabels(tree).includes("Søk etter stasjoner"), `${name}: values count as readable`);
      assert.ok(treeLabels(tree).includes("Alle filtre"), `${name}: labels count as readable`);
      assert.ok(treeIds(tree).includes("station-filters-button"), `${name}: ids are found`);
    }
  });

  it("deduplicates, so a repeated label does not inflate the count", () => {
    assert.equal(treeLabels(COMPACT).filter((l) => l === "Alle filtre").length, 1);
  });

  it("does not depend on the container being called `children`", () => {
    // A reader that knows one child key is one rename away from reporting an empty screen,
    // and "empty" is the answer that sends an agent to the wrong next move. This shape is
    // not hypothetical: the test double in this repo used `nodes`, and the miss hint came
    // back blank against it while looking perfectly healthy.
    const odd = { roots: [{ nodes: [{ label: "Deep label", id: "deep-id" }] }] };
    assert.deepEqual(treeLabels(odd), ["Deep label"]);
    assert.deepEqual(treeIds(odd), ["deep-id"]);
    // ...and a singly-nested object container, not just an array.
    const nested = { roots: [{ content: { label: "Wrapped", id: "wrapped-id" } }] };
    assert.deepEqual(treeLabels(nested), ["Wrapped"]);
    assert.deepEqual(treeIds(nested), ["wrapped-id"]);
  });

  it("survives the shapes a degraded capture returns", () => {
    for (const empty of [null, undefined, {}, { roots: [] }, "not a tree", 42]) {
      assert.deepEqual(treeLabels(empty), [], `${JSON.stringify(empty)} must not throw`);
      assert.deepEqual(treeIds(empty), []);
    }
  });
});

describe("telling an agent why its selector missed", () => {
  it("names what IS on screen, so a miss can be told from an unreadable screen", () => {
    // The real case: `waitFor {text:"Design system"}` failed after 9.5s on a screen showing
    // six rows, one of them "Design system". Those rows are absent from the tree, so no
    // selector could ever have matched and no amount of waiting would have helped. The
    // timeout alone could not say that; a list of what the tree does hold can.
    const hint = selectorMissHint(COMPACT);
    assert.match(hint, /Alle filtre/, "it must quote real labels from the screen");
    assert.match(hint, /3 readable label/, "and count them");
    assert.match(hint, /screenshot/i, "and name the way out");
  });

  it("explains the selector-semantics trap when the string is right there", () => {
    // Measured against a live daemon: `query {text:"Filter examples"}` MATCHES while
    // `assert` and `waitFor` on the identical selector FAIL — that string is a TextField's
    // value, and those two match `label` only. Same selector, three verbs, two answers, and
    // 6.2s spent learning it. Without naming it, the agent reads "not found" beside a list
    // that plainly contains what it asked for and concludes the screen is broken.
    const tree = { roots: [{ children: [{ role: "TextField", value: "Filter examples" }, { label: "Examples" }] }] };
    const hint = selectorMissHint(tree, "Filter examples");
    assert.match(hint, /IS present/, "it must say the string is there");
    assert.match(hint, /LABEL/, "and which field the verb actually matches");
    assert.match(hint, /query/, "and which verb would have worked");
  });

  it("does not claim presence for a string that genuinely is not there", () => {
    const tree = { roots: [{ children: [{ label: "Examples" }] }] };
    const hint = selectorMissHint(tree, "Design system");
    assert.ok(!/IS present/.test(hint), "a real miss must stay a real miss");
    assert.match(hint, /Examples/, "and still name what the screen does hold");
  });

  it("says something different when the capture is empty rather than merely missing one thing", () => {
    // iOS degrades to nothing on map-heavy screens. "0 labels" and "20 labels, none of them
    // yours" call for the same next move but for different reasons — say which it is.
    const hint = selectorMissHint({ roots: [] });
    assert.match(hint, /Nothing is readable/i);
    assert.match(hint, /screenshot/i);
    assert.ok(!/0 readable label/.test(hint), "an empty capture must not be reported as a normal miss");
  });

  it("stays a hint rather than becoming a dump", () => {
    const many = { roots: [{ children: Array.from({ length: 200 }, (_, i) => ({ label: `Row number ${i}` })) }] };
    const hint = selectorMissHint(many);
    assert.match(hint, /\+188 more/, "the tail must be counted, not printed");
    assert.ok(hint.length < 1200, `a miss hint must stay small, was ${hint.length}`);
  });

  it("truncates a single very long label instead of pasting a paragraph", () => {
    const hint = selectorMissHint({ roots: [{ children: [{ label: "x".repeat(300) }] }] });
    assert.match(hint, /…/, "a long label is elided");
    assert.ok(hint.length < 400, `was ${hint.length}`);
  });
});
