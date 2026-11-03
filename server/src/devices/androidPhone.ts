import { AndroidError, makeDefaultExec, type Exec, type ExecResult } from "./android.ts";

// ---------------------------------------------------------------------------
// Android phones plugged in by cable: borrowed hardware, never created. Deckhand
// lists them, waits for one to be usable, drives the ONE app a preview registered
// and nothing else on the phone, and reads that app's logcat. It never boots,
// wipes, kills or changes a setting on one (docs/physical-devices-plan.md).
// ---------------------------------------------------------------------------

/** Android's package grammar — dot-separated segments, each starting with a letter. */
export const ANDROID_PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/** True for an emulator's adb serial. Everything else adb lists is hardware. */
export function isEmulatorSerial(serial: string): boolean {
  return /^emulator-\d+$/.test(serial);
}

export interface AdbDeviceLine {
  serial: string;
  state: string;
  model?: string;
}

/** `adb devices -l` → serial, state and the `model:` field. */
export function parseAdbDevicesLong(stdout: string): AdbDeviceLine[] {
  const out: AdbDeviceLine[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("List of devices") || line.startsWith("*")) continue;
    const [serial, ...rest] = line.split(/\s+/);
    if (!serial) continue;
    // "no permissions (…)" is a two-word state; everything with a colon is a field.
    const fieldsAt = rest.findIndex((t) => t.includes(":"));
    const state = (fieldsAt < 0 ? rest : rest.slice(0, fieldsAt)).join(" ") || "unknown";
    const model = rest.find((t) => t.startsWith("model:"))?.slice("model:".length);
    out.push({ serial, state, ...(model ? { model } : {}) });
  }
  return out;
}

/** Why a phone cannot be targeted now, and the one action that makes it targetable. */
export interface PhoneBlocker {
  blocker: string;
  fix: string;
}

/** The blocker an adb state names, or null for a usable `device`. */
export function blockerForState(state: string): PhoneBlocker | null {
  if (state === "device") return null;
  if (state === "unauthorized") {
    return { blocker: "not authorized for USB debugging", fix: "unlock the phone and accept the \"Allow USB debugging\" prompt for this Mac" };
  }
  if (state === "offline") return { blocker: "offline", fix: "unplug the cable and plug it back in" };
  if (state.startsWith("no permissions")) return { blocker: "adb has no permission to the USB device", fix: "unplug and replug the phone, then run `adb kill-server` on the Mac" };
  return { blocker: `adb reports it as "${state}"`, fix: "boot the phone normally (not recovery or bootloader) and replug it" };
}

/** `dumpsys power` → awake, asleep, or null when the field is missing. */
export function parseWakefulness(out: string): "awake" | "asleep" | null {
  const m = /mWakefulness=(\w+)/.exec(out);
  if (!m) return null;
  return m[1] === "Awake" ? "awake" : "asleep";
}

/** `dumpsys window policy` → whether the keyguard is showing, or null when it does not say. */
export function parseKeyguardShowing(out: string): boolean | null {
  const m = /KeyguardStateMonitor[\s\S]*?mIsShowing=(true|false)/.exec(out) ?? /isKeyguardShowing=(true|false)/.exec(out);
  return m ? m[1] === "true" : null;
}

export interface PhoneInfo {
  id: string;
  state: string;
  model?: string;
  manufacturer?: string;
  os?: string;
  awake?: boolean | null;
  locked?: boolean | null;
}

/** The blocker for a phone adb can talk to, or null when it is targetable. */
export function usabilityBlocker(p: PhoneInfo): PhoneBlocker | null {
  const s = blockerForState(p.state);
  if (s) return s;
  if (p.awake === false) {
    return { blocker: "asleep", fix: "wake the phone (press its power button) and turn on Developer options → Stay awake while charging" };
  }
  if (p.locked === true) return { blocker: "locked", fix: "unlock the phone (deckhand cannot type a passcode)" };
  return null;
}

// --- install, uninstall, app data -------------------------------------------

export class InstallConflictError extends AndroidError {
  constructor(
    message: string,
    readonly kind: "signature" | "downgrade",
  ) {
    super(message);
    this.name = "InstallConflictError";
  }
}

/** An `adb install` failure, classified: the two conflicts are resolvable for the registered app only. */
export function classifyInstallFailure(output: string): AndroidError {
  const said = output.trim().split("\n").filter(Boolean).pop() ?? "adb install failed";
  if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match|INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES/i.test(output)) {
    return new InstallConflictError(`signature mismatch: the installed copy is signed with a different key (${said})`, "signature");
  }
  if (/INSTALL_FAILED_VERSION_DOWNGRADE/i.test(output)) {
    return new InstallConflictError(`version downgrade: the phone has a newer versionCode of this app (${said})`, "downgrade");
  }
  return new AndroidError(`adb install failed: ${said}`);
}

export interface InstalledPackage {
  versionName: string | null;
  versionCode: string | null;
  installer: string | null;
  firstInstallTime: string | null;
}

/** The fields of `dumpsys package <pkg>` recorded before an install is replaced. */
export function parseDumpsysPackage(out: string): InstalledPackage {
  const f = (re: RegExp) => re.exec(out)?.[1]?.trim() ?? null;
  return {
    versionName: f(/versionName=(\S+)/),
    versionCode: f(/versionCode=(\d+)/),
    installer: f(/installerPackageName=(\S+)/),
    firstInstallTime: f(/firstInstallTime=([^\n]+)/),
  };
}

// --- logs --------------------------------------------------------------------

export interface LogLine {
  /** Epoch ms in the PHONE's clock. */
  at: number;
  pid: number;
  level: string;
  tag: string;
  message: string;
}

/** `adb logcat -v epoch` line: `  1792763415.835  1354  1428 D Tag     : message`. */
const LOGCAT_EPOCH = /^\s*(\d+)\.(\d{3})\d*\s+(\d+)\s+\d+\s+([VDIWEF])\s+(.*?)\s*:\s?(.*)$/;

export function parseLogcatEpoch(text: string): LogLine[] {
  const out: LogLine[] = [];
  for (const line of text.split("\n")) {
    const m = LOGCAT_EPOCH.exec(line.replace(/\r$/, ""));
    if (!m) continue;
    out.push({ at: Number(m[1]) * 1000 + Number(m[2]), pid: Number(m[3]), level: m[4]!, tag: m[5]!, message: m[6]! });
  }
  return out;
}

const CRASH_TAGS = new Set(["AndroidRuntime", "ActivityManager", "DEBUG", "libc"]);

/** Pids the system logged starting for `pkg` (`Start proc 1234:pkg/u0a…`), so a crashed process's lines still count. */
export function startedPids(lines: LogLine[], pkg: string): number[] {
  const re = new RegExp(`Start proc (\\d+):${pkg.replace(/\./g, "\\.")}(?:[/:]|$)`);
  return lines.flatMap((l) => {
    const m = l.tag === "ActivityManager" ? re.exec(l.message) : null;
    return m ? [Number(m[1])] : [];
  });
}

/** The app's own lines, plus the system's lines that report its crashes. */
export function appLogLines(lines: LogLine[], pids: ReadonlySet<number>, pkg: string): LogLine[] {
  return lines.filter(
    (l) => pids.has(l.pid) || (CRASH_TAGS.has(l.tag) && l.message.includes(pkg)) || (l.tag === "AndroidRuntime" && /FATAL EXCEPTION|^Process: /.test(l.message)),
  );
}

/**
 * Phone clock minus Mac clock. Some phones run with a wrong clock and `logcat -T` filters on the
 * phone's, so deckhand measures the difference rather than ever setting it.
 */
export function clockOffsetMs(phoneEpochSeconds: string, before: number, after: number): number | null {
  const s = Number(phoneEpochSeconds.trim());
  if (!Number.isFinite(s) || s <= 0) return null;
  return s * 1000 - Math.round((before + after) / 2);
}

// --- input -------------------------------------------------------------------

export class NonAsciiTextError extends AndroidError {
  constructor(text: string) {
    const bad = [...new Set([...text].filter((c) => /[^\x20-\x7e]/.test(c)))].join("");
    super(
      `adb \`input text\` types ASCII only, and this text contains ${JSON.stringify(bad)} — deckhand will not type a mangled string. ` +
        "Type the ASCII part and enter the rest by hand in the viewer, or use a value without those characters.",
    );
    this.name = "NonAsciiTextError";
  }
}

/** A device-shell argument for `input text`: ASCII only, `%s` for a space, single-quoted. */
export function escapeInputText(text: string): string {
  if (/[^\x20-\x7e]/.test(text)) throw new NonAsciiTextError(text);
  if (text.includes("%s")) throw new AndroidError('adb `input text` types "%s" as a space, so this text cannot be typed exactly — type it in two parts around the "%s"');
  return `'${text.replace(/'/g, `'\\''`).replace(/ /g, "%s")}'`;
}

// --- the registered app -------------------------------------------------------

export class AppPolicyError extends AndroidError {
  constructor(message: string) {
    super(message);
    this.name = "AppPolicyError";
  }
}

/**
 * Everything deckhand may do to an app on a phone, bound to the ONE package the preview
 * registered. Every method names its package and the guard refuses any other, so no code path
 * can route someone else's app through here — the phone is borrowed, and the apps on it are
 * not deckhand's. Settings are not on this list at all.
 */
export class RegisteredApp {
  constructor(
    private readonly exec: Exec,
    readonly serial: string,
    readonly pkg: string,
  ) {
    if (!ANDROID_PACKAGE_RE.test(pkg)) throw new AppPolicyError(`"${pkg}" is not an Android package name`);
  }

  private guard(pkg: string, what: string): void {
    if (pkg !== this.pkg) {
      throw new AppPolicyError(`refusing to ${what} ${pkg} on ${this.serial}: deckhand only touches the preview's registered app, ${this.pkg}`);
    }
  }

  private adb(args: string[], timeoutMs = 30_000): Promise<ExecResult> {
    return this.exec("adb", ["-s", this.serial, ...args], { timeoutMs });
  }

  /** What is installed under the package, or null when nothing is. */
  async installed(pkg: string): Promise<InstalledPackage | null> {
    this.guard(pkg, "inspect");
    const path = await this.adb(["shell", "pm", "path", pkg]);
    if (path.code !== 0 || !path.stdout.toString().includes("package:")) return null;
    const res = await this.adb(["shell", "dumpsys", "package", pkg]);
    return parseDumpsysPackage(res.stdout.toString());
  }

  /** `adb install -r`, which keeps the app's data. A conflict throws InstallConflictError. */
  async install(pkg: string, apkPath: string): Promise<void> {
    this.guard(pkg, "install");
    if (!apkPath.endsWith(".apk")) throw new AndroidError(`can only install an .apk, got ${apkPath}`);
    const res = await this.adb(["install", "-r", apkPath], 300_000);
    const out = `${res.stdout.toString()}\n${res.stderr}`;
    if (res.code !== 0 || !/\bSuccess\b/.test(out)) throw classifyInstallFailure(out);
  }

  async uninstall(pkg: string): Promise<void> {
    this.guard(pkg, "uninstall");
    const res = await this.adb(["uninstall", pkg], 120_000);
    if (res.code !== 0 || !/\bSuccess\b/.test(res.stdout.toString())) {
      throw new AndroidError(`adb uninstall ${pkg} failed: ${`${res.stdout.toString()} ${res.stderr}`.trim().slice(0, 200)}`);
    }
  }

  /** `pm clear`: the app's data and its signed-in session go; the install stays. */
  async clearData(pkg: string): Promise<void> {
    this.guard(pkg, "clear the data of");
    const res = await this.adb(["shell", "pm", "clear", pkg]);
    if (res.code !== 0 || !/\bSuccess\b/.test(res.stdout.toString())) {
      throw new AndroidError(`pm clear ${pkg} failed: ${`${res.stdout.toString()} ${res.stderr}`.trim().slice(0, 200)}`);
    }
  }

  async forceStop(pkg: string): Promise<void> {
    this.guard(pkg, "stop");
    await this.adb(["shell", "am", "force-stop", pkg]);
  }

  /** A cold start of the app's launcher activity, with `-e K V` string extras. */
  async launch(pkg: string, extras: string[] = []): Promise<void> {
    this.guard(pkg, "launch");
    const resolved = await this.adb(["shell", "cmd", "package", "resolve-activity", "--brief", pkg]);
    const activity = resolved.stdout
      .toString()
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith(`${pkg}/`));
    if (!activity) throw new AndroidError(`${pkg} has no launcher activity on ${this.serial}`);
    const res = await this.adb(["shell", "am", "start", "-S", "-W", "-n", shellQuote(activity), ...extras.map(shellQuote)], 60_000);
    const said = `${res.stdout.toString()}\n${res.stderr}`;
    if (res.code !== 0 || /^error/im.test(said)) throw new AndroidError(`am start ${activity} failed: ${said.trim().slice(0, 200)}`);
  }

  /** sha256 of the installed base APK, or null when it is not installed or the phone cannot hash. */
  async installedApkSha256(pkg: string): Promise<string | null> {
    this.guard(pkg, "inspect");
    const path = await this.adb(["shell", "pm", "path", pkg]);
    const base = path.stdout
      .toString()
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("package:") && l.endsWith("/base.apk"))
      ?.slice("package:".length);
    if (path.code !== 0 || !base) return null;
    const res = await this.adb(["shell", "sha256sum", shellQuote(base)], 120_000);
    const hash = /^([0-9a-f]{64})\b/.exec(res.stdout.toString().trim())?.[1];
    return res.code === 0 && hash ? hash : null;
  }

  /** Pids of the app's processes now; empty when it is not running. */
  async pids(pkg: string): Promise<number[]> {
    this.guard(pkg, "look up");
    const res = await this.adb(["shell", "pidof", pkg]);
    return res.stdout
      .toString()
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
  }

  /** A VIEW intent addressed to this app only, so no other app on the phone can answer it. `extras` are `-e K V` pairs. */
  async openUrl(pkg: string, url: string, extras: string[] = []): Promise<void> {
    this.guard(pkg, "open a link in");
    const res = await this.adb(["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", shellQuote(url), ...extras.map(shellQuote), pkg]);
    const said = `${res.stdout.toString()}\n${res.stderr}`;
    if (res.code !== 0 || /^error/im.test(said)) throw new AndroidError(`am start VIEW failed: ${said.trim().slice(0, 200)}`);
  }

  /**
   * The app's logcat since `sinceMs` (Mac clock), its lines re-stamped into the Mac's clock, and
   * whether it is running now — a fact, not a verdict.
   */
  async log(pkg: string, sinceMs: number, offsetMs: number): Promise<{ lines: string[]; pids: number[] }> {
    this.guard(pkg, "read the log of");
    const from = ((sinceMs + offsetMs - 1000) / 1000).toFixed(3);
    const res = await this.adb(["logcat", "-d", "-v", "epoch", "-T", from], 30_000);
    if (res.code !== 0) throw new AndroidError(`logcat exited ${res.code}: ${res.stderr.trim().slice(0, 200)}`);
    const all = parseLogcatEpoch(res.stdout.toString());
    const now = await this.pids(pkg);
    const mine = appLogLines(all, new Set([...now, ...startedPids(all, pkg)]), pkg);
    const lines = mine.map((l) => `${new Date(l.at - offsetMs).toISOString()} ${l.pid} ${l.level} ${l.tag}: ${l.message}`);
    return { lines, pids: now };
  }
}

/** Single-quote one argument for the phone's shell, which re-splits what adb hands it. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// --- the phones themselves ------------------------------------------------------

export class AndroidPhones {
  constructor(private readonly exec: Exec = makeDefaultExec()) {}

  private adb(serial: string, args: string[], timeoutMs = 10_000): Promise<ExecResult> {
    return this.exec("adb", ["-s", serial, ...args], { timeoutMs });
  }

  /** Every phone adb lists (emulators excluded), probed. Throws when adb itself does not answer. */
  async list(): Promise<PhoneInfo[]> {
    const res = await this.exec("adb", ["devices", "-l"], { timeoutMs: 10_000 });
    if (res.code !== 0) throw new AndroidError(`adb devices exited ${res.code}: ${res.stderr.trim().slice(0, 200)}`);
    const phones = parseAdbDevicesLong(res.stdout.toString()).filter((d) => !isEmulatorSerial(d.serial));
    return Promise.all(phones.map((d) => this.probe(d.serial, d.state, d.model)));
  }

  /** One phone's state, model and whether it is awake and unlocked. Read-only. */
  async probe(serial: string, state?: string, model?: string): Promise<PhoneInfo> {
    const st = state ?? (await this.adbState(serial));
    if (st !== "device") return { id: serial, state: st, ...(model ? { model: model.replace(/_/g, "-") } : {}) };
    const sh = async (...a: string[]) => {
      const r = await this.adb(serial, ["shell", ...a]).catch(() => null);
      return r && r.code === 0 ? r.stdout.toString().trim() : "";
    };
    const [m, manufacturer, os, power, policy] = await Promise.all([
      sh("getprop", "ro.product.model"),
      sh("getprop", "ro.product.manufacturer"),
      sh("getprop", "ro.build.version.release"),
      sh("dumpsys", "power"),
      sh("dumpsys", "window", "policy"),
    ]);
    const awake = parseWakefulness(power);
    return {
      id: serial,
      state: st,
      ...(m ? { model: m } : model ? { model } : {}),
      ...(manufacturer ? { manufacturer } : {}),
      ...(os ? { os: `Android ${os}` } : {}),
      awake: awake === null ? null : awake === "awake",
      locked: parseKeyguardShowing(policy),
    };
  }

  /** adb's state for one serial, or "missing" when it is not listed at all. */
  async adbState(serial: string): Promise<string> {
    const res = await this.exec("adb", ["devices", "-l"], { timeoutMs: 10_000 });
    if (res.code !== 0) throw new AndroidError(`adb devices exited ${res.code}: ${res.stderr.trim().slice(0, 200)}`);
    return parseAdbDevicesLong(res.stdout.toString()).find((d) => d.serial === serial)?.state ?? "missing";
  }

  /**
   * Wait for the phone to be awake and unlocked. A wake key is input, not a setting, so it is
   * sent once; the passcode is the person's, so a locked phone is waited for and then reported.
   */
  async waitUsable(serial: string, timeoutMs: number, signal?: AbortSignal, onWait?: (b: PhoneBlocker) => void): Promise<PhoneInfo> {
    const deadline = Date.now() + timeoutMs;
    let woke = false;
    for (;;) {
      if (signal?.aborted) throw new AndroidError(`waiting for ${serial} was aborted`);
      const info = await this.probe(serial);
      const blocked = usabilityBlocker(info);
      if (!blocked) return info;
      if (info.state === "missing") throw new AndroidError(`phone ${serial} is not connected: adb does not list it`);
      if (blocked.blocker === "asleep" && !woke) {
        woke = true;
        await this.adb(serial, ["shell", "input", "keyevent", "KEYCODE_WAKEUP"]).catch(() => {});
      }
      onWait?.(blocked);
      if (Date.now() >= deadline) throw new AndroidError(`phone ${serial} is ${blocked.blocker} — ${blocked.fix}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  /** Phone clock minus Mac clock, measured; null when the phone would not say. */
  async clockOffsetMs(serial: string): Promise<number | null> {
    const before = Date.now();
    const res = await this.adb(serial, ["shell", "date", "+%s"]).catch(() => null);
    if (!res || res.code !== 0) return null;
    return clockOffsetMs(res.stdout.toString(), before, Date.now());
  }

  /** The guarded handle on the preview's registered app on this phone. */
  registeredApp(serial: string, pkg: string): RegisteredApp {
    return new RegisteredApp(this.exec, serial, pkg);
  }

  /** Drop one of deckhand's own `adb reverse` rules; a rule that is already gone is not an error. */
  async removeReverse(serial: string, devicePort: number): Promise<void> {
    await this.adb(serial, ["reverse", "--remove", `tcp:${devicePort}`]).catch(() => {});
  }
}
