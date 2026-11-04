import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import { IphoneMjpegBackend, keyAction } from "./iphoneMjpeg.ts";
import type { UiAction } from "../testing/control.ts";

const UDID = "00008120-000000000000001E";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

/** WDA's MJPEG server as it frames a stream: multipart with Content-Length, one frame then idle. */
async function fakeWdaMjpeg(frames: Buffer[] = [JPEG]): Promise<{ url: string; server: Server }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=--BoundaryString" });
    for (const f of frames) res.write(Buffer.concat([Buffer.from(`--BoundaryString\r\nContent-type: image/jpg\r\nContent-Length: ${f.length}\r\n\r\n`), f, Buffer.from("\r\n\r\n")]));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/`, server };
}

function backend(url: string, acted: UiAction[] = []) {
  return new IphoneMjpegBackend({
    portRange: [0, 0],
    mjpegUrl: async () => url,
    lease: () => "pv1",
    act: async (_udid, a) => void acted.push(a),
    describe: async () => "e1 Button \"Start\"",
  });
}

/** Port 0 cannot be allocated as a range, so tests pick a free one first. */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

async function backendOnFreePort(url: string, acted: UiAction[] = []) {
  const port = await freePort();
  return new IphoneMjpegBackend({ portRange: [port, port], mjpegUrl: async () => url, lease: () => "pv1", act: async (_u, a) => void acted.push(a), describe: async () => "screen" });
}

describe("the iPhone MJPEG helper", () => {
  it("serves WDA's MJPEG on loopback under the viewer's paths, and 404s avcc so the viewer plays MJPEG", async () => {
    const wda = await fakeWdaMjpeg();
    const b = await backendOnFreePort(wda.url);
    try {
      const s = await b.attach({ platform: "ios", udid: UDID });
      assert.match(s.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.equal(s.helperBasePath, `/helper/${UDID}`);
      assert.equal((await fetch(`${s.origin}${s.helperBasePath}/stream.avcc`)).status, 404);
      const ac = new AbortController();
      try {
        const res = await fetch(`${s.origin}${s.helperBasePath}/stream.mjpeg`, { signal: ac.signal });
        assert.equal(res.headers.get("content-type"), "application/octet-stream");
        const reader = res.body!.getReader();
        let got = Buffer.alloc(0);
        while (!got.includes(Buffer.from([0xff, 0xd9]))) got = Buffer.concat([got, Buffer.from((await reader.read()).value!)]);
        assert.ok(got.includes(Buffer.from("Content-Length: 9")));
      } finally {
        ac.abort();
      }
      assert.equal(await s.waitForFirstFrame(2000), true);
      assert.equal(await s.describe(), "screen");
    } finally {
      await b.reapOrphans();
      wda.server.closeAllConnections();
      wda.server.close();
    }
  });

  it("opens no WDA stream for a viewer that left while WDA was still starting", async () => {
    let opened = 0;
    const wda = createServer((_req, res) => {
      opened++;
      res.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=--BoundaryString" });
    });
    await new Promise<void>((r) => wda.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(wda.address() as { port: number }).port}/`;
    let release!: () => void;
    const started = new Promise<void>((r) => (release = r));
    const port = await freePort();
    const b = new IphoneMjpegBackend({ portRange: [port, port], mjpegUrl: async () => (await started, url), lease: () => "pv1", act: async () => {}, describe: async () => "" });
    try {
      const s = await b.attach({ platform: "ios", udid: UDID });
      const ac = new AbortController();
      const viewer = fetch(`${s.origin}${s.helperBasePath}/stream.mjpeg`, { signal: ac.signal }).catch(() => null);
      await new Promise((r) => setTimeout(r, 50));
      ac.abort();
      await viewer;
      await new Promise((r) => setTimeout(r, 50));
      release();
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(opened, 0, "a WDA stream was opened for nobody, and held until the phone's helper detached");
    } finally {
      await b.reapOrphans();
      wda.closeAllConnections();
      wda.close();
    }
  });

  it("reports no first frame when WDA sends none", async () => {
    const wda = await fakeWdaMjpeg([]);
    const b = await backendOnFreePort(wda.url);
    try {
      const s = await b.attach({ platform: "ios", udid: UDID });
      assert.equal(await s.waitForFirstFrame(700), false);
      await s.detach();
    } finally {
      wda.server.closeAllConnections();
      wda.server.close();
    }
  });

  it("turns viewer touches and keys into ui actions, and drops hardware buttons", async () => {
    const acted: UiAction[] = [];
    const b = await backendOnFreePort("http://127.0.0.1:1/", acted);
    const s = await b.attach({ platform: "ios", udid: UDID });
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(s.origin).port}${s.helperBasePath}/ws`);
    try {
      await new Promise((r, j) => ws.once("open", r).once("error", j));
      const frame = (tag: number, o: object) => ws.send(Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(o))]));
      frame(0x03, { type: "begin", x: 0.5, y: 0.5 });
      frame(0x03, { type: "end", x: 0.501, y: 0.5 });
      frame(0x03, { type: "begin", x: 0.5, y: 0.8 });
      frame(0x03, { type: "end", x: 0.5, y: 0.2 });
      frame(0x04, { button: "home" });
      frame(0x07, { orientation: "landscape_left" });
      frame(0x06, { type: "down", usage: 4, char: "æ" });
      frame(0x06, { type: "up", usage: 4, char: "æ" });
      frame(0x06, { type: "down", usage: 40 });
      for (let i = 0; i < 50 && acted.length < 4; i++) await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(acted.map((a) => a.type), ["tap", "swipe", "type", "key"]);
      assert.deepEqual(acted[0], { type: "tap", x: 0.501, y: 0.5 });
      assert.deepEqual(acted[2], { type: "type", text: "æ" });
      assert.deepEqual(acted[3], { type: "key", name: "enter" });
    } finally {
      ws.close();
      await s.detach();
    }
  });

  it("drops input still queued when its viewer socket closes, and binds what it sends to the lease it connected under", async () => {
    const acted: { a: UiAction; lease: string }[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r));
    const port = await freePort();
    let tenant: string | null = "pvA";
    const b = new IphoneMjpegBackend({
      portRange: [port, port],
      mjpegUrl: async () => "http://127.0.0.1:1/",
      lease: () => tenant,
      act: async (_u, a, lease) => {
        acted.push({ a, lease });
        await blocked;
      },
      describe: async () => "",
    });
    const s = await b.attach({ platform: "ios", udid: UDID });
    const ws = new WebSocket(`ws://127.0.0.1:${port}${s.helperBasePath}/ws`);
    try {
      await new Promise((r, j) => ws.once("open", r).once("error", j));
      const frame = (o: object) => ws.send(Buffer.concat([Buffer.from([0x06]), Buffer.from(JSON.stringify(o))]));
      frame({ type: "down", usage: 4, char: "a" });
      frame({ type: "down", usage: 5, char: "b" });
      for (let i = 0; i < 50 && acted.length < 1; i++) await new Promise((r) => setTimeout(r, 20));
      ws.close();
      await new Promise((r) => setTimeout(r, 100));
      tenant = "pvB";
      release();
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(acted, [{ a: { type: "type", text: "a" }, lease: "pvA" }], "a queued keystroke from a closed viewer was sent on");
    } finally {
      await s.detach();
    }
  });

  it("closes a viewer socket when no preview drives the phone", async () => {
    const acted: UiAction[] = [];
    const port = await freePort();
    const b = new IphoneMjpegBackend({ portRange: [port, port], mjpegUrl: async () => "http://127.0.0.1:1/", lease: () => null, act: async (_u, a) => void acted.push(a), describe: async () => "" });
    const s = await b.attach({ platform: "ios", udid: UDID });
    const ws = new WebSocket(`ws://127.0.0.1:${port}${s.helperBasePath}/ws`);
    try {
      const code = await new Promise<number>((r) => ws.once("close", (c) => r(c)));
      assert.equal(code, 1008);
      assert.deepEqual(acted, []);
    } finally {
      await s.detach();
    }
  });

  it("refuses a device that is not an iPhone", async () => {
    await assert.rejects(() => backend("http://127.0.0.1:1/").attach({ platform: "android", udid: "x", serial: "R5C" }), /iOS device/);
  });

  it("closes helpers outside the keep-set, and spares those in it", async () => {
    const b = await backendOnFreePort("http://127.0.0.1:1/");
    const s = await b.attach({ platform: "ios", udid: UDID });
    await b.reapOrphans(new Set([UDID]));
    assert.equal((await fetch(`${s.origin}${s.helperBasePath}/health`)).status, 200);
    await b.reapOrphans(new Set());
    await assert.rejects(() => fetch(`${s.origin}${s.helperBasePath}/health`));
  });

  it("maps the typing bar's keys", () => {
    assert.deepEqual(keyAction({ usage: 42 }), { type: "key", name: "backspace" });
    assert.equal(keyAction({ usage: 225 }), null);
  });
});
