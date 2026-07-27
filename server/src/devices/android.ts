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
export type Exec = (cmd: string, args: string[], opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<ExecResult>;

function makeDefaultExec(): Exec {
  const env = safeAndroidEnv();
  return (cmd, args, opts) =>
    new Promise((resolve) => {
      execFile(
        cmd,
        args,
        { encoding: "buffer", timeout: opts?.timeoutMs, env: opts?.env ?? env, maxBuffer: 64 * 1024 * 1024 },
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

/** Parse `avdmanager list avd` output → AVD names. */
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

  private async run(cmd: string, args: string[], opts?: { timeoutMs?: number }): Promise<ExecResult> {
    return this.exec(cmd, args, opts);
  }
  private async adb(serial: string | null, args: string[], opts?: { timeoutMs?: number }): Promise<ExecResult> {
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
    opts: { wipeData?: boolean } = {},
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
      ...(opts.wipeData ? ["-wipe-data"] : []),
    ]);
    await this.adb(serial, ["wait-for-device"], { timeoutMs });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await this.adb(serial, ["shell", "getprop", "sys.boot_completed"]);
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

  async describe(serial: string): Promise<string> {
    // Dump to a temp file on device, then read it back (`/dev/tty` truncates).
    const path = "/sdcard/deckhand-ui.xml";
    await this.adb(serial, ["shell", "uiautomator", "dump", path]);
    const res = await this.adb(serial, ["shell", "cat", path]);
    return compactUiAutomatorXml(res.stdout.toString());
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
