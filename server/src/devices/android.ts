import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { androidProcessEnv } from "./toolEnv.ts";

// ---------------------------------------------------------------------------
// Android emulator control (auto-mate-learnings.md §5). Deckhand creates the
// AVD and boots the emulator itself with a fixed console port, so the adb
// serial is deterministic (`emulator-<port>`). Pure parsing/selection is
// fixture-testable; the exec seam is injectable.
//
// NOTE: on-device validation is pending (needs an Android SDK + emulator on the
// mini). The command shapes follow the documented adb/avdmanager/emulator CLIs.
// ---------------------------------------------------------------------------

export interface ExecResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}
export type Exec = (cmd: string, args: string[], opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal }) => Promise<ExecResult>;

export function makeDefaultExec(): Exec {
  const env = safeAndroidEnv();
  return (cmd, args, opts) =>
    new Promise((resolve) => {
      execFile(
        cmd,
        args,
        { encoding: "buffer", timeout: opts?.timeoutMs, env: opts?.env ?? env, signal: opts?.signal, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code = err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0;
          resolve({
            stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
            stderr: stderr.toString(),
            code: typeof code === "number" ? code : 1,
          });
        },
      );
    });
}

function safeAndroidEnv(): NodeJS.ProcessEnv {
  try {
    return androidProcessEnv();
  } catch {
    return process.env;
  }
}

export interface SystemImage {
  /** sdkmanager package path, e.g. `system-images;android-34;google_apis;arm64-v8a`. */
  pkg: string;
  api: number;
}

export class AndroidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AndroidError";
  }
}

// --- pure parsing / selection ----------------------------------------------

/**
 * `adb devices` → serials. Skips the "List of devices attached" banner, blank
 * lines, and any device not in a usable state (`offline`, `unauthorized`) —
 * those still HOLD the console port, so they must count as taken.
 */
export function parseAdbDevices(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("List of devices"))
    .map((l) => l.split(/\s+/)[0]!)
    .filter(Boolean);
}

export function parseAvdList(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*Name:\s*(.+?)\s*$/.exec(line);
    if (m) names.push(m[1]!);
  }
  return names;
}

/**
 * Parse installed `system-images;android-NN;...` packages from
 * `sdkmanager --list_installed`.
 *
 * API levels are not always integers — minor platform releases ship as
 * `android-36.1`, and matching only `\d+` skipped those images entirely. On a
 * machine whose only other image was API 29 that silently pinned every preview
 * to Android 10, whose emulator has no working AVC encoder, forcing the
 * multi-megabyte PNG fallback for video. Parse the level as a decimal.
 */
export function parseSystemImages(text: string): SystemImage[] {
  const out: SystemImage[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const m = /(system-images;android-(\d+(?:\.\d+)*);[^\s|]+)/.exec(line);
    if (m && !seen.has(m[1]!)) {
      seen.add(m[1]!);
      out.push({ pkg: m[1]!, api: Number.parseFloat(m[2]!) });
    }
  }
  return out;
}

/** Select a system image for a requested API level (e.g. "34", "android 34"); default newest installed. */
export function selectSystemImage(images: SystemImage[], requested?: string): SystemImage {
  if (images.length === 0) throw new AndroidError("no Android system images installed");
  if (requested) {
    // Keep the decimal point: stripping non-digits turned "36.1" into 361.
    const want = Number.parseFloat(String(requested).replace(/[^\d.]/g, ""));
    // "36" should accept 36.1 when that is the only 36.x image installed.
    const matches = images.filter((i) => i.api === want || Math.trunc(i.api) === want);
    if (matches.length === 0) {
      throw new AndroidError(`no installed Android system image for API ${want} (have: ${images.map((i) => i.api).join(", ")})`);
    }
    // Prefer arm64 on Apple Silicon.
    return matches.find((i) => /arm64/.test(i.pkg)) ?? matches[0]!;
  }
  return [...images].sort((a, b) => b.api - a.api)[0]!;
}

/** Deterministic adb serial for a fixed emulator console port. */
export function serialForPort(port: number): string {
  return `emulator-${port}`;
}

/** The console port a serial was minted from, or NaN if it isn't an emulator serial. */
export function portForSerial(serial: string): number {
  return Number.parseInt(serial.replace(/^emulator-/, ""), 10);
}

/** True when getprop reports the emulator finished booting. */
export function bootCompleted(getpropOutput: string): boolean {
  return getpropOutput.trim() === "1";
}

/** Compact a uiautomator XML dump into a token-efficient a11y tree for `describe`. */
export function compactUiAutomatorXml(xml: string): string {
  const lines: string[] = [];
  const nodeRe = /<node\b([^>]*)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(xml))) {
    const attrs = m[1]!;
    const get = (k: string) => {
      const a = new RegExp(`${k}="([^"]*)"`).exec(attrs);
      return a ? a[1]! : "";
    };
    const text = get("text");
    const desc = get("content-desc");
    const cls = get("class").split(".").pop() ?? "";
    const bounds = get("bounds");
    const label = text || desc;
    if (label || /Button|EditText|TextView|Image|Switch|CheckBox/.test(cls)) {
      lines.push(`${cls}${label ? ` "${label}"` : ""}${bounds ? ` ${bounds}` : ""}`.trim());
    }
  }
  return lines.join("\n");
}

// --- emulator / adb operations ---------------------------------------------

export class AndroidManager {
  constructor(private readonly exec: Exec = makeDefaultExec()) {}

  private async run(cmd: string, args: string[], opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<ExecResult> {
    return this.exec(cmd, args, opts);
  }
  private async adb(
    serial: string | null,
    args: string[],
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ExecResult> {
    return this.run("adb", serial ? ["-s", serial, ...args] : args, opts);
  }

  async listSystemImages(): Promise<SystemImage[]> {
    const res = await this.run("sdkmanager", ["--list_installed"]);
    return parseSystemImages(res.stdout.toString());
  }

  async listAvds(): Promise<string[]> {
    const res = await this.run("avdmanager", ["list", "avd"]);
    return parseAvdList(res.stdout.toString());
  }

  /**
   * Every device the shared adb server can currently see, by serial.
   *
   * This is the only source of truth for "is console port N already taken".
   * Deckhand's own port set knows nothing about emulators it did not start —
   * the developer's Android Studio AVD, or one of its own that is still exiting
   * — and adb is a host-wide daemon, so a stranger's `emulator-5554` is fully
   * addressable and answers `wait-for-device` instantly.
   */
  async attachedSerials(): Promise<string[]> {
    const res = await this.adb(null, ["devices"]);
    return parseAdbDevices(res.stdout.toString());
  }

  /** Create (or replace) an AVD from a system image. */
  async createAvd(name: string, image: SystemImage, deviceProfile = "pixel_7"): Promise<void> {
    const res = await this.run("avdmanager", [
      "create",
      "avd",
      "--force",
      "--name",
      name,
      "--package",
      image.pkg,
      "--device",
      deviceProfile,
    ]);
    if (res.code !== 0) throw new AndroidError(`avdmanager create failed: ${res.stderr.trim().slice(0, 200)}`);
  }

  /**
   * Boot an emulator on a fixed console port; returns the serial once fully
   * booted. `wipeData` factory-resets a reused (pooled) AVD whose previous
   * tenant is unknown, so no stale app state carries over.
   */
  async bootEmulator(
    avdName: string,
    consolePort: number,
    timeoutMs = 240_000,
    opts: { wipeData?: boolean; signal?: AbortSignal } = {},
  ): Promise<string> {
    const serial = serialForPort(consolePort);
    // Detached: the emulator runs for the life of the preview.
    void this.run("emulator", [
      "-avd",
      avdName,
      "-port",
      String(consolePort),
      "-no-audio",
      "-no-boot-anim",
      "-no-snapshot",
      // Nobody looks at the emulator's own window — deckhand streams the device
      // over adb — but drawing it is not free: an idle pixel_7/API36 emulator
      // measured 227% CPU windowed vs 34% with these two flags. `-gpu host`
      // renders through Metal instead of falling back to a software rasteriser,
      // which is what made a headless emulator expensive in the first place.
      // Both capture paths keep working headless: screenrecord (the H.264
      // primary) and screencap (the MJPEG fallback) read from SurfaceFlinger,
      // not from the host window.
      "-no-window",
      "-gpu",
      "host",
      ...(opts.wipeData ? ["-wipe-data"] : []),
    ]);
    // The waits below take minutes. Without a signal, a preview collected by
    // the idle sweep mid-boot left this loop running: it finished later against
    // a device nothing tracked any more, and (with pooling on) against a slot a
    // newer preview may already have leased.
    await this.adb(serial, ["wait-for-device"], { timeoutMs, signal: opts.signal });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) throw new AndroidError(`emulator ${avdName} boot aborted`);
      const res = await this.adb(serial, ["shell", "getprop", "sys.boot_completed"], { signal: opts.signal });
      if (res.code === 0 && bootCompleted(res.stdout.toString())) return serial;
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new AndroidError(`emulator ${avdName} did not finish booting within ${Math.round(timeoutMs / 1000)}s`);
  }

  async installApk(serial: string, apkPath: string): Promise<void> {
    const res = await this.adb(serial, ["install", "-r", "-g", apkPath], { timeoutMs: 180_000 });
    if (res.code !== 0) throw new AndroidError(`adb install failed: ${res.stderr.trim().slice(0, 200)}`);
  }

  /** Verify a package is installed (returns its apk path, or null). */
  async packagePath(serial: string, pkg: string): Promise<string | null> {
    const res = await this.adb(serial, ["shell", "pm", "path", pkg]);
    if (res.code !== 0) return null;
    const out = res.stdout.toString().trim();
    return out.startsWith("package:") ? out.slice("package:".length) : null;
  }

  /**
   * Point the device's `localhost:devicePort` at `hostPort` on this machine.
   * A React Native / Expo debug build reaches its bundler at localhost:8081 —
   * so whatever holds host 8081 serves the app. `expo start` in ANY unrelated
   * project installs `tcp:8081 → tcp:8081` on every attached device, which
   * silently feeds a preview the wrong project's bundle inside the right native
   * shell. Deckhand owns the mapping for its own devices instead.
   */
  async reversePort(serial: string, devicePort: number, hostPort: number): Promise<void> {
    const res = await this.adb(serial, ["reverse", `tcp:${devicePort}`, `tcp:${hostPort}`]);
    if (res.code !== 0) throw new AndroidError(`adb reverse failed: ${res.stderr.trim().slice(0, 200)}`);
  }

  /** Stop the app if it is running. Best-effort: a package that isn't up is not an error. */
  async forceStop(serial: string, pkg: string): Promise<void> {
    await this.adb(serial, ["shell", "am", "force-stop", pkg]).catch(() => {});
  }

  /**
   * Launch via a VIEW intent — the Android counterpart of `simctl openurl`.
   * An Expo dev client started with a plain `am start` reconnects to whatever
   * server it opened LAST, which after a session on another project is that
   * project's Metro: the right app icon, someone else's JS. The deep link names
   * the server explicitly, so the preview always loads its own bundle.
   */
  async openUrl(serial: string, url: string): Promise<void> {
    const res = await this.adb(serial, ["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url]);
    if (res.code !== 0 || /^error/im.test(`${res.stdout.toString()}\n${res.stderr}`)) {
      throw new AndroidError(`am start VIEW failed: ${(res.stderr || res.stdout.toString()).trim().slice(0, 200)}`);
    }
  }

  async launch(serial: string, pkg: string): Promise<void> {
    // Resolve the launchable activity and `am start` it — reliable and idempotent.
    // We deliberately avoid `monkey` as the primary path: on emulators with no
    // physical keys it prints "SYS_KEYS has no physical keys" and exits non-zero
    // even when it *did* launch the app, so its exit code can't be trusted.
    const resolved = await this.adb(serial, ["shell", "cmd", "package", "resolve-activity", "--brief", pkg]);
    const activity = resolved.stdout
      .toString()
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith(`${pkg}/`));
    if (activity) {
      const res = await this.adb(serial, ["shell", "am", "start", "-n", activity]);
      // `am start` returns 0 and may warn "Activity not started, … brought to the
      // front" when it's already running — that's success; only "Error" is a fail.
      if (res.code === 0 && !/^error/im.test(`${res.stdout.toString()}\n${res.stderr}`)) return;
    }
    // Fallback: monkey (best-effort), then confirm the app is actually in the
    // activity stack rather than trusting monkey's unreliable exit code.
    await this.adb(serial, ["shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"]).catch(() => {});
    const check = await this.adb(serial, ["shell", "dumpsys", "activity", "activities"]);
    if (!check.stdout.toString().includes(pkg)) {
      throw new AndroidError(`could not launch ${pkg} on ${serial}`);
    }
  }

  async screenshotPng(serial: string): Promise<Buffer> {
    const res = await this.adb(serial, ["exec-out", "screencap", "-p"]);
    if (res.code !== 0 || res.stdout.length === 0) throw new AndroidError(`screencap failed: ${res.stderr.trim().slice(0, 200)}`);
    return res.stdout;
  }

  /**
   * The accessibility tree, or an actionable error — never an empty string.
   *
   * Both adb exit codes used to be discarded, so a failed dump and a genuinely empty screen
   * produced the same value: `""`. That reaches an agent through the `describe` tool as "this
   * screen has nothing on it", which is a confident wrong answer rather than a failure, and it
   * is the shape of bug this repo has now paid for four times.
   *
   * And it fails routinely: `uiautomator dump` refuses while the window is still animating
   * ("could not get idle state"), which is the normal condition for the first seconds after a
   * boot, an app launch, or any navigation. So poll — same reasoning as the screencap deadline
   * next door, where one attempt with a short timeout declared healthy devices dead.
   *
   * Found by the Android leg of `doctor --device-only` on its first run against real hardware.
   */
  async describe(serial: string, timeoutMs = 15_000): Promise<string> {
    // Dump to a temp file on device, then read it back (`/dev/tty` truncates).
    const path = "/sdcard/deckhand-ui.xml";
    const deadline = Date.now() + timeoutMs;
    let last = "no attempt completed";
    for (let attempt = 1; ; attempt++) {
      const dump = await this.adb(serial, ["shell", "uiautomator", "dump", path]);
      // uiautomator reports its failures on stdout as often as stderr, and exits 0 while doing
      // it — so the text is load-bearing, not just the code.
      const said = `${dump.stdout.toString()}${dump.stderr}`.trim();
      if (dump.code === 0 && !/error|could not get idle/i.test(said)) {
        const res = await this.adb(serial, ["shell", "cat", path]);
        const tree = res.code === 0 ? compactUiAutomatorXml(res.stdout.toString()) : "";
        if (tree) return tree;
        last = res.code === 0 ? "dump succeeded but the file read back empty" : `cat exited ${res.code}`;
      } else {
        last = said.slice(0, 160) || `uiautomator dump exited ${dump.code}`;
      }
      if (Date.now() >= deadline) {
        throw new AndroidError(`no accessibility tree from ${serial} after ${attempt} attempt(s): ${last}`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  /** Locate the built debug APK in a worktree (for install-many), or null. */
  async findApk(worktreePath: string): Promise<string | null> {
    // RN/Expo build to <worktree>/android/…; NativeScript to <worktree>/platforms/android/….
    const rel = join("app", "build", "outputs", "apk", "debug");
    for (const base of [join("platforms", "android", rel), join("android", rel)]) {
      const dir = join(worktreePath, base);
      try {
        const apk = readdirSync(dir).find((f) => f.endsWith(".apk"));
        if (apk) return join(dir, apk);
      } catch {
        // try the next layout
      }
    }
    return null;
  }

  /**
   * Kill an emulator and wait for it to actually be gone. `emu kill` returns
   * immediately while QEMU takes seconds to exit, still holding its console port
   * and the AVD's lock file — reusing either before then fails the next boot
   * ("AVD is already running") or lands two emulators on one serial.
   */
  async shutdown(serial: string, timeoutMs = 20_000): Promise<void> {
    await this.adb(serial, ["emu", "kill"]).catch(() => {});
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await this.adb(serial, ["get-state"]).catch(() => ({ code: 1 }) as ExecResult);
      if (res.code !== 0) return; // adb no longer knows the serial: the emulator is gone
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async deleteAvd(name: string): Promise<void> {
    await this.run("avdmanager", ["delete", "avd", "--name", name]).catch(() => {});
  }
}
