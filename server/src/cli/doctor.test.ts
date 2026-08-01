import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deviceGateExit, type Check } from "./doctor.ts";

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

const smoke = (ok: boolean): Check => ({ name: "smoke: sim + serve-sim first frame", ok, gate: true, smoke: true });
const tool = (name: string, ok: boolean): Check => ({ name, ok, gate: true });

describe("deviceGateExit", () => {
  it("fails when no smoke check was produced", () => {
    // The shipped bug, exactly: config threw, so runDoctor never reached the smoke test.
    const r = deviceGateExit([{ name: "config files", ok: false }, tool("xcodebuild", true), tool("simctl", true)]);
    assert.equal(r.code, 1, "a gate that booted no device has not passed");
    assert.match(r.reason ?? "", /did not run/);
  });

  it("passes only when the smoke check ran and every gated check is green", () => {
    const r = deviceGateExit([{ name: "config files", ok: true }, tool("xcodebuild", true), smoke(true)]);
    assert.equal(r.code, 0);
    assert.equal(r.reason, undefined);
  });

  it("fails on a failed smoke check", () => {
    const r = deviceGateExit([tool("xcodebuild", true), smoke(false)]);
    assert.equal(r.code, 1);
    assert.deepEqual(
      r.failed.map((c) => c.name),
      ["smoke: sim + serve-sim first frame"],
    );
  });

  it("ignores checks outside the gate, however they fail", () => {
    // The whole point of --device-only: a missing GitHub credential is real, and is exactly
    // the wrong reason for a code gate to go red. A gate that fails for reasons the author
    // cannot fix gets ignored within a week.
    const r = deviceGateExit([
      { name: "github credential", ok: false, detail: "no PAT" },
      { name: "auto-restart services (launchd)", ok: false, warn: true },
      smoke(true),
    ]);
    assert.equal(r.code, 0);
  });

  it("treats skipped and warn gated checks as non-failures", () => {
    const r = deviceGateExit([{ name: "serve-sim (vendored)", ok: false, gate: true, skipped: true }, smoke(true)]);
    assert.equal(r.code, 0);
  });

  it("is keyed on the gate flag, not on the check's display name", () => {
    // `serve-sim (vendored, 1.2.3)` builds its label at runtime and `smoke: …` is prose.
    // The previous filter was a regex over those strings, so renaming the one check that
    // boots a device would have silently dropped it from the gate and kept exiting 0.
    const renamed: Check = { name: "first frame (real device)", ok: false, gate: true, smoke: true };
    assert.equal(deviceGateExit([renamed]).code, 1, "the flag travels with the check, the name does not");
  });
});
