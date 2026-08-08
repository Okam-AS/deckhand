import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { createShareRouter, createHostWebProxyMiddleware, createPinGate, type PinGate } from "./proxy.ts";
import { PreviewError, type PreviewEngine } from "../engine/preview.ts";
import { hashPassword, type PasswordHash } from "./shares.ts";

/** Togglable share PIN for the gate tests (current = null → no PIN required). */
interface SharePin {
  shareId: string;
  length: number;
  pin: string;
}
// `others` is the several-panes case: every extra pane carries its OWN PIN, so the
// page's own slot can't express "the other panes are locked too". A list rather
// than one slot because a page can show more than two sources.
const pinState: { current: SharePin | null; others: SharePin[] } = { current: null, others: [] };
const findPin = (shareId: string): SharePin | null =>
  [pinState.current, ...pinState.others].find((p) => p?.shareId === shareId) ?? null;
const fakePinInfo = (shareId: string): { required: boolean; length: number } => {
  const p = findPin(shareId);
  return p ? { required: true, length: p.length } : { required: false, length: 0 };
};
const fakeVerifyPin = (shareId: string, pin: string): boolean => {
  const p = findPin(shareId);
  return Boolean(p && p.pin === pin);
};
// The gate folds the PIN record in force into the cookie, so the fake engine has
// to produce a stable-per-PIN record the same way the real one does.
const pinHashes = new Map<string, PasswordHash>();
const fakePinRecord = (shareId: string): (PasswordHash & { length: number }) | null => {
  const p = findPin(shareId);
  if (!p) return null;
  const key = `${shareId}:${p.pin}`;
  let h = pinHashes.get(key);
  if (!h) {
    h = hashPassword(p.pin);
    pinHashes.set(key, h);
  }
  return { ...h, length: p.length };
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

/** The Path attribute of a Set-Cookie line, or undefined when it carries none. */
function cookiePath(setCookie: string): string | undefined {
  return /;\s*path=([^;]*)/i.exec(setCookie)?.[1]?.trim();
}

/**
 * Would a browser send a cookie scoped to `cookiePath` on a request for
 * `requestPath`? RFC 6265 §5.1.4, so the assertion is about REACH rather than
 * about the header's spelling.
 */
function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (cookiePath === requestPath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
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
    pinRecordForShare: fakePinRecord,
    verifyPin: fakeVerifyPin,
    // "share1", "paired-share" and "third-share" stand in for one live page's
    // panes: unlocking any pane has to unlock the rest, or the others hang on
    // "Connecting…". Three, not two, so a regression to single-partner minting
    // fails here instead of only showing up on a real three-source page.
    pairedShareIds: (shareId: string) =>
      shareId === "share1"
        ? ["paired-share", "third-share"]
        : shareId === "paired-share" || shareId === "third-share"
          ? ["share1"]
          : [],
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
      pinRecordForShare: fakePinRecord,
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

  it("locked: the PIN gate is case-insensitive, because Express routing is", async () => {
    // Express dispatches string routes case-insensitively by default, so a
    // case-SENSITIVE gate in front of them gated nothing: /Dev/ served the live
    // screen and the accessibility tree of a PIN-locked share with no PIN.
    for (const seg of ["DEV", "Dev", "dEv"]) {
      const res = await fetch(`${base()}/s/share1/${seg}/ios-0/ax`);
      assert.equal(res.status, 401, `/${seg}/ must be gated exactly like /dev/`);
    }
    const restart = await fetch(`${base()}/s/share1/RESTART`, { method: "POST" });
    assert.equal(restart.status, 401, "/RESTART must be gated exactly like /restart");
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

  it("survives a malformed cookie instead of losing every cookie on the request", async () => {
    // A browser sends every cookie set on this hostname, including ones deckhand
    // never wrote — a web preview's own app can set them. decodeURIComponent
    // throws URIError on a stray '%', and one bad value used to take the whole
    // header down with it: on an HTTP route a 500, and on the WS upgrade (which
    // has no error boundary) a destroyed socket, leaving the viewer retrying
    // forever with nothing on screen and nothing in any log.
    const good = await fetch(`${base()}/s/share1/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin: "1234" }),
    });
    const own = (good.headers.getSetCookie?.() ?? []).find((c) => c.includes("Path=/s/share1"))!;
    const unlock = `deck_unlock=${/deck_unlock=([^;]+)/.exec(own)![1]}`;

    const res = await fetch(`${base()}/s/share1/state`, { headers: { cookie: `junk=100%; ${unlock}` } });
    assert.equal(res.status, 200, "a value we cannot decode must not invalidate the ones we can");
    assert.equal(((await res.json()) as { locked?: boolean }).locked, false);
  });

  it("one PIN unlocks a partner pane, not just the page's own share", async () => {
    // A page is a set of panes. This one shows two — the smallest case that can
    // go wrong, with the N case in the test directly below — and the partner
    // pane streams from its OWN shareId, so from its own path-scoped cookie.
    // Before this, unlocking the page's own share left the partner refusing
    // every WS upgrade ("share is PIN-locked"): it sat on "Connecting…" forever
    // with no pad and no error. `paired-share` is wired as share1's partner.
    pinState.others = [{ shareId: "paired-share", length: 4, pin: "4321" }];
    try {
      const locked = await fetch(`${base()}/s/paired-share/dev/ios-0/stream.mjpeg`);
      assert.equal(locked.status, 401, "the partner pane starts gated");

      const good = await fetch(`${base()}/s/share1/unlock`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin: "1234" }),
      });
      assert.equal(good.status, 200);

      // Two cookies, same name, distinct paths — so pick the partner's by Path.
      // A SELECTOR, not an assertion about scoping: that claim is held by
      // "scopes each minted unlock cookie to one share, and never to a wider
      // path". Widen the scope and repair this line, and nothing stays red.
      const all = good.headers.getSetCookie?.() ?? [];
      const partner = all.find((c) => c.includes("Path=/s/paired-share"));
      assert.ok(partner, `expected an unlock cookie scoped to the partner, got: ${all.join(" | ")}`);
      const cookie = `deck_unlock=${/deck_unlock=([^;]+)/.exec(partner)![1]}`;

      const opened = await fetch(`${base()}/s/paired-share/dev/ios-0/stream.mjpeg`, { headers: { cookie } });
      assert.notEqual(opened.status, 401, "the partner pane must no longer be PIN-gated");
    } finally {
      pinState.others = [];
    }
  });

  it("one PIN unlocks EVERY pane, not just the first", async () => {
    // A page can show more than two sources (old app + main + this branch), and
    // each pane streams from its own path-scoped cookie. Minting only the first
    // partner left the third pane refusing every WS upgrade — visually identical
    // to the two-pane bug, but invisible to a test that only ever wires a pair.
    pinState.others = [
      { shareId: "paired-share", length: 4, pin: "4321" },
      { shareId: "third-share", length: 4, pin: "5678" },
    ];
    try {
      const good = await fetch(`${base()}/s/share1/unlock`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin: "1234" }),
      });
      assert.equal(good.status, 200);

      const all = good.headers.getSetCookie?.() ?? [];
      for (const partner of ["paired-share", "third-share"]) {
        // Again a selector, not a scoping assertion — see the note above.
        const set = all.find((c) => c.includes(`Path=/s/${partner}`));
        assert.ok(set, `expected an unlock cookie for ${partner}, got: ${all.join(" | ")}`);
        const cookie = `deck_unlock=${/deck_unlock=([^;]+)/.exec(set)![1]}`;
        const opened = await fetch(`${base()}/s/${partner}/dev/ios-0/stream.mjpeg`, { headers: { cookie } });
        assert.notEqual(opened.status, 401, `${partner} must no longer be PIN-gated`);
      }
    } finally {
      pinState.others = [];
    }
  });

  it("scopes each minted unlock cookie to one share, and never to a wider path", async () => {
    // `/state`'s top-up loop calls its `allowed` term belt-and-braces, on the
    // grounds that a partner's cookie is path-scoped and so never reaches
    // `/s/<this share>/state` in the first place. That is a claim about what
    // Set-Cookie says, and nothing checked it: the tests above match
    // `Path=/s/<id>` only to PICK a cookie out of the list, so widening every
    // scope to `/` would be "fixed" by editing a selector and the belt would be
    // gone with nothing red. Asserted here as REACH (RFC 6265 path-match), not
    // as header text, so a reformat cannot break it and a real widening cannot
    // pass.
    pinState.others = [
      { shareId: "paired-share", length: 4, pin: "4321" },
      { shareId: "third-share", length: 4, pin: "5678" },
    ];
    try {
      const good = await fetch(`${base()}/s/share1/unlock`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin: "1234" }),
      });
      assert.equal(good.status, 200);
      const set = good.headers.getSetCookie?.() ?? [];
      assert.equal(set.length, 3, `expected one unlock cookie per share, got: ${set.join(" | ")}`);

      const paths = set.map((c) => {
        const p = cookiePath(c);
        assert.ok(p, `an unlock cookie with no Path is scoped by the browser, not by us: ${c}`);
        return p;
      });
      const shares = ["share1", "paired-share", "third-share"];
      for (const p of paths) {
        // The property the comment rests on: one cookie, one share.
        const reaches = shares.filter((id) => pathMatches(p, `/s/${id}/dev/ios-0/stream.mjpeg`));
        assert.deepEqual(reaches, [reaches[0]], `Path=${p} is sent to ${reaches.length} shares (${reaches.join(", ")}), not 1`);
        assert.equal(pathMatches(p, "/health"), false, `Path=${p} escapes /s/ altogether`);
      }
      assert.equal(new Set(paths).size, 3, `each share needs its own scope, got: ${paths.join(", ")}`);
    } finally {
      pinState.others = [];
    }
  });

  it("tops up the partner's cookie on /state when the pair formed after the unlock", async () => {
    // Unlocking mints the partner cookie — but only for a pair that EXISTS at
    // that moment. Two previews that only became a pair once the second booted
    // (or a cookie carried over from an earlier session) left the partner pane
    // streaming from a shareId this browser had no cookie for, stuck on
    // "Connecting…" with no way to unlock it: the pad only renders for the
    // page's own share. /state is polled, so the pair self-heals in one poll.
    const good = await fetch(`${base()}/s/share1/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin: "1234" }),
    });
    assert.equal(good.status, 200);
    const own = (good.headers.getSetCookie?.() ?? []).find((c) => c.includes("Path=/s/share1"))!;
    const cookie = `deck_unlock=${/deck_unlock=([^;]+)/.exec(own)![1]}`;

    // NOW the partner gets a PIN — i.e. the pair formed after the unlock.
    pinState.others = [{ shareId: "paired-share", length: 4, pin: "4321" }];
    try {
      assert.equal((await fetch(`${base()}/s/paired-share/dev/ios-0/stream.mjpeg`)).status, 401);

      const state = await fetch(`${base()}/s/share1/state`, { headers: { cookie } });
      assert.equal(state.status, 200);
      const partner = (state.headers.getSetCookie?.() ?? []).find((c) => c.includes("Path=/s/paired-share"));
      assert.ok(partner, "polling /state on an unlocked share must mint the partner's cookie");

      const partnerCookie = `deck_unlock=${/deck_unlock=([^;]+)/.exec(partner)![1]}`;
      const opened = await fetch(`${base()}/s/paired-share/dev/ios-0/stream.mjpeg`, { headers: { cookie: partnerCookie } });
      assert.notEqual(opened.status, 401, "the partner pane must stream after the top-up");
    } finally {
      pinState.others = [];
    }
  });

  it("does not mint a partner cookie for a LOCKED share's /state", async () => {
    // The top-up must ride on an already-proven unlock, never hand one out.
    pinState.others = [{ shareId: "paired-share", length: 4, pin: "4321" }];
    try {
      const state = await fetch(`${base()}/s/share1/state`);
      assert.equal(((await state.json()) as { locked?: boolean }).locked, true);
      assert.equal((state.headers.getSetCookie?.() ?? []).length, 0, "a locked share must set no cookies");
    } finally {
      pinState.others = [];
    }
  });

  it("does not mint a partner cookie for a PUBLIC share's /state", async () => {
    // The hole this closes: pairing is symmetric, so /state on the PUBLIC side of
    // a pair used to hand any anonymous caller an unlock cookie for the
    // PIN-protected share — the whole PIN bypassed with just the public link.
    // (When it was found, every extra pane was booted public by construction.
    // Panes take the page's access now; the guard never rested on that, and this
    // is still what /state itself must refuse.)
    const wasCurrent = pinState.current;
    pinState.current = null; // share1 public
    pinState.others = [{ shareId: "paired-share", length: 4, pin: "4321" }];
    try {
      const state = await fetch(`${base()}/s/share1/state`);
      assert.equal(state.status, 200);
      assert.equal(((await state.json()) as { locked?: boolean }).locked, false);
      // REACH, not text. This used to look for the literal `Path=/s/paired-share`
      // and assert it was not found — which passes when the scope is WIDER too,
      // because `find` returns undefined for a reason that has nothing to do
      // with the property. A leak scoped to `/` sailed straight through the
      // assertion whose whole job was to catch it. A cookie with no Path at all
      // counts as a leak here as well: its scope is then the browser's guess
      // from the request URL, which is not ours to assume.
      //
      // What this does NOT catch, so do not read it as covering both: widening
      // the scope while the minting guard holds mints nothing here at all, so
      // there is no cookie to be wrongly scoped. That mutation belongs to
      // "scopes each minted unlock cookie to one share, and never to a wider
      // path". This one catches the minting bug, at any scope.
      const partnerRoute = `/s/paired-share/dev/ios-0/stream.mjpeg`;
      const leaked = (state.headers.getSetCookie?.() ?? []).filter((c) => {
        const p = cookiePath(c);
        return p === undefined || pathMatches(p, partnerRoute);
      });
      assert.deepEqual(leaked, [], "a public share must mint nothing that reaches its protected partner");
      assert.equal((await fetch(`${base()}/s/paired-share/dev/ios-0/stream.mjpeg`)).status, 401);
    } finally {
      pinState.others = [];
      pinState.current = wasCurrent;
    }
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

describe("the PIN gate resolves the same shareId the handlers do", () => {
  // The gate only means anything when there IS a PIN, so lock share1 for this block —
  // without it the control below passes vacuously and the bypass test proves nothing.
  before(() => {
    pinState.current = { shareId: "share1", length: 4, pin: "1234" };
  });
  after(() => {
    pinState.current = null;
  });

  it("is not bypassed by percent-encoding the share id", async () => {
    // Third bypass on this path, same shape as the first two: the gate and the handler
    // disagree about what the shareId IS. `req.path` is NOT percent-decoded; `req.params`
    // is. So `/s/%73hare1/...` gates on the literal "%73hare1" — a share nobody has, hence
    // no PIN record, hence "public" — and then serves "share1", which is locked.
    for (const path of [
      "/s/%73hare1/web/index.html",
      "/s/%73hare1/dev/dev-0/stream.mjpeg",
      "/s/%73hare1/dev/dev-0/ax",
    ]) {
      const plain = await fetch(`${proxyBase}${path.replace("%73", "s")}`);
      const encoded = await fetch(`${proxyBase}${path}`);
      assert.equal(plain.status, 401, `${path}: fixture sanity — the plain spelling is locked`);
      assert.equal(
        encoded.status,
        401,
        `${path} returned ${encoded.status} instead of 401 — the gate read the raw path ("%73hare1", ` +
          `which has no PIN record and is therefore treated as public) while the handler read the ` +
          `DECODED param ("share1", which is locked)`,
      );
    }
    const restart = await fetch(`${proxyBase}/s/%73hare1/restart`, { method: "POST" });
    assert.equal(restart.status, 401, "and a link holder must not be able to rebuild a locked share");
  });

  it("still gates the ordinary spelling", async () => {
    assert.equal((await fetch(`${proxyBase}/s/share1/dev/dev-0/ax`)).status, 401);
  });

  it("fails closed on a malformed escape rather than waving it through", async () => {
    // decodeURIComponent throws on "%zz". A request whose target we cannot resolve is not a
    // request we may pass to the handlers — that is how the bypass above worked.
    const res = await fetch(`${proxyBase}/s/%zzhare1/dev/dev-0/ax`);
    assert.ok(res.status === 400 || res.status === 401, `expected a refusal, got ${res.status}`);
  });
});

describe("unlock answers with the state", () => {
  before(() => {
    pinState.current = { shareId: "web-share", length: 4, pin: "1234" };
  });
  after(() => {
    pinState.current = null;
  });

  it("returns the share state, so the viewer needs no second round trip", async () => {
    // It used to POST /unlock, wait, then GET /state and wait again — two sequential trips
    // for one action. On the server both are sub-millisecond; through the tunnel each is
    // ~230ms, so the pad sat with every dot filled for half a second showing nothing. The
    // second call asked for something this handler already had.
    const res = await fetch(`${proxyBase}/s/web-share/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin: "1234" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; state?: { devices?: unknown[] } };
    assert.equal(body.ok, true);
    assert.ok(body.state, "the state rides along with the unlock");
    assert.ok(Array.isArray(body.state!.devices), "and it is the real state, not a stub");
  });

  it("says nothing about the state when the PIN is wrong", async () => {
    // A failed attempt must not leak what is behind the gate.
    const res = await fetch(`${proxyBase}/s/web-share/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin: "9999" }),
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.state, undefined, "no state for a wrong PIN");
  });
});

/**
 * The PIN throttle is the only thing standing between a 4-digit share PIN and
 * whoever has the URL — and a share grants device INPUT, not just video.
 *
 * The bug these pin down: on lockout the gate set `lockedUntil` AND reset
 * `fails` to 0, so waiting out one 30-second lock handed back a full fresh
 * budget. That is a self-renewing ~600 guesses an hour against a 10,000-key
 * space, i.e. the whole space inside a day, with nothing to see in any log.
 */
describe("pin gate throttle", () => {
  const SHARE = "throttled-share";
  const gateEngine = {
    pinInfoForShare: (id: string) => (id === SHARE ? { required: true, length: 4 } : { required: false, length: 0 }),
    pinRecordForShare: (id: string) => (id === SHARE ? { ...hashPassword("1234"), length: 4 } : null),
    verifyPin: (id: string, pin: string) => id === SHARE && pin === "1234",
  } as unknown as PreviewEngine;

  /** A gate whose clock the test drives. maxFails/lockMs are the production defaults. */
  const gate = (clock: { t: number }) => createPinGate(gateEngine, "test-secret", { now: () => clock.t });

  /** A successful attempt carries no lock; narrowing it here keeps the assertions readable. */
  const lockOf = (r: ReturnType<PinGate["attempt"]>): number => (r.ok ? 0 : r.lockedMs);

  const failUntilLocked = (g: ReturnType<typeof createPinGate>): number => {
    for (let i = 0; i < 5; i++) {
      const locked = lockOf(g.attempt(SHARE, "0000"));
      if (locked > 0) return locked;
    }
    throw new Error("never locked");
  };

  it("does not restore the attempt budget when a lock expires", () => {
    const clock = { t: 1_000_000 };
    const g = gate(clock);
    const firstLock = failUntilLocked(g);
    assert.ok(firstLock > 0, "five wrong PINs lock the share");

    clock.t += firstLock + 1; // wait it out
    assert.ok(lockOf(g.attempt(SHARE, "0000")) > 0, "one further wrong PIN re-locks immediately — no fresh five-guess budget");
  });

  it("escalates the lock, so guessing gets slower rather than staying free", () => {
    const clock = { t: 2_000_000 };
    const g = gate(clock);
    const first = failUntilLocked(g);

    clock.t += first + 1;
    const second = lockOf(g.attempt(SHARE, "0000"));
    assert.ok(second > first, `second lock (${second}ms) must exceed the first (${first}ms)`);

    clock.t += second + 1;
    const third = lockOf(g.attempt(SHARE, "0000"));
    assert.ok(third > second, `third lock (${third}ms) must exceed the second (${second}ms)`);
  });

  it("still lets the right PIN through, and clears the record when it does", () => {
    const clock = { t: 3_000_000 };
    const g = gate(clock);
    g.attempt(SHARE, "0000");
    g.attempt(SHARE, "0000");
    const ok = g.attempt(SHARE, "1234");
    assert.equal(ok.ok, true);
    assert.ok(ok.cookie, "and hands back the unlock cookie");
    // A correct PIN wipes the counter: the next wrong guess starts a fresh budget.
    for (let i = 0; i < 4; i++) assert.equal(lockOf(g.attempt(SHARE, "0000")), 0);
  });

  it("forgives after a long quiet spell, so a fumbling colleague is not locked out for the week", () => {
    // The escalation has to decay or it is a one-way ratchet: `lockouts` only cleared on a
    // CORRECT pin, and the server is a LaunchAgent that runs for weeks. Someone who mistypes
    // across an afternoon reaches the 15-minute cap with a one-attempt budget and stays there —
    // and their correct PIN is refused for the whole window. An hour of silence is far longer
    // than any brute-force run can afford and far shorter than a working day.
    const clock = { t: 5_000_000 };
    const g = gate(clock);
    let lock = 0;
    for (let round = 0; round < 4; round++) {
      lock = failUntilLocked(g);
      clock.t += lock + 1;
    }
    assert.ok(lock >= 240_000, `escalation reached ${lock}ms before the quiet spell`);

    clock.t += 60 * 60_000 + 1; // an hour of nobody trying
    assert.equal(lockOf(g.attempt(SHARE, "0000")), 0, "the first wrong PIN after the quiet spell must not re-lock");
    const relock = failUntilLocked(g);
    assert.equal(relock, 30_000, "and the budget and the lock are back to their starting size");
  });

  it("forgets stale failures too, not just stale lockouts", () => {
    // The sibling of the bug above, and it survived the first fix: `forgettable` required
    // `lockedUntil > 0`, so an entry that accumulated failures WITHOUT ever locking (four
    // typos, budget five) aged out never. A month later the next single mistake locked the
    // share. Four-fifths of a lockout is not a state anyone should carry for a month.
    const clock = { t: 6_000_000 };
    const g = gate(clock);
    for (let i = 0; i < 4; i++) assert.equal(lockOf(g.attempt(SHARE, "0000")), 0, "four misses do not lock");

    clock.t += 60 * 60_000 + 1; // nobody touches this share for an hour
    for (let i = 0; i < 4; i++) {
      assert.equal(lockOf(g.attempt(SHARE, "0000")), 0, `miss ${i + 1} after the quiet spell must not lock`);
    }
    assert.equal(lockOf(g.attempt(SHARE, "0000")), 30_000, "the fifth does, from a full budget");
  });

  it("makes waiting out a lock cost the cap, not a fresh budget", () => {
    // Strategy A for an attacker who knows the URL: guess until locked, sit out exactly the
    // lock, repeat. That path never goes quiet, so forgiveness never applies and the escalation
    // cap governs: ~4 guesses an hour. THIS is where the ~96/day figure comes from — not from
    // THROTTLE_FORGET_MS, which an attacker on this path never reaches.
    const clock = { t: 0 };
    const g = createPinGate({ ...gateEngine, verifyPin: () => false } as unknown as PreviewEngine, "test-secret", {
      now: () => clock.t,
    });
    const DAY = 24 * 60 * 60_000;
    let guesses = 0;
    while (clock.t < 7 * DAY) {
      const r = g.attempt(SHARE, "0000");
      guesses++;
      if (!r.ok && r.lockedMs > 0) clock.t += r.lockedMs + 1;
    }
    assert.ok(guesses / 7 < 150, `${(guesses / 7).toFixed(0)}/day on the wait-out-the-lock path`);
  });

  it("makes a FULL budget cost half an hour of total silence, whatever the lock was", () => {
    // Strategy B, and the better one: go quiet until the entry is forgotten, then spend a fresh
    // five. That is worth ~120/day at an hour of forgiveness and ~7 200/day at a minute — so the
    // rate test above cannot see a shortened THROTTLE_FORGET_MS at all (its attacker always
    // retries the instant a lock expires, and is therefore never quiet). This one binds the
    // constant directly: no amount of silence under half an hour may hand back the budget.
    const clock = { t: 0 };
    const g = gate(clock);
    failUntilLocked(g);

    // Twenty-nine minutes of silence: still one attempt, still an immediate re-lock.
    clock.t += 29 * 60_000;
    assert.ok(lockOf(g.attempt(SHARE, "0000")) > 0, "under half an hour must not restore the budget");

    // Properly quiet — measured from THAT attempt, which reset the clock by re-locking.
    clock.t += 121 * 60_000;
    for (let i = 0; i < 4; i++) {
      assert.equal(lockOf(g.attempt(SHARE, "0000")), 0, `miss ${i + 1} of a restored budget must not lock`);
    }
    assert.equal(lockOf(g.attempt(SHARE, "0000")), 30_000, "and the fifth locks from the start of the ladder");
  });

  it("keeps ignoring a share that has no PIN", () => {
    const g = gate({ t: 4_000_000 });
    const r = g.attempt("no-such-share", "0000");
    assert.equal(r.ok, false);
    assert.equal(lockOf(r), 0, "an unknown share must not mint a throttle entry");
  });
});
