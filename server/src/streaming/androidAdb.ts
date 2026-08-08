import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { WebSocketServer, type WebSocket } from "ws";
import { allocatePort, helperBasePath, type AttachedStream, type StreamDeviceRef, type StreamingBackend } from "./backend.ts";
import { AvccSource, RECORDER_PKILL_PATTERN } from "./androidH264.ts";
import { AVD_PREFIX, parseAdbDevices } from "../devices/android.ts";

/**
 * How long to keep asking a freshly booted emulator for a frame. Matches the
 * iOS backend's window: a cold `screencap` under load is slow, not broken.
 */
const FIRST_FRAME_TIMEOUT_MS = 20_000;

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
  /** `adb devices` → every serial the shared adb daemon can see. Injected by tests. */
  listSerials?: () => Promise<string[]>;
  /**
   * Serials that some HOST process is currently recording — i.e. an
   * `adb -s <serial> exec-out screenrecord` is alive somewhere on this Mac.
   * Injected by tests; see `sweepDeviceRecorders` for why it is not our own
   * helper map.
   */
  hostRecorderSerials?: () => Promise<Set<string>>;
}

/** Parse `adb shell wm size` → device pixel dimensions. */
export function parseWmSize(output: string): { w: number; h: number } | null {
  const m = /(\d+)x(\d+)/.exec(output);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

/**
 * Parse `adb -s <serial> emu avd name` → the AVD this emulator was booted from.
 *
 * The console answers with the name and then its own `OK` status line, and
 * either can be absent when the console refuses (no auth token, a device that
 * is not an emulator at all). Anything that does not look like a name answers
 * null rather than a guess: the one caller treats null as "not provably ours"
 * and leaves the device alone.
 */
export function parseEmuAvdName(output: string): string | null {
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line || line === "OK" || line.startsWith("KO")) continue;
    return line;
  }
  return null;
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

function defaultListSerials(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile("adb", ["devices"], { encoding: "utf8", timeout: 5_000 }, (err, stdout) =>
      // A failed enumeration must sweep NOTHING, not everything: an empty list
      // means "found no orphans", which is the safe direction here.
      resolve(err ? [] : parseAdbDevices(String(stdout))),
    );
  });
}

/**
 * Serials with a live host-side recorder, read from `ps`.
 *
 * A device-side `screenrecord` started by `adb exec-out` is owned by that adb
 * process on THIS Mac; when the owner is alive the recorder is live work, and
 * when it is gone the recorder is the orphan we are hunting. This is the only
 * owner signal that survives a process boundary, and it has to: `deckhand
 * doctor --device-only` runs `reapOrphans()` from a SECOND process while the
 * server may be mid-preview, where the in-memory helper map is empty and `keep`
 * is empty too.
 */
function defaultHostRecorderSerials(): Promise<Set<string>> {
  return new Promise((resolve, reject) => {
    execFile("ps", ["-ax", "-o", "command="], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        // Unknown owners, NOT "no owners". The sweep abandons the whole pass on
        // a rejection; an empty set here would read as "nothing is live" and
        // kill every recorder on the machine.
        reject(err);
        return;
      }
      const serials = new Set<string>();
      for (const line of String(stdout).split("\n")) {
        if (!line.includes("exec-out") || !line.includes("screenrecord")) continue;
        const m = /(?:^|\s)-s\s+(\S+)/.exec(line);
        if (m) serials.add(m[1]!);
      }
      resolve(serials);
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
  private readonly listSerials: NonNullable<AndroidAdbOptions["listSerials"]>;
  private readonly hostRecorderSerials: NonNullable<AndroidAdbOptions["hostRecorderSerials"]>;
  private readonly helpers = new Map<string, Helper>();

  constructor(opts: AndroidAdbOptions) {
    this.range = opts.portRange;
    this.adb = opts.adb ?? ((serial, args, o) => defaultAdb(serial, args, o));
    this.listSerials = opts.listSerials ?? defaultListSerials;
    this.hostRecorderSerials = opts.hostRecorderSerials ?? defaultHostRecorderSerials;
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

    // Reject on 'error', not just resolve on success. Without a listener, an http.Server
    // emitting 'error' — EADDRINUSE is the ordinary case, from a leaked helper on the same
    // port — THROWS, the promise never settles, and attach() hangs forever. The engine is
    // awaiting it, so the preview sits in "starting the stream" with no error and no timeout,
    // and cli.ts's crash guard deliberately keeps the process alive, so nothing else surfaces
    // it either. A port collision must fail the device, not wedge it.
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.removeListener("listening", onListening);
        reject(new Error(`android helper could not bind 127.0.0.1:${port} — ${err.message}`));
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });
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
      waitForFirstFrame: async (timeoutMs = FIRST_FRAME_TIMEOUT_MS) => {
        // Poll to a deadline rather than taking one 5s shot. `screencap` renders
        // the whole framebuffer to PNG, and on an emulator that has just booted
        // — while sibling previews are building and other devices are starting —
        // that routinely takes longer than five seconds. A single tight attempt
        // reported a perfectly healthy device as "produced no first frame", and
        // the engine's retry just repeated the same too-short wait three times.
        // The iOS backend already probes to a 20s deadline; this matches it.
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const res = await backend.adb(helper.serial, ["exec-out", "screencap", "-p"], { timeoutMs: 8000 });
          if (res.code === 0 && res.stdout.length > 0) return true;
          if (Date.now() >= deadline) return false;
          await new Promise((r) => setTimeout(r, 500));
        }
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

  /**
   * Unlike serve-sim's detached daemons, these helpers are HTTP servers in THIS process — they
   * die with it, so the in-memory map really is their owner and a fresh process has nothing of
   * ours to collect. This matters at boot (a no-op) and during the janitor sweep (not a no-op).
   *
   * The one Android resource that DOES outlive us is the on-device `screenrecord`:
   * androidH264.ts pkills it from its own `stop()`, which is our graceful teardown only, so a
   * crashed or SIGKILLed server leaves it running with no owner. Not cosmetic — the host
   * encoder is single-instance across emulators, so one orphan makes every other device
   * produce zero bytes with no error at all, which from inside androidH264.ts is
   * indistinguishable from "this device cannot encode" and silently drops the whole machine to
   * the ~4 MB/s MJPEG fallback. `sweepDeviceRecorders` is the second half of this sweep.
   */
  async reapOrphans(keep: ReadonlySet<string> = new Set()): Promise<void> {
    for (const [serial, helper] of [...this.helpers]) {
      if (keep.has(serial)) continue;
      helper.stop();
      this.helpers.delete(serial);
    }
    await this.sweepDeviceRecorders(keep);
  }

  /**
   * Kill `screenrecord` processes left running INSIDE emulators by a previous
   * deckhand. Four tests have to pass before a device is touched, and each one
   * is load-bearing:
   *
   *   1. the serial is an emulator. Physical devices are borrowed hardware
   *      (devices/physical.ts) and deckhand never streams them, so a
   *      `screenrecord` on a plugged-in phone is always somebody else's.
   *   2. the AVD is deckhand-named. A developer's own emulator is out of
   *      bounds, and a console that will not tell us the name reads as "not
   *      provably ours" — the safe direction.
   *   3. neither the serial nor its AVD name is in `keep`, and no helper of
   *      ours holds the serial. `keep` carries BOTH identifiers, so the serial
   *      alone would answer for an ATTACHED device — the AVD name is still
   *      checked because it covers a window the serial cannot: between
   *      `record.udid = <avd name>` and `record.serial = <serial>` an emulator
   *      is still booting and is in `keep` by name only.
   *   4. no host-side `adb -s <serial> exec-out screenrecord` is alive. This is
   *      the only check that survives a process boundary, and it is what makes
   *      `deckhand doctor --device-only` — a separate process, empty helper map,
   *      empty `keep`, run routinely while the server is streaming — safe.
   *
   * Then the kill itself is narrowed once more, to our own recorder's argv
   * (`RECORDER_PKILL_PATTERN`). An `adb shell` process carries no env marker
   * from this side, so that argv is the closest thing to a marker that exists
   * on the device; the graceful `stop()` path kills by name and can afford to,
   * because it owns the recorder it is killing and this does not.
   *
   * Never throws, and fails towards killing nothing: a failed enumeration is
   * "no orphans found", never "no live work found".
   */
  private async sweepDeviceRecorders(keep: ReadonlySet<string>): Promise<void> {
    try {
      const serials = (await this.listSerials()).filter((s) => s.startsWith("emulator-"));
      const candidates: string[] = [];
      for (const serial of serials) {
        if (this.helpers.has(serial) || keep.has(serial)) continue;
        const res = await this.adb(serial, ["emu", "avd", "name"], { timeoutMs: 5_000 });
        if (res.code !== 0) continue;
        const avd = parseEmuAvdName(res.stdout.toString());
        if (!avd || !avd.startsWith(AVD_PREFIX) || keep.has(avd)) continue;
        candidates.push(serial);
      }
      if (candidates.length === 0) return;
      // Read the owners LAST, which NARROWS the race and does not close it: the
      // loop below awaits one 5 s-timeout pkill per candidate, so by candidate N
      // this snapshot can be N × 5 s old, and a `start_preview` that attached in
      // the meantime has a recorder we cannot see. Reading it before the `emu avd
      // name` probes would only have made it staler.
      //
      // Tolerable because of where the cost lands, not because the window is
      // small: the loser is one freshly started recorder, and `AvccSource` either
      // restarts the segment (a device that had already produced) or settles a
      // TIMED backoff — that device streams MJPEG until `retryAfterMs` expires,
      // then tries H.264 again. Never a permanent verdict, and never somebody
      // else's process: staleness can only make us kill one of OUR recorders on
      // one of OUR emulators a moment too early — the candidate list already
      // passed all four ownership tests, and the pkill matches our own argv.
      const busy = await this.hostRecorderSerials();
      for (const serial of candidates) {
        if (busy.has(serial)) continue;
        await this.adb(serial, ["shell", "pkill", "-INT", "-f", deviceShellQuote(RECORDER_PKILL_PATTERN)], {
          timeoutMs: 5_000,
        });
      }
    } catch {
      // adb missing, ps unreadable, a device that vanished mid-sweep: leave
      // every recorder alone rather than guess at ownership.
    }
  }
}
