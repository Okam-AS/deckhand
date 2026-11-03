import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";

// ---------------------------------------------------------------------------
// The USB forward from this Mac to a phone's loopback-bound WebDriverAgent. `iproxy` listens on the
// Mac; without `-s 127.0.0.1` older builds listened on every interface, which would hand the phone
// to the LAN with no authentication in front of it. The listen invariant reads `.listen()` in this
// repo and cannot see a spawned binary's bind, so `iproxyArgs` is pinned by its own test.
// ---------------------------------------------------------------------------

/** Env marker on every iPhone helper deckhand spawns (iproxy, the WDA runner, syslog), so a later boot can reap them. */
export const IPHONE_MARKER_ENV = "DECKHAND_IPHONE";

export const WDA_DEVICE_PORT = 8100;
export const WDA_MJPEG_DEVICE_PORT = 9100;

export class IproxyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IproxyError";
  }
}

/** Mac-side ports for one phone, stable across runs and clear of WDA's own 8100/9100. */
export function wdaPortsFor(udid: string): { http: number; mjpeg: number } {
  let h = 0;
  for (const c of udid.toUpperCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { http: 18400 + (h % 100), mjpeg: 18500 + (h % 100) };
}

export function iproxyArgs(udid: string, pairs: readonly (readonly [number, number])[]): string[] {
  return ["-u", udid, "-s", "127.0.0.1", ...pairs.map(([local, device]) => `${local}:${device}`)];
}

export function portAnswers(port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

export interface IproxyOptions {
  udid: string;
  pairs: readonly (readonly [number, number])[];
  spawnImpl?: typeof spawn;
  portAnswersImpl?: (port: number) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
}

export class IproxyForward {
  readonly udid: string;
  readonly pairs: readonly (readonly [number, number])[];
  private readonly spawnImpl: typeof spawn;
  private readonly answers: (port: number) => Promise<boolean>;
  private readonly sleep: (ms: number) => Promise<void>;
  private child: ChildProcess | undefined;
  private ensuring: Promise<void> | undefined;

  constructor(opts: IproxyOptions) {
    this.udid = opts.udid;
    this.pairs = opts.pairs;
    this.spawnImpl = opts.spawnImpl ?? spawn;
    this.answers = opts.portAnswersImpl ?? ((p) => portAnswers(p));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  livePids(): number[] {
    return this.alive() && this.child?.pid ? [this.child.pid] : [];
  }

  /** The forward up, spawning it when it is not. Idempotent and safe to call before every request. */
  ensure(): Promise<void> {
    if (this.alive()) return Promise.resolve();
    this.ensuring ??= this.start().finally(() => (this.ensuring = undefined));
    return this.ensuring;
  }

  private alive(): boolean {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null;
  }

  private async start(): Promise<void> {
    for (const [local] of this.pairs) {
      if (await this.answers(local)) {
        throw new IproxyError(
          `127.0.0.1:${local} is already held by another process, so deckhand cannot forward ${this.udid} there. An iproxy left by an earlier deckhand is reaped when the server starts; stop anything else holding the port.`,
        );
      }
    }
    const child = this.spawnImpl("iproxy", iproxyArgs(this.udid, this.pairs), {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, [IPHONE_MARKER_ENV]: "1" },
    });
    let failed = false;
    child.on("error", () => (failed = true));
    child.unref();
    this.child = child;
    const gone = () => failed || child.exitCode !== null || child.signalCode !== null;
    for (let i = 0; i < 30 && !gone(); i++) {
      if (await this.answers(this.pairs[0]![0])) return;
      await this.sleep(100);
    }
    const exited = gone();
    if (!exited) child.kill("SIGTERM");
    if (this.child === child) this.child = undefined;
    throw new IproxyError(
      exited
        ? `iproxy exited before forwarding ${this.udid}: install libimobiledevice (\`brew install libimobiledevice\`) and check the phone is cabled and trusts this Mac`
        : `iproxy for ${this.udid} never listened on 127.0.0.1:${this.pairs[0]![0]}`,
    );
  }

  stop(): void {
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null) child.kill("SIGTERM");
  }
}
