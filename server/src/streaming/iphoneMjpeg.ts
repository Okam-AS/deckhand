import { createServer, get, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { allocatePort, helperBasePath, type AttachedStream, type StreamDeviceRef, type StreamingBackend } from "./backend.ts";
import { classifyGesture, parseInputFrame } from "./androidAdb.ts";
import type { UiAction } from "../testing/control.ts";

// ---------------------------------------------------------------------------
// A physical iPhone's stream: WebDriverAgent's own MJPEG (port 9100 on the phone's loopback),
// reached through deckhand's iproxy forward and re-served by a per-phone helper on 127.0.0.1 under
// the same `/helper/<udid>/…` paths the viewer already uses. `stream.avcc` answers 404, which the
// viewer reads as "play MJPEG". Viewer input arrives on `ws` in serve-sim's [tag][JSON] frames and
// becomes `ui` actions, so the wiring can route them through IphoneControl — which refuses anything
// outside the preview's app. Hardware buttons and rotation from the viewer are dropped: deckhand
// never acts outside the app on a borrowed phone.
// ---------------------------------------------------------------------------

const FIRST_FRAME_TIMEOUT_MS = 20_000;

export interface IphoneMjpegOptions {
  portRange: [number, number];
  /** WDA's MJPEG for this phone on loopback (WdaRunner.mjpegUrl, once ensureRunning resolved). */
  mjpegUrl(udid: string): Promise<string>;
  /** One viewer gesture or keystroke as a `ui` action. */
  act(udid: string, action: UiAction): Promise<unknown>;
  /** The `describe` text for this phone. */
  describe(udid: string): Promise<string>;
  /** Told when a viewer action failed; input is fire-and-forget for the viewer. */
  onInputError?(udid: string, error: unknown): void;
}

/** A viewer key frame as a `ui` action: printable characters type, a few HID usages are named keys. */
export function keyAction(frame: { usage: number; char?: string }): UiAction | null {
  if (frame.char) return { type: "type", text: frame.char };
  const name = ({ 40: "enter", 42: "backspace", 43: "tab", 44: "space" } as Record<number, string>)[frame.usage];
  return name ? { type: "key", name } : null;
}

interface Helper {
  udid: string;
  port: number;
  server: Server;
  wss: WebSocketServer;
  upstreams: Set<IncomingMessage>;
}

export class IphoneMjpegBackend implements StreamingBackend {
  private readonly helpers = new Map<string, Helper>();
  private readonly pendingPorts = new Set<number>();

  constructor(private readonly opts: IphoneMjpegOptions) {}

  async attach(device: StreamDeviceRef): Promise<AttachedStream> {
    if (device.platform !== "ios" || !device.udid) throw new Error("the iPhone MJPEG backend needs an iOS device with a UDID");
    const existing = this.helpers.get(device.udid);
    if (existing) return this.handle(existing);
    const used = new Set([...[...this.helpers.values()].map((h) => h.port), ...this.pendingPorts]);
    const port = allocatePort(this.opts.portRange[0], this.opts.portRange[1], used);
    this.pendingPorts.add(port);
    try {
      const udid = device.udid;
      const base = helperBasePath(udid);
      const upstreams = new Set<IncomingMessage>();
      const server = createServer((req, res) => {
        const url = (req.url ?? "").split("?")[0]!;
        if (url === `${base}/health`) return void res.writeHead(200).end("ok");
        if (url === `${base}/stream.mjpeg`) return void this.serveMjpeg(udid, res, upstreams);
        res.writeHead(404).end();
      });
      const wss = new WebSocketServer({ noServer: true });
      server.on("upgrade", (req, socket, head) => {
        if ((req.url ?? "").split("?")[0] === `${base}/ws`) wss.handleUpgrade(req, socket, head, (ws) => this.wireInput(ws, udid));
        else socket.destroy();
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", (e) => reject(new Error(`iPhone stream helper could not bind 127.0.0.1:${port} — ${e.message}`)));
        server.listen(port, "127.0.0.1", () => resolve());
      });
      const helper: Helper = { udid, port, server, wss, upstreams };
      this.helpers.set(udid, helper);
      return this.handle(helper);
    } finally {
      this.pendingPorts.delete(port);
    }
  }

  private handle(h: Helper): AttachedStream {
    return {
      origin: `http://127.0.0.1:${h.port}`,
      helperBasePath: helperBasePath(h.udid),
      waitForFirstFrame: (timeoutMs = FIRST_FRAME_TIMEOUT_MS) => this.firstFrame(h.udid, timeoutMs),
      describe: () => this.opts.describe(h.udid),
      detach: () => this.detach(h.udid),
    };
  }

  /**
   * Byte-for-byte from WDA, re-declared as octet-stream: Safari's fetch refuses to stream a
   * multipart body, and the viewer parses WDA's `Content-Length` framing out of the bytes either way.
   */
  private serveMjpeg(udid: string, res: ServerResponse, upstreams: Set<IncomingMessage>): void {
    let viewerGone = false;
    res.once("close", () => (viewerGone = true));
    void this.opts
      .mjpegUrl(udid)
      .then((url) => {
        if (viewerGone) return;
        const req = get(url, (up) => {
          if (up.statusCode !== 200) {
            up.resume();
            if (!res.headersSent) res.writeHead(502).end(`WDA's MJPEG answered ${up.statusCode}`);
            return;
          }
          upstreams.add(up);
          res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-cache", connection: "close" });
          up.pipe(res);
          const done = () => {
            upstreams.delete(up);
            up.destroy();
          };
          res.on("close", done);
          up.on("close", () => {
            upstreams.delete(up);
            res.end();
          });
        });
        req.on("error", (e) => {
          if (!res.headersSent) res.writeHead(502).end(`WDA's MJPEG is not reachable: ${e.message}`);
          else res.destroy();
        });
        res.on("close", () => req.destroy());
      })
      .catch((e: unknown) => {
        if (!res.headersSent) res.writeHead(503).end(`WDA is not running for this phone: ${e instanceof Error ? e.message : String(e)}`);
      });
  }

  /** A first whole JPEG out of WDA's stream; `/health` lies about video, a frame does not. */
  private async firstFrame(udid: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ok = await this.oneFrame(udid, deadline - Date.now()).catch(() => false);
      if (ok) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  private async oneFrame(udid: string, timeoutMs: number): Promise<boolean> {
    const url = await this.opts.mjpegUrl(udid);
    return new Promise<boolean>((resolve) => {
      let buf = Buffer.alloc(0);
      let settled = false;
      const finish = (v: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.destroy();
        resolve(v);
      };
      const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
      const req = get(url, (up) => {
        if (up.statusCode !== 200) return finish(false);
        up.on("data", (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk]);
          const soi = buf.indexOf(Buffer.from([0xff, 0xd8]));
          if (soi >= 0 && buf.indexOf(Buffer.from([0xff, 0xd9]), soi + 2) > 0) finish(true);
          else if (buf.length > 8 * 1024 * 1024) finish(false);
        });
        up.on("end", () => finish(false));
      });
      req.on("error", () => finish(false));
    });
  }

  private wireInput(ws: WebSocket, udid: string): void {
    let start: { x: number; y: number } | null = null;
    let downAt = 0;
    let queue = Promise.resolve();
    const send = (a: UiAction) => {
      queue = queue.then(() => this.opts.act(udid, a).then(() => undefined, (e: unknown) => this.opts.onInputError?.(udid, e)));
    };
    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      const frame = parseInputFrame(data as Buffer);
      if (!frame) return;
      if (frame.kind === "touch") {
        if (frame.type === "begin") {
          start = { x: frame.x, y: frame.y };
          downAt = Date.now();
        } else if (frame.type === "end" && start) {
          const g = classifyGesture(start, { x: frame.x, y: frame.y }, Date.now() - downAt);
          send(g.kind === "tap" ? { type: "tap", x: g.x, y: g.y } : { type: "swipe", startX: g.x1, startY: g.y1, endX: g.x2, endY: g.y2, durationMs: g.durationMs });
          start = null;
        }
      } else if (frame.kind === "key" && frame.type === "down") {
        const a = keyAction(frame);
        if (a) send(a);
      }
    });
  }

  async detach(udid: string): Promise<void> {
    const h = this.helpers.get(udid);
    if (!h) return;
    this.helpers.delete(udid);
    for (const up of h.upstreams) up.destroy();
    for (const c of h.wss.clients) c.terminate();
    h.wss.close();
    h.server.closeAllConnections();
    await new Promise<void>((r) => h.server.close(() => r()));
  }

  /** The helpers are servers in this process, so nothing of ours outlives it; prune to `keep`. */
  async reapOrphans(keep: ReadonlySet<string> = new Set()): Promise<void> {
    for (const udid of [...this.helpers.keys()]) if (!keep.has(udid)) await this.detach(udid);
  }
}
