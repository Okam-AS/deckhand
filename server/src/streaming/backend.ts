import type { Platform } from "../state.ts";

// ---------------------------------------------------------------------------
// The swappable streaming seam (PLAN §8). Nothing outside server/src/streaming/
// may import a concrete backend — the engine, proxy, and MCP tools see only
// this interface. iOS = serve-sim (Phase 1); Android = scrcpy (Phase 2).
// ---------------------------------------------------------------------------

export interface StreamDeviceRef {
  platform: Platform;
  udid: string;
  serial?: string; // android (Phase 2)
  port?: number; // web: the dev server's loopback port
  basePath?: string; // web: the share base the dev server serves under (e.g. "/s/<id>/web")
}

/**
 * A live attachment to one device's streaming helper. `origin` +
 * `helperBasePath` is the loopback upstream the share proxy forwards to; the
 * proxy exposes only the video (`stream.avcc`/`stream.mjpeg`), input (`ws`),
 * and `ax` subpaths under it — never the helper's other routes.
 */
export interface AttachedStream {
  origin: string; // e.g. "http://127.0.0.1:3100"
  helperBasePath: string; // e.g. "/helper/<udid>"
  /** Resolve when the helper has produced a first frame (avcc or mjpeg). */
  waitForFirstFrame(timeoutMs?: number): Promise<boolean>;
  /** Token-efficient accessibility tree for the `describe` tool. */
  describe(): Promise<string>;
  /** Kill the helper and release its port. Idempotent. */
  detach(): Promise<void>;
}

export interface StreamingBackend {
  /** Attach to an already-booted device; resolves once the stream endpoint is up. */
  attach(device: StreamDeviceRef): Promise<AttachedStream>;
  /** Kill any orphaned helpers this backend can find (crash recovery / janitor). */
  reapOrphans(): Promise<void>;
}

/** Allocate the first free port in [lo, hi] not in `inUse`. */
export function allocatePort(lo: number, hi: number, inUse: ReadonlySet<number>): number {
  for (let p = lo; p <= hi; p++) {
    if (!inUse.has(p)) return p;
  }
  throw new Error(`no free helper port in range ${lo}-${hi}`);
}

/** Build the helper base path for a udid, e.g. "/helper/<udid>". */
export function helperBasePath(udid: string): string {
  return `/helper/${udid}`;
}

/** The subpaths the share proxy is allowed to forward under a device. */
export const PROXY_ALLOWED_SUBPATHS = ["stream.avcc", "stream.mjpeg", "ws", "ax"] as const;
export type ProxySubpath = (typeof PROXY_ALLOWED_SUBPATHS)[number];

export function isAllowedSubpath(sub: string): sub is ProxySubpath {
  return (PROXY_ALLOWED_SUBPATHS as readonly string[]).includes(sub);
}
