import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseRuntimes,
  parseDeviceTypes,
  selectRuntime,
  selectDeviceType,
  deviceLabel,
  SimctlError,
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
