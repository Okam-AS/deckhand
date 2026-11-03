import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { wdaSourceToTree, WdaSourceError } from "./wdaTree.ts";
import { flattenTree, renderNode, ScreenBook } from "./screen.ts";

// Captured from an iPhone 15 (iOS 27.0.1) with WDA, Settings > Developer, pruned to the visible nodes.
const settings = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "wda-settings-developer.json"), "utf8")) as unknown;

const node = (o: object) => ({ isVisible: "1", isEnabled: "1", isAccessible: "0", rect: { x: 10, y: 100, width: 300, height: 40 }, ...o });

describe("WDA source → describe tree", () => {
  it("lists what VoiceOver reads on a captured screen, in points, with the RN testID as id", () => {
    const lines = flattenTree(wdaSourceToTree(settings)).map((n, i) => renderNode(`e${i + 1}`, n));
    assert.deepEqual(lines.slice(0, 7), [
      'e1 Application "Innstillinger"',
      'e2 Button "Innstillinger" #BackButton',
      'e3 StaticText "Utvikler"',
      'e4 Cell "Sammenkoblede datamaskiner, 1" #PAIRED_MACS',
      'e5 Other "Sammenkoblede Macer kan vise og styre iPhone eksternt."',
      'e6 Other "UI-automatisering"',
      'e7 Switch "Aktiver UI-automatisering" #UIAGroup.0 value="1"',
    ]);
    const back = flattenTree(wdaSourceToTree(settings)).find((n) => n.id === "BackButton");
    assert.deepEqual(back?.frame, { x: 16, y: 58, width: 44, height: 45 });
  });

  it("drops the texts inside a cell, the switch drawn twice, and invisible rows", () => {
    const nodes = flattenTree(wdaSourceToTree(settings));
    assert.equal(nodes.filter((n) => n.label === "Sammenkoblede datamaskiner").length, 0);
    assert.equal(nodes.filter((n) => n.role === "Switch").length, 1);
    assert.equal(nodes.some((n) => n.label === "Diagnostikk"), false);
  });

  it("gives refs and taps the screen book can resolve by id", () => {
    const book = new ScreenBook();
    book.record(wdaSourceToTree(settings));
    const text = book.full();
    const ref = /(e\d+) Button "Innstillinger" #BackButton/.exec(text)?.[1];
    assert.ok(ref, text);
    assert.deepEqual(book.resolve(ref), { kind: "selector", selector: { id: "BackButton" } });
    assert.deepEqual(book.snapshot?.bounds, { x: 0, y: 0, width: 393, height: 852 });
  });

  it("names a field by its label and holds what was typed as its value; keeps spinners; marks disabled", () => {
    const tree = wdaSourceToTree({
      value: node({
        type: "Application",
        label: "Demo",
        children: [
          node({ type: "TextField", label: "E-post", value: "test@example.com", rawIdentifier: "email_input", isAccessible: "1", isFocused: "1" }),
          node({ type: "SecureTextField", label: "Passord", value: "••••••", isAccessible: "1" }),
          node({ type: "ActivityIndicator", label: "In progress" }),
          node({ type: "Button", label: "Logg inn", isAccessible: "1", isEnabled: "0", traits: "Button, NotEnabled" }),
          node({ type: "Other", isAccessible: "0" }),
          node({ type: "Button", label: "Hidden", isAccessible: "1", isVisible: "0" }),
          node({ type: "Button", label: "Flat", isAccessible: "1", rect: { x: 0, y: 0, width: 0, height: 10 } }),
        ],
      }),
    });
    const kids = tree.roots[0]!.children!;
    assert.deepEqual(
      kids.map((k) => [k.role, k.label, k.value, k.id]),
      [
        ["TextField", "E-post", "test@example.com", "email_input"],
        ["SecureTextField", "Passord", "••••••", undefined],
        ["ActivityIndicator", "In progress", undefined, undefined],
        ["Button", "Logg inn", undefined, undefined],
      ],
    );
    assert.equal(kids[0]!.focused, true);
    assert.equal(kids[1]!.secure, true);
    assert.equal(kids[3]!.enabled, false);
    const flat = flattenTree(tree).find((n) => n.role === "TextField");
    assert.deepEqual([flat?.label, flat?.value], ["E-post", "test@example.com"]);
  });

  it("lifts a system alert nested in the app's source into a root of its own", () => {
    const tree = wdaSourceToTree({
      value: node({
        type: "Application",
        label: "Demo",
        rect: { x: 0, y: 0, width: 393, height: 852 },
        children: [
          node({ type: "Button", label: "Fortsett", isAccessible: "1" }),
          node({
            type: "Application",
            label: "SpringBoard",
            rect: { x: 0, y: 0, width: 393, height: 852 },
            children: [node({ type: "Alert", label: "Tillat varsler?", children: [node({ type: "Button", label: "Tillat", isAccessible: "1" })] })],
          }),
        ],
      }),
    });
    assert.deepEqual(tree.roots.map((r) => r.label), ["Demo", "SpringBoard"]);
    assert.deepEqual(tree.roots[1]!.children!.map((c) => c.label), ["Tillat varsler?"]);
    assert.deepEqual(tree.roots[1]!.children![0]!.children!.map((c) => c.label), ["Tillat"]);
    assert.equal(tree.roots[0]!.children!.some((c) => c.label === "Tillat"), false);
  });

  it("refuses something that is not a WDA source rather than answering an empty screen", () => {
    assert.throws(() => wdaSourceToTree({ value: { error: "invalid session id" } }), WdaSourceError);
    assert.throws(() => wdaSourceToTree("<html>"), WdaSourceError);
  });
});
