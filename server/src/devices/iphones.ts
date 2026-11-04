import { defaultExec, type Exec } from "./ios.ts";
import { discoverIphones, type PhysicalIphone } from "./iphoneDiscovery.ts";
import { IphoneApps } from "./iphoneApps.ts";
import { IphoneSyslog } from "./iphoneSyslog.ts";
import { WdaRunner, WdaStartError } from "./wdaRunner.ts";
import { wdaPortsFor } from "./iproxy.ts";
import type { WdaClient } from "../testing/wdaClient.ts";

// ---------------------------------------------------------------------------
// The physical iPhones cabled to this Mac, as the server owns them: one WDA runner (and its
// loopback iproxy forward) per phone, started on first use and kept up across previews — a cold
// WDA start costs ~30 s — and reaped by IPHONE_MARKER_ENV when the next server boots. Previews
// borrow a phone's app handle (registered bundle only) and syslog stream; they never own WDA.
// ---------------------------------------------------------------------------

export interface StartFailure {
  message: string;
  hint?: string;
  at: number;
}

export interface IphonesOptions {
  exec?: Exec;
  productsDir?: string;
  discover?: () => Promise<PhysicalIphone[]>;
  runnerFor?: (udid: string, ports: { http: number; mjpeg: number }) => WdaRunner;
  now?: () => number;
}

export class Iphones {
  private readonly exec: Exec;
  private readonly discover: () => Promise<PhysicalIphone[]>;
  private readonly runnerFor: (udid: string, ports: { http: number; mjpeg: number }) => WdaRunner;
  private readonly now: () => number;
  private readonly runners = new Map<string, WdaRunner>();
  private readonly failures = new Map<string, StartFailure>();

  constructor(opts: IphonesOptions = {}) {
    this.exec = opts.exec ?? defaultExec;
    this.now = opts.now ?? (() => Date.now());
    this.discover = opts.discover ?? (() => discoverIphones({ exec: this.exec, ...(opts.productsDir ? { productsDir: opts.productsDir } : {}) }));
    this.runnerFor = opts.runnerFor ?? ((udid, ports) => new WdaRunner({ udid, ports, exec: this.exec, ...(opts.productsDir ? { productsDir: opts.productsDir } : {}) }));
  }

  /**
   * Paired, cabled iPhones and what blocks each. A WDA start that failed is a blocker too — the
   * Automation Mode prompt is only visible that way — until a later start succeeds.
   */
  async list(): Promise<PhysicalIphone[]> {
    const phones = await this.discover();
    return phones.map((p) => {
      const f = this.failures.get(p.udid);
      const restart = this.runners.get(p.udid)?.lastError;
      const extra = f ? [`WDA could not start: ${f.hint ?? f.message}`] : restart ? [`WDA stopped: ${restart}`] : [];
      return extra.length ? { ...p, blockers: [...p.blockers, ...extra] } : p;
    });
  }

  /** The last WDA start failure on this phone, while it stands. */
  startFailure(udid: string): StartFailure | null {
    return this.failures.get(udid) ?? null;
  }

  /** Whether the phone is cabled now (`idevice_id -l`); null when that cannot be asked. */
  async connected(udid: string): Promise<boolean | null> {
    const r = await this.exec("idevice_id", ["-l"], { timeoutMs: 10_000 }).catch(() => null);
    if (!r || r.code !== 0) return null;
    return r.stdout.toString().split("\n").some((l) => l.trim().toLowerCase() === udid.toLowerCase());
  }

  private runner(udid: string): WdaRunner {
    let r = this.runners.get(udid);
    if (!r) {
      const taken = new Set([...this.runners.values()].flatMap((other) => [other.ports.http, other.ports.mjpeg]));
      r = this.runnerFor(udid, wdaPortsFor(udid, taken));
      this.runners.set(udid, r);
    }
    return r;
  }

  /** WDA up on this phone and a client for it; a failed start is remembered for `list`. */
  async client(udid: string): Promise<WdaClient> {
    const r = this.runner(udid);
    try {
      await r.ensureRunning();
    } catch (e) {
      this.failures.set(udid, { message: e instanceof Error ? e.message : String(e), ...(e instanceof WdaStartError && e.hint ? { hint: e.hint } : {}), at: this.now() });
      throw e;
    }
    this.failures.delete(udid);
    return r.client;
  }

  async mjpegUrl(udid: string): Promise<string> {
    await this.client(udid);
    return this.runner(udid).mjpegUrl;
  }

  /** The preview's app on this phone: install, launch, stop and remove apply to `bundleId` only. */
  apps(udid: string, bundleId: string): IphoneApps {
    return new IphoneApps({ udid, bundleId, exec: this.exec });
  }

  /** A syslog stream for one preview device; start it before launching the app. */
  syslog(udid: string, appProcess: string | undefined): IphoneSyslog {
    return new IphoneSyslog({ udid, ...(appProcess ? { appProcess } : {}) });
  }

  /** Pids of every runner and forward this server spawned and still has — the keep-set of the marker reap. */
  livePids(): number[] {
    return [...this.runners.values()].flatMap((r) => r.livePids());
  }

  stopAll(): void {
    for (const r of this.runners.values()) r.stop();
    this.runners.clear();
  }
}
