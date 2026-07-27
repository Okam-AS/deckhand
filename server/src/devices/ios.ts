import { execFile } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// iOS simulator control via `xcrun simctl`. Deckhand creates and boots its own
// simulators (its runtime choice), then points serve-sim at the UDID. Parsing
// and selection are pure (fixture-testable); the exec seam is injectable.
// ---------------------------------------------------------------------------

export interface ExecResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}
export type Exec = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<ExecResult>;

const defaultExec: Exec = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { encoding: "buffer", timeout: opts?.timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0;
        resolve({
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
          stderr: stderr.toString(),
          code: typeof code === "number" ? code : 1,
        });
      },
    );
  });

export interface Runtime {
  identifier: string;
  name: string; // "iOS 26.0"
  version: string; // "26.0"
  isAvailable: boolean;
}

export interface DeviceType {
  identifier: string;
  name: string; // "iPhone 16 Pro"
}

export class SimctlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimctlError";
  }
}

// --- pure parsing / selection ----------------------------------------------

export function parseRuntimes(json: unknown): Runtime[] {
  const runtimes = (json as { runtimes?: unknown[] }).runtimes ?? [];
  const out: Runtime[] = [];
  for (const r of runtimes) {
    const rt = r as Record<string, unknown>;
    const identifier = String(rt.identifier ?? "");
    const name = String(rt.name ?? "");
    // iOS only; skip watchOS/tvOS/visionOS.
    if (!/iOS/i.test(name) && !/iOS/i.test(identifier)) continue;
    const version = String(rt.version ?? name.replace(/^iOS\s*/i, ""));
    const isAvailable = rt.isAvailable === true || rt.availability === "(available)";
    out.push({ identifier, name, version, isAvailable });
  }
  return out;
}

/** An existing simulator, as reported by `simctl list devices -j`. */
export interface SimDevice {
  udid: string;
  name: string;
  state: string; // "Booted" | "Shutdown" | …
}

export function parseDevices(json: unknown): SimDevice[] {
  const byRuntime = (json as { devices?: Record<string, unknown[]> }).devices ?? {};
  const out: SimDevice[] = [];
  for (const list of Object.values(byRuntime)) {
    for (const d of list ?? []) {
      const dev = d as Record<string, unknown>;
      const udid = String(dev.udid ?? "");
      if (udid) out.push({ udid, name: String(dev.name ?? ""), state: String(dev.state ?? "") });
    }
  }
  return out;
}

export function parseDeviceTypes(json: unknown): DeviceType[] {
  const types = (json as { devicetypes?: unknown[] }).devicetypes ?? [];
  return types
    .map((t) => {
      const dt = t as Record<string, unknown>;
      return { identifier: String(dt.identifier ?? ""), name: String(dt.name ?? "") };
    })
    .filter((d) => d.identifier && d.name);
}

/** Compare two dotted version strings; returns >0 if a is newer. */
function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Pick an iOS runtime. `requested` may be "26", "iOS 26", "26.0" — matched by
 * version prefix. With no request, the newest available runtime wins.
 */
export function selectRuntime(runtimes: Runtime[], requested?: string): Runtime {
  const available = runtimes.filter((r) => r.isAvailable);
  if (available.length === 0) throw new SimctlError("no available iOS simulator runtimes installed");
  if (requested) {
    const want = requested.replace(/^iOS\s*/i, "").trim();
    const matches = available.filter((r) => r.version === want || r.version.startsWith(want + ".") || r.version.startsWith(want));
    if (matches.length === 0) {
      const have = available.map((r) => r.version).join(", ");
      throw new SimctlError(`no installed iOS runtime matches "${requested}" (have: ${have})`);
    }
    return matches.sort((a, b) => cmpVersion(b.version, a.version))[0]!;
  }
  return available.sort((a, b) => cmpVersion(b.version, a.version))[0]!;
}

/** Pick a device type. `requested` matched case-insensitively by name substring; default a modern iPhone. */
export function selectDeviceType(deviceTypes: DeviceType[], requested?: string): DeviceType {
  if (deviceTypes.length === 0) throw new SimctlError("no simulator device types available");
  // A requested model matches against ALL device types — iPads, TVs, etc. The
  // iPhone-only pool below is just the *default* preference; filtering it before
  // matching a request made every non-iPhone model ("iPad …") unselectable.
  if (requested) {
    const want = requested.toLowerCase();
    const hit =
      deviceTypes.find((d) => d.name.toLowerCase() === want) ?? deviceTypes.find((d) => d.name.toLowerCase().includes(want));
    if (!hit) throw new SimctlError(`no simulator device type matches "${requested}"`);
    return hit;
  }
  // Default: prefer a "Pro" iPhone, else the newest iPhone, else the last entry.
  const iphones = deviceTypes.filter((d) => /iPhone/i.test(d.name));
  const pool = iphones.length ? iphones : deviceTypes;
  return pool.find((d) => /iPhone\s*\d+\s*Pro$/i.test(d.name)) ?? pool[pool.length - 1]!;
}

export function deviceLabel(deviceType: DeviceType, runtime: Runtime): string {
  return `${deviceType.name} · ${runtime.name}`;
}

// --- simctl operations -----------------------------------------------------

export class Simctl {
  constructor(private readonly exec: Exec = defaultExec) {}

  private async run(args: string[], opts?: { timeoutMs?: number }): Promise<ExecResult> {
    return this.exec("xcrun", ["simctl", ...args], opts);
  }

  private async json(args: string[]): Promise<unknown> {
    const res = await this.run([...args, "-j"]);
    if (res.code !== 0) throw new SimctlError(`simctl ${args.join(" ")} failed: ${res.stderr.trim().slice(0, 200)}`);
    try {
      return JSON.parse(res.stdout.toString());
    } catch {
      throw new SimctlError(`simctl ${args.join(" ")} returned unparseable JSON`);
    }
  }

  async listRuntimes(): Promise<Runtime[]> {
    return parseRuntimes(await this.json(["list", "runtimes"]));
  }

  async listDeviceTypes(): Promise<DeviceType[]> {
    return parseDeviceTypes(await this.json(["list", "devicetypes"]));
  }

  /** Create a simulator; returns its UDID. */
  async create(name: string, deviceTypeId: string, runtimeId: string): Promise<string> {
    const res = await this.run(["create", name, deviceTypeId, runtimeId]);
    if (res.code !== 0) throw new SimctlError(`simctl create failed: ${res.stderr.trim().slice(0, 200)}`);
    const udid = res.stdout.toString().trim();
    if (!/^[0-9A-F-]{36}$/i.test(udid)) throw new SimctlError(`simctl create returned unexpected udid: ${udid}`);
    return udid;
  }

  /** Boot (idempotent — "already booted" is fine) and wait for full boot. */
  async bootAndWait(udid: string, timeoutMs = 180_000): Promise<void> {
    await this.run(["boot", udid]); // ignore "already booted"
    const status = await this.run(["bootstatus", udid, "-b"], { timeoutMs });
    if (status.code !== 0 && !(await this.isBooted(udid))) {
      throw new SimctlError(`device ${udid} failed to reach booted state`);
    }
  }

  /** Every simulator known to simctl (all runtimes), with its name and state. */
  async listDevices(): Promise<SimDevice[]> {
    return parseDevices(await this.json(["list", "devices"]));
  }

  async isBooted(udid: string): Promise<boolean> {
    return (await this.listDevices()).some((d) => d.udid === udid && d.state === "Booted");
  }

  async install(udid: string, appPath: string): Promise<void> {
    const res = await this.run(["install", udid, appPath]);
    if (res.code !== 0) throw new SimctlError(`simctl install failed: ${res.stderr.trim().slice(0, 200)}`);
  }

  async launch(udid: string, bundleId: string): Promise<void> {
    const res = await this.run(["launch", udid, bundleId]);
    if (res.code !== 0) throw new SimctlError(`simctl launch failed: ${res.stderr.trim().slice(0, 200)}`);
  }

  async openUrl(udid: string, url: string): Promise<void> {
    const res = await this.run(["openurl", udid, url]);
    if (res.code !== 0) throw new SimctlError(`simctl openurl failed: ${res.stderr.trim().slice(0, 200)}`);
  }

  /** Path to the installed app container, or null if not installed (used to verify install). */
  async appContainer(udid: string, bundleId: string): Promise<string | null> {
    const res = await this.run(["get_app_container", udid, bundleId]);
    if (res.code !== 0) return null;
    const path = res.stdout.toString().trim();
    return path.length ? path : null;
  }

  async screenshotPng(udid: string): Promise<Buffer> {
    // `simctl io <udid> screenshot -` does NOT write to stdout on current Xcode
    // (verified on-device: it creates a file literally named "-"). Write to a
    // temp file and read it back.
    const file = join(tmpdir(), `deckhand-shot-${udid}-${process.pid}-${this.shotSeq++}.png`);
    try {
      const res = await this.run(["io", udid, "screenshot", "--type", "png", file]);
      if (res.code !== 0) throw new SimctlError(`simctl screenshot failed: ${res.stderr.trim().slice(0, 200)}`);
      return readFileSync(file);
    } finally {
      rmSync(file, { force: true });
    }
  }
  private shotSeq = 0;

  async shutdown(udid: string): Promise<void> {
    await this.run(["shutdown", udid]);
  }

  /**
   * Wipe a simulator back to factory state (apps, data, settings). Used when a
   * pooled device is handed to a preview whose predecessor is unknown — i.e.
   * after a crash — so no stale app state leaks between tenants.
   */
  async erase(udid: string): Promise<void> {
    await this.run(["shutdown", udid]); // erase requires a shut-down device
    const res = await this.run(["erase", udid]);
    if (res.code !== 0) throw new SimctlError(`simctl erase failed: ${res.stderr.trim().slice(0, 200)}`);
  }

  async delete(udid: string): Promise<void> {
    await this.run(["delete", udid]);
  }
}
