import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  IphoneApps, IphoneAppError, appDirFromListing, classifyInstallFailure, executableFromAppUrl, inspectArtifact, launchArgs, parseProvisioning, pidsUnder,
} from "./iphoneApps.ts";
import { defaultExec, type Exec } from "./ios.ts";

const UDID = "00008120-000000000000001E";
const OURS = "com.example.preview";

function infoPlist(bundleId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleShortVersionString</key><string>3.1.0</string><key>CFBundleVersion</key><string>1018</string><key>CFBundleExecutable</key><string>Demo</string></dict></plist>`;
}

function profile(devices: string[]): Buffer {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>ExpirationDate</key><date>2027-10-23T14:18:08Z</date><key>ProvisionedDevices</key><array>${devices.map((d) => `<string>${d}</string>`).join("")}</array></dict></plist>`;
  return Buffer.concat([Buffer.from([0x30, 0x82, 0x01]), Buffer.from(xml, "latin1"), Buffer.from([0xa0, 0x00])]);
}

/** A device `.app` and an `.ipa` of it, built with the system's zip. */
function artifacts(bundleId: string, devices: string[] = [UDID]): { dir: string; app: string; ipa: string } {
  const dir = mkdtempSync(join(tmpdir(), "deckhand-ipa-test-"));
  const app = join(dir, "Payload", "Demo.app");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "Info.plist"), infoPlist(bundleId));
  writeFileSync(join(app, "embedded.mobileprovision"), profile(devices));
  execFileSync("zip", ["-q", "-r", "Demo.ipa", "Payload"], { cwd: dir });
  return { dir, app, ipa: join(dir, "Demo.ipa") };
}

interface Devicectl {
  calls: string[][];
  exec: Exec;
}

/** Real unzip/plutil; `xcrun devicectl` answered from `respond`, written where --json-output says. */
function devicectl(respond: (args: string[]) => { outcome?: string; result?: unknown; error?: unknown } = () => ({ result: {} })): Devicectl {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args, o) => {
    if (cmd !== "xcrun") return defaultExec(cmd, args, o);
    calls.push(args);
    const r = respond(args);
    const out = args[args.indexOf("--json-output") + 1]!;
    const outcome = r.outcome ?? "success";
    writeFileSync(out, JSON.stringify({ info: { outcome }, result: r.result, error: r.error }));
    return { code: outcome === "success" ? 0 : 1, stdout: Buffer.alloc(0), stderr: "" };
  };
  return { calls, exec };
}

const APP_URL = "file:///private/var/containers/Bundle/Application/ABC/Demo.app/";

function answers(args: string[]): { result?: unknown } {
  if (args.includes("apps")) return { result: { apps: [{ bundleIdentifier: OURS, version: "3.1.0", bundleVersion: "1018", url: APP_URL }] } };
  if (args.includes("processes")) return { result: { runningProcesses: [{ executable: `${APP_URL}Demo`, processIdentifier: 812 }, { executable: "file:///usr/libexec/x", processIdentifier: 3 }] } };
  if (args.includes("launch")) return { result: { process: { processIdentifier: 901 } } };
  return { result: {} };
}

describe("the registered-app guard", () => {
  // The operator's rule: on a borrowed phone, deckhand installs, starts, stops and removes only the
  // preview's own app. Each case here must reach no devicectl call at all.
  it("refuses to install an artifact that holds another app", async () => {
    const a = artifacts("com.someone.else");
    try {
      const d = devicectl();
      const apps = new IphoneApps({ udid: UDID, bundleId: OURS, exec: d.exec });
      await assert.rejects(() => apps.install(a.ipa), (e: unknown) => e instanceof IphoneAppError && e.code === "foreign_bundle");
      await assert.rejects(() => apps.install(a.app), (e: unknown) => e instanceof IphoneAppError && e.code === "foreign_bundle");
      assert.deepEqual(d.calls, []);
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
    }
  });

  for (const [verb, call] of [
    ["launch", (apps: IphoneApps) => apps.launch("com.apple.Preferences")],
    ["terminate", (apps: IphoneApps) => apps.terminate("com.apple.mobilesafari")],
    ["uninstall", (apps: IphoneApps) => apps.uninstall("com.someone.else")],
    ["read", (apps: IphoneApps) => apps.installedApp("com.someone.else")],
  ] as const) {
    it(`refuses to ${verb} any app but the registered one`, async () => {
      const d = devicectl(answers);
      const apps = new IphoneApps({ udid: UDID, bundleId: OURS, exec: d.exec });
      await assert.rejects(() => call(apps), (e: unknown) => e instanceof IphoneAppError && e.code === "foreign_bundle" && e.message.includes(OURS));
      assert.deepEqual(d.calls, []);
    });
  }
});

describe("installing", () => {
  it("installs the registered app from an .ipa, reading only its plist and profile", async () => {
    const a = artifacts(OURS);
    try {
      const d = devicectl();
      const r = await new IphoneApps({ udid: UDID, bundleId: OURS, exec: d.exec }).install(a.ipa);
      assert.equal(r.replaced, false);
      assert.deepEqual([r.info.bundleId, r.info.version, r.info.buildVersion, r.info.executable], [OURS, "3.1.0", "1018", "Demo"]);
      assert.deepEqual(d.calls.map((c) => c.slice(0, 7)), [["devicectl", "device", "install", "app", "--device", UDID, a.ipa]]);
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
    }
  });

  it("refuses a build whose profile does not list the phone, before touching it", async () => {
    const a = artifacts(OURS, ["00008101-0000000000000AAA"]);
    try {
      const d = devicectl();
      await assert.rejects(
        () => new IphoneApps({ udid: UDID, bundleId: OURS, exec: d.exec }).install(a.ipa),
        (e: unknown) => e instanceof IphoneAppError && e.code === "not_provisioned" && /register the phone/.test(e.hint ?? ""),
      );
      assert.deepEqual(d.calls, []);
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
    }
  });

  it("refuses a conflicting install by default, and replaces only the registered app when asked", async () => {
    const a = artifacts(OURS);
    try {
      let installs = 0;
      const conflict = () => ({ outcome: "failed", error: { domain: "com.apple.dt.CoreDeviceError", code: 3002, userInfo: { NSLocalizedDescription: { string: "MismatchedApplicationIdentifierEntitlement: the app is signed by a different team" } } } });
      const respond = (args: string[]) => (args.includes("install") ? (++installs === 1 ? conflict() : { result: {} }) : { result: {} });
      const d1 = devicectl(respond);
      await assert.rejects(() => new IphoneApps({ udid: UDID, bundleId: OURS, exec: d1.exec }).install(a.ipa), (e: unknown) => e instanceof IphoneAppError && e.code === "install_conflict");
      assert.equal(d1.calls.some((c) => c.includes("uninstall")), false);

      installs = 0;
      const d2 = devicectl(respond);
      const r = await new IphoneApps({ udid: UDID, bundleId: OURS, exec: d2.exec }).install(a.ipa, { replaceOnConflict: true });
      assert.equal(r.replaced, true);
      assert.deepEqual(d2.calls.map((c) => c[2]), ["install", "uninstall", "install"]);
      assert.equal(d2.calls[1]!.at(-3), OURS);
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
    }
  });

  it("tells a phone the profile does not list from a signing conflict", () => {
    assert.equal(classifyInstallFailure("The device is not provisioned: profile does not include this device (0xe8008012)").code, "not_provisioned");
    assert.equal(classifyInstallFailure("MismatchedApplicationIdentifierEntitlement").code, "install_conflict");
    assert.equal(classifyInstallFailure("downgrade not allowed").code, "install_conflict");
    assert.equal(classifyInstallFailure("disk full").code, "devicectl_failed");
  });

  it("refuses an archive that is not one app", () => {
    assert.throws(() => appDirFromListing("Payload/A.app/Info.plist\nPayload/B.app/Info.plist\n"), /found 2/);
    assert.equal(appDirFromListing("Payload/\nPayload/Demo.app/\nPayload/Demo.app/Info.plist\n"), "Payload/Demo.app");
  });

  it("reads the device list and expiry from a profile", () => {
    const p = parseProvisioning(profile([UDID, "X"]).toString("latin1"));
    assert.deepEqual(p.provisionedDevices, [UDID, "X"]);
    assert.equal(p.profileExpires, "2027-10-23T14:18:08Z");
    assert.equal(p.provisionsAllDevices, false);
  });

  it("refuses anything that is not an .ipa or .app", async () => {
    await assert.rejects(() => inspectArtifact("/tmp/x.apk"), (e: unknown) => e instanceof IphoneAppError && e.code === "bad_artifact");
  });
});

describe("launching and stopping", () => {
  it("launches fresh with allow-listed process arguments after -- and an optional payload URL", async () => {
    const d = devicectl(answers);
    const pid = await new IphoneApps({ udid: UDID, bundleId: OURS, exec: d.exec }).launch(OURS, { args: { BACKEND: "test" }, payloadUrl: "exp+demo://expo-development-client/?url=x" });
    assert.equal(pid, 901);
    const c = d.calls[0]!;
    assert.ok(c.includes("--terminate-existing"));
    assert.deepEqual(c.slice(c.indexOf("--payload-url"), c.indexOf("--payload-url") + 2), ["--payload-url", "exp+demo://expo-development-client/?url=x"]);
    assert.deepEqual(c.slice(c.indexOf("--")), ["--", "-BACKEND", "test"]);
  });

  it("refuses launch arguments that are not plain keys and values", () => {
    for (const bad of [{ "-x": "1" }, { KEY: "a b" }, { KEY: "$(rm)" }, { "": "x" }]) {
      assert.throws(() => launchArgs(bad), (e: unknown) => e instanceof IphoneAppError && e.code === "bad_launch_arg", JSON.stringify(bad));
    }
  });

  it("terminates the processes running from the app's bundle, and only those", async () => {
    const d = devicectl(answers);
    const apps = new IphoneApps({ udid: UDID, bundleId: OURS, exec: d.exec });
    assert.equal(await apps.isRunning(), true);
    assert.equal(await apps.terminate(OURS), true);
    const kills = d.calls.filter((c) => c.includes("terminate"));
    assert.deepEqual(kills.map((c) => c.slice(c.indexOf("--pid"), c.indexOf("--pid") + 2)), [["--pid", "812"]]);
  });

  it("reads which processes belong to the app and its process name", () => {
    assert.deepEqual(pidsUnder([{ executable: `${APP_URL}Demo`, processIdentifier: 5 }, { executable: "file:///private/var/containers/Bundle/Application/ABC/Demo.appx/x", processIdentifier: 6 }], APP_URL), [5]);
    assert.equal(executableFromAppUrl(APP_URL), "Demo");
    assert.equal(executableFromAppUrl(null), null);
  });

  it("surfaces devicectl's own reason when it fails", async () => {
    const d = devicectl(() => ({ outcome: "failed", error: { domain: "D", code: 1, userInfo: { NSLocalizedDescription: { string: "The device is locked." } } } }));
    await assert.rejects(() => new IphoneApps({ udid: UDID, bundleId: OURS, exec: d.exec }).uninstall(OURS), /The device is locked/);
  });
});
