/**
 * Android H.264 streaming source: `adb exec-out screenrecord` → AVCC → viewer.
 *
 * This replaces the PNG-per-frame path as the *primary* Android backend. The
 * numbers that motivated it, measured on a 1080x2400 emulator:
 *
 *   screencap PNG   ~640 KB per frame at a fixed 6.7 fps  =  ~4.2 MB/s
 *   screenrecord    ~124 KB for 10 s of continuous scroll =  ~12 KB/s
 *
 * The PNG path also wrote frames on a timer with no regard for whether the
 * socket could take them, so a phone that could pull ~1 MB/s just fell further
 * and further behind until the canvas never painted at all.
 *
 * One screenrecord process serves every viewer of a device (Android tolerates
 * few concurrent recorders, and N recorders would cost N encodes). Late joiners
 * are handed the cached parameter sets plus the current GOP — keyframe and every
 * delta since — so they decode to the live frame instead of waiting out
 * screenrecord's ~10 s keyframe interval.
 *
 * Devices whose system image has no working AVC encoder (notably the API 29
 * emulator image, where MediaCodec throws) are detected on first use and
 * reported as unsupported, so the route can 404 and let the viewer fall back to
 * MJPEG immediately rather than staring at a dead stream.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { AnnexBToAvcc, AVCC_TAG_DESCRIPTION, AVCC_TAG_DELTA, AVCC_TAG_KEYFRAME, frameChunk } from "./h264.ts";

/** Bits per second handed to the device encoder. Screen content is mostly
 *  static, so this is a ceiling for scroll bursts, not a steady cost: an idle
 *  screen costs ~0. Measured peak while continuously flinging a photo-heavy
 *  list was ~430 KB/s at 4 Mbit, which is more than a phone on cellular wants
 *  to absorb — 2.5 Mbit keeps that under ~310 KB/s with no visible loss at
 *  phone-canvas size. */
const BIT_RATE = 2_500_000;
/** Hard ceiling on the replay buffer; past this the segment is bounced for a
 *  fresh keyframe so memory cannot grow without bound. */
const MAX_GOP_BYTES = 8 * 1024 * 1024;
/**
 * How much catch-up we are willing to push at a joining viewer.
 *
 * Replaying a long GOP is correct but front-loads the connection: after a spell
 * of scrolling it can be megabytes, which is exactly the stall we are trying to
 * remove. Past this budget a joiner gets a fresh segment instead — one ~250 ms
 * hiccup for everyone watching, paid only when somebody actually joins, rather
 * than a periodic restart nobody asked for.
 */
const MAX_REPLAY_BYTES = 768 * 1024;
/** A segment that dies sooner than this is treated as a hard failure rather
 *  than a rotation/limit restart, so we stop respawning in a tight loop. */
const MIN_HEALTHY_SEGMENT_MS = 1_500;
/** How long to wait for the first parameter set before declaring the device's
 *  encoder unusable. */
const READY_TIMEOUT_MS = 8_000;
const RESTART_DELAY_MS = 100;
/**
 * A NAL is only delimited by the *next* start code, so on a screen that has
 * gone still the final access unit — the one showing the tap that just
 * happened — would sit in the parser until something else moved. After this
 * much silence we close it out and ship it.
 *
 * The window has to clear any pause the encoder might take mid-NAL, or we'd
 * emit a truncated slice and trip the viewer's decoder into MJPEG fallback.
 * Over local adb a write stalling this long does not happen in practice.
 */
const IDLE_FLUSH_MS = 120;
/**
 * How long the recorder stays up after the last viewer leaves.
 *
 * Without this, every reconnect — and the viewer reconnects routinely, to pull
 * a fresh keyframe — tore down screenrecord and immediately started it again.
 * The teardown's device-side `pkill screenrecord` then raced the new process
 * and sometimes killed it, which read as "this device cannot encode" and
 * dropped the viewer. Lingering makes a reconnect reuse the live recorder.
 */
const LINGER_MS = 3_000;

export interface AvccSubscriber {
  /** Return false to signal the consumer is backed up; the source will drop it. */
  write: (chunk: Buffer) => boolean;
  close: () => void;
}

export type SpawnRecorder = (serial: string) => ChildProcessWithoutNullStreams;

const defaultSpawnRecorder: SpawnRecorder = (serial) =>
  spawn("adb", [
    "-s",
    serial,
    "exec-out",
    "screenrecord",
    "--output-format=h264",
    `--bit-rate=${BIT_RATE}`,
    // 0 removes the 180 s cap (screenrecord v1.4+). Older devices reject it and
    // exit, which the restart loop absorbs as a segment boundary.
    "--time-limit=0",
    "-",
  ]);

/** One screenrecord process per device, fanned out to every viewer. */
export class AvccSource {
  private child: ChildProcessWithoutNullStreams | null = null;
  private parser = new AnnexBToAvcc();
  private readonly subscribers = new Set<AvccSubscriber>();

  private description: Buffer | null = null;
  private gop: Buffer[] = [];
  private gopBytes = 0;

  private startedAt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lingerTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** Whether this device has ever produced decodable video. Once it has, a
   *  short-lived segment is a restart to absorb, not an unusable encoder. */
  private everProduced = false;

  /** Cached outcome of "can this device encode H.264 at all". */
  private readyPromise: Promise<boolean> | null = null;
  private settleReady: ((ok: boolean) => void) | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly serial: string,
    private readonly spawnRecorder: SpawnRecorder = defaultSpawnRecorder,
  ) {}

  /**
   * True once the device has produced decodable H.264, false if its encoder is
   * unusable. Cached — the probe cost is paid once per device, and the running
   * recorder it starts is the same one subscribers then attach to.
   */
  ready(): Promise<boolean> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<boolean>((resolve) => {
      this.settleReady = resolve;
    });
    this.readyTimer = setTimeout(() => this.settle(false), READY_TIMEOUT_MS);
    this.start();
    return this.readyPromise;
  }

  /** Attach a viewer. Returns the unsubscribe function. */
  subscribe(sub: AvccSubscriber): () => void {
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    this.subscribers.add(sub);
    // Catch the newcomer up: parameter sets, then the current GOP — unless that
    // has grown past what is worth pushing, in which case a fresh segment gets
    // them a keyframe sooner than the replay would have arrived.
    if (this.gopBytes > MAX_REPLAY_BYTES) {
      this.restartSegment();
    } else {
      // A newcomer that backs up during catch-up is dropped like any other slow
      // subscriber — and must be *closed*, or its response hangs open forever
      // with no further bytes and the viewer only recovers via its watchdog.
      if (this.description && !sub.write(this.description)) {
        this.drop(sub);
        return () => {};
      }
      for (const chunk of this.gop) {
        if (!sub.write(chunk)) {
          this.drop(sub);
          return () => {};
        }
      }
    }
    this.start();
    return () => this.unsubscribe(sub);
  }

  private drop(sub: AvccSubscriber): void {
    this.subscribers.delete(sub);
    try {
      sub.close();
    } catch {
      /* already gone */
    }
    this.scheduleStop();
  }

  private unsubscribe(sub: AvccSubscriber): void {
    this.subscribers.delete(sub);
    this.scheduleStop();
  }

  /** Stop once the linger window passes with nobody watching. */
  private scheduleStop(): void {
    if (this.subscribers.size > 0 || this.lingerTimer || this.stopped) return;
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null;
      if (this.subscribers.size === 0) this.stop();
    }, LINGER_MS);
  }

  /** Tear everything down (device detach / server shutdown). */
  dispose(): void {
    this.stopped = true;
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    for (const sub of this.subscribers) sub.close();
    this.subscribers.clear();
    this.stop();
  }

  private settle(ok: boolean): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    const resolve = this.settleReady;
    this.settleReady = null;
    resolve?.(ok);
  }

  private start(): void {
    if (this.child || this.stopped) return;
    this.stopped = false;
    this.parser.reset();
    this.startedAt = Date.now();

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnRecorder(this.serial);
    } catch {
      this.settle(false);
      return;
    }
    this.child = child;

    child.stdout.on("data", (buf: Buffer) => this.onBytes(buf));
    // screenrecord reports encoder failures on stderr and then exits; nothing
    // there is actionable beyond the exit handling below.
    child.stderr.resume();
    child.on("error", () => this.onExit());
    child.on("close", () => this.onExit());
  }

  private stop(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.stdout.removeAllListeners("data");
    child.removeAllListeners("close");
    child.removeAllListeners("error");
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    // `adb exec-out` dying does not always take the device-side recorder with
    // it; a stray screenrecord would hold the encoder against the next start.
    try {
      spawn("adb", ["-s", this.serial, "shell", "pkill", "-INT", "screenrecord"], { stdio: "ignore" }).unref();
    } catch {
      /* best effort */
    }
    this.description = null;
    this.gop = [];
    this.gopBytes = 0;
    this.parser.reset();
  }

  private onExit(): void {
    const lived = Date.now() - this.startedAt;
    for (const ev of this.parser.flush()) this.emit(ev.type, ev.payload);
    this.child = null;

    // No viewers left, or we're shutting down: let it stay down.
    if (this.stopped || this.subscribers.size === 0) {
      if (this.settleReady) this.settle(this.description !== null);
      return;
    }
    // Died before ever producing anything usable — the encoder is the problem,
    // and respawning would just spin. Report unsupported so callers can fall
    // back. A device that has streamed before gets restarted instead: a short
    // segment there means rotation, a killed recorder or a lost adb link.
    if (!this.everProduced && this.description === null && lived < MIN_HEALTHY_SEGMENT_MS) {
      this.settle(false);
      for (const sub of this.subscribers) sub.close();
      this.subscribers.clear();
      return;
    }
    // Normal segment end (rotation, time limit): the next segment opens with a
    // fresh SPS/PPS + IDR, which re-configures every attached decoder.
    this.description = null;
    this.gop = [];
    this.gopBytes = 0;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopped && this.subscribers.size > 0) this.start();
    }, RESTART_DELAY_MS);
  }

  private onBytes(buf: Buffer): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const ev of this.parser.push(buf)) this.emit(ev.type, ev.payload);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      for (const ev of this.parser.flush()) this.emit(ev.type, ev.payload);
    }, IDLE_FLUSH_MS);
  }

  private emit(type: "description" | "keyframe" | "delta", payload: Buffer): void {
    const tag =
      type === "description" ? AVCC_TAG_DESCRIPTION : type === "keyframe" ? AVCC_TAG_KEYFRAME : AVCC_TAG_DELTA;
    const chunk = frameChunk(tag, payload);

    if (type === "description") {
      this.description = chunk;
      this.gop = [];
      this.gopBytes = 0;
      this.everProduced = true;
      this.settle(true);
    } else if (type === "keyframe") {
      this.gop = [chunk];
      this.gopBytes = chunk.length;
    } else {
      // A delta with no keyframe ahead of it is undecodable for a late joiner;
      // it still has to reach existing subscribers, just not the replay buffer.
      if (this.gop.length > 0) {
        this.gop.push(chunk);
        this.gopBytes += chunk.length;
      }
    }

    for (const sub of [...this.subscribers]) {
      if (!sub.write(chunk)) {
        this.subscribers.delete(sub);
        sub.close();
      }
    }
    this.scheduleStop();

    // Replay buffer outgrew its cap: bounce the segment to get a fresh IDR
    // rather than keeping megabytes of deltas alive.
    if (this.gopBytes > MAX_GOP_BYTES) this.restartSegment();
  }

  private restartSegment(): void {
    const child = this.child;
    if (!child) return;
    try {
      child.kill("SIGTERM"); // `close` handler starts the next segment
    } catch {
      /* already gone */
    }
  }
}
