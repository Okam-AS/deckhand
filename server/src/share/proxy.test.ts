import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { createShareRouter, createHostWebProxyMiddleware, createPinGate } from "./proxy.ts";
import { PreviewError, type PreviewEngine } from "../engine/preview.ts";

/** Togglable share PIN for the gate tests (current = null → no PIN required). */
interface SharePin {
  shareId: string;
  length: number;
  pin: string;
}
const pinState: { current: SharePin | null } = { current: null };
const fakePinInfo = (shareId: string): { required: boolean; length: number } => {
  const p = pinState.current;
  return p && p.shareId === shareId ? { required: true, length: p.length } : { required: false, length: 0 };
};
const fakeVerifyPin = (shareId: string, pin: string): boolean => {
  const p = pinState.current;
  return Boolean(p && p.shareId === shareId && p.pin === pin);
};

/** GET a loopback URL with an explicit Host header (fetch can't override Host reliably). */
function getWithHost(port: number, path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", port, path, method: "GET", headers: { host } }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** POST JSON to a loopback URL with an explicit Host header; returns status + set-cookie. */
function postWithHost(
  port: number,
  path: string,
  host: string,
  body: unknown,
): Promise<{ status: number; body: string; setCookie: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: "127.0.0.1", port, path, method: "POST", headers: { host, "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
      (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b, setCookie: String(res.headers["set-cookie"] ?? "") }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

// ---------------------------------------------------------------------------
// Regression: a serve-sim helper that drops its socket mid-stream (what happens
// on teardown while a viewer is watching) must not surface as an unhandled
// 'error' on the proxied Readable — that crashed the whole server process.
// ---------------------------------------------------------------------------

let helper: Server;
let helperOrigin: string;
let webHelper: Server;
let webHelperOrigin: string;
const webHits: string[] = [];
let proxy: Server;
let proxyBase: string;
const restartCalls: string[] = [];
const streamTrace: string[] = [];

before(async () => {
  // Fake helper: send a header + a chunk, then abruptly kill the socket.
  helper = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=f" });
    res.write("--f\r\nContent-Type: image/jpeg\r\n\r\n");
    res.write(Buffer.alloc(4096, 0x41));
    setTimeout(() => res.socket?.destroy(), 20); // helper goes away mid-stream
  });
  await new Promise<void>((r) => helper.listen(0, "127.0.0.1", r));
  helperOrigin = `http://127.0.0.1:${(helper.address() as AddressInfo).port}`;

  // Fake web dev server: echoes the exact path it was asked for (so the test can
  // assert the reverse proxy reconstructed the dev server's own base path).
  webHelper = createServer((req, res) => {
    webHits.push(req.url ?? "");
    res.writeHead(200, { "content-type": "text/html", etag: 'W/"1"' });
    res.end(`served ${req.url}`);
  });
  await new Promise<void>((r) => webHelper.listen(0, "127.0.0.1", r));
  webHelperOrigin = `http://127.0.0.1:${(webHelper.address() as AddressInfo).port}`;

  const engine = {
    findByShareId: (shareId: string) => {
      if (shareId === "share1")
        return { previewId: "p1", devices: [{ deviceId: "ios-0", platform: "ios", stream: { origin: helperOrigin, helperBasePath: "/helper/x" } }] };
      if (shareId === "web-share")
        return {
          previewId: "pw",
          devices: [{ deviceId: "web-0", platform: "web", stream: { origin: webHelperOrigin, helperBasePath: "/s/web-share/web" } }],
        };
      return null;
    },
    restartByShareId: (shareId: string) => {
      restartCalls.push(shareId);
      if (shareId === "local-share") return { previewId: "p1" };
      if (shareId === "git-share") throw new PreviewError("only local (dev-mode) previews can be restarted from the viewer");
      throw new PreviewError(`no active preview for share "${shareId}"`);
    },
    shareState: (shareId: string) => (shareId === "share1" || shareId === "web-share" ? { ready: true, devices: [] } : null),
    pinInfoForShare: fakePinInfo,
    verifyPin: fakeVerifyPin,
    logStreamEvent: (shareId: string, deviceId: string, line: string) => {
      streamTrace.push(`${shareId}/${deviceId} ${line}`);
    },
  } as unknown as PreviewEngine;

  const app = express();
  app.use("/s", createShareRouter({ engine, pinGate: createPinGate(engine, "test-secret") }));
  proxy = createServer(app);
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  proxyBase = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
});

after(() => {
  helper?.close();
  webHelper?.close();
  proxy?.close();
});

describe("stream diagnostics", () => {
  // A viewer stuck on "Connecting…" is the hardest failure to debug remotely:
  // nothing is on screen and, before this, nothing was in any log either.
  it("records why a stream request could not be routed", async () => {
    streamTrace.length = 0;
    await fetch(`${proxyBase}/s/share1/dev/ghost-0/stream.mjpeg`);
    const line = streamTrace.find((l) => l.includes("ghost-0"));
    assert.ok(line, "the miss is traced");
    assert.match(line!, /404/);
    assert.match(line!, /no device "ghost-0"/);
    assert.match(line!, /has: ios-0/); // tells the agent what to ask for instead
  });

  it("records the helper's answer for a request that did route", async () => {
    streamTrace.length = 0;
    const res = await fetch(`${proxyBase}/s/share1/dev/ios-0/stream.mjpeg`);
    await res.arrayBuffer().catch(() => {});
    assert.ok(
      streamTrace.some((l) => /GET stream\.mjpeg → helper 200 in \d+ms/.test(l)),
      `expected an upstream trace, got: ${streamTrace.join(" | ")}`,
    );
  });

  it("accepts the viewer's own report and rejects junk", async () => {
    streamTrace.length = 0;
    const ok = await fetch(`${proxyBase}/s/share1/dev/ios-0/clientlog`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "avcc no first frame", detail: "nothing decoded within 4000ms" }),
    });
    assert.equal(ok.status, 204);
    assert.ok(streamTrace.some((l) => l.includes("viewer: avcc no first frame — nothing decoded within 4000ms")));

    const bad = await fetch(`${proxyBase}/s/share1/dev/ios-0/clientlog`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "<script>alert(1)</script>" }),
    });
    assert.equal(bad.status, 400);
  });
});

describe("share proxy resilience", () => {
  it("survives an upstream helper that aborts mid-stream", async () => {
    // With the bug (bare .pipe, no error handler) the aborted upstream emits an
    // unhandled 'error' → the whole process crashes and this test file dies.
    const res = await fetch(`${proxyBase}/s/share1/dev/ios-0/stream.mjpeg`);
    assert.equal(res.status, 200);
    await res.arrayBuffer().catch(() => {}); // client sees the abort; that's fine
    await new Promise((r) => setTimeout(r, 50)); // let any stray 'error' surface

    // The proxy is still alive and serving after the mid-stream teardown.
    const again = await fetch(`${proxyBase}/s/unknown/dev/ios-0/stream.mjpeg`);
    assert.equal(again.status, 404);
  });
});

describe("share restart endpoint (viewer refresh button)", () => {
  it("restarts a local share once, then rate-limits the double-tap", async () => {
    const first = await fetch(`${proxyBase}/s/local-share/restart`, { method: "POST" });
    assert.equal(first.status, 202);
    const second = await fetch(`${proxyBase}/s/local-share/restart`, { method: "POST" });
    assert.equal(second.status, 429, "an immediate second tap must be throttled");
    assert.equal(restartCalls.filter((s) => s === "local-share").length, 1);
  });

  it("rejects git shares with 409 (the button is dev-mode only)", async () => {
    const res = await fetch(`${proxyBase}/s/git-share/restart`, { method: "POST" });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /only local/);
  });

  it("404s an unknown share", async () => {
    const res = await fetch(`${proxyBase}/s/nope/restart`, { method: "POST" });
    assert.equal(res.status, 404);
  });
});

describe("web preview reverse proxy", () => {
  it("forwards an arbitrary path to the share's own dev server, reconstructing its base", async () => {
    const res = await fetch(`${proxyBase}/s/web-share/web/assets/app.js`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "served /s/web-share/web/assets/app.js");
    // etag is one of the forwarded response headers a dev server needs.
    assert.ok(res.headers.get("etag"));
    assert.ok(webHits.includes("/s/web-share/web/assets/app.js"), "the dev server saw its own base path");
  });

  it("serves the app root for the base path", async () => {
    const res = await fetch(`${proxyBase}/s/web-share/web/`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "served /s/web-share/web/");
  });

  it("redirects the bare base (no trailing slash) so asset URLs resolve", async () => {
    const res = await fetch(`${proxyBase}/s/web-share/web`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/s/web-share/web/");
  });

  it("404s a web path on a share that has no web preview", async () => {
    const res = await fetch(`${proxyBase}/s/share1/web/anything`);
    assert.equal(res.status, 404);
  });
});

describe("subdomain web hosting (host-based proxy)", () => {
  let dev: Server;
  let devOrigin: string;
  let hostApp: Server;
  let hostPort: number;
  let ready = true;
  const HOSTID = "abc123def456abc123def456";

  before(async () => {
    dev = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`root ${req.url}`); // echoes the path so we can assert root forwarding
    });
    await new Promise<void>((r) => dev.listen(0, "127.0.0.1", r));
    devOrigin = `http://127.0.0.1:${(dev.address() as AddressInfo).port}`;

    // Fake resolveWebHost: the configured web host and the <hostId>.… label both
    // resolve to the dev server; the apex host resolves to null (falls through).
    const engine = {
      resolveWebHost: (hostHeader: string | undefined) => {
        const host = (hostHeader ?? "").split(":")[0]!.toLowerCase();
        const isOurs = host === "webpreview.example.com" || host.startsWith(`${HOSTID}.`);
        return isOurs ? { origin: ready ? devOrigin : null, ready, shareId: "web-share" } : null;
      },
      pinInfoForShare: fakePinInfo,
      verifyPin: fakeVerifyPin,
    } as unknown as PreviewEngine;

    const a = express();
    a.use(createHostWebProxyMiddleware(engine, createPinGate(engine, "test-secret")));
    a.get("/healthz", (_q, s) => s.json({ apex: true }));
    hostApp = createServer(a);
    await new Promise<void>((r) => hostApp.listen(0, "127.0.0.1", r));
    hostPort = (hostApp.address() as AddressInfo).port;
  });
  after(() => {
    dev?.close();
    hostApp?.close();
  });

  it("proxies a live subdomain host to its dev server at root (path preserved)", async () => {
    const res = await getWithHost(hostPort, "/some/path?q=1", `${HOSTID}.deckhand.sharghi.no`);
    assert.equal(res.status, 200);
    assert.equal(res.body, "root /some/path?q=1");
  });

  it("proxies the configured public web host too (single-host mode)", async () => {
    const res = await getWithHost(hostPort, "/", "webpreview.example.com");
    assert.equal(res.status, 200);
    assert.equal(res.body, "root /");
  });

  it("falls through to apex routing for a non-preview host", async () => {
    const res = await getWithHost(hostPort, "/healthz", "deckhand.sharghi.no");
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { apex: true });
  });

  it("serves a starting interstitial while the dev server boots", async () => {
    ready = false;
    const res = await getWithHost(hostPort, "/", `${HOSTID}.deckhand.sharghi.no`);
    assert.equal(res.status, 503);
    assert.match(res.body, /Starting/i);
    ready = true;
  });

  it("PIN-protected subdomain: serves the standalone pad, then unlocks via /__deck/unlock", async () => {
    pinState.current = { shareId: "web-share", length: 4, pin: "1234" };
    try {
      // Locked → any navigation gets the vanilla pad page (not the app).
      const gate = await getWithHost(hostPort, "/", `${HOSTID}.deckhand.sharghi.no`);
      assert.equal(gate.status, 200);
      assert.match(gate.body, /Enter PIN/);
      assert.doesNotMatch(gate.body, /root \//); // the real dev server was NOT reached
      // Wrong PIN → 401; right PIN → 200 + a host cookie.
      const bad = await postWithHost(hostPort, "/__deck/unlock", `${HOSTID}.deckhand.sharghi.no`, { pin: "0000" });
      assert.equal(bad.status, 401);
      const good = await postWithHost(hostPort, "/__deck/unlock", `${HOSTID}.deckhand.sharghi.no`, { pin: "1234" });
      assert.equal(good.status, 200);
      assert.match(good.setCookie, /deck_unlock=/);
    } finally {
      pinState.current = null;
    }
  });
});

describe("PIN gate (path-based share)", () => {
  const base = () => proxyBase;
  const cookieFrom = (res: Response): string => {
    const sc = (res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""]).join(";");
    const m = /deck_unlock=([^;]+)/.exec(sc);
    return m ? `deck_unlock=${m[1]}` : "";
  };

  before(() => {
    pinState.current = { shareId: "share1", length: 4, pin: "1234" };
  });
  after(() => {
    pinState.current = null;
  });

  it("locked: /state returns only { locked, pinLength } (no preview details)", async () => {
    const res = await fetch(`${base()}/s/share1/state`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { locked?: boolean; pinLength?: number; devices?: unknown };
    assert.equal(body.locked, true);
    assert.equal(body.pinLength, 4);
    assert.equal(body.devices, undefined);
  });

  it("locked: content routes 401 without a valid cookie", async () => {
    const res = await fetch(`${base()}/s/share1/dev/ios-0/stream.mjpeg`);
    assert.equal(res.status, 401);
  });

  it("wrong PIN → 401; right PIN → cookie that unlocks /state", async () => {
    const bad = await fetch(`${base()}/s/share1/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin: "9999" }),
    });
    assert.equal(bad.status, 401);

    const good = await fetch(`${base()}/s/share1/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin: "1234" }),
    });
    assert.equal(good.status, 200);
    const cookie = cookieFrom(good);
    assert.match(cookie, /deck_unlock=/);

    // With the cookie, /state returns the full (unlocked) state.
    const unlocked = await fetch(`${base()}/s/share1/state`, { headers: { cookie } });
    const body = (await unlocked.json()) as { locked?: boolean };
    assert.equal(body.locked, false);
  });

  it("throttles after repeated wrong PINs → 429", async () => {
    let last = 401;
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${base()}/s/share1/unlock`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin: "0000" }),
      });
      last = res.status;
    }
    assert.equal(last, 429, "the fifth wrong attempt is locked out");
  });
});
