import { acceptsChunk, backlogVerdict, isOrganicFeed, shouldHealStall, mayRecover, STALL_MS, MAX_RECOVERY, MAX_DECODE_QUEUE } from "./policy.ts";
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
// The rest of the tuning, and the decisions it drives, live in ./policy.ts — pure, and
// therefore the only part of this file `node --test` can reach. Their reasoning is there.
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
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backlogSince: number | null = null;
  private lastFeedAt = 0;
  private organicFeed = false; // a feed arrived after an ORGANIC_GAP_MS quiet gap
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
    // A live reconnect timer surviving teardown opened a second concurrent
    // stream for the same device once anything else restarted in the meantime.
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.backlogSince = null;
    this.fed = 0;
    this.delivered = 0;
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
    this.abort?.abort(); // never leave a previous connection streaming beside the new one
    const ac = new AbortController();
    this.abort = ac;
    this.lastFeedAt = 0;
    this.organicFeed = false;
    const demux = new AvccDemuxer();
    let gotFrame = false;

    // Clear the PREVIOUS attempt's watchdog before arming this one. Only
    // teardownStreams() cleared it, and the reconnect path
    // (upstreamEnded → scheduleReconnect → startAvcc) does not go through
    // teardown — so a connection that closed before its first frame left a timer
    // armed over a stale `gotFrame`, which then fired four seconds into a
    // perfectly healthy reconnected stream and demoted it to MJPEG for good.
    if (this.firstFrameTimer) clearTimeout(this.firstFrameTimer);
    this.firstFrameTimer = setTimeout(() => {
      // `this.abort !== ac` means a newer connection owns the player now; an old
      // timer must never speak for it. Belt-and-braces with the clear above.
      if (this.abort !== ac) return;
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
          // Our own teardown: stop silently, the new connection owns recovery.
          if (this.disposed || !this.active) return;
          if (done) return this.upstreamEnded(ac, "avcc stream");
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

  /**
   * The upstream body ended on its own — not an error, and not our teardown.
   * A helper restart, a re-attach, or a sim that stops producing all close the
   * response cleanly, and the read loop simply ran out. Before this, only the
   * `.catch()` path reconnected, so a clean end left the canvas holding its last
   * frame with the status still reporting "streaming": a frozen device that
   * looked alive, where taps were delivered and nothing ever moved.
   */
  private upstreamEnded(ac: AbortController, what: string): void {
    if (this.disposed || !this.active || this.abort !== ac) return;
    this.report(`${what} ended by the helper`, "reconnecting");
    this.scheduleReconnect();
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
    this.backlogSince = null;
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
    if (!acceptsChunk(this.sawKeyframe, isKey)) return;
    if (isKey) this.sawKeyframe = true;
    {
      const now = performance.now();
      const before = this.backlogSince;
      const verdict = backlogVerdict(dec.decodeQueueSize, now, { since: before });
      this.backlogSince = verdict.state.since;
      if (verdict.reconnect) {
        this.report("decode backlog", `queue ${dec.decodeQueueSize} for ${Math.round(now - (before ?? now))}ms — reconnecting`);
        this.reconnectAvcc();
        return;
      }
    }
    this.ts += 1; // monotonic
    try {
      dec.decode(new EncodedVideoChunk({ type: isKey ? "key" : "delta", timestamp: this.ts, data: payload }));
      this.fed += 1;
      const now = performance.now();
      if (isOrganicFeed(this.lastFeedAt, now)) this.organicFeed = true;
      this.lastFeedAt = now;
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
   * seed + keyframe repaint the current framebuffer within ~250 ms. Gated on
   * organicFeed — see ORGANIC_GAP_MS.
   */
  private armStallCheck(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      if (this.disposed || !this.active || this.mode !== "avcc") return;
      if (this.delivered < this.fed && this.organicFeed) {
        this.report("stall heal", `decoder owes ${this.fed - this.delivered} frame(s) — reconnecting`);
        this.reconnectAvcc();
      }
    }, STALL_MS);
  }

  private onFrame(frame: VideoFrame): void {
    this.delivered += 1;
    if (this.disposed || !this.active) {
      frame.close();
      return;
    }
    this.streamIsHealthy();
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
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
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
    this.abort?.abort();
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
          if (this.disposed || !this.active) return;
          if (done) return this.upstreamEnded(ac, "mjpeg stream");
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

  /**
   * A frame reached the screen, so whatever went wrong before is over — clear
   * the reconnect budget.
   *
   * This used to live only in the WebCodecs path, which meant MJPEG never
   * cleared it: the budget was a LIFETIME allowance rather than a
   * consecutive-failure one, so a device that recovered fine seven times over an
   * afternoon gave up permanently on the eighth — reported as "gave up", with a
   * reload as the only cure. The image tier is no rare corner: `start()` branches
   * on `isAvccSupported()` alone — there is no iOS/Android switch anywhere in the
   * viewer — so EITHER platform lands here when WebCodecs is missing, when a
   * decode errors, or when the server has no AVCC to give (the Android helper
   * 404s /stream.avcc on system images with no working encoder).
   */
  private streamIsHealthy(): void {
    this.recovery = 0;
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
      // A painted MJPEG/PNG frame is proof of health, exactly like a decoded one.
      this.streamIsHealthy();
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
