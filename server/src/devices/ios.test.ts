import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseRuntimes,
  parseDeviceTypes,
  selectRuntime,
  selectDeviceType,
  deviceLabel,
  SimctlError,
  Simctl,
  type Runtime,
} from "./ios.ts";

const runtimesJson = {
  runtimes: [
    { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-0", name: "iOS 26.0", version: "26.0", isAvailable: true },
    { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-27-0", name: "iOS 27.0", version: "27.0", isAvailable: true },
    { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-25-0", name: "iOS 25.0", version: "25.0", isAvailable: false },
    { identifier: "com.apple.CoreSimulator.SimRuntime.watchOS-11-0", name: "watchOS 11.0", version: "11.0", isAvailable: true },
  ],
};

const deviceTypesJson = {
  devicetypes: [
    { identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16", name: "iPhone 16" },
    { identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro", name: "iPhone 16 Pro" },
    { identifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro", name: 'iPad Pro 13-inch' },
  ],
};

describe("parseRuntimes", () => {
  it("keeps only iOS runtimes", () => {
    const rts = parseRuntimes(runtimesJson);
    assert.deepEqual(
      rts.map((r) => r.version).sort(),
      ["25.0", "26.0", "27.0"],
    );
    assert.equal(rts.some((r) => /watchOS/.test(r.name)), false);
  });
});

describe("parseDeviceTypes", () => {
  it("parses id + name", () => {
    const dts = parseDeviceTypes(deviceTypesJson);
    assert.equal(dts.length, 3);
    assert.equal(dts[1]!.name, "iPhone 16 Pro");
  });
});

describe("selectRuntime", () => {
  const rts = parseRuntimes(runtimesJson);

  it("defaults to the newest available", () => {
    assert.equal(selectRuntime(rts).version, "27.0");
  });

  it("matches a requested major version in several forms", () => {
    assert.equal(selectRuntime(rts, "26").version, "26.0");
    assert.equal(selectRuntime(rts, "iOS 26").version, "26.0");
    assert.equal(selectRuntime(rts, "26.0").version, "26.0");
  });

  it("ignores unavailable runtimes and errors when none match", () => {
    assert.throws(() => selectRuntime(rts, "25"), (e) => e instanceof SimctlError); // 25 is unavailable
    assert.throws(() => selectRuntime([] as Runtime[]), (e) => e instanceof SimctlError);
  });
});

describe("selectDeviceType", () => {
  const dts = parseDeviceTypes(deviceTypesJson);

  it("defaults to a Pro iPhone", () => {
    assert.equal(selectDeviceType(dts).name, "iPhone 16 Pro");
  });

  it("matches a requested model by substring", () => {
    assert.equal(selectDeviceType(dts, "iPhone 16").name, "iPhone 16");
    assert.equal(selectDeviceType(dts, "16 pro").name, "iPhone 16 Pro");
  });

  it("matches a requested iPad (the iPhone default pool must not hide it)", () => {
    assert.equal(selectDeviceType(dts, "iPad Pro 13-inch").name, "iPad Pro 13-inch");
    assert.equal(selectDeviceType(dts, "ipad").name, "iPad Pro 13-inch");
  });

  it("errors on an unmatched model", () => {
    assert.throws(() => selectDeviceType(dts, "Pixel 9"), (e) => e instanceof SimctlError);
  });
});

describe("deviceLabel", () => {
  it("combines model and runtime", () => {
    const rt = selectRuntime(parseRuntimes(runtimesJson), "26");
    const dt = selectDeviceType(parseDeviceTypes(deviceTypesJson), "16 pro");
    assert.equal(deviceLabel(dt, rt), "iPhone 16 Pro · iOS 26.0");
  });
});

describe("Simctl.delete", () => {
  /** A simctl whose every call reports the given exit code. */
  const simctlExiting = (code: number) =>
    new Simctl(async (_cmd: string, _args: string[]) => ({
      stdout: Buffer.alloc(0),
      stderr: code === 0 ? "" : "Unable to delete device: in use",
      code,
    }));

  it("throws when simctl fails, so the caller's guard is not a no-op", async () => {
    // bootIos deletes a pooled device whose erase failed and only creates a
    // replacement if the delete SUCCEEDED — two simulators under one pool name
    // means a later lease can bind the stale one, still holding the previous
    // tenant's container, while the tenant map calls it clean. A swallowed exit
    // code made that catch unreachable and the replacement got created anyway.
    await assert.rejects(() => simctlExiting(1).delete("UDID-1"), (e) => e instanceof SimctlError);
  });

  it("resolves when simctl succeeds", async () => {
    await simctlExiting(0).delete("UDID-1");
  });
});

describe("silencing the dev-build overlays", () => {
  it("writes the three keys Expo registers as defaults, before launch", async () => {
    // Verified against expo-dev-menu 57.0.8, DevMenuPreferences.swift — all three are
    // register(defaults:) entries, so a written value wins:
    //   EXDevMenuShowsAtLaunch            ?? true
    //   EXDevMenuIsOnboardingFinished     ?? false
    //   EXDevMenuShowFloatingActionButton ?? true
    const calls: string[][] = [];
    const simctl = new Simctl(async (_cmd: string, args: string[]) => {
      calls.push(args);
      return { code: 0, stdout: Buffer.from(""), stderr: "" };
    });
    await simctl.silenceDevOverlays("UDID-1", "com.acme.app");

    // run() prefixes "simctl", so the recorded argv starts there.
    const writes = calls.filter((c) => c[1] === "spawn" && c[3] === "defaults");
    assert.equal(writes.length, 3, "all three overlays, or one of them still shows");
    const expected: [string, string][] = [
      ["EXDevMenuShowsAtLaunch", "NO"],
      ["EXDevMenuIsOnboardingFinished", "YES"],
      ["EXDevMenuShowFloatingActionButton", "NO"],
    ];
    for (const [key, value] of expected) {
      const w = writes.find((c) => c.includes(key));
      assert.ok(w, `missing ${key}`);
      assert.deepEqual(w, ["simctl", "spawn", "UDID-1", "defaults", "write", "com.acme.app", key, "-bool", value]);
    }
  });

  it("never lets a failed preference take the preview down with it", async () => {
    // A tidy-up is not worth a boot. Every write swallows its own error.
    const simctl = new Simctl(async () => {
      throw new Error("simctl spawn exploded");
    });
    await simctl.silenceDevOverlays("UDID-1", "com.acme.app");
  });
});
