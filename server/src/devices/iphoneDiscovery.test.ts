import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IphoneDiscoveryError, blockersFor, discoverIphones, parseDevicectlDevices, readWdaProfile, type DevicectlPhone } from "./iphoneDiscovery.ts";
import type { Exec } from "./ios.ts";

const UDID = "00008120-000000000000001E";

// The shape devicectl 651 writes for a cabled iPhone 15 on iOS 27.0.1, trimmed, plus a simulator.
const LIST = {
  info: { outcome: "success" },
  result: {
    devices: [
      {
        connectionProperties: { pairingState: "paired", transportType: "wired" },
        deviceProperties: { developerModeStatus: "enabled", name: "Test iPhone", osVersionNumber: "27.0.1" },
        hardwareProperties: { deviceType: "iPhone", marketingName: "iPhone 15", platform: "iOS", productType: "iPhone15,4", reality: "physical", udid: UDID },
        properties: {
          connection: { pairingState: "paired", transportType: "wired" },
          hardware: { deviceType: "iPhone", marketingName: "iPhone 15", platform: "iOS", productType: "iPhone15,4", reality: "physical", udid: UDID },
          software: { osVersionNumber: { stringValue: "27.0.1" } },
          state: { developerModeStatus: { enabled: { mode: 1 } }, name: "Test iPhone" },
        },
      },
      {
        hardwareProperties: { deviceType: "iPhone", marketingName: "iPhone 18 Pro", platform: "iOS", reality: "simulated", udid: "69DCA81F-B5E5-495F-A57B-F57958242C3B" },
        connectionProperties: { pairingState: "unsupported", transportType: "localNetwork" },
      },
      {
        connectionProperties: { pairingState: "paired", transportType: "localNetwork" },
        deviceProperties: { developerModeStatus: "disabled", name: "Old iPhone", osVersionNumber: "17.5" },
        hardwareProperties: { deviceType: "iPhone", marketingName: "iPhone 12", platform: "iOS", reality: "physical", udid: "00008101-0000000000000AAA" },
      },
    ],
  },
};

function wdaDir(devices: string[] | null, expires = "2027-10-23T14:18:08Z"): string {
  const dir = mkdtempSync(join(tmpdir(), "deckhand-wda-products-"));
  if (devices) {
    const app = join(dir, "Debug-iphoneos", "WebDriverAgentRunner-Runner.app");
    mkdirSync(app, { recursive: true });
    const xml = `<?xml version="1.0"?><plist version="1.0"><dict><key>ExpirationDate</key><date>${expires}</date><key>ProvisionedDevices</key><array>${devices.map((d) => `<string>${d}</string>`).join("")}</array></dict></plist>`;
    writeFileSync(join(app, "embedded.mobileprovision"), Buffer.concat([Buffer.from([0x30, 0x82]), Buffer.from(xml)]));
  }
  return dir;
}

function exec(over: { list?: unknown; listCode?: number; usb?: string[] | null; locked?: boolean } = {}): Exec {
  return async (cmd, args) => {
    const ok = (s = "") => ({ code: 0, stdout: Buffer.from(s), stderr: "" });
    if (cmd === "idevice_id") return over.usb === null ? { code: 1, stdout: Buffer.alloc(0), stderr: "not found" } : ok((over.usb ?? [UDID]).join("\n"));
    if (cmd === "xcrun") {
      const out = args[args.indexOf("--json-output") + 1]!;
      if (args.includes("lockState")) writeFileSync(out, JSON.stringify({ info: { outcome: "success" }, result: { passcodeRequired: over.locked ?? false } }));
      else writeFileSync(out, JSON.stringify(over.list ?? LIST));
      return { code: over.listCode ?? 0, stdout: Buffer.alloc(0), stderr: over.listCode ? "xcrun: error: unable to find utility \"devicectl\"" : "" };
    }
    return ok();
  };
}

describe("iPhone discovery", () => {
  it("lists physical iPhones only, from either devicectl shape", () => {
    const phones = parseDevicectlDevices(LIST);
    assert.deepEqual(phones.map((p) => [p.udid, p.model, p.osVersion, p.wired, p.developerMode]), [
      [UDID, "iPhone 15", "27.0.1", true, true],
      ["00008101-0000000000000AAA", "iPhone 12", "17.5", false, false],
    ]);
  });

  it("lists a ready phone with no blockers", async () => {
    const dir = wdaDir([UDID]);
    try {
      const [p] = await discoverIphones({ exec: exec({ list: { ...LIST, result: { devices: [LIST.result.devices[0]] } } }), productsDir: dir, now: new Date(2026, 10, 3) });
      assert.deepEqual(p, { udid: UDID, name: "Test iPhone", model: "iPhone 15", osVersion: "27.0.1", blockers: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the one action for each blocker", async () => {
    const dir = wdaDir(["00008101-0000000000000AAA"], "2026-01-01T00:00:00Z");
    try {
      const phones = await discoverIphones({ exec: exec({ locked: true }), productsDir: dir, now: new Date(2026, 10, 3) });
      const [mine, old] = phones;
      assert.deepEqual(mine!.blockers.map((b) => b.split(":")[0]), ["locked", "the WDA profile does not list this phone", "the WDA profile expired on 2026-01-01T00"]);
      assert.deepEqual(old!.blockers.map((b) => b.split(":")[0]), ["not connected by USB", "Developer Mode is off", "the WDA profile expired on 2026-01-01T00"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says there is no WDA, and where to put one", () => {
    const dir = wdaDir(null);
    try {
      assert.equal(readWdaProfile(dir), null);
      const phone: DevicectlPhone = { udid: UDID, name: "x", model: null, productType: null, osVersion: null, paired: true, wired: true, developerMode: true };
      assert.match(blockersFor(phone, { usb: true, locked: false, wda: null, productsDir: dir, now: new Date() })[0]!, new RegExp(`no WDA installed: .*${dir}`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails loudly when devicectl fails, rather than answering no phones", async () => {
    await assert.rejects(() => discoverIphones({ exec: exec({ listCode: 72 }) }), IphoneDiscoveryError);
  });

  it("says libimobiledevice is missing when idevice_id cannot run", async () => {
    const dir = wdaDir([UDID]);
    try {
      const [p] = await discoverIphones({ exec: exec({ usb: null, list: { ...LIST, result: { devices: [LIST.result.devices[0]] } } }), productsDir: dir });
      assert.match(p!.blockers.join("\n"), /brew install libimobiledevice/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
