import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExecResult } from "../devices/android.ts";
import { RegisteredApp } from "../devices/androidPhone.ts";
import { AdbControl, findAll, parseUiAutomatorTree } from "./adbControl.ts";
import { SimDeckActionError } from "./control.ts";
import { ScreenBook } from "./screen.ts";

const XML =
  "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"0\">" +
  '<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="no.example.app" content-desc="" clickable="false" bounds="[0,0][1080,2178]">' +
  '<node index="0" text="Logg inn" resource-id="no.example.app:id/title" class="android.widget.TextView" package="no.example.app" content-desc="" clickable="false" bounds="[40,100][1040,200]" />' +
  '<node index="1" text="ola@example.no" resource-id="email" class="android.widget.EditText" package="no.example.app" content-desc="E-post" clickable="true" bounds="[40,300][1040,420]" />' +
  '<node index="2" text="" resource-id="" class="android.view.ViewGroup" package="no.example.app" content-desc="Fortsett &amp; lagre" clickable="true" bounds="[40,500][1040,640]" />' +
  "</node></hierarchy>UI hierchary dumped to: /dev/stdout\n";

function harness(opts: { dump?: string; app?: RegisteredApp | null } = {}) {
  const calls: string[] = [];
  const exec = async (_cmd: string, args: string[]): Promise<ExecResult> => {
    calls.push(args.join(" "));
    const say = (s: string): ExecResult => ({ code: 0, stdout: Buffer.from(s), stderr: "" });
    if (args.includes("size")) return say("Physical size: 1440x3200\nOverride size: 1080x2400\n");
    if (args.includes("dump")) return say(opts.dump ?? XML);
    if (args.includes("input_method")) return say("mInputShown=true");
    return say("");
  };
  const control = new AdbControl({ exec, appOf: () => opts.app ?? null, sleep: async () => {} });
  const target = { platform: "android" as const, udid: "RF8" };
  return { control, target, calls };
}

describe("the adb control backend's tree", () => {
  it("is one display-sized root that screen.ts lists with refs", async () => {
    const { control, target } = harness();
    const tree = await control.describe(target);
    const book = new ScreenBook();
    book.record(tree);
    const screen = book.full();
    assert.match(screen, /TextView "Logg inn"/);
    assert.match(screen, /EditText "E-post".*ola@example\.no/);
    assert.match(screen, /ViewGroup "Fortsett & lagre"/);
    assert.deepEqual(book.snapshot?.bounds, { x: 0, y: 0, width: 1080, height: 2400 });
  });

  it("refuses an empty dump rather than reporting an empty screen", async () => {
    const { control, target } = harness({ dump: "<hierarchy rotation=\"0\"></hierarchy>" });
    await assert.rejects(control.tree(target.udid, 0), /no accessibility tree/);
  });

  it("matches `text` on labels, and on a field's contents only for query", () => {
    const tree = parseUiAutomatorTree(XML, { w: 1080, h: 2400 });
    assert.equal(findAll(tree, { text: "ola@example.no" }, "assert").length, 0);
    assert.equal(findAll(tree, { text: "ola@example.no" }, "query").length, 1);
    assert.equal(findAll(tree, { id: "title" }, "tapElement")[0]?.label, "Logg inn");
  });
});

describe("the adb control backend's actions", () => {
  it("taps 0..1 of the display in the override size `input` uses", async () => {
    const { control, target, calls } = harness();
    await control.action(target, { type: "tap", x: 0.5, y: 0.5 });
    assert.ok(calls.includes("-s RF8 shell input tap 540 1200"), calls.join("\n"));
  });

  it("taps an element at its centre", async () => {
    const { control, target, calls } = harness();
    await control.action(target, { type: "tapElement", selector: { label: "Fortsett & lagre" } });
    assert.ok(calls.includes("-s RF8 shell input tap 540 570"));
  });

  it("refuses non-ASCII text with a clear error and types nothing", async () => {
    const { control, target, calls } = harness();
    await assert.rejects(
      control.action(target, { type: "type", text: "Bjørn" }),
      (e: unknown) => e instanceof SimDeckActionError && e.status === 422 && /ASCII/.test(e.message),
    );
    assert.ok(!calls.some((c) => c.includes("input text")));
  });

  it("types ASCII through `input text`", async () => {
    const { control, target, calls } = harness();
    await control.action(target, { type: "type", text: "hei du" });
    assert.ok(calls.includes("-s RF8 shell input text 'hei%sdu'"));
  });

  it("never changes a setting: no dark-mode toggle, no power or volume button", async () => {
    const { control, target, calls } = harness();
    await assert.rejects(control.action(target, { type: "toggleAppearance" }), (e: unknown) => e instanceof SimDeckActionError && e.status === 403);
    await assert.rejects(control.action(target, { type: "button", name: "power" }), /not pressed on a phone/);
    await assert.rejects(control.action(target, { type: "button", name: "volumeUp" }), /not pressed on a phone/);
    assert.ok(!calls.some((c) => c.includes("uimode") || c.includes("settings") || c.includes("keyevent 26")));
  });

  it("opens a link in the registered app only", async () => {
    const appCalls: string[] = [];
    const app = new RegisteredApp(
      async (_c, args) => {
        appCalls.push(args.join(" "));
        return { code: 0, stdout: Buffer.from("Starting"), stderr: "" };
      },
      "RF8",
      "no.example.app",
    );
    const { control, target } = harness({ app });
    await control.action(target, { type: "openUrl", url: "https://example.no/x" });
    assert.deepEqual(appCalls, ["-s RF8 shell am start -a android.intent.action.VIEW -d 'https://example.no/x' no.example.app"]);
    await assert.rejects(harness({ app: null }).control.action(target, { type: "openUrl", url: "https://x" }), /not installed yet/);
  });

  it("dismisses the keyboard with back only when it is showing", async () => {
    const { control, target, calls } = harness();
    assert.deepEqual(await control.action(target, { type: "dismissKeyboard" }), { action: "dismissKeyboard", shown: true });
    assert.ok(calls.includes("-s RF8 shell input keyevent 4"));
  });

  it("fails a verifier that does not hold with a 404, like SimDeck", async () => {
    const { control, target } = harness();
    await assert.rejects(control.action(target, { type: "assert", selector: { text: "Ikke her" } }), (e: unknown) => e instanceof SimDeckActionError && e.status === 404);
    assert.deepEqual(await control.action(target, { type: "assert", selector: { text: "Logg inn" } }), { action: "assert", ok: true });
  });
});
