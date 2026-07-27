import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SimDeckControl, SimDeckActionError } from "./control.ts";
import { SimDeckDaemon, SimDeckUnavailableError } from "./simdeck.ts";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** A fake `fetch` that records calls and answers SimDeck's control endpoints. */
function fakeFetch(): { impl: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(
      Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
    );
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, headers, body });
    if (url.includes("/api/health")) return new Response("{}", { status: 200 });
    if (url.includes("/accessibility-tree")) {
      return new Response(JSON.stringify({ source: "native-ax", nodes: [] }), { status: 200 });
    }
    if (url.endsWith("/screenshot.png")) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    if (url.endsWith("/action")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (url.endsWith("/pasteboard")) return new Response("{}", { status: 200 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const iosTarget = { platform: "ios" as const, udid: "UDID-1" };
const lastAction = (calls: Recorded[]) => [...calls].reverse().find((c) => c.url.endsWith("/action"))!;

describe("SimDeckControl.describe", () => {
  it("GETs the accessibility-tree with source + options and returns the parsed body", async () => {
    const { impl, calls } = fakeFetch();
    const control = new SimDeckControl({ fetchImpl: impl, port: 4310, autostart: false });
    const tree = await control.describe(iosTarget, { interactiveOnly: true, maxDepth: 3 });
    assert.deepEqual(tree, { source: "native-ax", nodes: [] });
    const call = calls.find((c) => c.url.includes("/accessibility-tree"))!;
    assert.equal(call.method, "GET");
    assert.match(call.url, /\/api\/simulators\/UDID-1\/accessibility-tree\?/);
    assert.match(call.url, /source=auto/);
    assert.match(call.url, /interactiveOnly=true/);
    assert.match(call.url, /maxDepth=3/);
  });

  it("falls back to the raw tree when interactiveOnly returns an empty (degraded) tree", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/health")) return new Response("{}", { status: 200 });
      calls.push(url);
      // The regular/interactive capture degrades to roots:[]; raw returns a node.
      if (url.includes("interactiveOnly=true")) {
        return new Response(JSON.stringify({ roots: [], fallbackReason: "…", source: "native-ax" }), { status: 200 });
      }
      return new Response(JSON.stringify({ roots: [{ AXLabel: "Okam Admin" }], source: "native-ax" }), { status: 200 });
    }) as unknown as typeof fetch;
    const control = new SimDeckControl({ fetchImpl, autostart: false });
    const tree = (await control.describe(iosTarget, { interactiveOnly: true })) as { roots: unknown[] };
    assert.equal(tree.roots.length, 1, "should return the non-empty raw tree");
    assert.equal(calls.length, 2, "should retry once without interactiveOnly");
    assert.ok(calls[1] && !calls[1].includes("interactiveOnly=true"), "retry must drop interactiveOnly");
  });

  it("URL-encodes an android:<avd> target", async () => {
    const { impl, calls } = fakeFetch();
    const control = new SimDeckControl({ fetchImpl: impl, autostart: false });
    await control.describe({ platform: "android", udid: "android:pixel_7" }, {});
    const call = calls.find((c) => c.url.includes("/accessibility-tree"))!;
    assert.match(call.url, /\/api\/simulators\/android%3Apixel_7\/accessibility-tree/);
  });
});

describe("SimDeckControl.action", () => {
  it("translates tap to a normalized /action POST with a same-origin Origin header", async () => {
    const { impl, calls } = fakeFetch();
    const control = new SimDeckControl({ fetchImpl: impl, port: 4310, autostart: false });
    await control.action(iosTarget, { type: "tap", x: 0.5, y: 0.25 });
    const c = lastAction(calls);
    assert.equal(c.method, "POST");
    assert.deepEqual(c.body, { action: "tap", x: 0.5, y: 0.25, normalized: true });
    assert.equal(c.headers.origin, "http://127.0.0.1:4310");
    assert.equal(c.headers["content-type"], "application/json");
  });

  it("translates tapElement/type/key/swipe/gesture/verifiers to SimDeck payloads", async () => {
    const { impl, calls } = fakeFetch();
    const control = new SimDeckControl({ fetchImpl: impl, autostart: false });

    await control.action(iosTarget, { type: "tapElement", selector: { text: "Continue" }, waitTimeoutMs: 5000 });
    assert.deepEqual(lastAction(calls).body, { action: "tap", selector: { text: "Continue" }, waitTimeoutMs: 5000 });

    await control.action(iosTarget, { type: "type", text: "hello" });
    assert.deepEqual(lastAction(calls).body, { action: "type", text: "hello" });

    await control.action(iosTarget, { type: "key", name: "enter" });
    assert.deepEqual(lastAction(calls).body, { action: "key", keyCode: 40 });

    await control.action(iosTarget, { type: "swipe", startX: 0.5, startY: 0.8, endX: 0.5, endY: 0.2, durationMs: 120 });
    assert.deepEqual(lastAction(calls).body, { action: "swipe", startX: 0.5, startY: 0.8, endX: 0.5, endY: 0.2, durationMs: 120 });

    await control.action(iosTarget, { type: "gesture", preset: "scroll-down" });
    assert.deepEqual(lastAction(calls).body, { action: "gesture", preset: "scroll-down" });

    await control.action(iosTarget, { type: "waitFor", selector: { id: "ok" }, timeoutMs: 3000 });
    assert.deepEqual(lastAction(calls).body, { action: "waitFor", selector: { id: "ok" }, timeoutMs: 3000 });

    await control.action(iosTarget, { type: "assert", selector: { label: "Done" } });
    assert.deepEqual(lastAction(calls).body, { action: "assert", selector: { label: "Done" } });
  });

  it("routes non-US iOS text through the pasteboard + Cmd-V (HID can't type it)", async () => {
    const { impl, calls } = fakeFetch();
    const control = new SimDeckControl({ fetchImpl: impl, autostart: false });
    await control.action(iosTarget, { type: "type", text: "blåbær" });
    const pb = calls.find((c) => c.url.endsWith("/pasteboard"))!;
    assert.deepEqual(pb.body, { text: "blåbær" });
    assert.deepEqual(lastAction(calls).body, { action: "key", keyCode: 25, modifiers: 0x08 });
  });

  it("types non-US text directly on Android (adb input text handles it)", async () => {
    const { impl, calls } = fakeFetch();
    const control = new SimDeckControl({ fetchImpl: impl, autostart: false });
    await control.action({ platform: "android", udid: "android:pixel" }, { type: "type", text: "blåbær" });
    assert.equal(
      calls.find((c) => c.url.endsWith("/pasteboard")),
      undefined,
    );
    assert.deepEqual(lastAction(calls).body, { action: "type", text: "blåbær" });
  });

  it("rejects an unknown key name", async () => {
    const { impl } = fakeFetch();
    const control = new SimDeckControl({ fetchImpl: impl, autostart: false });
    await assert.rejects(
      () => control.action(iosTarget, { type: "key", name: "nope" }),
      (e: unknown) => e instanceof SimDeckActionError && /unknown key/.test((e as Error).message),
    );
  });

  it("never touches the input WebSocket / webrtc / refresh endpoints", async () => {
    const { impl, calls } = fakeFetch();
    const control = new SimDeckControl({ fetchImpl: impl, autostart: false });
    await control.describe(iosTarget, { interactiveOnly: true });
    await control.action(iosTarget, { type: "tap", x: 0.1, y: 0.1 });
    await control.action(iosTarget, { type: "type", text: "æ" });
    await control.screenshot(iosTarget);
    assert.ok(calls.length > 0);
    assert.ok(calls.every((c) => !/\/(input|control|webrtc|refresh)(\b|\/)/.test(c.url)), "hit a forbidden endpoint");
  });

  it("surfaces a SimDeck error as SimDeckActionError", async () => {
    const errFetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/health")) return new Response("{}", { status: 200 });
      return new Response(JSON.stringify({ error: "element not found" }), { status: 404 });
    }) as unknown as typeof fetch;
    const control = new SimDeckControl({ fetchImpl: errFetch, autostart: false });
    await assert.rejects(
      () => control.action(iosTarget, { type: "assert", selector: { id: "x" } }),
      (e: unknown) => e instanceof SimDeckActionError && /element not found/.test((e as Error).message),
    );
  });
});

describe("SimDeckDaemon", () => {
  it("returns the loopback origin when the service is already healthy (no start)", async () => {
    let started = 0;
    const { impl } = fakeFetch();
    const daemon = new SimDeckDaemon({ fetchImpl: impl, port: 4310, startImpl: async () => void started++ });
    assert.equal(await daemon.ensureRunning(), "http://127.0.0.1:4310");
    assert.equal(started, 0);
  });

  it("starts the service when down, then resolves once health comes up", async () => {
    let started = 0;
    let healthy = false;
    const fetchSeq = (async (input: unknown) => {
      if (String(input).includes("/api/health")) return new Response("{}", { status: healthy ? 200 : 503 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const daemon = new SimDeckDaemon({
      fetchImpl: fetchSeq,
      autostart: true,
      startImpl: async () => {
        started++;
        healthy = true;
      },
    });
    assert.equal(await daemon.ensureRunning(), "http://127.0.0.1:4310");
    assert.equal(started, 1);
  });

  it("throws an actionable SimDeckUnavailableError when down and autostart is off", async () => {
    const downFetch = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    const daemon = new SimDeckDaemon({ fetchImpl: downFetch, autostart: false });
    await assert.rejects(
      () => daemon.ensureRunning(),
      (e: unknown) => e instanceof SimDeckUnavailableError && Boolean((e as SimDeckUnavailableError).hint),
    );
  });
});
