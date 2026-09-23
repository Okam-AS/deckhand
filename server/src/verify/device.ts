import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tryLock } from "./lock.ts";
import { join } from "node:path";
import { selectDeviceType, selectRuntime, type Simctl } from "../devices/ios.ts";
import type { UiAction } from "../testing/control.ts";
import type { DeviceShape, Orientation } from "./scenario.ts";

/**
 * Verify owns its simulators outright, outside the server's pool: `deckhand-` names belong to the
 * server's boot reaper and pool leases, and a second process leasing from that pool would erase a
 * device a live preview is standing on.
 */
export const VERIFY_SIM_PREFIX = "verify-";
const MAX_SLOTS = 3;

export function verifySimName(model: string, runtime: string, slot: number): string {
  const slug = `${model}-${runtime}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${VERIFY_SIM_PREFIX}${slug}${slot > 1 ? `-${slot}` : ""}`;
}

interface DeviceRecord {
  udid: string;
  /** Counter-clockwise quarter turns since boot, as far as verify has turned it. */
  quarterTurns: number;
}

export interface VerifyDevice {
  name: string;
  udid: string;
  model: string;
  runtime: string;
  orientation: Orientation;
  /** Rotate a raw screenshot counter-clockwise this many quarter turns to make it upright. */
  quarterTurns: number;
  /** False when the accessibility tree could not be read back to confirm the rotation. */
  orientationVerified: boolean;
  bootMs: number;
  orientationMs: number;
  release: () => void;
}

export interface DeviceDeps {
  simctl: Simctl;
  /** SimDeck, for rotation and for reading the orientation back. */
  action: (udid: string, a: UiAction) => Promise<unknown>;
  rootFrame: (udid: string) => Promise<{ width: number; height: number } | null>;
  home: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function readRecord(file: string): DeviceRecord | null {
  try {
    const r = JSON.parse(readFileSync(file, "utf8")) as DeviceRecord;
    return typeof r.udid === "string" && Number.isInteger(r.quarterTurns) ? r : null;
  } catch {
    return null;
  }
}

export async function acquireDevice(shape: DeviceShape, deps: DeviceDeps): Promise<VerifyDevice> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const runtime = selectRuntime(await deps.simctl.listRuntimes(), shape.runtime);
  const deviceType = selectDeviceType(await deps.simctl.listDeviceTypes(), shape.model);
  mkdirSync(join(deps.home, "devices"), { recursive: true });

  let name = "";
  let release: (() => void) | null = null;
  for (let slot = 1; slot <= MAX_SLOTS && !release; slot++) {
    name = verifySimName(deviceType.name, runtime.name, slot);
    release = tryLock(join(deps.home, "devices", `${name}.lock`));
  }
  if (!release) throw new Error(`all ${MAX_SLOTS} verify simulators for ${deviceType.name} · ${runtime.name} are busy`);

  try {
    const recordFile = join(deps.home, "devices", `${name}.json`);
    const t0 = now();
    const devices = await deps.simctl.listDevices();
    let dev = devices.find((d) => d.name === name);
    let record = dev ? readRecord(recordFile) : null;
    if (dev && dev.state === "Booted" && record?.udid !== dev.udid) {
      await deps.simctl.shutdown(dev.udid).catch(() => {});
      dev = { ...dev, state: "Shutdown" };
    }
    const udid = dev?.udid ?? (await deps.simctl.create(name, deviceType.identifier, runtime.identifier));
    if (dev?.state !== "Booted") {
      await deps.simctl.bootAndWait(udid);
      record = { udid, quarterTurns: 0 };
    }
    record ??= { udid, quarterTurns: 0 };
    const save = () => writeFileSync(recordFile, JSON.stringify(record));
    save();
    const bootMs = now() - t0;

    const t1 = now();
    const want = shape.orientation === "landscape" ? 1 : 0;
    let orientationVerified = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (((record.quarterTurns % 2) + 2) % 2 !== want) {
        await deps.action(udid, { type: "rotate", direction: want ? "left" : "right" });
        record.quarterTurns += want ? 1 : -1;
        save();
        await sleep(800);
      }
      const frame = await deps.rootFrame(udid);
      if (!frame) break;
      if ((frame.width > frame.height ? 1 : 0) === want) {
        orientationVerified = true;
        break;
      }
      await deps.simctl.shutdown(udid).catch(() => {});
      await deps.simctl.bootAndWait(udid);
      record.quarterTurns = 0;
      save();
    }
    return {
      name,
      udid,
      model: deviceType.name,
      runtime: runtime.name,
      orientation: shape.orientation,
      quarterTurns: record.quarterTurns,
      orientationVerified,
      bootMs,
      orientationMs: now() - t1,
      release,
    };
  } catch (e) {
    release();
    throw e;
  }
}

