import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deviceGateExit, freshnessVerdict, type Check } from "./doctor.ts";

/**
 * The `--device-only` exit code (`npm run test:device`).
 *
 * The gate shipped failing open: `runDoctor` pushes the smoke test only inside `if (config)`,
 * so a config-load failure produced a `checks` array holding nothing but `config files`
 * (dropped by the filter) and the two toolchain checks — which pass on any Mac with Xcode.
 * `failed.length === 0`, exit 0, "success" reported by a run that never created a simulator.
 * "The check did not run" and "the check passed" were the same value, which is the permissive-
 * default class this repo has been bitten by three times (loadAppsSafe, allocAndroidPort,
 * Simctl.delete).
 *
 * Testing it at all required pulling the decision out of `cli.ts`, which is an unrunnable
 * entry point full of `process.exit`. That extraction IS the fix; these tests only pin it.
 */

const smoke = (platform: "ios" | "android", ok = true): Check => ({ name: `smoke ${platform}: boot`, ok, gate: true, smoke: platform });
/** Both legs green — the only shape that may exit 0. */
const bothPlatforms = (): Check[] => [smoke("ios"), smoke("android")];
const tool = (name: string, ok: boolean): Check => ({ name, ok, gate: true });

describe("deviceGateExit", () => {
  it("fails when no smoke check was produced", () => {
    // The shipped bug, exactly: config threw, so runDoctor never reached the smoke tests.
    const r = deviceGateExit([{ name: "config files", ok: false }, tool("xcodebuild", true), tool("simctl", true)]);
    assert.equal(r.code, 1, "a gate that booted no device has not passed");
    assert.match(r.reason ?? "", /did not run/);
  });

  it("fails when only one platform was exercised", () => {
    // The gate was iOS-only while ci.yml justified excluding it from CI *because* CI cannot
    // do Android. Half the devices, reading as all of them — one layer further down.
    const r = deviceGateExit([tool("xcodebuild", true), smoke("ios")]);
    assert.equal(r.code, 1);
    assert.match(r.reason ?? "", /android/, "the missing platform must be named");
  });

  it("passes only when the smoke check ran and every gated check is green", () => {
    const r = deviceGateExit([{ name: "config files", ok: true }, tool("xcodebuild", true), ...bothPlatforms()]);
    assert.equal(r.code, 0);
    assert.equal(r.reason, undefined);
  });

  it("fails on a failed smoke check", () => {
    const r = deviceGateExit([tool("xcodebuild", true), smoke("ios"), smoke("android", false)]);
    assert.equal(r.code, 1);
    assert.deepEqual(
      r.failed.map((c) => c.name),
      ["smoke android: boot"],
    );
  });

  it("fails when a capability below boot is red, even though both platforms booted", () => {
    // boot/stream/describe are separate checks precisely so "it booted" cannot stand in for
    // "it streamed". A device that comes up and never produces a frame is the single most
    // common failure on this machine.
    const r = deviceGateExit([
      ...bothPlatforms(),
      { name: "smoke android: stream", ok: false, gate: true, detail: "no first frame" },
    ]);
    assert.equal(r.code, 1);
    assert.deepEqual(r.failed.map((c) => c.name), ["smoke android: stream"]);
  });

  it("ignores checks outside the gate, however they fail", () => {
    // The whole point of --device-only: a missing GitHub credential is real, and is exactly
    // the wrong reason for a code gate to go red. A gate that fails for reasons the author
    // cannot fix gets ignored within a week.
    const r = deviceGateExit([
      { name: "github credential", ok: false, detail: "no PAT" },
      { name: "auto-restart services (launchd)", ok: false, warn: true },
      ...bothPlatforms(),
    ]);
    assert.equal(r.code, 0);
  });

  it("treats skipped and warn gated checks as non-failures", () => {
    const r = deviceGateExit([{ name: "serve-sim (vendored)", ok: false, gate: true, skipped: true }, ...bothPlatforms()]);
    assert.equal(r.code, 0);
  });

  it("is keyed on the gate flag, not on the check's display name", () => {
    // `serve-sim (vendored, 1.2.3)` builds its label at runtime and `smoke: …` is prose.
    // The previous filter was a regex over those strings, so renaming the one check that
    // boots a device would have silently dropped it from the gate and kept exiting 0.
    const renamed: Check = { name: "first frame (real device)", ok: false, gate: true, smoke: "ios" };
    assert.equal(deviceGateExit([renamed, smoke("android")]).code, 1, "the flag travels with the check, the name does not");
  });
});

describe("freshnessVerdict", () => {
  it("catches a server too old to report its own version", () => {
    // The situation that prompted this: the running server predated the check that says
    // "you pulled, now restart", so it could not say it about itself. doctor is a fresh
    // process every time and always has the newest logic — this is where a stale server gets
    // caught by something that is not itself.
    const v = freshnessVerdict("abc1234", { });
    assert.equal(v.ok, false);
    assert.equal(v.warn, true, "a stale server still works — failing doctor over it teaches people to ignore doctor");
    assert.match(v.detail, /too old to report/);
    assert.match(v.detail, /launchctl kickstart/, "and the exact command");
  });

  it("catches a pull without a restart", () => {
    const v = freshnessVerdict("newsha1", { commit: "oldsha0" });
    assert.equal(v.ok, false);
    assert.match(v.detail, /running oldsha0, checkout is newsha1/);
    assert.match(v.detail, /tears down every booted preview/, "so the operator knows what it costs");
  });

  it("is quiet when the server is on this checkout", () => {
    const v = freshnessVerdict("abc1234", { commit: "abc1234", describe: "v0.1.61" });
    assert.equal(v.ok, true);
    assert.equal(v.detail, "v0.1.61");
  });
});
