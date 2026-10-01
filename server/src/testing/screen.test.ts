import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { flattenTree, RefError, ScreenBook, shapeOf } from "./screen.ts";

const node = (role: string, label: string | undefined, extra: Record<string, unknown> = {}) => ({ role, ...(label ? { label } : {}), ...extra });
const at = (x: number, y: number, width = 100, height = 40) => ({ frame: { x, y, width, height } });
/** A compact-snapshot screen 400×800 with these children. */
const screen = (...children: object[]) => ({ roots: [{ role: "Application", label: "App", frame: { x: 0, y: 0, width: 400, height: 800 }, children }] });

const BOARD = screen(node("Button", "Meny", { id: "kitchen-menu", ...at(300, 40) }), node("StaticText", "Nye", at(10, 40)), node("Group", undefined, at(0, 0)));
const MENU = screen(node("Button", "Bestillinger", at(10, 100)), node("Button", "Innstillinger", at(10, 160)));

describe("flattening a tree into listed elements", () => {
  it("reads the compact and the verbose shape the same way, and drops nameless containers", () => {
    const verbose = { roots: [{ AXRole: "AXApplication", AXLabel: "App", children: [{ AXRole: "AXButton", AXLabel: "Meny", AXUniqueId: "kitchen-menu" }, { AXRole: "AXGroup" }] }] };
    const compact = { snapshot: { roots: [{ role: "Application", label: "App", children: [{ role: "Button", label: "Meny", id: "kitchen-menu" }, { role: "Group" }] }] } };
    for (const tree of [verbose, compact]) {
      assert.deepEqual(
        flattenTree(tree).map((n) => [n.label, n.id]),
        [["App", undefined], ["Meny", "kitchen-menu"]],
      );
    }
  });

  it("marks an element outside the screen's bounds as offscreen", () => {
    const nodes = flattenTree(screen(node("Button", "Below", at(10, 900)), node("Button", "Here", at(10, 10))));
    assert.deepEqual(nodes.filter((n) => n.offscreen).map((n) => n.label), ["Below"]);
  });

  it("gives a moving element a different shape, so a transition never reads as still", () => {
    assert.notEqual(shapeOf(screen(node("Button", "A", at(10, 10)))), shapeOf(screen(node("Button", "A", at(10, 60)))));
    assert.equal(shapeOf(screen(node("Button", "A", at(10, 10.2)))), shapeOf(screen(node("Button", "A", at(10, 10.4)))));
  });

  it("does not let a running clock keep a screen from ever being still", () => {
    assert.equal(shapeOf(screen(node("Button", "#214 · 4:04"))), shapeOf(screen(node("Button", "#214 · 4:05"))));
    assert.notEqual(shapeOf(screen(node("Button", "#214 · 4 min"))), shapeOf(screen(node("Button", "#215 · 4 min"))));
  });
});

describe("ScreenBook refs", () => {
  it("keeps an element's ref across captures, including after it left the screen and came back", () => {
    const book = new ScreenBook();
    const first = book.record(BOARD);
    const menuRef = [...first.nodes].find(([, n]) => n.label === "Meny")![0];
    book.record(MENU);
    const back = book.record(BOARD);
    assert.equal([...back.nodes].find(([, n]) => n.label === "Meny")![0], menuRef);
  });

  it("keeps the ref of a field whose value changed, and reports it as changed", () => {
    const book = new ScreenBook();
    book.record(screen(node("TextField", "Mobilnummer", { id: "auth-phone", value: "" })));
    book.full();
    book.record(screen(node("TextField", "Mobilnummer", { id: "auth-phone", value: "99 99 99 99" })));
    const update = book.update();
    assert.match(update, /~ e2 TextField "Mobilnummer" #auth-phone value="99 99 99 99" \(was: TextField "Mobilnummer" #auth-phone\)/);
  });

  it("never moves a ref onto a different element when one of several identical rows goes", () => {
    const book = new ScreenBook();
    const rows = (...ys: number[]) => screen(...ys.map((y) => node("Button", "+", at(10, y))));
    const first = book.record(rows(100, 140, 180));
    const plusRefs = [...first.nodes].filter(([, n]) => n.label === "+").map(([r]) => r);
    assert.deepEqual(
      [...book.record(rows(100, 140, 180)).nodes].filter(([, n]) => n.label === "+").map(([r]) => r),
      plusRefs,
      "a re-read of an unchanged screen keeps them",
    );
    const scrolled = book.record(rows(80, 120, 160));
    for (const [ref, n] of scrolled.nodes) if (n.label === "+") assert.ok(!plusRefs.includes(ref), `${ref} kept across a move`);
    book.record(rows(100, 140, 180));
    // The first row is deleted and the other two slide up into its place.
    const after = book.record(rows(100, 140));
    for (const [ref, n] of after.nodes) if (n.label === "+") assert.ok(!plusRefs.includes(ref), `${ref} was reused for a row it may not name`);
    assert.throws(() => book.resolve(plusRefs[2]!), /shared its name/, "a gone duplicate is not retried by an ambiguous label");
  });

  it("keeps a unique element's ref while identical rows around it change", () => {
    const book = new ScreenBook();
    const s1 = book.record(screen(node("Button", "Lagre", at(10, 10)), node("Button", "+", at(10, 100)), node("Button", "+", at(10, 140))));
    const save = [...s1.nodes].find(([, n]) => n.label === "Lagre")![0];
    const s2 = book.record(screen(node("Button", "Lagre", at(10, 10)), node("Button", "+", at(10, 140))));
    assert.equal([...s2.nodes].find(([, n]) => n.label === "Lagre")![0], save);
  });
});

describe("ScreenBook rendering", () => {
  it("sends only what changed, saying which refs are gone", () => {
    const book = new ScreenBook();
    book.record(screen(...Array.from({ length: 10 }, (_, i) => node("Button", `Row ${i}`))));
    book.full();
    book.record(screen(...Array.from({ length: 9 }, (_, i) => node("Button", `Row ${i}`)), node("Button", "New row")));
    const update = book.update();
    assert.match(update, /^Screen r2 /);
    assert.match(update, /\n\+ e12 Button "New row"/);
    assert.match(update, /\n- e11 Button "Row 9"/);
    assert.doesNotMatch(update, /Row 0/, "an unchanged line is not repeated");
  });

  it("sends the whole screen when most of it changed", () => {
    const book = new ScreenBook();
    book.record(BOARD);
    book.full();
    book.record(MENU);
    const update = book.update();
    assert.match(update, /changed substantially/);
    assert.match(update, /Innstillinger/);
  });

  it("says so when nothing changed, rather than sending an empty diff", () => {
    const book = new ScreenBook();
    book.record(BOARD);
    book.full();
    book.record(BOARD);
    assert.match(book.update(), /nothing listed changed/);
  });

  it("diffs against what the agent was SHOWN, not against the last capture", () => {
    const book = new ScreenBook();
    book.record(screen(...Array.from({ length: 10 }, (_, i) => node("Button", `Row ${i}`))));
    book.full();
    book.record(screen(...Array.from({ length: 10 }, (_, i) => node("Button", `Row ${i}`)), node("Button", "Toast")));
    book.record(screen(...Array.from({ length: 10 }, (_, i) => node("Button", `Row ${i}`)), node("Button", "Toast")));
    assert.match(book.update(), /\+ e12 Button "Toast"/);
  });
});

describe("ScreenBook.resolve", () => {
  it("prefers a unique id, then a unique label, and falls back to the element's centre", () => {
    const book = new ScreenBook();
    book.record(
      screen(
        node("Button", "Meny", { id: "kitchen-menu", ...at(300, 40) }),
        node("Button", "Innstillinger", at(10, 160)),
        node("Button", "Mer", at(0, 400, 200, 100)),
        node("Button", "Mer", at(200, 400, 200, 100)),
      ),
    );
    assert.deepEqual(book.resolve("e2"), { kind: "selector", selector: { id: "kitchen-menu" } });
    assert.deepEqual(book.resolve("@e3"), { kind: "selector", selector: { label: "Innstillinger" } });
    assert.deepEqual(book.resolve("e5"), { kind: "point", x: 0.75, y: 450 / 800 });
  });

  it("refuses to tap an offscreen element by its centre", () => {
    const book = new ScreenBook();
    book.record(screen(node("Button", "Mer", at(0, 900)), node("Button", "Mer", at(0, 1000))));
    assert.throws(() => book.resolve("e2"), /off screen/);
  });

  it("retries a ref that left the screen by the id or label it had", () => {
    const book = new ScreenBook();
    book.record(BOARD);
    book.record(MENU);
    assert.deepEqual(book.resolve("e2"), { kind: "selector", selector: { id: "kitchen-menu" } });
    assert.throws(() => book.resolve("e99"), /unknown ref e99/);
  });
});
