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

  it("reads an Android tree's names, ids and typed text", () => {
    const android = {
      roots: [
        {
          type: "FrameLayout",
          frame: { x: 0, y: 0, width: 1080, height: 2400 },
          children: [
            { type: "TextView", text: "Display & touch", AXIdentifier: "android:id/title", frame: { x: 40, y: 200, width: 600, height: 80 } },
            { type: "ImageButton", contentDescription: "Navigate up", resourceId: "com.x:id/up", frame: { x: 0, y: 60, width: 120, height: 120 } },
            { type: "EditText", text: "99999999", hint: "Mobilnummer", frame: { x: 40, y: 400, width: 1000, height: 120 } },
          ],
        },
      ],
    };
    assert.deepEqual(
      flattenTree(android).map((n) => [n.role, n.label, n.id, n.value]),
      [
        ["TextView", "Display & touch", "android:id/title", undefined],
        ["ImageButton", "Navigate up", "com.x:id/up", undefined],
        ["EditText", "Mobilnummer", undefined, "99999999"],
      ],
    );
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
  it("keeps an element's ref across captures while it stays, and gives what comes back under its name a new one", () => {
    const book = new ScreenBook();
    const first = book.record(BOARD);
    const menuRef = [...first.nodes].find(([, n]) => n.label === "Meny")![0];
    assert.equal([...book.record(BOARD).nodes].find(([, n]) => n.label === "Meny")![0], menuRef);
    book.record(MENU);
    const back = book.record(BOARD);
    const now = [...back.nodes].find(([, n]) => n.label === "Meny")![0];
    assert.notEqual(now, menuRef, "the «Slett» of the next order is not the one the agent saw");
    assert.throws(() => book.resolve(menuRef), new RegExp(`now on ${now}`));
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
    assert.throws(() => book.resolve(plusRefs[2]!), /no longer on screen/, "a gone duplicate is not retried by an ambiguous label");
  });

  it("keeps a unique element's ref while identical rows around it change", () => {
    const book = new ScreenBook();
    const s1 = book.record(screen(node("Button", "Lagre", at(10, 10)), node("Button", "+", at(10, 100)), node("Button", "+", at(10, 140))));
    const save = [...s1.nodes].find(([, n]) => n.label === "Lagre")![0];
    const s2 = book.record(screen(node("Button", "Lagre", at(10, 10)), node("Button", "+", at(10, 140))));
    assert.equal([...s2.nodes].find(([, n]) => n.label === "Lagre")![0], save);
  });
});

describe("ScreenBook refs that lost their element", () => {
  it("does not hand a ref to a twin that appeared next to its element", () => {
    const book = new ScreenBook();
    const ref = [...book.record(screen(node("Button", "Slett", at(10, 100)))).nodes].find(([, n]) => n.label === "Slett")![0];
    book.record(screen(node("Button", "Slett", at(10, 100)), node("Button", "Slett", at(10, 200))));
    assert.throws(() => book.resolve(ref), /no longer on screen/);
  });

  it("does not hand a ref to the twin that stays when its element goes", () => {
    const book = new ScreenBook();
    const ref = [...book.record(screen(node("Button", "Slett", at(10, 100)))).nodes].find(([, n]) => n.label === "Slett")![0];
    book.record(screen(node("Button", "Slett", at(10, 100)), node("Button", "Slett", at(10, 200))));
    const left = book.record(screen(node("Button", "Slett", at(10, 200))));
    assert.notEqual([...left.nodes].find(([, n]) => n.label === "Slett")![0], ref);
  });

  it("does not retry a gone ref by a name the current screen holds twice", () => {
    const book = new ScreenBook();
    const ref = [...book.record(screen(node("Button", "Lagre", { id: "save", ...at(10, 100) }))).nodes].find(([, n]) => n.id === "save")![0];
    book.record(screen(node("Link", "Lagre", { id: "save", ...at(10, 100) }), node("Link", "Lagre", { id: "save", ...at(10, 300) })));
    assert.throws(() => book.resolve(ref), /different element/);
    book.record(screen(node("Link", "Lagre", { id: "save", ...at(10, 300) })));
    assert.throws(() => book.resolve(ref), /different element/, "nor by a name one other element holds");
  });

  it("does not retry a gone ref by a label another element now holds, and names that element", () => {
    const book = new ScreenBook();
    const ref = [...book.record(screen(node("Button", "Slett", at(10, 100)))).nodes].find(([, n]) => n.label === "Slett")![0];
    const now = book.record(screen(node("Link", "Slett", at(10, 300))));
    const link = [...now.nodes].find(([, n]) => n.role === "Link")![0];
    assert.throws(() => book.resolve(ref), new RegExp(`now on ${link}, a different element`));
  });

  it("does not retry a gone ref by an id whose element now says something else", () => {
    const book = new ScreenBook();
    const ref = [...book.record(screen(node("Button", "Neste", { id: "primary", ...at(10, 100) }))).nodes].find(([, n]) => n.id === "primary")![0];
    book.record(screen(node("Button", "Betal", { id: "primary", ...at(10, 100) })));
    assert.throws(() => book.resolve(ref), /different element/);
  });

  it("does not retry a gone ref by an id that a row of the same kind now holds", () => {
    const book = new ScreenBook();
    const ref = [...book.record(screen(node("Button", "Ordre 12", { id: "order-row", ...at(10, 100) }))).nodes].find(([, n]) => n.label === "Ordre 12")![0];
    book.record(screen(node("Button", "Ordre 13", { id: "order-row", ...at(10, 100) })));
    assert.throws(() => book.resolve(ref), /different element/);
  });

  it("keeps elements apart whose labels differ only by a time", () => {
    const book = new ScreenBook();
    const slots = (y: number) => screen(...["12:00", "12:15", "12:30"].map((t, i) => node("Button", t, at(10, y + i * 50))));
    const refOf = (s: ReturnType<ScreenBook["record"]>, label: string) => [...s.nodes].find(([, n]) => n.label === label)![0];
    const first = book.record(slots(100));
    const scrolled = book.record(slots(60));
    for (const t of ["12:00", "12:15", "12:30"]) assert.equal(refOf(scrolled, t), refOf(first, t), `${t} kept its ref across a scroll`);
    assert.deepEqual(book.resolve(refOf(first, "12:30")), { kind: "selector", selector: { label: "12:30" } });
    const one = book.record(screen(node("Button", "12:30", at(10, 100))));
    assert.equal(refOf(one, "12:30"), refOf(first, "12:30"));
    const other = book.record(screen(node("Button", "12:45", at(10, 100))));
    assert.notEqual(refOf(other, "12:45"), refOf(first, "12:00"), "a reading that was shared never carries a ref");
  });

  it("never gives one ref to two elements", () => {
    const book = new ScreenBook();
    const slot = (t: string, y: number) => node("Button", t, at(10, y));
    book.record(screen(slot("12:00", 100)));
    book.record(screen(slot("12:15", 100)));
    const both = book.record(screen(slot("12:00", 100), slot("12:15", 200)));
    assert.equal([...both.nodes.values()].filter((n) => n.role === "Button").length, 2, "each element has its own ref");
  });

  it("does not carry a ref to a different element that took the same reading's place elsewhere", () => {
    const book = new ScreenBook();
    const ref = [...book.record(screen(node("Button", "Bord 4 12:00", at(10, 100)))).nodes].find(([, n]) => n.role === "Button")![0];
    const other = book.record(screen(node("Button", "Bord 4 12:05", at(10, 400))));
    assert.notEqual([...other.nodes].find(([, n]) => n.role === "Button")![0], ref);
  });

  it("does not hand a ref to a twin that moved after its element went", () => {
    const book = new ScreenBook();
    const ref = [...book.record(screen(node("Button", "Slett", at(10, 100)))).nodes].find(([, n]) => n.label === "Slett")![0];
    book.record(screen(node("Button", "Slett", at(10, 100)), node("Button", "Slett", at(10, 200))));
    const left = book.record(screen(node("Button", "Slett", at(10, 300))));
    assert.notEqual([...left.nodes].find(([, n]) => n.label === "Slett")![0], ref);
  });

  it("keeps an iOS field's name when its value repeats it", () => {
    const field = flattenTree(screen(node("TextField", "Søk", { value: "Søk", ...at(10, 100) }))).find((n) => n.role === "TextField");
    assert.equal(field!.label, "Søk");
  });

  it("keeps an Android field's ref when what is typed shows up as its label", () => {
    // SimDeck's compact Android tree: label and value are both the field's text.
    const book = new ScreenBook();
    const field = (text: string) => screen(node("EditText", text, { value: text, ...at(10, 100) }));
    const ref = [...book.record(field("First name")).nodes].find(([, n]) => n.role === "EditText")![0];
    const typed = book.record(field("Ola"));
    assert.equal([...typed.nodes].find(([, n]) => n.role === "EditText")![0], ref);
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

  it("keeps the refs of elements a mid-animation capture missed, when told to", () => {
    const book = new ScreenBook();
    const ref = [...book.record(BOARD).nodes].find(([, n]) => n.label === "Meny")![0];
    book.record(screen(node("StaticText", "Nye", at(10, 40))), { keepGone: true });
    assert.equal([...book.record(BOARD).nodes].find(([, n]) => n.label === "Meny")![0], ref);
  });

  it("never retries a ref that left the screen by its name, even when nothing holds that name now", () => {
    const book = new ScreenBook();
    book.record(BOARD);
    book.record(MENU);
    // e2 was «Meny» #kitchen-menu; the order it belonged to may be gone, and the next one's would answer.
    assert.throws(() => book.resolve("e2"), /no longer on screen — target what you want/);
    assert.throws(() => book.resolve("e99"), /unknown ref e99/);
  });
});
