import { AvccDemuxer, avcCodecString, isAvccSupported } from "./avcc.ts";
import { createMjpegFrameParser } from "./mjpeg.ts";

// ---------------------------------------------------------------------------
// One device's live video: H.264-over-chunked-HTTP (stream.avcc) decoded with
// WebCodecs, MJPEG fallback. Ports the battle-tested behaviors from
// docs/reference/auto-mate-learnings.md §2 (transport-agnostic): IDR gating,
// monotonic timestamps, decode-backlog reset, rAF single-frame paint,
// visibility gating, first-frame watchdog, bounded recovery, disposed guard.
//
// serve-sim reality (measured 2026-07-15): the helper sends ONE keyframe per
// connection and then deltas only — there is no mid-stream IDR and no way to
// request one, EXCEPT reconnecting (a fresh connection opens with seed JPEG +
// keyframe in ~250 ms). So every "wait for the next keyframe" recovery must be
// a stream reconnect. The encoder is change-driven (frames only when pixels
// change), which exposes decoders that hold output until more input arrives
// (Safari ignores optimizeForLatency): the last typed character stays inside
// the decoder until the next screen change. The stall self-heal below detects
// owed frames on an idle stream and reconnects — the seed repaints the current
// framebuffer immediately.
// ---------------------------------------------------------------------------

const FIRST_FRAME_TIMEOUT_MS = 4000;
const MAX_DECODE_QUEUE = 2;
const MAX_RECOVERY = 8;
// Longest quiet gap seen on a live stream with a blinking caret is ~430 ms —
// 600 ms only fires when the screen has truly gone still with frames owed.
const STALL_MS = 600;
// Enough to capture a whole failed connect + its retries; small enough that a
// misbehaving stream can't turn the diagnostic channel into traffic of its own.
const MAX_REPORTS = 40;

export type PlayerStatus = "connecting" | "streaming" | "fallback" | "error";

export interface PlayerCallbacks {
  onStatus?: (status: PlayerStatus) => void;
  onResize?: (w: number, h: number) => void;
}

export class DevicePlayer {
  private readonly ctx: CanvasRenderingContext2D;
  private disposed = false;
  private active = true;
  private abort: AbortController | null = null;

  private decoder: VideoDecoder | null = null;
  private description: Uint8Array | null = null;
  private sawKeyframe = false;
  private ts = 0;
  private pending: VideoFrame | null = null;
  private rafScheduled = false;
  private recovery = 0;
  private firstFrameTimer: ReturnType<typeof setTimeout> | null = null;
  private mode: "avcc" | "mjpeg" = "avcc";
  // Stall self-heal: chunks fed vs frames the decoder has actually delivered.
  private fed = 0;
  private delivered = 0;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private reports = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly baseUrl: string, // /s/<shareId>/dev/<deviceId>
    private readonly cb: PlayerCallbacks = {},
  ) {
    const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!ctx) throw new Error("2d canvas context unavailable");
    this.ctx = ctx;
  }

  /**
   * Tell the server what the browser is seeing. The failure that matters most —
   * a viewer stuck on "Connecting…" while the device is `ready` — is invisible
   * server-side, so the player reports its own turning points into the device's
   * `stream` log. Fire-and-forget, capped, and never carrying page content.
   */
  private report(event: string, detail?: string): void {
    if (this.reports >= MAX_REPORTS) return;
    this.reports += 1;
    void fetch(`${this.baseUrl}/clientlog`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event, detail }),
      keepalive: true,
    }).catch(() => {
      /* diagnostics must never break playback */
    });
  }

  start(): void {
    if (this.disposed) return;
    this.cb.onStatus?.("connecting");
    if (isAvccSupported()) {
      this.report("start", "avcc (WebCodecs)");
      this.startAvcc();
    } else {
      this.report("start", "mjpeg (no WebCodecs support)");
      this.startMjpeg();
    }
  }

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (this.disposed) return;
    if (active) this.start();
    else this.teardownStreams();
  }

  dispose(): void {
    this.disposed = true;
    this.teardownStreams();
  }

  private teardownStreams(): void {
    this.abort?.abort();
    this.abort = null;
    if (this.firstFrameTimer) clearTimeout(this.firstFrameTimer);
    this.firstFrameTimer = null;
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
    try {
      this.decoder?.close();
    } catch {
      /* noop */
    }
    this.decoder = null;
    this.description = null;
    this.sawKeyframe = false;
    this.pending?.close();
    this.pending = null;
  }

  /** Drop the avcc connection and open a fresh one — the only way to get a new
   *  keyframe from serve-sim (arrives with a seed JPEG, so the repaint is instant). */
  private reconnectAvcc(): void {
    this.teardownStreams();
    if (this.disposed || !this.active) return;
    this.startAvcc();
  }

  // --- AVCC (H.264 / WebCodecs) ---------------------------------------------

  private startAvcc(): void {
    this.mode = "avcc";
    const ac = new AbortController();
    this.abort = ac;
    const demux = new AvccDemuxer();
    let gotFrame = false;

    this.firstFrameTimer = setTimeout(() => {
      if (!gotFrame && !this.disposed && this.active) {
        this.report("avcc no first frame", `nothing decoded within ${FIRST_FRAME_TIMEOUT_MS}ms — falling back to mjpeg`);
        this.fallbackToMjpeg();
      }
    }, FIRST_FRAME_TIMEOUT_MS);

    const markFrame = () => {
      if (!gotFrame) {
        gotFrame = true;
        this.report("avcc streaming");
        this.cb.onStatus?.("streaming");
      }
    };

    fetch(`${this.baseUrl}/stream.avcc`, { signal: ac.signal })
      .then(async (res) => {
        // serve-sim serves no H.264/avcc endpoint (404) — go straight to MJPEG
        // instead of waiting out the first-frame watchdog (no 4s black screen).
        if (res.status === 404) {
          this.report("avcc 404", "no H.264 endpoint on this helper — using mjpeg");
          this.fallbackToMjpeg();
          return;
        }
        if (!res.ok || !res.body) throw new Error(`avcc ${res.status}`);
        const reader = res.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done || this.disposed || !this.active) break;
          if (!value) continue;
          for (const chunk of demux.push(value)) {
            if (chunk.type === "description") {
              this.configureDecoder(chunk.payload);
            } else if (chunk.type === "seed") {
              this.paintImage(chunk.payload);
              markFrame();
            } else if (chunk.type === "keyframe" || chunk.type === "delta") {
              this.feed(chunk.type === "keyframe", chunk.payload);
              markFrame();
            }
          }
        }
      })
      .catch((e: unknown) => {
        // A deliberate teardown/reconnect aborted this fetch — only the still-
        // current connection may schedule recovery, or reconnects double up.
        if (!this.disposed && this.active && this.abort === ac) {
          this.report("avcc connection lost", e instanceof Error ? e.message : String(e));
          this.scheduleReconnect();
        }
      });
  }

  private configureDecoder(description: Uint8Array): void {
    this.description = description;
    try {
      this.decoder?.close();
    } catch {
      /* noop */
    }
    this.sawKeyframe = false;
    this.fed = 0;
    this.delivered = 0;
    this.decoder = new VideoDecoder({
      output: (frame) => this.onFrame(frame),
      error: () => this.onDecodeError(),
    });
    this.decoder.configure({
      codec: avcCodecString(description),
      description,
      optimizeForLatency: true,
      hardwareAcceleration: "prefer-hardware",
    } as VideoDecoderConfig);
  }

  private feed(isKey: boolean, payload: Uint8Array): void {
    const dec = this.decoder;
    if (!dec || dec.state !== "configured") return;
    // IDR gate: don't feed deltas until the first keyframe.
    if (!this.sawKeyframe && !isKey) return;
    if (isKey) this.sawKeyframe = true;
    // Backlog reset: catch up instead of drifting into latency. Must be a
    // reconnect — a bare decoder reset would gate on a mid-stream keyframe
    // that serve-sim never sends, freezing the stream for good.
    if (dec.decodeQueueSize > MAX_DECODE_QUEUE) {
      this.reconnectAvcc();
      return;
    }
    this.ts += 1; // monotonic
    try {
      dec.decode(new EncodedVideoChunk({ type: isKey ? "key" : "delta", timestamp: this.ts, data: payload }));
      this.fed += 1;
      this.armStallCheck();
    } catch {
      this.onDecodeError();
    }
  }

  /**
   * Change-driven stream + a decoder that holds output until more input
   * arrives (Safari) = the last frame of a burst — the typed character, the
   * pressed key — stays invisible until the next screen change. If the stream
   * goes quiet while the decoder still owes frames, reconnect: the fresh
   * seed + keyframe repaint the current framebuffer within ~250 ms.
   */
  private armStallCheck(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      if (this.disposed || !this.active || this.mode !== "avcc") return;
      if (this.delivered < this.fed) this.reconnectAvcc();
    }, STALL_MS);
  }

  private onFrame(frame: VideoFrame): void {
    this.delivered += 1;
    if (this.disposed || !this.active) {
      frame.close();
      return;
    }
    this.recovery = 0;
    const w = frame.displayWidth || frame.codedWidth;
    const h = frame.displayHeight || frame.codedHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.cb.onResize?.(w, h);
    }
    this.pending?.close();
    this.pending = frame;
    if (!this.rafScheduled) {
      this.rafScheduled = true;
      requestAnimationFrame(() => {
        this.rafScheduled = false;
        const f = this.pending;
        this.pending = null;
        if (f) {
          try {
            this.ctx.drawImage(f, 0, 0, this.canvas.width, this.canvas.height);
          } finally {
            f.close();
          }
        }
      });
    }
  }

  private onDecodeError(): void {
    if (this.disposed || !this.active) return;
    this.fallbackToMjpeg();
  }

  private scheduleReconnect(): void {
    if (this.recovery >= MAX_RECOVERY) {
      this.report("gave up", `${MAX_RECOVERY} reconnects failed — the viewer now shows an error`);
      this.cb.onStatus?.("error");
      return;
    }
    this.recovery += 1;
    setTimeout(() => {
      if (!this.disposed && this.active) this.mode === "avcc" ? this.startAvcc() : this.startMjpeg();
    }, 500);
  }

  // --- MJPEG fallback --------------------------------------------------------

  private fallbackToMjpeg(): void {
    if (this.mode === "mjpeg") return;
    this.teardownStreams();
    if (this.disposed || !this.active) return;
    this.cb.onStatus?.("fallback");
    this.startMjpeg();
  }

  private startMjpeg(): void {
    this.mode = "mjpeg";
    const ac = new AbortController();
    this.abort = ac;
    const parser = createMjpegFrameParser((jpeg) => this.paintImage(jpeg));
    fetch(`${this.baseUrl}/stream.mjpeg`, { signal: ac.signal })
      .then(async (res) => {
        if (!res.ok || !res.body) {
          this.report("mjpeg failed", `HTTP ${res.status}`);
          throw new Error(`mjpeg ${res.status}`);
        }
        this.report("mjpeg streaming");
        this.cb.onStatus?.(this.mode === "mjpeg" ? "fallback" : "streaming");
        const reader = res.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done || this.disposed || !this.active) break;
          if (value) parser.push(value);
        }
      })
      .catch((e: unknown) => {
        if (!this.disposed && this.active && this.abort === ac) {
          this.report("mjpeg connection lost", e instanceof Error ? e.message : String(e));
          this.scheduleReconnect();
        }
      });
  }

  private paintImage(bytes: Uint8Array): void {
    // Render via an <img> + object URL rather than createImageBitmap: it's the
    // most compatible path across browsers. Safari's createImageBitmap(Blob)
    // fails on the Android backend's PNG frames (adb screencap → PNG), leaving a
    // black device; <img> decodes both PNG and JPEG everywhere. Detect the real
    // encoding from the magic bytes so the blob MIME is honest.
    const copy = bytes.slice();
    const isPng = copy[0] === 0x89 && copy[1] === 0x50 && copy[2] === 0x4e && copy[3] === 0x47;
    const url = URL.createObjectURL(new Blob([copy], { type: isPng ? "image/png" : "image/jpeg" }));
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      if (this.disposed || !this.active) return;
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (w === 0 || h === 0) return;
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
        this.cb.onResize?.(w, h);
      }
      this.ctx.drawImage(img, 0, 0, this.canvas.width, this.canvas.height);
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }
}
