import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { IphoneControl, IphoneActionError, type DeviceControl, type IphoneTarget } from "./iphoneControl.ts";
import { SimDeckControl, SimDeckActionError, type SimDeckTarget, type UiAction } from "./control.ts";
import { WdaClient, WdaError } from "./wdaClient.ts";
import { fakeWda, pointerMoves, wdaNode, type FakeWdaState } from "../test-support/wdaFake.ts";

const target: IphoneTarget = { platform: "ios", udid: "00008120-000000000000001E", bundleId: "com.example.app" };

const app = (...children: object[]) => ({
  type: "Application",
  label: "Demo",
  isVisible: "1",
  rect: { x: 0, y: 0, width: 390, height: 844 },
  children: [{ type: "Window", isVisible: "1", rect: { x: 0, y: 0, width: 390, height: 844 }, children }],
});

function setup(over: Partial<FakeWdaState> = {}) {
  const wda = fakeWda(over);
  let clock = 0;
  const control = new IphoneControl({
    clientFor: async () => new WdaClient({ baseUrl: "http://127.0.0.1:18400", fetchImpl: wda.fetch }),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  });
  return { ...wda, control };
}

describe("the WDA client", () => {
  it("refuses any address but loopback", () => {
    for (const bad of ["http://192.168.1.20:8100", "http://localhost:8100", "https://127.0.0.1:8100", "http://0.0.0.0:8100"]) {
      assert.throws(() => new WdaClient({ baseUrl: bad }), WdaError, bad);
    }
  });

  it("opens a session without a bundle id, so opening one launches nothing, and reuses the live one", async () => {
    const { fetch, calls } = fakeWda();
    const c = new WdaClient({ baseUrl: "http://127.0.0.1:18400", fetchImpl: fetch });
    await c.tap(10, 20);
    await c.tap(30, 40);
    const opens = calls.filter((x) => x.path === "/session");
    assert.equal(opens.length, 1);
    assert.deepEqual(opens[0]!.body, { capabilities: { alwaysMatch: {} } });
  });

  it("sends no credential on any call", async () => {
    const { fetch, calls } = fakeWda();
    const c = new WdaClient({ baseUrl: "http://127.0.0.1:18400", fetchImpl: fetch });
    await c.status();
    await c.source();
    await c.screenshot();
    await c.activeAppInfo();
    await c.tap(1, 2);
    await c.keys("hei");
    for (const call of calls) {
      assert.deepEqual(Object.keys(call.headers).filter((h) => h !== "content-type"), [], `${call.path} sent a header beyond content-type`);
    }
  });

  it("refuses a screenshot that is not a PNG", async () => {
    const { fetch } = fakeWda();
    const notPng = (async (input: unknown, init?: RequestInit) =>
      String(input).endsWith("/screenshot") ? new Response(JSON.stringify({ value: Buffer.from("<html>").toString("base64") })) : fetch(input as string, init)) as typeof fetch;
    const c = new WdaClient({ baseUrl: "http://127.0.0.1:18400", fetchImpl: notPng });
    await assert.rejects(() => c.screenshot(), /not a PNG/);
  });

  it("reads the phone's Wi-Fi address from status, and null when WDA is not there", async () => {
    const { fetch } = fakeWda({ wifiIp: "10.0.0.7" });
    assert.equal((await new WdaClient({ baseUrl: "http://127.0.0.1:1", fetchImpl: fetch }).status())?.wifiIp, "10.0.0.7");
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    assert.equal(await new WdaClient({ baseUrl: "http://127.0.0.1:1", fetchImpl: down }).status(), null);
  });
});

describe("IphoneControl", () => {
  it("has the same shape as the simulator control, so the engine can hold either", () => {
    const sim: DeviceControl<SimDeckTarget> = new SimDeckControl({ autostart: false });
    const phone: DeviceControl<IphoneTarget> = setup().control;
    assert.ok(sim && phone);
    assert.ok(new IphoneActionError("x", 400) instanceof SimDeckActionError, "tools.ts maps SimDeckActionError to ui_error");
  });

  it("describes the screen as {roots} in points", async () => {
    const { control } = setup({ source: app(wdaNode({ type: "Button", label: "Start", rawIdentifier: "start" })) });
    const tree = await control.describe(target);
    assert.equal(tree.roots[0]!.frame.width, 390);
    assert.deepEqual(tree.roots[0]!.children!.map((c) => [c.role, c.label, c.id]), [["Button", "Start", "start"]]);
  });

  it("says a locked phone is locked instead of answering an empty screen", async () => {
    const { control } = setup({ source: app() });
    await assert.rejects(() => control.describe(target), /locked or asleep/);
  });

  it("taps 0..1 of the screen in points", async () => {
    const { control, calls } = setup();
    await control.action(target, { type: "tap", x: 0.5, y: 0.25 });
    assert.deepEqual(pointerMoves(calls), [[[195, 211]]]);
  });

  it("taps an element at its centre, found by id, label or text", async () => {
    const { control, calls } = setup({
      source: app(wdaNode({ type: "Button", label: "Kom i gang", rawIdentifier: "welcome-start", rect: { x: 20, y: 700, width: 350, height: 50 } })),
    });
    for (const selector of [{ id: "welcome-start" }, { label: "Kom i gang" }, { text: "Kom i gang" }, { text: "^Kom", regex: true }]) {
      await control.action(target, { type: "tapElement", selector });
    }
    assert.deepEqual(pointerMoves(calls), Array(4).fill([[195, 725]]));
  });

  it("waits for an element that renders late, and says when it never does", async () => {
    let reads = 0;
    const late = app(wdaNode({ type: "Button", label: "Ready" }));
    const { control } = setup({ source: () => (++reads < 3 ? app(wdaNode({ type: "StaticText", label: "Loading" })) : late) });
    await control.action(target, { type: "tapElement", selector: { label: "Ready" }, waitTimeoutMs: 2000 });
    assert.equal(reads, 3);
    await assert.rejects(
      () => setup({ source: app(wdaNode({ type: "StaticText", label: "x" })) }).control.action(target, { type: "waitFor", selector: { id: "never" }, timeoutMs: 1000 }),
      (e: unknown) => e instanceof IphoneActionError && e.status === 404,
    );
  });

  it("never touches or types while another app is in front", async () => {
    for (const a of [
      { type: "tap", x: 0.5, y: 0.5 },
      { type: "type", text: "x" },
      { type: "swipe", startX: 0.5, startY: 0.8, endX: 0.5, endY: 0.2 },
      { type: "back" },
      { type: "tapElement", selector: { label: "Start" } },
    ] as UiAction[]) {
      const { control, calls } = setup({ bundleId: "com.apple.springboard", source: app(wdaNode({ type: "Button", label: "Start" })) });
      await assert.rejects(() => control.action(target, a), /never acts outside/);
      assert.equal(calls.some((c) => c.path.endsWith("/actions") || c.path.endsWith("/wda/keys")), false, a.type);
    }
  });

  it("refuses to touch a phone with no app registered for it", async () => {
    const { control, calls } = setup();
    await assert.rejects(() => control.action({ platform: "ios", udid: target.udid }, { type: "tap", x: 0.1, y: 0.1 }), /no app is registered/);
    assert.equal(calls.some((c) => c.path.endsWith("/actions")), false);
  });

  it("refuses home, hardware buttons, openUrl and appearance with a reason, sending nothing", async () => {
    for (const a of [{ type: "home" }, { type: "button", name: "lock" }, { type: "openUrl", url: "https://example.com" }, { type: "toggleAppearance" }] as UiAction[]) {
      const { control, calls } = setup();
      await assert.rejects(() => control.action(target, a), (e: unknown) => e instanceof IphoneActionError && e.status === 422 && e.message.length > 40);
      assert.equal(calls.length, 0, a.type);
    }
  });

  it("types through WDA's keyboard, non-ASCII included, and maps named keys", async () => {
    const { control, calls } = setup();
    await control.action(target, { type: "type", text: "blåbær" });
    await control.action(target, { type: "key", name: "enter" });
    const typed = calls.filter((c) => c.path.endsWith("/wda/keys")).map((c) => (c.body as { value: string[] }).value.join(""));
    assert.deepEqual(typed, ["blåbær", "\n"]);
    await assert.rejects(() => control.action(target, { type: "key", name: "up" }), /cannot be typed/);
  });

  it("goes back with the navigation bar's back button when there is one", async () => {
    const { control, calls } = setup({ source: app(wdaNode({ type: "Button", label: "Innstillinger", rawIdentifier: "BackButton", rect: { x: 16, y: 58, width: 44, height: 44 } })) });
    const r = (await control.action(target, { type: "back" })) as { method: string };
    assert.equal(r.method, "backButton");
    assert.deepEqual(pointerMoves(calls), [[[38, 80]]]);
  });

  it("finds a labelled back button top-left, Norwegian included", async () => {
    const { control } = setup({ source: app(wdaNode({ type: "Button", label: "Tilbake", rect: { x: 8, y: 60, width: 30, height: 30 } })) });
    assert.equal(((await control.action(target, { type: "back" })) as { method: string }).method, "backButton");
  });

  it("swipes in from the left edge otherwise, and says that a modal will not close that way", async () => {
    const { control, calls } = setup({ source: app(wdaNode({ type: "Button", label: "Lukk", rect: { x: 330, y: 60, width: 40, height: 40 } })) });
    const r = (await control.action(target, { type: "back" })) as { method: string; note: string };
    assert.equal(r.method, "edgeSwipe");
    assert.match(r.note, /modal/);
    assert.deepEqual(pointerMoves(calls), [[[2, 422], [273, 422]]]);
  });

  it("answers the verifiers from the tree", async () => {
    const { control } = setup({ source: app(wdaNode({ type: "TextField", label: "E-post", value: "a@b.no" })) });
    assert.deepEqual(await control.action(target, { type: "query", selector: { text: "a@b.no" } }), {
      action: "query",
      count: 1,
      matches: [{ role: "TextField", label: "E-post", value: "a@b.no" }],
    });
    await control.action(target, { type: "assert", selector: { label: "E-post" } });
    await control.action(target, { type: "assertNot", selector: { label: "Passord" } });
    await assert.rejects(() => control.action(target, { type: "assert", selector: { label: "Passord" } }), /No accessibility element matched/);
    await assert.rejects(() => control.action(target, { type: "assertNot", selector: { label: "E-post" } }), /is on screen/);
  });

  it("scrolls until the element is on screen, and stops where the screen stops moving", async () => {
    let scrolled = 0;
    const row = (y: number) => wdaNode({ type: "Cell", label: "Row 30", rect: { x: 0, y, width: 390, height: 44 } });
    const wda = setup({ source: () => app(row(1400 - scrolled * 400)) });
    const realFetch = wda.fetch;
    const counting = new IphoneControl({
      clientFor: async () =>
        new WdaClient({
          baseUrl: "http://127.0.0.1:18400",
          fetchImpl: (async (i: unknown, init?: RequestInit) => {
            if (String(i).endsWith("/actions")) scrolled++;
            return realFetch(i as string, init);
          }) as typeof fetch,
        }),
    });
    const r = (await counting.action(target, { type: "scrollUntilVisible", selector: { label: "Row 30" } })) as { scrolls: number };
    assert.equal(r.scrolls, 2);
    const stuck = setup({ source: app(wdaNode({ type: "Cell", label: "Row 1" })) });
    await assert.rejects(() => stuck.control.action(target, { type: "scrollUntilVisible", selector: { label: "Row 99" } }), /did not come into view/);
    assert.equal(pointerMoves(stuck.calls).length, 1);
  });

  it("refuses to tap an element that is off screen", async () => {
    const { control, calls } = setup({ source: app(wdaNode({ type: "Button", label: "Far", rect: { x: 10, y: 2000, width: 100, height: 40 } })) });
    await assert.rejects(() => control.action(target, { type: "tapElement", selector: { label: "Far" } }), /off screen/);
    assert.equal(pointerMoves(calls).length, 0);
  });

  it("recovers from a session WDA has dropped", async () => {
    const { control, calls, state } = setup();
    await control.action(target, { type: "tap", x: 0.1, y: 0.1 });
    state.sessionId = null;
    await control.action(target, { type: "tap", x: 0.1, y: 0.1 });
    state.failOnce.set("/session/S1/actions", [404, { error: "invalid session id", message: "Session does not exist" }]);
    await control.action(target, { type: "tap", x: 0.1, y: 0.1 });
    assert.equal(calls.filter((c) => c.path === "/session").length, 2);
    assert.equal(calls.filter((c) => c.path.endsWith("/actions")).length, 4);
  });

  it("never sends a deckhand ref to WDA", async () => {
    const { control, calls } = setup();
    await assert.rejects(() => control.action(target, { type: "tapElement", selector: { ref: "e3" } }), /unresolved/);
    assert.equal(calls.length, 0);
  });
});
