import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExecResult } from "./android.ts";
import {
  AndroidPhones,
  AppPolicyError,
  InstallConflictError,
  NonAsciiTextError,
  RegisteredApp,
  appLogLines,
  blockerForState,
  classifyInstallFailure,
  clockOffsetMs,
  escapeInputText,
  isEmulatorSerial,
  parseAdbDevicesLong,
  parseKeyguardShowing,
  parseLogcatEpoch,
  parseWakefulness,
  startedPids,
  usabilityBlocker,
} from "./androidPhone.ts";

function fakeExec(reply: (args: string[]) => Partial<ExecResult> = () => ({})) {
  const calls: string[] = [];
  const exec = async (_cmd: string, args: string[]): Promise<ExecResult> => {
    calls.push(args.join(" "));
    const r = reply(args);
    return { code: r.code ?? 0, stdout: r.stdout ?? Buffer.from(""), stderr: r.stderr ?? "" };
  };
  return { exec, calls };
}
const buf = (s: string): Buffer => Buffer.from(s);

describe("phone discovery", () => {
  it("parses `adb devices -l` with its model field and two-word states", () => {
    const out = [
      "List of devices attached",
      "RF8N30YRFKY            device usb:0-1.1 product:x1seea model:SM_G980F device:x1s transport_id:5",
      "0A1B2C3D               unauthorized usb:0-1.2 transport_id:6",
      "emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 transport_id:1",
      "XYZ                    no permissions (user in plugdev group); see [http://developer.android.com/tools/device.html] usb:1-1",
      "",
    ].join("\n");
    assert.deepEqual(parseAdbDevicesLong(out), [
      { serial: "RF8N30YRFKY", state: "device", model: "SM_G980F" },
      { serial: "0A1B2C3D", state: "unauthorized" },
      { serial: "emulator-5554", state: "device", model: "sdk_gphone64_arm64" },
      { serial: "XYZ", state: "no permissions (user in plugdev group); see" },
    ]);
  });

  it("tells an emulator serial from hardware", () => {
    assert.equal(isEmulatorSerial("emulator-5554"), true);
    assert.equal(isEmulatorSerial("RF8N30YRFKY"), false);
    assert.equal(isEmulatorSerial("192.168.1.20:5555"), false);
  });

  it("names one blocker and its fix for every state that is not `device`", () => {
    assert.equal(blockerForState("device"), null);
    for (const s of ["unauthorized", "offline", "no permissions (x)", "recovery"]) {
      const b = blockerForState(s);
      assert.ok(b && b.blocker && b.fix, s);
    }
    assert.match(blockerForState("unauthorized")!.fix, /Allow USB debugging/);
  });

  it("reads awake and the keyguard from dumpsys, and null when they are not there", () => {
    assert.equal(parseWakefulness("  mWakefulness=Awake\n"), "awake");
    assert.equal(parseWakefulness("  mWakefulness=Asleep\n"), "asleep");
    assert.equal(parseWakefulness("nothing"), null);
    assert.equal(parseKeyguardShowing("    KeyguardStateMonitor\n        mIsShowing=true\n"), true);
    assert.equal(parseKeyguardShowing("    KeyguardStateMonitor\n        mIsShowing=false\n"), false);
    assert.equal(parseKeyguardShowing("unrelated"), null);
  });

  it("blocks an asleep or locked phone, but not one whose state it could not read", () => {
    assert.equal(usabilityBlocker({ id: "a", state: "device", awake: true, locked: false }), null);
    assert.equal(usabilityBlocker({ id: "a", state: "device", awake: false, locked: false })!.blocker, "asleep");
    assert.equal(usabilityBlocker({ id: "a", state: "device", awake: true, locked: true })!.blocker, "locked");
    assert.equal(usabilityBlocker({ id: "a", state: "device", awake: null, locked: null }), null);
  });

  it("lists hardware only, and a failed `adb devices` is an error, not an empty list", async () => {
    const { exec } = fakeExec((args) => {
      if (args[0] === "devices") return { stdout: buf("List of devices attached\nemulator-5554 device\nRF8 device model:SM_G980F\n") };
      if (args.includes("ro.product.model")) return { stdout: buf("SM-G980F\n") };
      if (args.includes("ro.build.version.release")) return { stdout: buf("13\n") };
      if (args.includes("power")) return { stdout: buf("mWakefulness=Awake") };
      if (args.includes("policy")) return { stdout: buf("KeyguardStateMonitor\n mIsShowing=false") };
      return {};
    });
    const phones = await new AndroidPhones(exec).list();
    assert.deepEqual(phones.map((p) => [p.id, p.model, p.os, p.awake, p.locked]), [["RF8", "SM-G980F", "Android 13", true, false]]);

    const broken = fakeExec(() => ({ code: 1, stderr: "adb: not found" }));
    await assert.rejects(new AndroidPhones(broken.exec).list(), /adb devices exited 1/);
  });

  it("measures the phone's clock offset rather than trusting it", () => {
    // The S20 on the test bench reads March 2025 in November 2026.
    const mac = 1_793_708_882_000;
    assert.equal(clockOffsetMs("1741589329\n", mac - 100, mac + 100), 1_741_589_329_000 - mac);
    assert.equal(clockOffsetMs("garbage", mac, mac), null);
  });
});

describe("the registered app guard", () => {
  const PKG = "no.example.app";

  it("refuses to uninstall, clear, stop, install or open a link in any other package — and runs no adb for it", async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: buf("Success") }));
    const app = new RegisteredApp(exec, "RF8", PKG);
    const other = "com.android.chrome";
    await assert.rejects(app.uninstall(other), AppPolicyError);
    await assert.rejects(app.clearData(other), AppPolicyError);
    await assert.rejects(app.forceStop(other), AppPolicyError);
    await assert.rejects(app.install(other, "/x.apk"), AppPolicyError);
    await assert.rejects(app.openUrl(other, "https://x"), AppPolicyError);
    await assert.rejects(app.installed(other), AppPolicyError);
    await assert.rejects(app.pids(other), AppPolicyError);
    await assert.rejects(app.log(other, 0, 0), AppPolicyError);
    assert.deepEqual(calls, [], "a refused call must not reach adb");
  });

  it("does what it is asked to the registered package", async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: buf("Success") }));
    const app = new RegisteredApp(exec, "RF8", PKG);
    await app.uninstall(PKG);
    await app.clearData(PKG);
    await app.forceStop(PKG);
    await app.install(PKG, "/b/app-debug.apk");
    await app.openUrl(PKG, "exp+x://expo-development-client/?url=a&b=c");
    assert.deepEqual(calls, [
      `-s RF8 uninstall ${PKG}`,
      `-s RF8 shell pm clear ${PKG}`,
      `-s RF8 shell am force-stop ${PKG}`,
      "-s RF8 install -r /b/app-debug.apk",
      `-s RF8 shell am start -a android.intent.action.VIEW -d 'exp+x://expo-development-client/?url=a&b=c' ${PKG}`,
    ]);
  });

  it("refuses to be built for something that is not a package name", () => {
    assert.throws(() => new RegisteredApp(fakeExec().exec, "RF8", "-k; rm -rf /"), AppPolicyError);
  });

  it("classifies the two install conflicts it may resolve, and nothing else", () => {
    const sig = classifyInstallFailure("Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package signatures do not match]");
    assert.ok(sig instanceof InstallConflictError && sig.kind === "signature");
    const down = classifyInstallFailure("Failure [INSTALL_FAILED_VERSION_DOWNGRADE]");
    assert.ok(down instanceof InstallConflictError && down.kind === "downgrade");
    const other = classifyInstallFailure("Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]");
    assert.ok(!(other instanceof InstallConflictError));
  });

  it("throws the conflict out of install so the caller decides", async () => {
    const { exec } = fakeExec(() => ({ code: 1, stdout: buf("Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match]") }));
    await assert.rejects(new RegisteredApp(exec, "RF8", PKG).install(PKG, "/a.apk"), InstallConflictError);
  });
});

describe("app logs", () => {
  const PKG = "no.example.app";
  const text = [
    "  1741589300.100  1000  1010 I ActivityManager: Start proc 4242:no.example.app/u0a300 for activity",
    "  1741589301.200  4242  4250 I ReactNativeJS: hello",
    "  1741589301.300  5555  5555 I OtherApp: not ours",
    "  1741589302.000  4242  4242 E AndroidRuntime: FATAL EXCEPTION: main",
    "  1741589302.001  4242  4242 E AndroidRuntime: Process: no.example.app, PID: 4242",
    "  1741589302.500  1000  1010 I ActivityManager: Process no.example.app (pid 4242) has died",
    "--------- beginning of crash",
  ].join("\n");

  it("keeps the app's lines and the system's lines about it, from a pid that has since died", () => {
    const lines = parseLogcatEpoch(text);
    assert.deepEqual(startedPids(lines, PKG), [4242]);
    const mine = appLogLines(lines, new Set(startedPids(lines, PKG)), PKG);
    assert.deepEqual(
      mine.map((l) => l.message),
      [
        "Start proc 4242:no.example.app/u0a300 for activity",
        "hello",
        "FATAL EXCEPTION: main",
        "Process: no.example.app, PID: 4242",
        "Process no.example.app (pid 4242) has died",
      ],
    );
  });

  it("asks logcat in the phone's clock and stamps lines back into the Mac's", async () => {
    const offset = -52_119_553_000; // phone behind by ~603 days
    const since = 1_741_589_300_000 - offset;
    const { exec, calls } = fakeExec((args) => (args.includes("logcat") ? { stdout: buf(text) } : args.includes("pidof") ? { stdout: buf("") } : {}));
    const out = await new RegisteredApp(exec, "RF8", PKG).log(PKG, since, offset);
    assert.ok(calls[0]!.endsWith(`-T ${((since + offset - 1000) / 1000).toFixed(3)}`), calls[0]);
    assert.equal(out.lines[1], `${new Date(1_741_589_301_200 - offset).toISOString()} 4242 I ReactNativeJS: hello`);
    assert.deepEqual(out.pids, [], "not running is reported as no pids, not hidden");
  });
});

describe("typing", () => {
  it("escapes spaces and quotes for `input text`", () => {
    assert.equal(escapeInputText("a b'c"), "'a%sb'\\''c'");
  });

  it("refuses non-ASCII with an error naming the characters, never a mangled string", () => {
    assert.throws(() => escapeInputText("blåbær"), (e: Error) => e instanceof NonAsciiTextError && /"åæ"/.test(e.message));
  });
});
