import type { AttachedStream, StreamDeviceRef, StreamingBackend } from "./backend.ts";

// ---------------------------------------------------------------------------
// Web backend: the streaming seam for a frontend web preview. There is no
// device screen — the "stream" is the dev server itself. `origin` is the dev
// server's loopback port (started by the engine via DevProcessManager) and
// `helperBasePath` is the share base it serves under; the share proxy forwards
// browser requests there. `waitForFirstFrame` is an HTTP readiness probe (the
// dev server answering on its base path) instead of a video frame. `detach` is
// a no-op: the engine owns the dev process and kills it on teardown.
// ---------------------------------------------------------------------------

const READY_TIMEOUT_MS = 30_000;

export interface WebBackendOptions {
  fetchImpl?: typeof fetch;
}

export class WebBackend implements StreamingBackend {
  private readonly fetchImpl: typeof fetch;

  constructor(opts: WebBackendOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async attach(device: StreamDeviceRef): Promise<AttachedStream> {
    if (device.platform !== "web") throw new Error(`web backend only supports web previews (got ${device.platform})`);
    if (!device.port) throw new Error("web backend needs a dev-server port");
    const origin = `http://127.0.0.1:${device.port}`;
    const base = device.basePath ?? "";
    const backend = this;
    return {
      origin,
      helperBasePath: base,
      waitForFirstFrame: (timeoutMs) => backend.probeUp(origin, base, timeoutMs),
      describe: async () => "web preview (a live dev server; no accessibility tree)",
      detach: async () => {},
    };
  }

  async reapOrphans(): Promise<void> {
    // The engine's DevProcessManager owns every web dev process and reaps them;
    // there are no detached helper daemons for this backend to clean up.
  }

  /** Resolve true once the dev server answers on its base path within the window. */
  private async probeUp(origin: string, base: string, timeoutMs = READY_TIMEOUT_MS): Promise<boolean> {
    const url = `${origin}${base}/`;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.probeOnce(url)) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  private async probeOnce(url: string): Promise<boolean> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    try {
      const res = await this.fetchImpl(url, { signal: ctrl.signal, redirect: "manual" });
      // Any HTTP answer means the server is up (200 for the app shell, 3xx for a
      // base redirect, 304 for a cache hit) — a dead port throws instead.
      return res.status > 0;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
