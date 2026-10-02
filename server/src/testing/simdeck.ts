import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// SimDeck daemon lifecycle (control-only). deckhand talks to a local SimDeck
// service for agent-driven UI inspection + control — describe (accessibility
// tree) and ui (tap/type/…) — attaching to the SAME simulator/emulator deckhand
// already booted (iOS by UDID, Android by `android:<avd>`). Video stays with
// serve-sim / adb-screencap; SimDeck is never asked to stream.
//
// Two hard rules keep us off SimDeck's fragile paths and off any token handling:
//   1. Use REST only: GET /api/health, GET /api/simulators/{udid}/accessibility-tree,
//      POST /api/simulators/{udid}/action, POST .../pasteboard (the non-US iOS
//      typing path), GET .../screenshot.png. NEVER the /input or /control
//      WebSocket, /webrtc/offer, or /refresh — those spin up the private
//      CoreSimulator display/encoder session.
//   2. Auth via the same-origin loophole: SimDeck accepts a loopback POST with a
//      matching `Origin` header and no token (a loopback GET needs neither). So
//      deckhand holds NO SimDeck token — there is no secret to leak.
//
// This module owns only "is the service up, and where?". The REST surface lives
// in control.ts. Mirrors the injectable-impl shape of streaming/serveSim.ts so
// it's deterministically testable.
// ---------------------------------------------------------------------------

/**
 * Absolute path to the PINNED SimDeck launcher — `simdeck` is an exact-version dependency of the
 * server, so the daemon deckhand starts is the one its tests and `ui` geometry were checked
 * against, not whatever a global install happens to be. The package exports only `./test`, so
 * resolve that and walk to the package root: `packages/simdeck-test/dist/index.js` → root.
 */
export function vendoredSimDeckBin(): string {
  const require = createRequire(import.meta.url);
  const pkgRoot = dirname(dirname(dirname(dirname(require.resolve("simdeck/test")))));
  return join(pkgRoot, "packages", "cli", "bin", "simdeck.mjs");
}

/** The version in the `simdeck` package.json at or above `path` (a launcher or a native binary), or null. */
export function simdeckVersionAt(path: string): string | null {
  let dir = dirname(path);
  for (let i = 0; i < 5; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
      if (pkg.name === "simdeck" && typeof pkg.version === "string") return pkg.version;
    } catch {
      // no package.json here; keep walking up
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** The executable of the process listening on a loopback TCP port, or null. */
function defaultListener(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { timeout: 5000 }, (_e, out) => {
      const pid = String(out ?? "").trim().split(/\s+/)[0];
      if (!pid) return resolve(null);
      execFile("ps", ["-o", "comm=", "-p", pid], { timeout: 3000 }, (_e2, comm) => resolve(String(comm ?? "").trim() || null));
    });
  });
}

export interface SimDeckDaemonOptions {
  bin?: string;
  /**
   * The executable listening on the port. Defaults to lsof + ps, unless `fetchImpl` is injected:
   * a test that fakes SimDeck's HTTP has no process behind the port.
   */
  listenerImpl?: (port: number) => Promise<string | null>;
  port?: number;
  /** Best-effort start the service if it isn't already reachable (default true). */
  autostart?: boolean;
  fetchImpl?: typeof fetch;
  /** Injected for tests: run the SimDeck start command. */
  startImpl?: (bin: string, args: string[]) => Promise<void>;
  now?: () => number;
}

/** Thrown when SimDeck isn't reachable and can't be started — carries an actionable hint. */
export class SimDeckUnavailableError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "SimDeckUnavailableError";
  }
}

const HEALTH_TIMEOUT_MS = 1500;
const START_TIMEOUT_MS = 20_000;

function defaultStart(bin: string, args: string[]): Promise<void> {
  // `simdeck -p <port>` starts-or-reuses the local service and prints JSON, then
  // the CLI returns (the service persists) — same shape as serve-sim --detach.
  // Some versions may want --headless; adjust here if the installed CLI differs.
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 15_000 }, () => resolve());
  });
}

export class SimDeckDaemon {
  private readonly bin: string;
  private readonly port: number;
  private readonly autostart: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly startImpl: NonNullable<SimDeckDaemonOptions["startImpl"]>;
  private readonly now: () => number;
  private origin: string | null = null;
  private readonly listener: ((port: number) => Promise<string | null>) | null;
  /** De-dupe concurrent ensureRunning() calls into one start attempt. */
  private starting: Promise<string> | null = null;

  constructor(opts: SimDeckDaemonOptions = {}) {
    this.bin = opts.bin ?? vendoredSimDeckBin();
    this.port = opts.port ?? 4310;
    this.autostart = opts.autostart ?? true;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.startImpl = opts.startImpl ?? defaultStart;
    this.now = opts.now ?? (() => Date.now());
    this.listener = opts.listenerImpl ?? (opts.fetchImpl ? null : defaultListener);
  }

  /** The loopback origin deckhand uses for every SimDeck request (also the same-origin `Origin`). */
  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Resolve the running SimDeck origin, starting the service if needed. Throws SimDeckUnavailableError. */
  ensureRunning(): Promise<string> {
    if (this.origin) return Promise.resolve(this.origin);
    if (this.starting) return this.starting;
    this.starting = this.bringUp().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async bringUp(): Promise<string> {
    const origin = this.baseUrl;
    if (await this.healthy(origin)) return (this.origin = await this.pinned(origin));
    if (!this.autostart) throw this.unavailable();

    // Kick the start command off but don't strictly await it — depending on the
    // installed CLI it may return immediately (detached service) or block
    // (foreground server). Either way, gate readiness on /api/health answering.
    void this.startImpl(this.bin, ["-p", String(this.port)]).catch(() => {});
    const deadline = this.now() + START_TIMEOUT_MS;
    while (this.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
      if (await this.healthy(origin)) return (this.origin = await this.pinned(origin));
    }
    throw this.unavailable();
  }

  /**
   * A SimDeck already on the port may be any version (a global install, another checkout's, a
   * LaunchAgent's), and `ui` geometry was checked against the pinned one: refuse anything else
   * rather than drive it unawares. Not stopped here — `simdeck kill` stops every SimDeck service of
   * this Mac user, other people's included.
   */
  private async pinned(origin: string): Promise<string> {
    const want = simdeckVersionAt(this.bin);
    if (!this.listener || !want) return origin;
    const exe = await this.listener(this.port).catch(() => null);
    const got = exe ? simdeckVersionAt(exe) : null;
    if (got === want) return origin;
    throw new SimDeckUnavailableError(
      `the SimDeck on 127.0.0.1:${this.port} is ${got ? `version ${got}` : exe ? `not a SimDeck package (${exe})` : "a process deckhand cannot identify"}, not deckhand's pinned ${want}`,
      `Stop it and retry: \`node_modules/.bin/simdeck kill\` in the deckhand checkout stops every SimDeck service of this Mac user (a LaunchAgent with KeepAlive restarts its own — unload it first), ` +
        `or give deckhand its own port with \`simdeck.port\` in config.yaml.`,
    );
  }

  private async healthy(origin: string): Promise<boolean> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(`${origin}/api/health`, { signal: ctrl.signal });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private unavailable(): SimDeckUnavailableError {
    return new SimDeckUnavailableError(
      `SimDeck isn't reachable on 127.0.0.1:${this.port}`,
      `Agent-driven testing needs SimDeck, pinned in deckhand's own dependencies: run \`npm ci\` in the deckhand ` +
        `checkout, then retry. SimDeck runs one service per Mac user, so one started on another port stands in the way. ` +
        `deckhand keeps its own video stream — SimDeck is control-only.`,
    );
  }

  /** Forget the cached origin (e.g. after a health failure) so the next call re-checks/starts. */
  reset(): void {
    this.origin = null;
  }
}
