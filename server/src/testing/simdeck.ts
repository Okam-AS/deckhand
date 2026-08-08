import { execFile } from "node:child_process";

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

export interface SimDeckDaemonOptions {
  bin?: string;
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
  /** De-dupe concurrent ensureRunning() calls into one start attempt. */
  private starting: Promise<string> | null = null;

  constructor(opts: SimDeckDaemonOptions = {}) {
    this.bin = opts.bin ?? "simdeck";
    this.port = opts.port ?? 4310;
    this.autostart = opts.autostart ?? true;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.startImpl = opts.startImpl ?? defaultStart;
    this.now = opts.now ?? (() => Date.now());
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
    if (await this.healthy(origin)) return (this.origin = origin);
    if (!this.autostart) throw this.unavailable();

    // Kick the start command off but don't strictly await it — depending on the
    // installed CLI it may return immediately (detached service) or block
    // (foreground server). Either way, gate readiness on /api/health answering.
    void this.startImpl(this.bin, ["-p", String(this.port)]).catch(() => {});
    const deadline = this.now() + START_TIMEOUT_MS;
    while (this.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
      if (await this.healthy(origin)) return (this.origin = origin);
    }
    throw this.unavailable();
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
      `Agent-driven testing needs SimDeck on the deckhand machine. Install it (\`npm i -g simdeck\`) ` +
        `and/or start it (run \`simdeck\`), then retry. deckhand keeps its own video stream — SimDeck is control-only.`,
    );
  }

  /** Forget the cached origin (e.g. after a health failure) so the next call re-checks/starts. */
  reset(): void {
    this.origin = null;
  }
}
