import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { WebSocketServer, type WebSocket } from "ws";
import { allocatePort, helperBasePath, type AttachedStream, type StreamDeviceRef, type StreamingBackend } from "./backend.ts";
import { AvccSource } from "./androidH264.ts";

// ---------------------------------------------------------------------------
// Android streaming backend.
//
// Video has two tiers, both behind this one StreamingBackend seam:
//
//   /stream.avcc   H.264 from `adb exec-out screenrecord`, repackaged to AVCC
//                  (see androidH264.ts). Primary path. ~12 KB/s for continuous
//                  scrolling on a 1080x2400 screen.
//   /stream.mjpeg  `adb screencap` PNG frames. Fallback for system images with
//                  no working AVC encoder — notably the API 29 emulator, where
//                  MediaCodec throws. ~4 MB/s, i.e. unusable over mobile, which
//                  is why it is no longer the default.
//
// The viewer needs no platform switch: it asks for /stream.avcc first and
// already treats a 404 as "use MJPEG", which is exactly what an encoder-less
// device returns.
//
// Input is unchanged — the same `/ws` [tag][JSON] protocol serve-sim speaks on
// iOS, translated to `adb input` (0x03 touch, 0x04 button → keyevent,
// 0x07 orientation → user_rotation).
//
// Pure helpers (gesture classification, pixel mapping, wm-size parsing,
// Annex-B→AVCC) are unit-tested; the per-device HTTP/WS server and adb calls
// are validated on-device.
// ---------------------------------------------------------------------------

const FRAME_INTERVAL_MS = 150; // ~6-7 fps screencap (MJPEG fallback only)
const MJPEG_BOUNDARY = "deckhandframe";
/** Unsent bytes tolerated on a viewer socket before we stop feeding it. Past
 *  this the consumer is slower than the device and buffering only adds latency. */
const MAX_SOCKET_BACKLOG_BYTES = 2 * 1024 * 1024;

export interface AndroidAdbOptions {
  portRange: [number, number];
  adb?: (serial: string, args: string[], opts?: { binary?: boolean; timeoutMs?: number }) => Promise<{ stdout: Buffer; code: number }>;
}

/** Parse `adb shell wm size` → device pixel dimensions. */
export function parseWmSize(output: string): { w: number; h: number } | null {
  const m = /(\d+)x(\d+)/.exec(output);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

/** Map normalized 0..1 coordinates to device pixels. */
export function normToPixels(x: number, y: number, size: { w: number; h: number }): { px: number; py: number } {
  const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
  return { px: Math.round(clamp(x) * size.w), py: Math.round(clamp(y) * size.h) };
}

export type Gesture =
  | { kind: "tap"; x: number; y: number }
  | { kind: "swipe"; x1: number; y1: number; x2: number; y2: number; durationMs: number };

/** Classify a begin→end gesture: a short move is a tap, a longer one a swipe. */
export function classifyGesture(
  start: { x: number; y: number },
  end: { x: number; y: number },
  durationMs: number,
): Gesture {
  const dist = Math.hypot(end.x - start.x, end.y - start.y);
  if (dist < 0.015) return { kind: "tap", x: end.x, y: end.y };
  return { kind: "swipe", x1: start.x, y1: start.y, x2: end.x, y2: end.y, durationMs: Math.max(40, Math.min(durationMs, 1500)) };
}

/**
 * One decoded HID ws frame ([tag:u8][JSON] — the same wire format the iOS
 * serve-sim helper speaks, so the viewer needs no platform switch).
 * Key frames carry a HID `usage` (what serve-sim's native side consumes) and,
 * for printable characters, the `char` itself — which is all Android needs
 * (`input text`), sparing it a HID-usage reverse map.
 */
export type InputFrame =
  | { kind: "touch"; type: "begin" | "move" | "end"; x: number; y: number }
  | { kind: "button"; button: string }
  | { kind: "orientation"; orientation: string }
  | { kind: "key"; type: "down" | "up"; usage: number; char?: string };

// HID usage → Android keycode, for the non-printing keys the typing bar sends
// (printables arrive as `char` and go through `input text` instead). Modifiers
// like shift (usage 225) are intentionally absent — `input text` handles case.
const HID_USAGE_TO_KEYCODE: Record<number, number> = {
  40: 66, // return → KEYCODE_ENTER
  41: 111, // escape → KEYCODE_ESCAPE
  42: 67, // backspace → KEYCODE_DEL
  43: 61, // tab → KEYCODE_TAB
  76: 112, // forward delete → KEYCODE_FORWARD_DEL
  79: 22, // right → KEYCODE_DPAD_RIGHT
  80: 21, // left → KEYCODE_DPAD_LEFT
  81: 20, // down → KEYCODE_DPAD_DOWN
  82: 19, // up → KEYCODE_DPAD_UP
};

/** Android keycode for a special-key HID usage, or null (unmapped/modifier). */
export function usageToKeycode(usage: number): number | null {
  return HID_USAGE_TO_KEYCODE[usage] ?? null;
}

/** Single-quote a string for the device-side shell `adb shell` runs. */
function deviceShellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * `adb` args to type one printable character. Space goes through a keyevent
 * (KEYCODE_SPACE) since `input text " "` is unreliable; everything else is a
 * single device-shell-quoted `input text` so metacharacters stay literal.
 */
export function adbTypeCharArgs(ch: string): string[] {
  if (ch === " ") return ["shell", "input", "keyevent", "62"];
  return ["shell", `input text ${deviceShellQuote(ch)}`];
}

export function parseInputFrame(buf: Buffer): InputFrame | null {
  if (buf.length < 2) return null;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(buf.subarray(1).toString()) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (buf[0] === 0x03 && typeof msg.type === "string" && typeof msg.x === "number" && typeof msg.y === "number") {
    if (msg.type !== "begin" && msg.type !== "move" && msg.type !== "end") return null;
    return { kind: "touch", type: msg.type, x: msg.x, y: msg.y };
  }
  if (buf[0] === 0x04 && typeof msg.button === "string") return { kind: "button", button: msg.button };
  if (buf[0] === 0x06 && (msg.type === "down" || msg.type === "up") && typeof msg.usage === "number") {
    return { kind: "key", type: msg.type, usage: msg.usage, ...(typeof msg.char === "string" ? { char: msg.char } : {}) };
  }
  if (buf[0] === 0x07 && typeof msg.orientation === "string") return { kind: "orientation", orientation: msg.orientation };
  return null;
}

/** Android surface rotation (settings user_rotation 0..3) for a serve-sim orientation name. */
export function orientationToUserRotation(orientation: string): number | null {
  const map: Record<string, number> = { portrait: 0, landscape_left: 1, portrait_upside_down: 2, landscape_right: 3 };
  return map[orientation] ?? null;
}

/** Build the `adb shell input ...` args for a gesture at a given device size. */
export function adbInputArgs(g: Gesture, size: { w: number; h: number }): string[] {
  if (g.kind === "tap") {
    const { px, py } = normToPixels(g.x, g.y, size);
    return ["shell", "input", "tap", String(px), String(py)];
  }
  const a = normToPixels(g.x1, g.y1, size);
  const b = normToPixels(g.x2, g.y2, size);
  return ["shell", "input", "swipe", String(a.px), String(a.py), String(b.px), String(b.py), String(Math.round(g.durationMs))];
}

function defaultAdb(serial: string, args: string[], opts?: { timeoutMs?: number }) {
  return new Promise<{ stdout: Buffer; code: number }>((resolve) => {
    execFile("adb", ["-s", serial, ...args], { encoding: "buffer", timeout: opts?.timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      resolve({
        stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
        code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0,
      });
    });
  });
}

interface Helper {
  serial: string;
  port: number;
  server: Server;
  wss: WebSocketServer;
  avcc: AvccSource;
  stop: () => void;
}

export class AndroidAdbBackend implements StreamingBackend {
  private readonly range: [number, number];
  private readonly adb: NonNullable<AndroidAdbOptions["adb"]>;
  private readonly helpers = new Map<string, Helper>();

  constructor(opts: AndroidAdbOptions) {
    this.range = opts.portRange;
    this.adb = opts.adb ?? ((serial, args, o) => defaultAdb(serial, args, o));
  }

  private usedPorts(): Set<number> {
    return new Set([...this.helpers.values()].map((h) => h.port));
  }

  private async screenSize(serial: string): Promise<{ w: number; h: number }> {
    const res = await this.adb(serial, ["shell", "wm", "size"]);
    return parseWmSize(res.stdout.toString()) ?? { w: 1080, h: 2340 };
  }

  async attach(device: StreamDeviceRef): Promise<AttachedStream> {
    if (device.platform !== "android" || !device.serial) {
      throw new Error("android backend requires an android device with a serial");
    }
    const serial = device.serial;
    const existing = this.helpers.get(serial);
    if (existing) return this.streamHandle(existing);

    const port = allocatePort(this.range[0], this.range[1], this.usedPorts());
    const base = helperBasePath(serial);
    // `wm size` reports the rotation-independent physical size; `size` is the
    // live input coordinate space, transposed by wireInput on rotation.
    const size = await this.screenSize(serial);
    const natural = { ...size };

    const avcc = new AvccSource(serial);

    const server = createServer((req, res) => {
      const url = (req.url ?? "").split("?")[0]!;
      if (url === `${base}/health`) {
        res.writeHead(200).end("ok");
        return;
      }
      if (url === `${base}/stream.avcc`) {
        void this.serveAvcc(avcc, res);
        return;
      }
      if (url === `${base}/stream.mjpeg`) {
        this.serveMjpeg(serial, res);
        return;
      }
      res.writeHead(404).end();
    });

    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      const url = (req.url ?? "").split("?")[0]!;
      if (url === `${base}/ws`) {
        wss.handleUpgrade(req, socket, head, (ws) => this.wireInput(ws, serial, size, natural));
      } else {
        socket.destroy();
      }
    });

    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    const helper: Helper = {
      serial,
      port,
      server,
      wss,
      avcc,
      stop: () => {
        try {
          avcc.dispose();
          wss.close();
          server.close();
        } catch {
          /* noop */
        }
      },
    };
    this.helpers.set(serial, helper);
    return this.streamHandle(helper);
  }

  private streamHandle(helper: Helper): AttachedStream {
    const origin = `http://127.0.0.1:${helper.port}`;
    const base = helperBasePath(helper.serial);
    const backend = this;
    return {
      origin,
      helperBasePath: base,
      waitForFirstFrame: async () => {
        const res = await backend.adb(helper.serial, ["exec-out", "screencap", "-p"], { timeoutMs: 5000 });
        return res.code === 0 && res.stdout.length > 0;
      },
      describe: async () => {
        await backend.adb(helper.serial, ["shell", "uiautomator", "dump", "/sdcard/deckhand-ui.xml"]);
        const res = await backend.adb(helper.serial, ["shell", "cat", "/sdcard/deckhand-ui.xml"]);
        return res.stdout.toString();
      },
      detach: async () => backend.detach(helper.serial),
    };
  }

  /**
   * H.264 over the same `[len][tag][payload]` wire format serve-sim uses for
   * iOS, so the viewer decodes Android with the identical WebCodecs path and no
   * platform switch. A device whose image cannot encode (the API 29 emulator
   * throws inside MediaCodec) answers 404, which the player already treats as
   * "go straight to MJPEG" — no watchdog wait, no black screen.
   */
  private async serveAvcc(source: AvccSource, res: import("node:http").ServerResponse): Promise<void> {
    let supported: boolean;
    try {
      supported = await source.ready();
    } catch {
      supported = false;
    }
    if (!supported) {
      if (!res.headersSent) res.writeHead(404).end();
      return;
    }
    if (res.destroyed) return;

    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "cache-control": "no-cache",
      connection: "close",
    });

    // Deltas cannot be dropped selectively — one missing chunk corrupts every
    // frame until the next IDR. So when a viewer falls too far behind we cut
    // the connection instead of buffering: the player reconnects and is caught
    // up from the replay buffer, which is both correct and bounded.
    const unsubscribe = source.subscribe({
      write: (chunk) => {
        if (res.destroyed) return false;
        res.write(chunk);
        return res.writableLength <= MAX_SOCKET_BACKLOG_BYTES;
      },
      close: () => res.destroy(),
    });
    res.on("close", unsubscribe);
  }

  private serveMjpeg(serial: string, res: import("node:http").ServerResponse): void {
    res.writeHead(200, {
      // NOT multipart/x-mixed-replace: Safari's fetch() refuses to stream a
      // multipart body (WebKit intercepts it for legacy <img> server-push),
      // failing with "Load failed" before a single frame. application/octet-stream
      // streams fine everywhere; the viewer's parser reads the same
      // `--boundary + Content-Length` framing out of the body regardless of this
      // declared type. (iOS avoids this by using the H.264/avcc octet-stream path.)
      "content-type": "application/octet-stream",
      "cache-control": "no-cache",
      connection: "close",
    });
    let closed = false;
    res.on("close", () => {
      closed = true;
    });
    // Capture → write → *wait for the socket to actually take it* → capture
    // again. The previous version fired a screencap every 150 ms regardless,
    // so a viewer pulling 1 MB/s while the device produced ~4 MB/s of PNG fell
    // permanently behind with the overflow parked in this process's memory.
    // Waiting on drain makes the capture rate the consumer's rate.
    const waitForDrain = () =>
      new Promise<void>((resolve) => {
        if (closed || res.writableLength <= MAX_SOCKET_BACKLOG_BYTES) {
          resolve();
          return;
        }
        // A viewer that disconnects while we are parked here never emits
        // "drain", so wake on the socket ending too — otherwise this promise
        // never settles and pins the capture loop (and `res`) in memory.
        const done = () => {
          res.off("drain", done);
          res.off("close", done);
          res.off("error", done);
          resolve();
        };
        res.once("drain", done);
        res.once("close", done);
        res.once("error", done);
      });

    const tick = async () => {
      while (!closed) {
        const startedAt = Date.now();
        const shot = await this.adb(serial, ["exec-out", "screencap", "-p"], { timeoutMs: 5000 });
        if (closed) return;
        if (shot.code === 0 && shot.stdout.length > 0) {
          res.write(`--${MJPEG_BOUNDARY}\r\nContent-Type: image/png\r\nContent-Length: ${shot.stdout.length}\r\n\r\n`);
          res.write(shot.stdout);
          res.write("\r\n");
          await waitForDrain();
          if (closed) return;
        }
        const elapsed = Date.now() - startedAt;
        if (elapsed < FRAME_INTERVAL_MS) await new Promise((r) => setTimeout(r, FRAME_INTERVAL_MS - elapsed));
      }
    };
    void tick();
  }

  private wireInput(
    ws: WebSocket,
    serial: string,
    size: { w: number; h: number },
    natural: { w: number; h: number },
  ): void {
    let start: { x: number; y: number } | null = null;
    let downAt = 0;
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
          void this.adb(serial, adbInputArgs(g, size));
          start = null;
        }
      } else if (frame.kind === "button") {
        // Only home for now — other names are ignored rather than guessed at.
        if (frame.button === "home") void this.adb(serial, ["shell", "input", "keyevent", "3"]);
      } else if (frame.kind === "key") {
        // Act on press; ignore release. Printables type via `input text`; the
        // rest map to a keyevent (unmapped usages like shift are dropped).
        if (frame.type !== "down") return;
        if (frame.char) {
          void this.adb(serial, adbTypeCharArgs(frame.char));
        } else {
          const code = usageToKeycode(frame.usage);
          if (code !== null) void this.adb(serial, ["shell", "input", "keyevent", String(code)]);
        }
      } else {
        const rotation = orientationToUserRotation(frame.orientation);
        if (rotation === null) return;
        // `input tap/swipe` operates in the rotated coordinate space: transpose
        // the live size for 90°/270°. Mutates the shared object so every ws
        // connection to this device maps consistently.
        size.w = rotation % 2 ? natural.h : natural.w;
        size.h = rotation % 2 ? natural.w : natural.h;
        // Auto-rotate must be off for user_rotation to take effect.
        void this.adb(serial, ["shell", "settings", "put", "system", "accelerometer_rotation", "0"]).then(() =>
          this.adb(serial, ["shell", "settings", "put", "system", "user_rotation", String(rotation)]),
        );
      }
    });
  }

  async detach(serial: string): Promise<void> {
    const helper = this.helpers.get(serial);
    if (!helper) return;
    this.helpers.delete(serial);
    helper.stop();
  }

  async reapOrphans(): Promise<void> {
    for (const helper of this.helpers.values()) helper.stop();
    this.helpers.clear();
  }
}
