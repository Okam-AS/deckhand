import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSimctl } from "../test-support/fakes.ts";
import { isPooled, orphanSims } from "../engine/reaper.ts";
import type { SimDevice } from "../devices/ios.ts";
import type { UiAction } from "../testing/control.ts";
import { acquireDevice, tryLock, verifySimName } from "./device.ts";
import { DEFAULT_DEVICE } from "./scenario.ts";

const root = mkdtempSync(join(tmpdir(), "verify-device-"));
after(() => rmSync(root, { recursive: true, force: true }));

const runtimes = async () => [{ identifier: "rt.26-5", name: "iOS 26.5", version: "26.5", isAvailable: true }];
const types = async () => [{ identifier: "dt.ipad9", name: "iPad (9th generation)" }];

function harness(home: string, devices: SimDevice[] = [], frame = { width: 1080, height: 810 }) {
  const log: string[] = [];
  const actions: UiAction[] = [];
  const simctl = fakeSimctl({ listRuntimes: runtimes, listDeviceTypes: types, listDevices: async () => devices }, log);
  const deps = {
    simctl,
    home,
    sleep: async () => {},
    action: async (_: string, a: UiAction) => void actions.push(a),
    rootFrame: async () => frame,
  };
  return { deps, log, actions };
}

describe("verify simulators", () => {
  it("are named outside everything the server's reaper and pool may touch", () => {
    const name = verifySimName("iPad (9th generation)", "iOS 26.5", 1);
    assert.equal(name, "verify-ipad-9th-generation-ios-26-5");
    assert.equal(verifySimName("iPad (9th generation)", "iOS 26.5", 2), `${name}-2`);
    assert.deepEqual(orphanSims([{ name, udid: "U", state: "Booted" } as SimDevice]), []);
    assert.equal(isPooled(name), false);
  });

  it("are held by one process at a time, and a dead holder's lock is taken over", () => {
    const file = join(root, "one.lock");
    const release = tryLock(file);
    assert.ok(release);
    assert.equal(tryLock(file), null);
    release!();
    writeFileSync(file, "999999");
    const again = tryLock(file);
    assert.ok(again, "pid 999999 is not running");
    assert.equal(readFileSync(file, "utf8"), String(process.pid));
    again!();
  });

  it("boots a fresh device and turns it to landscape once, remembering the turn", async () => {
    const home = join(root, "fresh");
    const h = harness(home);
    const dev = await acquireDevice(DEFAULT_DEVICE, h.deps);
    assert.deepEqual(h.log, ["simctl create verify-ipad-9th-generation-ios-26-5", "simctl boot UDID-verify-ipad-9th-generation-ios-26-5"]);
    assert.deepEqual(h.actions, [{ type: "rotate", direction: "left" }]);
    assert.equal(dev.quarterTurns, 1);
    assert.equal(dev.orientationVerified, true);
    const record = JSON.parse(readFileSync(join(home, "devices", `${dev.name}.json`), "utf8"));
    assert.deepEqual(record, { udid: dev.udid, quarterTurns: 1 });
    dev.release();

    const booted = harness(home, [{ name: dev.name, udid: dev.udid, state: "Booted" } as SimDevice]);
    const reused = await acquireDevice(DEFAULT_DEVICE, booted.deps);
    assert.deepEqual(booted.log, [], "a warm device it already turned is used as it is");
    assert.deepEqual(booted.actions, []);
    assert.equal(reused.quarterTurns, 1);
    reused.release();
  });

  it("takes the next slot while the first device is busy", async () => {
    const home = join(root, "busy");
    const first = await acquireDevice(DEFAULT_DEVICE, harness(home).deps);
    const second = await acquireDevice(DEFAULT_DEVICE, harness(home).deps);
    assert.equal(second.name, `${first.name}-2`);
    first.release();
    second.release();
  });

  it("reboots a booted device whose orientation it cannot account for", async () => {
    const home = join(root, "unknown");
    const h = harness(home, [{ name: "verify-ipad-9th-generation-ios-26-5", udid: "U1", state: "Booted" } as SimDevice]);
    const dev = await acquireDevice(DEFAULT_DEVICE, h.deps);
    assert.deepEqual(h.log, ["simctl shutdown U1", "simctl boot U1"]);
    assert.equal(dev.quarterTurns, 1);
    dev.release();
  });

  it("reboots and turns again when the screen disagrees with the record", async () => {
    const home = join(root, "drift");
    const h = harness(home);
    let reads = 0;
    h.deps.rootFrame = async () => (reads++ === 0 ? { width: 810, height: 1080 } : { width: 1080, height: 810 });
    const dev = await acquireDevice(DEFAULT_DEVICE, h.deps);
    assert.deepEqual(h.actions, [{ type: "rotate", direction: "left" }, { type: "rotate", direction: "left" }]);
    assert.ok(h.log.includes("simctl shutdown UDID-verify-ipad-9th-generation-ios-26-5"));
    assert.equal(dev.quarterTurns, 1);
    dev.release();
  });
});
