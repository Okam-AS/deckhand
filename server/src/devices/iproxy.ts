import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { defaultExec, type Exec } from "./ios.ts";

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

const PORT_SLOTS = 100;

/** Mac-side ports for one phone: its hashed slot, or the next one no port in `taken` uses. Clear of WDA's own 8100/9100. */
export function wdaPortsFor(udid: string, taken: ReadonlySet<number> = new Set()): { http: number; mjpeg: number } {
  let h = 0;
  for (const c of udid.toUpperCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  for (let i = 0; i < PORT_SLOTS; i++) {
    const slot = (h + i) % PORT_SLOTS;
    const ports = { http: 18400 + slot, mjpeg: 18500 + slot };
    if (!taken.has(ports.http) && !taken.has(ports.mjpeg)) return ports;
  }
  throw new IproxyError(`every WDA port slot is taken, so ${udid} cannot be forwarded`);
}

export type IproxyForwards = Map<string, { http: number; mjpeg: number }>;

/** `ps -axo args=` → each running iproxy's phone (UDID upper-cased) and the Mac ports it forwards to WDA. */
export function parseIproxyForwards(psArgs: string): IproxyForwards {
  const out: IproxyForwards = new Map();
  for (const line of psArgs.split("\n")) {
    const argv = line.trim().split(/\s+/);
    if (!/(^|\/)iproxy$/.test(argv[0] ?? "")) continue;
    const udid = argv[argv.indexOf("-u") + 1];
    if (!argv.includes("-u") || !udid) continue;
    const local = (device: number) => argv.map((a) => /^(\d+):(\d+)$/.exec(a)).find((m) => m && Number(m[2]) === device)?.[1];
    const http = local(WDA_DEVICE_PORT);
    const mjpeg = local(WDA_MJPEG_DEVICE_PORT);
    if (http && mjpeg) out.set(udid.toUpperCase(), { http: Number(http), mjpeg: Number(mjpeg) });
  }
  return out;
}

export function iproxyArgs(udid: string, pairs: readonly (readonly [number, number])[]): string[] {
  return ["-u", udid, "-s", "127.0.0.1", ...pairs.map(([local, device]) => `${local}:${device}`)];
}

/** The forwards running on this Mac by phone, from any process; null when `ps` cannot be asked. */
export async function runningIproxyForwards(exec: Exec = defaultExec): Promise<IproxyForwards | null> {
  const r = await exec("ps", ["-axo", "args="], { timeoutMs: 10_000 }).catch(() => null);
  return r && r.code === 0 ? parseIproxyForwards(r.stdout.toString()) : null;
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
