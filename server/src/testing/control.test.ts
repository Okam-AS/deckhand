import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SimDeckControl, SimDeckActionError, type UiAction } from "./control.ts";
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
    if (url.endsWith("/action")) {
      // The `describe` action answers with the compact snapshot nested under `snapshot`;
      // every other action just echoes ok.
      if ((body as { action?: string })?.action === "describe") {
        return new Response(JSON.stringify({ action: "describe", ok: true, snapshot: { roots: [{ id: "compact-root" }] } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.endsWith("/pasteboard")) return new Response("{}", { status: 200 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const iosTarget = { platform: "ios" as const, udid: "UDID-1" };
const lastAction = (calls: Recorded[]) => [...calls].reverse().find((c) => c.url.endsWith("/action"))!;

/** Every request-issuing path this client has: health, both describe backends, action, pasteboard, screenshot. */
async function exerciseEveryPath(control: SimDeckControl): Promise<void> {
  await control.describe(iosTarget, { interactiveOnly: true });
  await control.describe(iosTarget, { source: "react-native", maxDepth: 3 });
  await control.action(iosTarget, { type: "tap", x: 0.1, y: 0.1 });
  await control.action(iosTarget, { type: "type", text: "æ" });
  await control.screenshot(iosTarget);
}

describe("SimDeckControl.describe", () => {
  it("uses the compact describe action by default, unwrapped to the endpoint's shape", async () => {
    // Measured on one app screen: the action returns the same 76 elements in 10,157 bytes
    // that the full tree spends 29,918 on, and the interactiveOnly tree 26,501 for 70. The
    // saving is encoding, not content — so this is the default and nothing is lost.
    const { impl, calls } = fakeFetch();
    const control = new SimDeckControl({ fetchImpl: impl, autostart: false });
    const tree = await control.describe(iosTarget, { interactiveOnly: true });
    // Unwrapped: callers must not have to know which backend answered.
    assert.deepEqual(tree, { roots: [{ id: "compact-root" }] });
    assert.deepEqual(lastAction(calls).body, { action: "describe" });
    assert.ok(!calls.some((c) => c.url.includes("/accessibility-tree")), "the expensive endpoint must not be touched");
  });

  it("still uses the endpoint when the caller asks for a source or a depth", async () => {
    // The action ignores every option — verified against the daemon. `source` is a real
    // lever (framework inspector vs the native-AX fallback, which degrades to unlabelled
    // nodes on map-heavy screens), so asking for one must not be silently dropped.
    for (const opts of [{ source: "react-native" }, { maxDepth: 3 }]) {
      const { impl, calls } = fakeFetch();
      const control = new SimDeckControl({ fetchImpl: impl, autostart: false });
      await control.describe(iosTarget, opts);
      assert.ok(calls.some((c) => c.url.includes("/accessibility-tree")), `${JSON.stringify(opts)} must reach the endpoint`);
    }
  });

  it("falls back to the endpoint when the compact snapshot comes back empty", async () => {
    // iOS AX capture degrades to nothing on some screens. Answering "empty" is never true.
    const seen: string[] = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/health")) return new Response("{}", { status: 200 });
      seen.push(url);
      if (url.endsWith("/action")) return new Response(JSON.stringify({ snapshot: { roots: [] } }), { status: 200 });
      return new Response(JSON.stringify({ roots: [{ AXLabel: "Uno-X" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const control = new SimDeckControl({ fetchImpl, autostart: false });
    const tree = (await control.describe(iosTarget, {})) as { roots: unknown[] };
    assert.equal(tree.roots.length, 1, "must return the endpoint's tree, not the empty snapshot");
    assert.ok(seen.some((u) => u.includes("/accessibility-tree")), "must have fallen through");
  });

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
    // maxDepth forces the endpoint path, which is the one this fallback belongs to.
    const tree = (await control.describe(iosTarget, { interactiveOnly: true, maxDepth: 9 })) as { roots: unknown[] };
    assert.equal(tree.roots.length, 1, "should return the non-empty raw tree");
    assert.equal(calls.length, 2, "should retry once without interactiveOnly");
    assert.ok(calls[1] && !calls[1].includes("interactiveOnly=true"), "retry must drop interactiveOnly");
  });

  it("URL-encodes an android:<avd> target", async () => {
    const { impl, calls } = fakeFetch();
    const control = new SimDeckControl({ fetchImpl: impl, autostart: false });
    await control.describe({ platform: "android", udid: "android:pixel_7" }, { maxDepth: 4 });
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

  it("translates the actions SimDeck had that deckhand was not exposing", async () => {
    // Every payload below was probed against a live daemon before it was written down --
    // these are the shapes it accepts, not shapes inferred from a doc. The seven exist
    // because a real run burned round trips faking them: an agent that cannot say "go
    // back" guesses an edge-swipe, and one that cannot scroll to an element runs a
    // screenshot/scroll loop instead.
    const cases: Array<[UiAction, Record<string, unknown>]> = [
      [{ type: "back" }, { action: "back" }],
      [{ type: "dismissKeyboard" }, { action: "dismissKeyboard" }],
      // SimDeck reads `ms`. It echoes `durationMs`, and accepts that key while sleeping 0.
      [{ type: "sleep", ms: 250 }, { action: "sleep", ms: 250 }],
      [{ type: "scrollUntilVisible", selector: { id: "row-9" } }, { action: "scrollUntilVisible", selector: { id: "row-9" } }],
      [{ type: "toggleAppearance" }, { action: "toggleAppearance" }],
      [{ type: "assertNot", selector: { text: "Spinner" } }, { action: "assertNot", selector: { text: "Spinner" } }],
      [{ type: "waitForNot", selector: { text: "Spinner" } }, { action: "waitForNot", selector: { text: "Spinner" } }],
      [
        { type: "waitForNot", selector: { text: "Spinner" }, timeoutMs: 5000 },
        { action: "waitForNot", selector: { text: "Spinner" }, timeoutMs: 5000 },
      ],
    ];
    for (const [action, expected] of cases) {
      const { impl, calls } = fakeFetch();
      const control = new SimDeckControl({ fetchImpl: impl, autostart: false });
      await control.action(iosTarget, action);
      assert.deepEqual(lastAction(calls).body, expected, `${action.type} must post exactly this`);
    }
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
    await exerciseEveryPath(new SimDeckControl({ fetchImpl: impl, autostart: false }));
    assert.ok(calls.length > 0);
    assert.ok(calls.every((c) => !/\/(input|control|webrtc|refresh)(\b|\/)/.test(c.url)), "hit a forbidden endpoint");
  });

  it("sends no credential on any call — no Authorization, no cookie, no token", async () => {
    // The same-origin loopback allowance is the whole auth story, so the absence of a
    // credential is a property to keep, not an accident. `Origin` is not one: it is a
    // statement about where the request came from, and SimDeck grants it nothing a
    // loopback caller did not already have.
    const { impl, calls } = fakeFetch();
    await exerciseEveryPath(new SimDeckControl({ fetchImpl: impl, autostart: false }));
    assert.ok(calls.length > 0);
    for (const c of calls) {
      assert.deepEqual(
        Object.keys(c.headers).filter((h) => h !== "content-type" && h !== "origin"),
        [],
        `${c.url} sent a header beyond content-type/origin — a credential to SimDeck is a secret deckhand would then hold`,
      );
      assert.doesNotMatch(c.url, /token|auth|key=/i, `${c.url} carries a credential in the URL`);
    }
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

// Two of this seam's rules cannot be proved by the fake fetch above, and both read as
// covered by tests that are not covering them:
//   - a `new WebSocket(…)` never goes through `fetchImpl` at all, so the REST-only rule's
//     headline half is invisible to every runtime assertion here;
//   - the runtime assertions see only the methods they call, so a method added tomorrow
//     that opens /input or attaches a token is simply not exercised, and passes.
// So both are also asserted against the SOURCE of server/src/testing/, which nothing new
// in this directory can be outside of. Comments are stripped first: the rules themselves
// are written in the file headers, and quoting a prohibition used to satisfy it.
describe("the SimDeck client's source", () => {
  const DIR = import.meta.dirname;
  const sources = readdirSync(DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => [f, stripComments(readFileSync(join(DIR, f), "utf8"))] as const);

  it("opens no WebSocket to SimDeck", () => {
    assert.ok(sources.length >= 2, "read no sources — the scan below would be vacuous");
    for (const [file, src] of sources) {
      assert.doesNotMatch(
        src,
        /\bnew WebSocket\b|\bwss?:\/\//,
        `${file} opens a socket to SimDeck — /input and /control start the private CoreSimulator ` +
          `display and encoder session, which is the path PLAN §2 rejected. REST only.`,
      );
    }
  });

  it("names no /input, /control, /webrtc or /refresh endpoint", () => {
    for (const [file, src] of sources) {
      assert.doesNotMatch(
        src,
        /(?<![.\w])\/(input|control|webrtc|refresh)\b/,
        `${file} names a forbidden SimDeck endpoint — REST only (accessibility-tree, action, pasteboard, screenshot.png, health).`,
      );
    }
  });

  it("sends no credential to SimDeck", () => {
    for (const [file, src] of sources) {
      assert.doesNotMatch(
        src,
        /\b(authorization|cookie|bearer|simdeck_token|x-api-key)\b/i,
        `${file} handles a SimDeck credential. Auth here is the same-origin loopback allowance and ` +
          `nothing else, so deckhand holds no SimDeck token — there is no secret to leak, and that is the point.`,
      );
    }
  });
});

/** Drop comment lines so a rule quoted in a file header cannot satisfy the scan that enforces it. */
function stripComments(src: string): string {
  return src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

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
