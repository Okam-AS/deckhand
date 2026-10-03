import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { LiveShareRegistry, LiveShareError, createLiveShareRouter, LIVE_DEVICE_ID } from "./liveShares.ts";
import { createShareRouter, createPinGate, handleShareUpgrade } from "./proxy.ts";
import type { AttachedStream } from "../streaming/backend.ts";
import type { SimDevice } from "../devices/ios.ts";
import type { PreviewEngine } from "../engine/preview.ts";

function fakeStream(origin = "http://127.0.0.1:1", firstFrame = true) {
  const s = { detached: 0 };
  const stream: AttachedStream = {
    origin,
    helperBasePath: "/helper/u",
    waitForFirstFrame: async () => firstFrame,
    describe: async () => "",
    detach: async () => {
      s.detached++;
    },
  };
  return { stream, s };
}

function registry(opts: { devices?: SimDevice[]; alive?: Set<number>; firstFrame?: boolean; origin?: string } = {}) {
  const alive = opts.alive ?? new Set([42]);
  const made: ReturnType<typeof fakeStream>[] = [];
  const reg = new LiveShareRegistry({
    attach: async () => {
      const f = fakeStream(opts.origin, opts.firstFrame ?? true);
      made.push(f);
      return f.stream;
    },
    simPrefix: "okam-factory-",
    listDevices: async () => opts.devices ?? [{ udid: "U1", name: "okam-factory-1", state: "Booted" }],
    pidAlive: (pid) => alive.has(pid),
    genShareId: (() => {
      let n = 0;
      return () => `share${++n}`;
    })(),
  });
  return { reg, made, alive };
}

describe("LiveShareRegistry", () => {
  it("shares only a booted okam-factory- simulator owned by a live pid", async () => {
    const { reg } = registry({
      devices: [
        { udid: "P1", name: "deckhand-pool-1", state: "Booted" },
        { udid: "M1", name: "okam-main-ipad9", state: "Booted" },
        { udid: "F2", name: "okam-factory-2", state: "Shutdown" },
      ],
    });
    for (const udid of ["P1", "M1", "F2", "nope"]) {
      await assert.rejects(reg.create({ udid, pid: 42 }), (e: LiveShareError) => e.status === 403, udid);
    }
    const { reg: r2 } = registry();
    await assert.rejects(r2.create({ udid: "U1", pid: 7 }), (e: LiveShareError) => e.status === 400);
    const off = new LiveShareRegistry({ attach: async () => fakeStream().stream, listDevices: async () => [{ udid: "U1", name: "okam-factory-1", state: "Booted" }] });
    await assert.rejects(off.create({ udid: "U1", pid: process.pid }), (e: LiveShareError) => e.status === 403);
  });

  it("keeps one share per simulator: a new one revokes the old", async () => {
    const { reg, made } = registry();
    const a = await reg.create({ udid: "U1", pid: 42 });
    const b = await reg.create({ udid: "U1", pid: 42 });
    assert.equal(reg.find(a.shareId), null);
    assert.equal(reg.wasRevoked(a.shareId), true);
    assert.equal(made[0]!.s.detached, 1);
    assert.equal(reg.find(b.shareId)?.udid, "U1");
  });

  it("detaches and refuses when the stream never shows a frame", async () => {
    const { reg, made } = registry({ firstFrame: false });
    await assert.rejects(reg.create({ udid: "U1", pid: 42 }), (e: LiveShareError) => e.status === 504);
    assert.equal(made[0]!.s.detached, 1);
  });

  it("revokes on request: the stream is detached and the id reads as revoked", async () => {
    const { reg, made } = registry();
    const s = await reg.create({ udid: "U1", pid: 42 });
    assert.equal(reg.find(s.shareId)?.udid, "U1");
    assert.equal(reg.wasRevoked(s.shareId), false);
    assert.equal(await reg.revoke(s.shareId), true);
    assert.equal(reg.find(s.shareId), null);
    assert.equal(reg.wasRevoked(s.shareId), true);
    assert.equal(made[0]!.s.detached, 1);
    assert.equal(await reg.revoke(s.shareId), false);
  });

  it("drops a share whose owner process died without revoking it", async () => {
    const { reg, made, alive } = registry();
    const s = await reg.create({ udid: "U1", pid: 42 });
    alive.delete(42);
    assert.equal(reg.find(s.shareId), null);
    assert.equal(reg.wasRevoked(s.shareId), true);
    assert.equal(made[0]!.s.detached, 1);
  });

  it("sweep revokes a dead owner's share with no request touching it", async () => {
    const { reg, made, alive } = registry();
    const s = await reg.create({ udid: "U1", pid: 42 });
    alive.delete(42);
    await reg.sweep();
    assert.equal(made[0]!.s.detached, 1);
    assert.equal(reg.wasRevoked(s.shareId), true);
  });
});

async function listen(server: Server): Promise<{ server: Server; base: string }> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe("/admin/live-shares", () => {
  let srv: Server;
  let base: string;
  const { reg } = registry();
  const hdr = { "content-type": "application/json" };
  const body = JSON.stringify({ udid: "U1", pid: 42 });

  before(async () => {
    const app = express();
    app.use("/admin/live-shares", createLiveShareRouter({ registry: reg }));
    ({ server: srv, base } = await listen(createServer(app)));
  });
  after(() => srv.close());

  it("refuses a request that came through the tunnel", async () => {
    for (const h of ["cf-connecting-ip", "cf-ray"]) {
      const r = await fetch(`${base}/admin/live-shares`, { method: "POST", headers: { ...hdr, [h]: "1.2.3.4" }, body });
      assert.equal(r.status, 404, h);
      const d = await fetch(`${base}/admin/live-shares/share1`, { method: "DELETE", headers: { [h]: "1.2.3.4" } });
      assert.equal(d.status, 404, h);
    }
    assert.equal(reg.find("share1"), null);
  });

  it("refuses a body that is not {udid, pid}", async () => {
    const r = await fetch(`${base}/admin/live-shares`, { method: "POST", headers: hdr, body: JSON.stringify({ udid: "U1", pid: "42" }) });
    assert.equal(r.status, 400);
  });

  it("opens a share with no credential and revokes it", async () => {
    const r = await fetch(`${base}/admin/live-shares`, { method: "POST", headers: hdr, body });
    assert.equal(r.status, 201);
    const j = (await r.json()) as { shareId: string; deviceId: string };
    assert.deepEqual(Object.keys(j).sort(), ["deviceId", "shareId"]);
    assert.equal(j.deviceId, "ios-0");
    assert.equal((await fetch(`${base}/admin/live-shares/${j.shareId}`, { method: "DELETE" })).status, 204);
    assert.equal((await fetch(`${base}/admin/live-shares/${j.shareId}`, { method: "DELETE" })).status, 404);
  });

  it("passes the registry's refusal through with its status", async () => {
    const r = await fetch(`${base}/admin/live-shares`, { method: "POST", headers: hdr, body: JSON.stringify({ udid: "X", pid: 42 }) });
    assert.equal(r.status, 403);
    assert.match(((await r.json()) as { error: string }).error, /okam-factory-/);
  });
});

describe("a live share through the share proxy", () => {
  let helper: Server;
  let helperWs: WebSocketServer;
  let helperWsHits = 0;
  let proxy: Server;
  let base: string;
  let dist: string;
  let reg: LiveShareRegistry;
  let shareId: string;

  before(async () => {
    helper = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`helper ${req.url}`);
    });
    helperWs = new WebSocketServer({ server: helper });
    helperWs.on("connection", () => helperWsHits++);
    const h = await listen(helper);
    ({ reg } = registry({ origin: h.base }));
    shareId = (await reg.create({ udid: "U1", pid: 42 })).shareId;
    const engine = {
      findByShareId: (id: string) => {
        const live = reg.find(id);
        return live ? { previewId: `live-${id}`, viewOnly: true, devices: [{ deviceId: LIVE_DEVICE_ID, platform: "ios", stream: live.stream }] } : null;
      },
      liveShareRevoked: (id: string) => reg.wasRevoked(id),
      shareState: (id: string) => (reg.find(id) ? { viewOnly: true, devices: [{ deviceId: LIVE_DEVICE_ID }] } : null),
      restartByShareId: () => {
        throw new Error("no restart for a live share");
      },
      pinInfoForShare: () => ({ required: false, length: 0 }),
      pinRecordForShare: () => null,
      pairedShareIds: () => [],
      logStreamEvent: () => {},
    } as unknown as PreviewEngine;
    dist = mkdtempSync(join(tmpdir(), "live-viewer-"));
    writeFileSync(join(dist, "index.html"), "<html>viewer</html>");
    const pinGate = createPinGate(engine, "secret");
    const app = express();
    app.use("/s", createShareRouter({ engine, pinGate, viewerDist: dist }));
    proxy = createServer(app);
    const wss = new WebSocketServer({ noServer: true });
    proxy.on("upgrade", (req, socket, head) => {
      if (!handleShareUpgrade(engine, pinGate, wss, req, socket, head)) socket.destroy();
    });
    ({ base } = await listen(proxy));
  });
  after(() => {
    proxy.close();
    helperWs.close();
    helper.close();
    rmSync(dist, { recursive: true, force: true });
  });

  it("serves the video and nothing else", async () => {
    for (const sub of ["stream.avcc", "stream.mjpeg"]) {
      const v = await fetch(`${base}/s/${shareId}/dev/${LIVE_DEVICE_ID}/${sub}`);
      assert.equal(v.status, 200, sub);
      assert.match(await v.text(), new RegExp(`${sub.replace(".", "\\.")}$`));
    }
    assert.equal((await fetch(`${base}/s/${shareId}/dev/${LIVE_DEVICE_ID}/ax`)).status, 404);
    assert.equal((await fetch(`${base}/s/${shareId}/web/`)).status, 404);
    assert.notEqual((await fetch(`${base}/s/${shareId}/restart`, { method: "POST" })).status, 202);
    const log = await fetch(`${base}/s/${shareId}/dev/${LIVE_DEVICE_ID}/clientlog`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "x" }),
    });
    assert.equal(log.status, 404);
    const st = (await (await fetch(`${base}/s/${shareId}/state`)).json()) as { viewOnly?: boolean; devices: { deviceId: string }[] };
    assert.equal(st.viewOnly, true);
    assert.deepEqual(st.devices.map((d) => d.deviceId), [LIVE_DEVICE_ID]);
  });

  it("refuses the input socket", async () => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/s/${shareId}/dev/${LIVE_DEVICE_ID}/ws`);
    const opened = await new Promise<boolean>((r) => {
      ws.on("open", () => r(true));
      ws.on("error", () => r(false));
    });
    ws.terminate();
    assert.equal(opened, false);
    assert.equal(helperWsHits, 0);
  });

  it("answers the viewer link 200 while live and 410 once revoked", async () => {
    const live = await new Promise<number>((r) => httpRequest(`${base}/s/${shareId}`, (res) => (res.resume(), r(res.statusCode ?? 0))).end());
    assert.equal(live, 200);
    await reg.revoke(shareId);
    const gone = await fetch(`${base}/s/${shareId}`);
    assert.equal(gone.status, 410);
    assert.match(await gone.text(), /viewer/);
    assert.equal((await fetch(`${base}/s/${shareId}/dev/${LIVE_DEVICE_ID}/stream.mjpeg`)).status, 410);
    assert.equal((await fetch(`${base}/s/${shareId}/state`)).status, 410);
    assert.equal((await fetch(`${base}/s/someone-elses-share`)).status, 200);
  });
});
