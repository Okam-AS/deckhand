import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { paths } from "../paths.ts";
import { defaultExec, type Exec } from "./ios.ts";
import { IPHONE_MARKER_ENV, IproxyForward, WDA_DEVICE_PORT, WDA_MJPEG_DEVICE_PORT, wdaPortsFor } from "./iproxy.ts";
import { WdaClient, type WdaStatus } from "../testing/wdaClient.ts";

// ---------------------------------------------------------------------------
// WebDriverAgent on a physical iPhone, in pre-signed mode: the operator copies a Products folder
// built and signed elsewhere into the deckhand home, and this Mac only runs
// `xcodebuild test-without-building` against it — no Apple ID, certificate or profile here.
//
// Stock WDA binds every interface with no authentication, so the original `.xctestrun` is never
// run: a copy sets USE_IP=127.0.0.1 on every test target (HTTP and MJPEG), and the Mac reaches it
// over USB through IproxyForward. `wifiExposure` checks that from outside the phone.
// ---------------------------------------------------------------------------

export class WdaStartError extends Error {
  constructor(
    message: string,
    /** What the operator has to do, when the log says. */
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "WdaStartError";
  }
}

export function loopbackXctestrunName(udid: string): string {
  return `deckhand-loopback-${udid}.xctestrun`;
}

const SERVER_URL = /ServerURLHere->(\S+?)<-ServerURLHere|ServerURLHere->(\S+)/;

/** The `ServerURLHere->…` line WDA logs once its HTTP server is up. */
export function parseServerUrl(log: string): string | null {
  const m = SERVER_URL.exec(log);
  return m?.[1] ?? m?.[2] ?? null;
}

/** What a failed WDA start's log says the operator must do. */
export function startFailureHint(log: string): string | undefined {
  // Measured on iOS 27: testmanagerd logs "Writer daemon requires authentication to enable automation mode" and waits for Face ID or the passcode.
  if (/Timed out while enabling automation mode/i.test(log)) {
    return "someone at the phone must approve the Automation Mode prompt with Face ID or the passcode, then retry; if no prompt appears, turn on Settings → Developer → Enable UI Automation";
  }
  if (/UI Automation|automation mode|Automation is (not enabled|disabled)/i.test(log)) return "turn on Settings → Developer → Enable UI Automation on the phone";
  if (/Developer Mode/i.test(log)) return "turn on Developer Mode on the phone (Settings → Privacy & Security → Developer Mode)";
  if (/not (been )?explicitly trusted|untrusted developer|invalid code signature|could not be verified/i.test(log)) {
    return "trust the WDA signer on the phone (Settings → General → VPN & Device Management)";
  }
  if (/provision|0xe8008012|does not include this device/i.test(log)) return "the WDA profile does not list this phone: re-sign WDA with the phone's UDID registered, and copy the new Products folder";
  if (/is locked|passcode|unlock/i.test(log)) return "unlock the phone and set Auto-Lock to Never";
  if (/not (paired|trusted)|pairing/i.test(log)) return "pair the phone with this Mac and tap Trust on it";
  return undefined;
}

/** Every keypath in an `.xctestrun` (format 1 or 2) whose test target carries EnvironmentVariables. */
export function xctestrunTargets(json: unknown): string[] {
  const j = json as Record<string, unknown>;
  const configs = j.TestConfigurations;
  if (Array.isArray(configs)) {
    const out: string[] = [];
    configs.forEach((c, ci) => {
      const targets = (c as { TestTargets?: unknown })?.TestTargets;
      if (Array.isArray(targets)) targets.forEach((t, ti) => {
        if (t && typeof t === "object") out.push(`TestConfigurations.${ci}.TestTargets.${ti}`);
      });
    });
    return out;
  }
  return Object.keys(j).filter((k) => !k.startsWith("__") && !k.includes(".") && j[k] !== null && typeof j[k] === "object" && !Array.isArray(j[k]));
}

function at(json: unknown, keypath: string): unknown {
  return keypath.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), json);
}

/** The first appium/WebDriverAgent release whose MJPEG server honours USE_IP. */
export const MIN_WDA_VERSION = "16.15.3";

export function bindsMjpegToLoopback(version: string | undefined): boolean {
  const have = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? "")?.slice(1).map(Number);
  if (!have) return false;
  const want = MIN_WDA_VERSION.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (have[i] !== want[i]) return have[i]! > want[i]!;
  return true;
}

export type Exposure = "exposed" | "refused" | "cant-tell";

/**
 * Whether something answers on the phone's Wi-Fi address. Probed with curl, not Node: macOS Local
 * Network privacy can block this process's own sockets to LAN hosts, which would read as "safe".
 * A connection the port accepted is `exposed` however the request ends — WDA's MJPEG stream never
 * ends, so curl times out on it. Only a refused connection (curl exit 7) is `refused`.
 */
export async function probeWifiPort(ip: string, port: number, exec: Exec = defaultExec): Promise<Exposure> {
  if (isIP(ip) === 0) return "cant-tell";
  const host = isIP(ip) === 6 ? `[${ip}]` : ip;
  const res = await exec("curl", ["-s", "-o", "/dev/null", "-m", "3", "-w", "%{num_connects}", `http://${host}:${port}/status`], { timeoutMs: 6_000 });
  if (res.code === 0 || Number(res.stdout.toString().trim()) > 0) return "exposed";
  if (res.code === 7) return "refused";
  return "cant-tell";
}

export interface WifiExposure {
  /** `not-exposed` only when every WDA port refused on the phone's Wi-Fi address. */
  verdict: "exposed" | "not-exposed" | "cant-tell" | "no-wifi";
  ip?: string;
  ports: Record<number, Exposure>;
}

export async function wifiExposure(wifiIp: string | undefined, exec: Exec = defaultExec): Promise<WifiExposure> {
  if (!wifiIp || wifiIp === "127.0.0.1") return { verdict: "no-wifi", ports: {} };
  const ports: Record<number, Exposure> = {};
  for (const p of [WDA_DEVICE_PORT, WDA_MJPEG_DEVICE_PORT]) ports[p] = await probeWifiPort(wifiIp, p, exec);
  const all = Object.values(ports);
  const verdict = all.includes("exposed") ? "exposed" : all.every((e) => e === "refused") ? "not-exposed" : "cant-tell";
  return { verdict, ip: wifiIp, ports };
}

export interface WdaRunnerOptions {
  udid: string;
  productsDir?: string;
  logPath?: string;
  ports?: { http: number; mjpeg: number };
  startTimeoutMs?: number;
  restartDelayMs?: number;
  exec?: Exec;
  spawnImpl?: typeof spawn;
  fetchImpl?: typeof fetch;
  forward?: IproxyForward;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 10 * 60_000;

export class WdaRunner {
  readonly udid: string;
  readonly ports: { http: number; mjpeg: number };
  readonly client: WdaClient;
  readonly forward: IproxyForward;
  readonly logPath: string;
  /** Why the last start or restart failed; cleared once WDA is ready again. */
  lastError: string | undefined;
  private readonly productsDir: string;
  private readonly startTimeoutMs: number;
  private readonly restartDelayMs: number;
  private readonly exec: Exec;
  private readonly spawnImpl: typeof spawn;
  private readonly log: (line: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private runner: ChildProcess | undefined;
  /** Only a runner that came up is restarted when it exits; one that failed to start reports why instead. */
  private cameUp: ChildProcess | undefined;
  private starting: Promise<void> | undefined;
  private stopped = false;
  private restarts: number[] = [];

  constructor(opts: WdaRunnerOptions) {
    this.udid = opts.udid;
    this.ports = opts.ports ?? wdaPortsFor(opts.udid);
    this.productsDir = opts.productsDir ?? paths.wdaProducts();
    this.logPath = opts.logPath ?? join(paths.logsDir(), `wda-${opts.udid}.log`);
    this.startTimeoutMs = opts.startTimeoutMs ?? 120_000;
    this.restartDelayMs = opts.restartDelayMs ?? 5_000;
    this.exec = opts.exec ?? defaultExec;
    this.spawnImpl = opts.spawnImpl ?? spawn;
    this.log = opts.log ?? (() => {});
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
    this.client = new WdaClient({ baseUrl: `http://127.0.0.1:${this.ports.http}`, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
    this.forward =
      opts.forward ??
      new IproxyForward({ udid: opts.udid, pairs: [[this.ports.http, WDA_DEVICE_PORT], [this.ports.mjpeg, WDA_MJPEG_DEVICE_PORT]], spawnImpl: this.spawnImpl });
  }

  /** WDA's MJPEG stream on this Mac, through the forward. */
  get mjpegUrl(): string {
    return `http://127.0.0.1:${this.ports.mjpeg}/`;
  }

  /** Pids deckhand spawned for this phone that are alive now — the keep-set for a marker reap. */
  livePids(): number[] {
    const own = this.runnerAlive() && this.runner?.pid ? [this.runner.pid] : [];
    return [...own, ...this.forward.livePids()];
  }

  /**
   * WDA ready and reachable over USB, started when it is not. A WDA this runner did not start is
   * kept only when its Wi-Fi address provably refuses WDA's ports; anything else is replaced, since
   * starting a new test run on the phone ends the old one.
   */
  async ensureRunning(): Promise<WdaStatus> {
    this.stopped = false;
    await this.forward.ensure();
    const st = await this.client.status();
    if (st?.ready) {
      if (this.runnerAlive()) return st;
      const exposure = await wifiExposure(st.wifiIp, this.exec);
      if (exposure.verdict === "not-exposed" || exposure.verdict === "no-wifi") return st;
      this.log(`a WDA deckhand did not start answers for ${this.udid} and its Wi-Fi exposure is ${exposure.verdict}; replacing it with a loopback-only one`);
    }
    this.starting ??= this.start().finally(() => (this.starting = undefined));
    await this.starting;
    const after = await this.client.status();
    if (!after?.ready) throw new WdaStartError(`WDA on ${this.udid} stopped answering right after it started (log: ${this.logPath})`);
    return after;
  }

  private runnerAlive(): boolean {
    return !!this.runner && this.runner.exitCode === null && this.runner.signalCode === null;
  }

  /** The signed-elsewhere `.xctestrun`; deckhand's own copies are never picked. */
  sourceXctestrun(): string {
    if (!existsSync(this.productsDir)) {
      throw new WdaStartError(`no WebDriverAgent at ${this.productsDir}`, `copy a WDA Products folder built and signed for this phone to ${this.productsDir}`);
    }
    const f = readdirSync(this.productsDir)
      .filter((n) => n.endsWith(".xctestrun") && n.includes("iphoneos") && !n.startsWith("deckhand-") && !n.includes("loopback"))
      .sort()
      .pop();
    if (!f) throw new WdaStartError(`no iphoneos .xctestrun in ${this.productsDir}`, "copy the whole Products folder of a device build of WebDriverAgentRunner");
    return join(this.productsDir, f);
  }

  /**
   * A copy of the `.xctestrun` with USE_IP=127.0.0.1 on every test target, next to the original
   * because `__TESTROOT__` is the file's own directory. Only the `.app` is signed, not this file.
   * Read back after writing: a target plutil skipped would run WDA on every interface.
   */
  async loopbackXctestrun(): Promise<string> {
    const src = this.sourceXctestrun();
    const dst = join(dirname(src), loopbackXctestrunName(this.udid));
    // Edited under a private name, then renamed: an xcodebuild already started on `dst` must never read it unbound mid-edit.
    const tmp = join(dirname(src), `.deckhand-loopback-${this.udid}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
    copyFileSync(src, tmp);
    try {
      const targets = xctestrunTargets(await this.plistJson(tmp));
      if (targets.length === 0) throw new WdaStartError(`${src} has no test target`);
      const env: [string, string][] = [["USE_IP", "127.0.0.1"], ["USE_PORT", String(WDA_DEVICE_PORT)], ["MJPEG_SERVER_PORT", String(WDA_MJPEG_DEVICE_PORT)]];
      for (const t of targets) {
        if (at(await this.plistJson(tmp), `${t}.EnvironmentVariables`) === undefined) {
          await this.plutil(["-insert", `${t}.EnvironmentVariables`, "-dictionary", tmp]);
        }
        for (const [k, v] of env) await this.plutil(["-replace", `${t}.EnvironmentVariables.${k}`, "-string", v, tmp]);
      }
      const written = await this.plistJson(tmp);
      for (const t of targets) {
        if (at(written, `${t}.EnvironmentVariables.USE_IP`) !== "127.0.0.1") throw new WdaStartError(`could not bind WDA to loopback in ${dst} (${t})`);
      }
      renameSync(tmp, dst);
    } finally {
      rmSync(tmp, { force: true });
    }
    return dst;
  }

  private async plutil(args: string[]): Promise<void> {
    const res = await this.exec("plutil", args);
    if (res.code !== 0) throw new WdaStartError(`plutil ${args[0]} failed on ${args.at(-1)}: ${res.stderr.trim()}`);
  }

  private async plistJson(file: string): Promise<unknown> {
    const res = await this.exec("plutil", ["-convert", "json", "-o", "-", file]);
    if (res.code !== 0) throw new WdaStartError(`plutil could not read ${file}: ${res.stderr.trim()}`);
    return JSON.parse(res.stdout.toString()) as unknown;
  }

  private async start(): Promise<void> {
    const xctestrun = await this.loopbackXctestrun();
    mkdirSync(dirname(this.logPath), { recursive: true });
    const fd = openSync(this.logPath, "w");
    let runner: ChildProcess;
    try {
      runner = this.spawnImpl("xcodebuild", ["test-without-building", "-xctestrun", xctestrun, "-destination", `id=${this.udid}`], {
        detached: true,
        stdio: ["ignore", fd, fd],
        env: { ...process.env, [IPHONE_MARKER_ENV]: "1" },
      });
    } finally {
      closeSync(fd);
    }
    let spawnFailed = false;
    runner.on("error", () => (spawnFailed = true));
    runner.unref();
    this.runner = runner;
    runner.on("exit", (code) => this.onExit(runner, code));
    this.log(`starting WDA on ${this.udid} (log ${this.logPath})`);

    const deadline = this.now() + this.startTimeoutMs;
    let url: string | null = null;
    while (this.now() < deadline) {
      if (spawnFailed || runner.exitCode !== null || runner.signalCode !== null) {
        if (this.runner === runner) this.runner = undefined;
        const tail = this.logTail();
        throw new WdaStartError(`xcodebuild exited before WDA came up on ${this.udid}: ${tail}`, startFailureHint(this.readLog()));
      }
      url ??= parseServerUrl(this.readLog());
      const st = url ? await this.client.status(2_000) : null;
      if (st?.ready) {
        if (!bindsMjpegToLoopback(st.build)) {
          if (this.runner === runner) this.runner = undefined;
          killGroup(runner);
          throw new WdaStartError(
            `the WebDriverAgent under ${this.productsDir} is ${st.build ? `version ${st.build}` : "of an unknown version"}; before ${MIN_WDA_VERSION} it serves the phone's screen stream on every interface whatever USE_IP says`,
            `build WebDriverAgentRunner from appium/WebDriverAgent ${MIN_WDA_VERSION} or newer, re-sign it, and copy the new Products folder to ${this.productsDir}`,
          );
        }
        this.lastError = undefined;
        this.cameUp = runner;
        this.log(`WDA up on ${this.udid}: it reports ${url}, reached over USB at ${this.client.baseUrl}`);
        return;
      }
      await this.sleep(1_000);
    }
    if (this.runner === runner) this.runner = undefined;
    killGroup(runner);
    const log = this.readLog();
    const waiting = /Running tests/.test(log) ? "WDA launched on the phone but never served; if the phone shows an Automation Mode prompt, someone there must approve it" : undefined;
    throw new WdaStartError(`WDA on ${this.udid} was not ready after ${Math.round(this.startTimeoutMs / 1000)} s: ${this.logTail()}`, startFailureHint(log) ?? waiting);
  }

  private onExit(runner: ChildProcess, code: number | null): void {
    if (this.runner !== runner) return;
    this.runner = undefined;
    if (this.cameUp !== runner || this.stopped) return;
    const now = this.now();
    this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    if (this.restarts.length >= MAX_RESTARTS) {
      this.lastError = `WDA on ${this.udid} exited ${MAX_RESTARTS} times in ${RESTART_WINDOW_MS / 60_000} minutes; not restarting it (log: ${this.logPath})`;
      this.log(this.lastError);
      return;
    }
    this.restarts.push(now);
    this.log(`WDA runner on ${this.udid} exited (${code}); restarting`);
    setTimeout(() => {
      if (this.stopped) return;
      this.ensureRunning().catch((e: Error) => {
        this.lastError = e.message;
        this.log(`WDA restart on ${this.udid} failed: ${e.message}`);
      });
    }, this.restartDelayMs).unref();
  }

  private readLog(): string {
    try {
      return readFileSync(this.logPath, "utf8");
    } catch {
      return "";
    }
  }

  private logTail(): string {
    // xcodebuild logs an "error = invalidDigitCount" record on every run against iOS 27; it is never the reason.
    const lines = this.readLog().trim().split("\n").filter((l) => l.trim() && !/IDESchemeActionSDKRecord|xcodebuild: WARNING/.test(l));
    const telling = lines.filter((l) => /error|fail|denied|locked|trust|automation|provision/i.test(l)).slice(-4);
    return (telling.length ? telling : lines.slice(-3)).join(" | ").slice(0, 500) || `(empty log ${this.logPath})`;
  }

  /** Stop what this runner started; a WDA it did not start is left alone. */
  stop(): void {
    this.stopped = true;
    const runner = this.runner;
    this.runner = undefined;
    if (runner) killGroup(runner);
    this.forward.stop();
  }
}

function killGroup(child: ChildProcess): void {
  if (child.exitCode !== null || !child.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}
