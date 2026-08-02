import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Exec, makeDefaultExec } from "./android.ts";

// ---------------------------------------------------------------------------
// Physical-device DETECTION (read-only). Phase 0 of physical-device support:
// this module only answers "what real hardware can this Mac see right now" —
// it never boots, installs, wipes, or streams anything. iOS via
// `xcrun devicectl list devices` (CoreDevice, Xcode 15+), Android via
// `adb devices -l`. Pure parsing is fixture-testable; the exec seam is
// injectable, same shape as Simctl/AndroidManager.
//
// LAW for every later phase: a physical device is BORROWED, like a local
// checkout (AGENTS.md) — deckhand may install and launch on it when asked, and
// must never erase, factory-reset, pool, or delete it. Nothing in this module
// can mutate a device, which is what makes Phase 0 safe to ship alone.
// ---------------------------------------------------------------------------

export interface PhysicalIosDevice {
  /** CoreDevice identifier (UUID) — what `devicectl` commands address. */
  identifier: string;
  /** Hardware UDID (e.g. "00008030-…") — what xcodebuild/expo `--device` wants. */
  udid: string;
  /** User-given device name, e.g. "Kari's iPad". */
  name: string;
  /** Marketing model, e.g. "iPad (9th generation)". */
  model: string;
  /** "iPhone" | "iPad" | … (hardwareProperties.deviceType). */
  deviceType: string;
  osVersion: string;
  /**
   * "usb" when cabled, "network" for Wi-Fi pairing, "unknown" for any
   * transportType devicectl reports that this code has not seen — later phases
   * branch on transport (network pairing needs tunnel setup), so an unfamiliar
   * value must not be asserted as either.
   */
  transport: "usb" | "network" | "unknown";
  /** Building to the device requires Developer Mode on it; surface it here. */
  developerMode: boolean;
}

export interface PhysicalAndroidDevice {
  serial: string;
  /** From `adb devices -l` (model:…), when present. */
  model?: string;
  /**
   * "device" = usable. "unauthorized" = the phone is showing its "allow USB
   * debugging?" dialog — actionable, so it is reported rather than dropped.
   * "offline" = seen but unusable.
   */
  state: "device" | "unauthorized" | "offline";
}

export interface PhysicalDevices {
  ios: PhysicalIosDevice[];
  android: PhysicalAndroidDevice[];
  /**
   * Present only when a platform's SCAN failed (tool missing, hung devicectl,
   * unparseable output) — engine.md: an empty result and a failed lookup must
   * not be the same value. An agent seeing `errors` must say "could not scan"
   * (and suggest `deckhand doctor`), never "no devices connected".
   */
  errors?: { ios?: string; android?: string };
}

// --- pure parsing ----------------------------------------------------------

/**
 * Parse `devicectl list devices --json-output` (jsonVersion 3, verified against
 * devicectl 518.33 on-machine 2026-08-02). Keeps only devices that are
 * physical (`hardwareProperties.reality === "physical"` — devicectl can also
 * report simulators), paired, and running iOS/iPadOS. devicectl lists devices
 * it merely REMEMBERS too; connection state is intentionally not filtered on
 * here beyond pairing, because "paired but currently unreachable" is still the
 * answer to "what iPad could I target" — later phases verify reachability at
 * boot time, with their own error surface.
 */
export function parseDevicectlDevices(json: unknown): PhysicalIosDevice[] {
  const devices = (json as { result?: { devices?: unknown[] } } | null)?.result?.devices ?? [];
  const out: PhysicalIosDevice[] = [];
  for (const d of devices) {
    const dev = d as {
      identifier?: unknown;
      connectionProperties?: { pairingState?: unknown; transportType?: unknown };
      deviceProperties?: { name?: unknown; osVersionNumber?: unknown; developerModeStatus?: unknown };
      hardwareProperties?: { udid?: unknown; marketingName?: unknown; deviceType?: unknown; platform?: unknown; reality?: unknown };
    };
    const hw = dev.hardwareProperties ?? {};
    const conn = dev.connectionProperties ?? {};
    const props = dev.deviceProperties ?? {};
    if (hw.reality !== "physical") continue;
    if (conn.pairingState !== "paired") continue;
    // iOS covers iPadOS in devicectl's vocabulary; skip watchOS/tvOS/visionOS.
    if (String(hw.platform ?? "") !== "iOS") continue;
    const identifier = String(dev.identifier ?? "");
    const udid = String(hw.udid ?? "");
    if (!identifier || !udid) continue;
    out.push({
      identifier,
      udid,
      name: String(props.name ?? ""),
      model: String(hw.marketingName ?? ""),
      deviceType: String(hw.deviceType ?? ""),
      osVersion: String(props.osVersionNumber ?? ""),
      transport: conn.transportType === "wired" ? "usb" : conn.transportType === "localNetwork" ? "network" : "unknown",
      developerMode: props.developerModeStatus === "enabled",
    });
  }
  return out;
}

/**
 * Parse `adb devices -l` down to PHYSICAL devices: skips the banner, blank
 * lines, adb daemon-start noise, and every emulator serial (`emulator-<port>`).
 * Emulators stay the emulator layer's business (`parseAdbDevices` in
 * android.ts, which deliberately counts them all — different question).
 */
export function parseAdbPhysicalDevices(stdout: string): PhysicalAndroidDevice[] {
  const out: PhysicalAndroidDevice[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("List of devices") || line.startsWith("*")) continue;
    const [serial, state] = line.split(/\s+/);
    if (!serial || !state || serial.startsWith("emulator-")) continue;
    if (state !== "device" && state !== "unauthorized" && state !== "offline") continue;
    const model = /model:(\S+)/.exec(line)?.[1];
    out.push({ serial, state, model });
  }
  return out;
}

// --- the scanner -----------------------------------------------------------

export interface PhysicalDeviceScannerOptions {
  exec?: Exec;
  /** Injected for tests: read devicectl's --json-output file. */
  readFileImpl?: (path: string) => Buffer;
  /** Injected for tests: delete that file afterwards. */
  rmImpl?: (path: string) => void;
}

function scanError(prefix: string, e: unknown): string {
  return `${prefix}: ${e instanceof Error ? e.message : String(e)}`;
}

/**
 * Best-effort by construction: `list()` NEVER throws. A machine without Xcode,
 * without adb, or with a hung devicectl answers with empty lists — but a FAILED
 * scan is reported in `errors`, never conflated with a genuine zero-device
 * answer, because this feeds `list_devices` and an agent reading a silent `[]`
 * would tell a user their plugged-in iPhone does not exist.
 */
export class PhysicalDeviceScanner {
  private readonly exec: Exec;
  private readonly readFileImpl: (path: string) => Buffer;
  private readonly rmImpl: (path: string) => void;
  private seq = 0;

  constructor(opts: PhysicalDeviceScannerOptions = {}) {
    // android.ts's exec, not ios.ts's: adb lives under the SDK root, so the
    // spawn env must carry the resolved ANDROID_HOME/PATH (toolEnv.ts) or a
    // non-default SDK location gets ENOENT while AndroidManager sees devices
    // fine. xcrun is on the base PATH regardless, so sharing the env is safe.
    this.exec = opts.exec ?? makeDefaultExec();
    this.readFileImpl = opts.readFileImpl ?? readFileSync;
    this.rmImpl = opts.rmImpl ?? ((p) => rmSync(p, { force: true }));
  }

  async list(): Promise<PhysicalDevices> {
    const [ios, android] = await Promise.all([this.listIos(), this.listAndroid()]);
    const errors = { ...(ios.error ? { ios: ios.error } : {}), ...(android.error ? { android: android.error } : {}) };
    return { ios: ios.devices, android: android.devices, ...(Object.keys(errors).length ? { errors } : {}) };
  }

  /**
   * devicectl only speaks JSON via `--json-output <file>` ("the ONLY supported
   * interface for scripts", per its own help) — stdout is a human table. Same
   * tmp-file dance as Simctl.screenshotPng, for the same reason. Its own
   * `--timeout` bounds the wait on remembered-but-unreachable Wi-Fi devices,
   * so an enumeration call cannot hang for the full exec ceiling.
   */
  async listIos(): Promise<{ devices: PhysicalIosDevice[]; error?: string }> {
    let file: string | null = null;
    try {
      file = join(tmpdir(), `deckhand-devicectl-${process.pid}-${this.seq++}.json`);
      const res = await this.exec("xcrun", ["devicectl", "list", "devices", "--quiet", "--timeout", "5", "--json-output", file], {
        timeoutMs: 8_000,
      });
      if (res.code !== 0) return { devices: [], error: `devicectl scan failed (exit ${res.code}): ${res.stderr.trim().slice(0, 200)}` };
      return { devices: parseDevicectlDevices(JSON.parse(this.readFileImpl(file).toString())) };
    } catch (e) {
      return { devices: [], error: scanError("devicectl scan failed", e) };
    } finally {
      try {
        if (file) this.rmImpl(file);
      } catch {
        // Best-effort cleanup of a tmp file — nothing to do about it.
      }
    }
  }

  async listAndroid(): Promise<{ devices: PhysicalAndroidDevice[]; error?: string }> {
    try {
      const res = await this.exec("adb", ["devices", "-l"], { timeoutMs: 5_000 });
      if (res.code !== 0) return { devices: [], error: `adb scan failed (exit ${res.code}): ${res.stderr.trim().slice(0, 200)}` };
      return { devices: parseAdbPhysicalDevices(res.stdout.toString()) };
    } catch (e) {
      return { devices: [], error: scanError("adb scan failed", e) };
    }
  }
}
