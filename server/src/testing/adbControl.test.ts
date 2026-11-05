import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExecResult } from "../devices/android.ts";
import { RegisteredApp } from "../devices/androidPhone.ts";
import { AdbControl, findAll, parseUiAutomatorTree } from "./adbControl.ts";
import { SimDeckActionError, type UiAction } from "./control.ts";
import { ScreenBook } from "./screen.ts";

const XML =
  "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"0\">" +
  '<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="no.example.app" content-desc="" clickable="false" bounds="[0,0][1080,2178]">' +
  '<node index="0" text="Logg inn" resource-id="no.example.app:id/title" class="android.widget.TextView" package="no.example.app" content-desc="" clickable="false" bounds="[40,100][1040,200]" />' +
  '<node index="1" text="ola@example.no" resource-id="email" class="android.widget.EditText" package="no.example.app" content-desc="E-post" clickable="true" bounds="[40,300][1040,420]" />' +
  '<node index="2" text="" resource-id="" class="android.view.ViewGroup" package="no.example.app" content-desc="Fortsett &amp; lagre" clickable="true" bounds="[40,500][1040,640]" />' +
  "</node></hierarchy>UI hierchary dumped to: /dev/stdout\n";

const IN_APP =
  "  mCurrentFocus=Window{6419467 u0 no.example.app/no.example.app.MainActivity}\n  mFocusedApp=ActivityRecord{1aa2b9b u0 no.example.app/.MainActivity} t11}\n";

function harness(opts: { dump?: string; app?: RegisteredApp | null; focus?: string | (() => string) } = {}) {
  const calls: string[] = [];
  const exec = async (_cmd: string, args: string[]): Promise<ExecResult> => {
    calls.push(args.join(" "));
    const say = (s: string): ExecResult => ({ code: 0, stdout: Buffer.from(s), stderr: "" });
    if (args.includes("size")) return say("Physical size: 1440x3200\nOverride size: 1080x2400\n");
    if (args.includes("dump")) return say(opts.dump ?? XML);
    if (args.includes("input_method")) return say("mInputShown=true");
    if (args.includes("window")) return say(typeof opts.focus === "function" ? opts.focus() : (opts.focus ?? IN_APP));
    return say("");
  };
  const app = "app" in opts ? opts.app : new RegisteredApp(exec, "RF8", "no.example.app");
  const control = new AdbControl({ exec, appOf: () => app ?? null, sleep: async () => {} });
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

  it("never presses home or the app switcher on a phone, and touches nothing", async () => {
    const { control, target, calls } = harness();
    for (const a of [{ type: "home" }, { type: "button", name: "home" }, { type: "button", name: "app-switch" }, { type: "button", name: "appSwitch" }] as UiAction[]) {
      await assert.rejects(control.action(target, a), (e: unknown) => e instanceof SimDeckActionError && e.status === 422 && /never presses home or the app switcher/.test(e.message), JSON.stringify(a));
    }
    assert.ok(!calls.some((c) => / keyevent (3|187)$/.test(c)), calls.join("\n"));
    await control.action(target, { type: "button", name: "back" });
    assert.ok(calls.includes("-s RF8 shell input keyevent 4"));
  });

  it("refuses a swipe that starts on the top or bottom edge, where Android pulls the shade or goes home", async () => {
    const { control, target, calls } = harness();
    await assert.rejects(control.action(target, { type: "swipe", startX: 0.5, startY: 0.01, endX: 0.5, endY: 0.6 }), /notification shade/);
    await assert.rejects(control.action(target, { type: "swipe", startX: 0.5, startY: 0.99, endX: 0.5, endY: 0.5 }), /recent apps/);
    assert.ok(!calls.some((c) => c.includes("input swipe")));
    await control.action(target, { type: "swipe", startX: 0.5, startY: 0.8, endX: 0.5, endY: 0.2 });
    assert.ok(calls.some((c) => c.includes("input swipe")));
  });

  it("never touches or types while the launcher, the shade or another app has focus", async () => {
    const outside = [
      ["  mCurrentFocus=Window{6419467 u0 com.sec.android.app.launcher/com.sec.android.app.launcher.activities.LauncherActivity}\n", /com\.sec\.android\.app\.launcher/],
      // The shade over the app: mFocusedApp still names the app, mCurrentFocus does not.
      ["  mCurrentFocus=Window{3eaecf1 u0 NotificationShade}\n  mFocusedApp=ActivityRecord{1aa2b9b u0 no.example.app/.MainActivity} t11}\n", /system window NotificationShade/],
      ["  mCurrentFocus=Window{1 u0 com.google.android.gm/com.google.android.gm.ConversationListActivityGmail}\n", /com\.google\.android\.gm\b/],
    ] as const;
    for (const [focus, says] of outside) {
      for (const a of [
        { type: "tap", x: 0.5, y: 0.5 },
        { type: "tapElement", selector: { label: "Fortsett & lagre" } },
        { type: "type", text: "x" },
        { type: "key", name: "enter" },
        { type: "swipe", startX: 0.5, startY: 0.8, endX: 0.5, endY: 0.2 },
        { type: "gesture", preset: "scroll-down" },
        { type: "button", name: "menu" },
      ] as UiAction[]) {
        const { control, target, calls } = harness({ focus });
        await assert.rejects(control.action(target, a), (e: unknown) => e instanceof SimDeckActionError && e.status === 409 && /never acts outside/.test(e.message) && says.test(e.message), `${a.type} ${focus}`);
        assert.ok(!calls.some((c) => / input (tap|text|swipe|keyevent)/.test(c)), `${a.type}: ${calls.join("\n")}`);
      }
    }
    // back still closes the shade, and reading the screen is never refused.
    const { control, target } = harness({ focus: outside[1][0] });
    await control.action(target, { type: "back" });
    await control.action(target, { type: "assert", selector: { text: "Logg inn" } });
  });

  it("drives the app's own popups, its permission prompt, Google sign-in and a Custom Tab", async () => {
    for (const focus of [
      "  mCurrentFocus=Window{5 u0 PopupWindow:9a1b2c}\n  mFocusedApp=ActivityRecord{1aa2b9b u0 no.example.app/.MainActivity} t11}\n",
      "  mCurrentFocus=Window{5 u0 com.google.android.permissioncontroller/com.android.permissioncontroller.permission.ui.GrantPermissionsActivity}\n",
      "  mCurrentFocus=Window{5 u0 com.google.android.gms/com.google.android.gms.auth.api.signin.ui.SignInActivity}\n",
      "  mCurrentFocus=Window{5 u0 com.android.chrome/org.chromium.chrome.browser.customtabs.CustomTabActivity}\n",
    ]) {
      const { control, target, calls } = harness({ focus });
      await control.action(target, { type: "tap", x: 0.5, y: 0.5 });
      assert.ok(calls.includes("-s RF8 shell input tap 540 1200"), focus);
    }
  });

  it("asks again when focus is between windows, and checks before each scroll and after waiting", async () => {
    let reads = 0;
    const { control, target, calls } = harness({ focus: () => (++reads < 3 ? "  mCurrentFocus=null\n" : IN_APP) });
    await control.action(target, { type: "tap", x: 0.5, y: 0.5 });
    assert.equal(reads, 3);
    assert.ok(calls.includes("-s RF8 shell input tap 540 1200"));

    let scrolls = 0;
    const leaves = harness({ dump: XML, focus: () => (scrolls++ < 1 ? IN_APP : "  mCurrentFocus=Window{3 u0 NotificationShade}\n") });
    await assert.rejects(leaves.control.action(leaves.target, { type: "scrollUntilVisible", selector: { text: "Ikke her" } }), /never acts outside/);
    assert.equal(leaves.calls.filter((c) => c.includes("input swipe")).length, 1, "one scroll, then the shade stopped it");
  });

  it("refuses to touch a phone whose app is not installed yet", async () => {
    const { control, target, calls } = harness({ app: null });
    await assert.rejects(control.action(target, { type: "tap", x: 0.5, y: 0.5 }), /not installed yet/);
    assert.ok(!calls.some((c) => c.includes("input tap")));
  });

  it("fails a verifier that does not hold with a 404, like SimDeck", async () => {
    const { control, target } = harness();
    await assert.rejects(control.action(target, { type: "assert", selector: { text: "Ikke her" } }), (e: unknown) => e instanceof SimDeckActionError && e.status === 404);
    assert.deepEqual(await control.action(target, { type: "assert", selector: { text: "Logg inn" } }), { action: "assert", ok: true });
  });
});
