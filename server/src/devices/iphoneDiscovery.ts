import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../paths.ts";
import { defaultExec, type Exec } from "./ios.ts";
import { parseProvisioning, profileIncludes, provisioningPlistXml } from "./iphoneApps.ts";

// ---------------------------------------------------------------------------
// Which physical iPhones deckhand could drive now: paired and cabled (a Wi-Fi-only pairing is not
// a target), each listed with the actions that would make it one. Read-only: nothing here starts
// WDA or touches the phone beyond lockdown and devicectl queries. "UI Automation off" cannot be
// read this way; the WDA start reports it (wdaRunner.ts startFailureHint).
// ---------------------------------------------------------------------------

export class IphoneDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IphoneDiscoveryError";
  }
}

export interface DevicectlPhone {
  udid: string;
  name: string;
  model: string | null;
  productType: string | null;
  osVersion: string | null;
  paired: boolean;
  wired: boolean;
  /** null when devicectl did not say. */
  developerMode: boolean | null;
}

export interface WdaProfile {
  expires: string | null;
  provisionedDevices: string[];
  provisionsAllDevices: boolean;
}

export interface PhysicalIphone {
  udid: string;
  name: string;
  model: string | null;
  osVersion: string | null;
  /** Empty when deckhand can drive it; otherwise each names the action that unblocks it. */
  blockers: string[];
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** `devicectl list devices --json-output` → physical iPhones; reads `properties`, falling back to the deprecated fields. */
export function parseDevicectlDevices(json: unknown): DevicectlPhone[] {
  const devices = obj(obj(json).result).devices;
  if (!Array.isArray(devices)) throw new IphoneDiscoveryError("devicectl listed no devices array");
  const out: DevicectlPhone[] = [];
  for (const d of devices.map(obj)) {
    const p = obj(d.properties);
    const hw = { ...obj(d.hardwareProperties), ...obj(p.hardware) };
    if (hw.reality !== "physical" || (hw.deviceType !== "iPhone" && hw.platform !== "iOS")) continue;
    const conn = { ...obj(d.connectionProperties), ...obj(p.connection) };
    const state = obj(p.state);
    const legacy = obj(d.deviceProperties);
    const udid = str(hw.udid);
    if (!udid) continue;
    const dev = state.developerModeStatus ?? legacy.developerModeStatus;
    const developerMode = typeof dev === "string" ? dev === "enabled" : dev && typeof dev === "object" ? "enabled" in (dev as Obj) : null;
    out.push({
      udid,
      name: str(state.name) ?? str(legacy.name) ?? udid,
      model: str(hw.marketingName),
      productType: str(hw.productType),
      osVersion: str(obj(obj(p.software).osVersionNumber).stringValue) ?? str(legacy.osVersionNumber),
      paired: conn.pairingState === "paired",
      wired: conn.transportType === "wired",
      developerMode,
    });
  }
  return out;
}

/** The provisioning profile embedded in the WDA runner app under `productsDir`, or null when there is no WDA. */
export function readWdaProfile(productsDir: string = paths.wdaProducts()): WdaProfile | null {
  const build = join(productsDir, "Debug-iphoneos");
  if (!existsSync(build)) return null;
  const app = readdirSync(build).find((n) => n.endsWith("-Runner.app")) ?? readdirSync(build).find((n) => n.endsWith(".app"));
  if (!app) return null;
  let xml: string | null = null;
  try {
    xml = provisioningPlistXml(readFileSync(join(build, app, "embedded.mobileprovision")));
  } catch {
    xml = null;
  }
  if (!xml) return { expires: null, provisionedDevices: [], provisionsAllDevices: false };
  const p = parseProvisioning(xml);
  return { expires: p.profileExpires, provisionedDevices: p.provisionedDevices, provisionsAllDevices: p.provisionsAllDevices };
}

const NOT_CABLED = "not connected by USB";

/** False for a phone devicectl knows only over Wi-Fi or from an earlier pairing. */
export function isCabled(phone: PhysicalIphone): boolean {
  return !phone.blockers.some((b) => b.startsWith(NOT_CABLED));
}

export function blockersFor(
  phone: DevicectlPhone,
  ctx: { usb: boolean | null; locked: boolean | null; wda: WdaProfile | null; productsDir: string; now: Date },
): string[] {
  const out: string[] = [];
  if (!phone.paired) out.push("not paired with this Mac: unlock the phone, cable it, and tap Trust");
  if (ctx.usb === false || (ctx.usb === null && !phone.wired)) out.push(`${NOT_CABLED}: cable it to this Mac (a Wi-Fi pairing is not a target)`);
  if (phone.developerMode === false) out.push("Developer Mode is off: turn it on in Settings → Privacy & Security → Developer Mode");
  if (ctx.locked) out.push("locked: unlock it, remove its passcode, and set Auto-Lock to Never");
  if (!ctx.wda) {
    out.push(`no WDA installed: copy a WebDriverAgent Products folder built and signed for this phone to ${ctx.productsDir}`);
  } else {
    if (!profileIncludes(ctx.wda, phone.udid)) out.push("the WDA profile does not list this phone: register its UDID with the signing team, re-sign WDA and copy the new Products folder");
    if (ctx.wda.expires && Date.parse(ctx.wda.expires) <= ctx.now.getTime()) out.push(`the WDA profile expired on ${ctx.wda.expires}: re-sign WDA and copy the new Products folder`);
  }
  return out;
}

export interface DiscoverOptions {
  exec?: Exec;
  productsDir?: string;
  now?: Date;
}

/**
 * Paired iPhones with their blockers. A failed devicectl throws rather than answering "no phones":
 * the two must never look the same to a caller deciding whether one is plugged in.
 */
export async function discoverIphones(opts: DiscoverOptions = {}): Promise<PhysicalIphone[]> {
  const exec = opts.exec ?? defaultExec;
  const productsDir = opts.productsDir ?? paths.wdaProducts();
  const phones = parseDevicectlDevices(await devicectlJson(exec, ["list", "devices"]));
  if (phones.length === 0) return [];
  const ids = await exec("idevice_id", ["-l"], { timeoutMs: 10_000 }).catch(() => null);
  const usbIds = ids && ids.code === 0 ? new Set(ids.stdout.toString().split("\n").map((l) => l.trim().toLowerCase()).filter(Boolean)) : null;
  const wda = readWdaProfile(productsDir);
  const out: PhysicalIphone[] = [];
  for (const phone of phones) {
    const usb = usbIds ? usbIds.has(phone.udid.toLowerCase()) : null;
    const locked = phone.paired && usb !== false ? await lockState(exec, phone.udid) : null;
    const blockers = blockersFor(phone, { usb, locked, wda, productsDir, now: opts.now ?? new Date() });
    if (!usbIds) blockers.push("libimobiledevice is missing, so deckhand cannot reach the phone over USB: `brew install libimobiledevice`");
    let osVersion = phone.osVersion;
    if (!osVersion && usb) osVersion = (await exec("ideviceinfo", ["-u", phone.udid, "-k", "ProductVersion"], { timeoutMs: 10_000 })).stdout.toString().trim() || null;
    out.push({ udid: phone.udid, name: phone.name, model: phone.model ?? phone.productType, osVersion, blockers });
  }
  return out;
}

/** true when the phone wants its passcode now; null when devicectl could not say. */
async function lockState(exec: Exec, udid: string): Promise<boolean | null> {
  try {
    const r = obj(obj(await devicectlJson(exec, ["device", "info", "lockState", "--device", udid])).result);
    return typeof r.passcodeRequired === "boolean" ? r.passcodeRequired : null;
  } catch {
    return null;
  }
}

async function devicectlJson(exec: Exec, args: string[]): Promise<unknown> {
  const dir = mkdtempSync(join(tmpdir(), "deckhand-devicectl-"));
  const out = join(dir, "out.json");
  try {
    const res = await exec("xcrun", ["devicectl", ...args, "--json-output", out], { timeoutMs: 30_000 });
    let json: unknown = null;
    try {
      json = JSON.parse(readFileSync(out, "utf8")) as unknown;
    } catch {
      json = null;
    }
    if (res.code !== 0 || obj(obj(json).info).outcome !== "success") {
      throw new IphoneDiscoveryError(`xcrun devicectl ${args.slice(0, 2).join(" ")} failed: ${res.stderr.trim().split("\n").pop() || `exit ${res.code}`}`);
    }
    return json;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
