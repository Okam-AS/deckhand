import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { allocatePort, type AttachedStream, type StreamDeviceRef, type StreamingBackend } from "./backend.ts";

/**
 * Absolute path to the VENDORED serve-sim binary — deckhand ships serve-sim as
 * a pinned dependency and patch-package strips its host shell-exec routes
 * (/exec, /exec-ws), so a share holder reaching the helper over the simulator's
 * shared loopback finds no code-execution channel. A serve-sim on PATH is
 * unpatched, so both the server (to spawn it) and `doctor` (to verify it) must
 * resolve THIS copy. The bundle isn't an exported subpath, so resolve a public
 * one (`middleware`) and walk to the package root: `dist/<middleware> → dist → pkg`.
 */
export function vendoredServeSimBin(): string {
  const require = createRequire(import.meta.url);
  const pkgRoot = dirname(dirname(require.resolve("serve-sim/middleware")));
  return join(pkgRoot, "dist", "serve-sim.js");
}

// ---------------------------------------------------------------------------
// serve-sim iOS backend — verified on-device against serve-sim 0.1.44
// (2026-07-09). The load-bearing discovery: run serve-sim in **`--detach`
// (daemon) mode**, not preview mode. Preview mode's device stream is lazy /
// browser-driven and never attaches to a headless `simctl`-booted sim (all
// routes 404). `serve-sim --detach -p <port> <udid>` spawns the streaming
// helper (and the CLI exits), which then serves **`/helper/<udid>/stream.mjpeg`**
// (real MJPEG frames, confirmed streaming headless at ~several fps) and
// **`/helper/<udid>/ws`** for input. It prints those exact URLs as JSON, which
// we parse rather than assume. `/health` is flaky, so readiness gates on the
// stream actually producing bytes. Teardown is `serve-sim -k <udid>` (the
// detached daemon has no child handle to kill).
//
// (H.264/`stream.avcc` is not served in this version; MJPEG is the path. A
// future serve-sim H.264 upgrade slots in behind this same seam.)
// ---------------------------------------------------------------------------

export interface ServeSimOptions {
  bin?: string;
  portRange: [number, number];
  /** Injected for tests: run `serve-sim --detach ...`, resolve its stdout. */
  detachImpl?: (bin: string, args: string[]) => Promise<string>;
  /** Injected for tests: run `serve-sim -k <udid>`. */
  killImpl?: (bin: string, args: string[]) => Promise<void>;
  fetchImpl?: typeof fetch;
}

const FIRST_FRAME_TIMEOUT_MS = 20_000; // the daemon needs ~8s to attach to a cold sim

interface DetachResult {
  streamUrl: string;
  wsUrl: string;
  port: number;
  device: string;
}

interface Helper {
  udid: string;
  port: number;
  base: string; // e.g. "/helper/<udid>"
}

function defaultDetach(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 30_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout.toString())));
  });
}
function defaultKill(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve) => execFile(bin, args, () => resolve()));
}

/** Derive the helper base path from serve-sim's reported streamUrl (e.g. ".../helper/<udid>/stream.mjpeg" → "/helper/<udid>"). */
export function basePathFromStreamUrl(streamUrl: string): string {
  try {
    const u = new URL(streamUrl);
    return u.pathname.replace(/\/stream\.(mjpeg|avcc)$/, "");
  } catch {
    return "";
  }
}

export class ServeSimBackend implements StreamingBackend {
  private readonly bin: string;
  private readonly range: [number, number];
  private readonly detachImpl: NonNullable<ServeSimOptions["detachImpl"]>;
  private readonly killImpl: NonNullable<ServeSimOptions["killImpl"]>;
  private readonly fetchImpl: typeof fetch;
  private readonly helpers = new Map<string, Helper>();

  constructor(opts: ServeSimOptions) {
    this.bin = opts.bin ?? "serve-sim";
    this.range = opts.portRange;
    this.detachImpl = opts.detachImpl ?? defaultDetach;
    this.killImpl = opts.killImpl ?? defaultKill;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private usedPorts(): Set<number> {
    return new Set([...this.helpers.values()].map((h) => h.port));
  }

  async attach(device: StreamDeviceRef): Promise<AttachedStream> {
    if (device.platform !== "ios") throw new Error(`serve-sim backend only supports iOS (got ${device.platform})`);

    let helper = this.helpers.get(device.udid);
    if (!helper) {
      const port = allocatePort(this.range[0], this.range[1], this.usedPorts());
      // Spawn the streaming helper (daemon) and read the URLs it reports.
      const stdout = await this.detachImpl(this.bin, ["--detach", "-p", String(port), device.udid]);
      const parsed = this.parseDetach(stdout);
      helper = { udid: device.udid, port, base: basePathFromStreamUrl(parsed.streamUrl) };
      this.helpers.set(device.udid, helper);
    }

    const origin = `http://127.0.0.1:${helper.port}`;
    const base = helper.base;
    const backend = this;
    // Readiness = the stream produces a first frame (health is unreliable).
    return {
      origin,
      helperBasePath: base,
      waitForFirstFrame: (timeoutMs) => backend.probeFirstFrame(origin, base, timeoutMs),
      describe: () => backend.describe(origin, base),
      detach: () => backend.detach(device.udid),
    };
  }

  private parseDetach(stdout: string): DetachResult {
    const line = stdout.split("\n").map((l) => l.trim()).find((l) => l.startsWith("{"));
    if (!line) throw new Error(`serve-sim --detach produced no JSON (got: ${stdout.slice(0, 160)})`);
    const parsed = JSON.parse(line) as DetachResult;
    if (!parsed.streamUrl) throw new Error("serve-sim --detach JSON missing streamUrl");
    return parsed;
  }

  private async probeFirstFrame(origin: string, base: string, timeoutMs = FIRST_FRAME_TIMEOUT_MS): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    // Try H.264 first (future versions), then MJPEG (current). Retry until a
    // frame lands or the window closes — the daemon needs a moment to attach.
    while (Date.now() < deadline) {
      if (await this.probeStream(`${origin}${base}/stream.avcc`, 1500)) return true;
      if (await this.probeStream(`${origin}${base}/stream.mjpeg`, 2000)) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  private async probeStream(url: string, timeoutMs: number): Promise<boolean> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(url, { signal: ctrl.signal });
      if (!res.ok || !res.body) return false;
      const reader = res.body.getReader();
      // Accumulate a few chunks: an MJPEG stream's first chunk is just the tiny
      // multipart header; a real frame is hundreds of KB, while serve-sim's
      // `{"disconnected":true}` stub is ~40 bytes. Threshold on total bytes.
      let total = 0;
      for (let i = 0; i < 8; i++) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value?.byteLength ?? 0;
        if (total > 4096) break;
      }
      await reader.cancel().catch(() => {});
      return total > 4096;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async describe(origin: string, base: string): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await this.fetchImpl(`${origin}${base}/ax`, { headers: { accept: "text/event-stream" }, signal: ctrl.signal });
      if (!res.ok || !res.body) throw new Error(`ax endpoint ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (let i = 0; i < 50; i++) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (/\n\n/.test(buf)) break;
      }
      await reader.cancel().catch(() => {});
      const data = buf
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n");
      return data || buf.trim();
    } finally {
      clearTimeout(timer);
    }
  }

  async detach(udid: string): Promise<void> {
    if (!this.helpers.has(udid)) return;
    this.helpers.delete(udid);
    await this.killImpl(this.bin, ["-k", udid]);
  }

  async reapOrphans(): Promise<void> {
    await this.killImpl(this.bin, ["-k"]);
  }
}
