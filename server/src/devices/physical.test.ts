import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PhysicalDeviceScanner,
  parseAdbPhysicalDevices,
  parseDevicectlDevices,
} from "./physical.ts";
import type { Exec, ExecResult } from "./ios.ts";

// ---------------------------------------------------------------------------
// Fixture shaped from REAL `devicectl list devices --json-output` (devicectl
// 518.33, jsonVersion 3, captured on-machine 2026-08-02), trimmed to the
// fields the parser reads plus the surrounding structure it must skip over.
// ---------------------------------------------------------------------------

function devicectlDevice(overrides: {
  identifier?: string;
  udid?: string;
  name?: string;
  marketingName?: string;
  deviceType?: string;
  platform?: string;
  reality?: string;
  pairingState?: string;
  transportType?: string;
  osVersionNumber?: string;
  developerModeStatus?: string;
}): unknown {
  return {
    capabilities: [{ featureIdentifier: "com.apple.coredevice.feature.connectdevice", name: "Connect to Device" }],
    connectionProperties: {
      authenticationType: "manualPairing",
      isMobileDeviceOnly: false,
      pairingState: overrides.pairingState ?? "paired",
      potentialHostnames: ["X.coredevice.local"],
      transportType: overrides.transportType ?? "localNetwork",
      tunnelState: "disconnected",
      tunnelTransportProtocol: "tcp",
    },
    deviceProperties: {
      bootedFromSnapshot: true,
      ddiServicesAvailable: false,
      developerModeStatus: overrides.developerModeStatus ?? "enabled",
      name: overrides.name ?? "iPad",
      osBuildUpdate: "22H420",
      osVersionNumber: overrides.osVersionNumber ?? "18.7.8",
      screenViewingURL: "devices://device/open?id=X",
    },
    hardwareProperties: {
      cpuType: { name: "arm64e", subType: 2, type: 16777228 },
      deviceType: overrides.deviceType ?? "iPad",
      hardwareModel: "J171AP",
      marketingName: overrides.marketingName ?? "iPad (9th generation)",
      platform: overrides.platform ?? "iOS",
      productType: "iPad12,1",
      reality: overrides.reality ?? "physical",
      udid: overrides.udid ?? "00008030-00122D3C26BA202E",
    },
    identifier: overrides.identifier ?? "ABBF991E-8F0F-522F-9B7C-EB1C94571984",
    tags: [],
    visibilityClass: "default",
  };
}

function devicectlJson(...devices: unknown[]): unknown {
  return {
    info: { commandType: "devicectl.list.devices", jsonVersion: 3, outcome: "success", version: "518.33" },
    result: { devices },
  };
}

describe("parseDevicectlDevices", () => {
  it("parses a paired physical iPad and iPhone from real-shaped JSON", () => {
    const json = devicectlJson(
      devicectlDevice({
        identifier: "A03D804A-042F-531E-88EC-BD8A3D8A0C17",
        udid: "00008150-001935D10220401C",
        name: "KariPhone",
        marketingName: "iPhone 17 Pro Max",
        deviceType: "iPhone",
        osVersionNumber: "26.6",
      }),
      devicectlDevice({}),
    );
    const out = parseDevicectlDevices(json);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], {
      identifier: "A03D804A-042F-531E-88EC-BD8A3D8A0C17",
      udid: "00008150-001935D10220401C",
      name: "KariPhone",
      model: "iPhone 17 Pro Max",
      deviceType: "iPhone",
      osVersion: "26.6",
      transport: "network",
      developerMode: true,
    });
    assert.equal(out[1]!.deviceType, "iPad");
    assert.equal(out[1]!.udid, "00008030-00122D3C26BA202E");
  });

  it("maps wired transport to usb and anything else to network", () => {
    const usb = parseDevicectlDevices(devicectlJson(devicectlDevice({ transportType: "wired" })));
    assert.equal(usb[0]!.transport, "usb");
    const wifi = parseDevicectlDevices(devicectlJson(devicectlDevice({ transportType: "localNetwork" })));
    assert.equal(wifi[0]!.transport, "network");
  });

  it("drops unpaired devices — devicectl remembers hardware it can no longer use", () => {
    const out = parseDevicectlDevices(devicectlJson(devicectlDevice({ pairingState: "unpaired" }), devicectlDevice({})));
    assert.equal(out.length, 1);
    assert.equal(out[0]!.deviceType, "iPad");
  });

  it("drops simulators — devicectl can report reality:simulated, and those belong to simctl", () => {
    const out = parseDevicectlDevices(devicectlJson(devicectlDevice({ reality: "simulated" })));
    assert.deepEqual(out, []);
  });

  it("drops non-iOS platforms (watchOS/tvOS/visionOS)", () => {
    const out = parseDevicectlDevices(devicectlJson(devicectlDevice({ platform: "watchOS" })));
    assert.deepEqual(out, []);
  });

  it("reports developer mode disabled — later phases must tell the user to flip it, not fail cryptically", () => {
    const out = parseDevicectlDevices(devicectlJson(devicectlDevice({ developerModeStatus: "disabled" })));
    assert.equal(out[0]!.developerMode, false);
  });

  it("drops records missing identifier or udid rather than emitting unusable handles", () => {
    assert.deepEqual(parseDevicectlDevices(devicectlJson(devicectlDevice({ identifier: "" }))), []);
    assert.deepEqual(parseDevicectlDevices(devicectlJson(devicectlDevice({ udid: "" }))), []);
  });

  it("answers [] for empty, malformed, or foreign JSON", () => {
    assert.deepEqual(parseDevicectlDevices(devicectlJson()), []);
    assert.deepEqual(parseDevicectlDevices({}), []);
    assert.deepEqual(parseDevicectlDevices(null), []);
    assert.deepEqual(parseDevicectlDevices({ result: { devices: [{}, { hardwareProperties: {} }] } }), []);
  });
});

describe("parseAdbPhysicalDevices", () => {
  const REAL_OUTPUT = [
    "List of devices attached",
    "R58M12ABCDE            device usb:34603008X product:beyond1lteexx model:SM_G973F device:beyond1 transport_id:2",
    "emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1",
    "192.168.1.44:5555      device product:raven model:Pixel_6_Pro device:raven transport_id:5",
    "0A241FDD4003ER         unauthorized usb:34603009X transport_id:3",
    "1B2C3D4E5F             offline transport_id:4",
    "",
  ].join("\n");

  it("keeps physical devices and drops every emulator serial", () => {
    const out = parseAdbPhysicalDevices(REAL_OUTPUT);
    assert.deepEqual(
      out.map((d) => d.serial),
      ["R58M12ABCDE", "192.168.1.44:5555", "0A241FDD4003ER", "1B2C3D4E5F"],
    );
  });

  it("extracts model and state per device", () => {
    const out = parseAdbPhysicalDevices(REAL_OUTPUT);
    assert.deepEqual(out[0], { serial: "R58M12ABCDE", state: "device", model: "SM_G973F" });
    assert.deepEqual(out[1], { serial: "192.168.1.44:5555", state: "device", model: "Pixel_6_Pro" });
    assert.equal(out[2]!.state, "unauthorized");
    assert.equal(out[2]!.model, undefined);
    assert.equal(out[3]!.state, "offline");
  });

  it("survives daemon-start noise, the banner, and blank output", () => {
    const noisy = ["* daemon not running; starting now at tcp:5037", "* daemon started successfully", "List of devices attached", ""].join(
      "\n",
    );
    assert.deepEqual(parseAdbPhysicalDevices(noisy), []);
    assert.deepEqual(parseAdbPhysicalDevices(""), []);
  });

  it("drops lines in states it does not understand rather than inventing a device", () => {
    assert.deepEqual(parseAdbPhysicalDevices("XYZ recovery transport_id:9\n"), []);
    assert.deepEqual(parseAdbPhysicalDevices("XYZ\n"), []);
  });
});

// ---------------------------------------------------------------------------
// The scanner: exec seam, tmp-file dance, and the never-throws guarantee.
// ---------------------------------------------------------------------------

function execResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return { stdout: Buffer.from(""), stderr: "", code: 0, ...overrides };
}

describe("PhysicalDeviceScanner", () => {
  it("runs devicectl with --json-output, reads the file back, and cleans it up", async () => {
    const calls: string[][] = [];
    let jsonPath = "";
    let removed = "";
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "xcrun") {
        jsonPath = args[args.length - 1]!;
        return execResult();
      }
      return execResult({ stdout: Buffer.from("List of devices attached\n") });
    };
    const scanner = new PhysicalDeviceScanner({
      exec,
      readFileImpl: (p) => {
        assert.equal(p, jsonPath);
        return Buffer.from(JSON.stringify(devicectlJson(devicectlDevice({}))));
      },
      rmImpl: (p) => {
        removed = p;
      },
    });
    const out = await scanner.list();
    assert.equal(out.ios.length, 1);
    assert.equal(out.ios[0]!.model, "iPad (9th generation)");
    assert.deepEqual(out.android, []);
    const devicectlCall = calls.find((c) => c[0] === "xcrun")!;
    assert.deepEqual(devicectlCall.slice(0, 5), ["xcrun", "devicectl", "list", "devices", "--quiet"]);
    assert.equal(devicectlCall[5], "--json-output");
    assert.equal(removed, jsonPath, "the tmp file must be deleted even on success");
  });

  it("answers empty lists when the tools are missing entirely (no Xcode, no adb)", async () => {
    const exec: Exec = async () => {
      throw new Error("spawn ENOENT");
    };
    const out = await new PhysicalDeviceScanner({ exec }).list();
    assert.deepEqual(out, { ios: [], android: [] });
  });

  it("answers empty lists on nonzero exits without reading the output file", async () => {
    let read = false;
    const exec: Exec = async () => execResult({ code: 1, stderr: "boom" });
    const out = await new PhysicalDeviceScanner({
      exec,
      readFileImpl: () => {
        read = true;
        return Buffer.from("{}");
      },
      rmImpl: () => {},
    }).list();
    assert.deepEqual(out, { ios: [], android: [] });
    assert.equal(read, false);
  });

  it("answers [] for iOS when devicectl writes unparseable JSON, still cleaning up", async () => {
    let removed = false;
    const exec: Exec = async (cmd) => (cmd === "xcrun" ? execResult() : execResult({ code: 1 }));
    const out = await new PhysicalDeviceScanner({
      exec,
      readFileImpl: () => Buffer.from("not json"),
      rmImpl: () => {
        removed = true;
      },
    }).list();
    assert.deepEqual(out.ios, []);
    assert.equal(removed, true);
  });

  it("keeps one side's answer when only the other side fails", async () => {
    const exec: Exec = async (cmd) => {
      if (cmd === "xcrun") throw new Error("no xcode");
      return execResult({
        stdout: Buffer.from("List of devices attached\nR58M12ABCDE device model:SM_G973F transport_id:2\n"),
      });
    };
    const out = await new PhysicalDeviceScanner({ exec, readFileImpl: () => Buffer.from("{}"), rmImpl: () => {} }).list();
    assert.deepEqual(out.ios, []);
    assert.equal(out.android.length, 1);
    assert.equal(out.android[0]!.serial, "R58M12ABCDE");
  });

  it("never throws even when cleanup itself throws", async () => {
    const exec: Exec = async (cmd) => (cmd === "xcrun" ? execResult() : execResult({ stdout: Buffer.from("") }));
    const out = await new PhysicalDeviceScanner({
      exec,
      readFileImpl: () => Buffer.from(JSON.stringify(devicectlJson())),
      rmImpl: () => {
        throw new Error("EPERM");
      },
    }).list();
    assert.deepEqual(out, { ios: [], android: [] });
  });
});
