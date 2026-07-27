import { join } from "node:path";
import type { AppType } from "../config.ts";
import type { Platform } from "../state.ts";
import type { WebFramework } from "./detect.ts";

// ---------------------------------------------------------------------------
// Build recipes (auto-mate-learnings.md §3). Pure command builders — no
// spawning here — so the exact command sequence per (app type, platform) is
// unit-testable. The engine runs the steps in order and applies per-stage
// watchdogs. Pitfalls encoded: never `--clear` on Metro, bare-RN Release +
// --no-packager, guarded pods, SPM pre-resolve for NativeScript.
// ---------------------------------------------------------------------------

/** ~6 min general idle timeout; ~3 min for stages known to stall silently (SPM). */
export const GENERAL_IDLE_MS = 6 * 60_000;
export const SPM_IDLE_MS = 3 * 60_000;
export const METRO_PORT = 8081;

export type StepRun =
  | { kind: "argv"; command: string; args: string[] }
  | { kind: "shell"; script: string };

export interface CommandStep {
  name: string;
  run: StepRun;
  cwd: string;
  env?: Record<string, string>;
  idleTimeoutMs: number;
  /** Failure logs but does not fail the preview (e.g. best-effort pre-resolve). */
  optional?: boolean;
}

export interface BuildPlanInput {
  type: AppType;
  platform: Platform;
  /** iOS simulator UDID or Android adb serial (unused for web). */
  udid: string;
  worktreePath: string;
  appEnv: Record<string, string>;
  /**
   * Local dev mode: the dir is the developer's own working copy, not a
   * disposable worktree. Never wipe node_modules (`npm ci` deletes it) — only
   * install when it's missing. NativeScript builds run as a long-lived
   * livesync process (see `nativescriptDevRun`) instead of plan steps.
   */
  local?: boolean;
}

/**
 * A project's lockfile decides its package manager, and bun has to be checked
 * first: a bun project's private-registry scopes live in `bunfig.toml`, which
 * npm cannot read. Running npm there resolves those scopes against the public
 * registry and 404s, which reads as a missing package rather than the wrong
 * tool. Deckhand does not install package managers — a bun.lock with no `bun`
 * on PATH is reported as exactly that.
 */
const BUN_GUARD = "[ -f bun.lock ] || [ -f bun.lockb ]";
const BUN_MISSING = 'echo "bun.lock found but bun is not installed — install it (brew install oven-sh/bun/bun)" >&2; exit 127';
const bunOr = (bunArgs: string, fallback: string): string =>
  `if ${BUN_GUARD}; then command -v bun >/dev/null || { ${BUN_MISSING}; }; bun install ${bunArgs}; else ${fallback}; fi`;

/** The dependency-install step, guarded to use `npm ci` only when a lockfile exists. */
export function installDepsStep(worktreePath: string, env: Record<string, string>): CommandStep {
  return {
    name: "install-deps",
    run: { kind: "shell", script: bunOr("--frozen-lockfile", "[ -f package-lock.json ] && npm ci || npm install") },
    cwd: worktreePath,
    env,
    idleTimeoutMs: GENERAL_IDLE_MS,
  };
}

/**
 * Local-mode dependency install: leave an existing node_modules alone (it's the
 * dev's). Borrow-never-own extends to git: when a lockfile exists we use the
 * read-only `npm ci` (never rewrites package-lock.json); with no lockfile we add
 * `--no-package-lock` so we don't drop a stray, untracked lockfile into the
 * developer's checkout. bun gets `--frozen-lockfile` for the same reason — it
 * resolves from bun.lock without ever writing it back. node_modules itself is
 * gitignored, so this leaves the tracked tree untouched.
 */
export function installDepsIfMissingStep(worktreePath: string, env: Record<string, string>): CommandStep {
  return {
    name: "install-deps",
    run: {
      kind: "shell",
      script: `[ -d node_modules ] || { ${bunOr("--frozen-lockfile", "[ -f package-lock.json ] && npm ci || npm install --no-package-lock")}; }`,
    },
    cwd: worktreePath,
    env,
    idleTimeoutMs: GENERAL_IDLE_MS,
  };
}

function depsStep(i: BuildPlanInput): CommandStep {
  return i.local ? installDepsIfMissingStep(i.worktreePath, i.appEnv) : installDepsStep(i.worktreePath, i.appEnv);
}

function expoIosPlan(i: BuildPlanInput): CommandStep[] {
  return [
    depsStep(i),
    {
      name: "build",
      // --no-bundler: Deckhand runs Metro itself (metro.ts) and launches via
      // deep link; letting `run:ios` also start a bundler races port 8081.
      run: { kind: "argv", command: "npx", args: ["expo", "run:ios", "--device", i.udid, "--no-bundler"] },
      cwd: i.worktreePath,
      env: i.appEnv,
      idleTimeoutMs: GENERAL_IDLE_MS,
    },
  ];
}

function reactNativeIosPlan(i: BuildPlanInput): CommandStep[] {
  return [
    depsStep(i),
    {
      name: "pods",
      // Only run pod install when the lockfile and installed manifest differ —
      // keeps warm worktrees fast. Matches the learnings verbatim.
      run: {
        kind: "shell",
        script:
          "if [ -f ios/Podfile ] && ! cmp -s ios/Podfile.lock ios/Pods/Manifest.lock; then (cd ios && (bundle exec pod install || pod install)); fi",
      },
      cwd: i.worktreePath,
      env: i.appEnv,
      idleTimeoutMs: GENERAL_IDLE_MS,
    },
    {
      name: "build",
      // Release (embeds the JS bundle → no Metro dependency; Debug hangs on the
      // connect-to-Metro screen headless). --no-packager avoids the interactive
      // "port 8081 busy, use 8082?" prompt that hangs headless installs.
      run: {
        kind: "argv",
        command: "npx",
        args: ["react-native", "run-ios", "--udid", i.udid, "--mode", "Release", "--no-packager"],
      },
      cwd: i.worktreePath,
      env: i.appEnv,
      idleTimeoutMs: GENERAL_IDLE_MS,
    },
  ];
}

function nativescriptIosPlan(i: BuildPlanInput): CommandStep[] {
  return [
    depsStep(i),
    {
      name: "ns-prepare",
      run: { kind: "argv", command: "ns", args: ["prepare", "ios"] },
      cwd: i.worktreePath,
      env: i.appEnv,
      idleTimeoutMs: GENERAL_IDLE_MS,
      optional: true,
    },
    {
      name: "spm-resolve",
      // Pre-resolve Swift packages out-of-band; SPM "Resolve Package Graph"
      // stalls silently, hence the shorter watchdog.
      run: {
        kind: "argv",
        command: "xcodebuild",
        args: [
          "-resolvePackageDependencies",
          "-disablePackageRepositoryCache",
          "-skipPackagePluginValidation",
        ],
      },
      cwd: join(i.worktreePath, "platforms", "ios"),
      env: i.appEnv,
      idleTimeoutMs: SPM_IDLE_MS,
      optional: true,
    },
    {
      name: "build",
      run: {
        kind: "argv",
        command: "ns",
        args: ["run", "ios", "--no-hmr", "--no-watch", "--justlaunch", "--device", i.udid],
      },
      cwd: i.worktreePath,
      env: i.appEnv,
      idleTimeoutMs: GENERAL_IDLE_MS,
    },
  ];
}

function androidPlan(i: BuildPlanInput): CommandStep[] {
  // `i.udid` carries the adb serial for Android.
  const serial = i.udid;
  const build = (): CommandStep => {
    if (i.type === "expo") {
      return {
        name: "build",
        run: { kind: "argv", command: "npx", args: ["expo", "run:android", "--device", serial, "--no-bundler"] },
        cwd: i.worktreePath,
        env: i.appEnv,
        idleTimeoutMs: GENERAL_IDLE_MS,
      };
    }
    if (i.type === "react-native") {
      return {
        name: "build",
        run: { kind: "argv", command: "npx", args: ["react-native", "run-android", "--deviceId", serial] },
        cwd: i.worktreePath,
        env: i.appEnv,
        idleTimeoutMs: GENERAL_IDLE_MS,
      };
    }
    return {
      name: "build",
      run: { kind: "argv", command: "ns", args: ["run", "android", "--no-hmr", "--no-watch", "--justlaunch", "--device", serial] },
      cwd: i.worktreePath,
      env: i.appEnv,
      idleTimeoutMs: GENERAL_IDLE_MS,
    };
  };
  return [depsStep(i), build()];
}

/** Ordered build steps for an app on a platform. */
export function buildPlan(input: BuildPlanInput): CommandStep[] {
  // Web is always local: the plan is just the guarded deps install; the engine
  // then starts the long-lived dev server (see `webDevRun`). No native build.
  if (input.type === "web") return [depsStep(input)];
  // Local NativeScript builds via the long-lived livesync process (spawned by
  // the engine after this plan) — the plan itself is just the guarded deps.
  if (input.local && input.type === "nativescript") return [depsStep(input)];
  if (input.platform === "android") return androidPlan(input);
  switch (input.type) {
    case "expo":
      return expoIosPlan(input);
    case "react-native":
      return reactNativeIosPlan(input);
    case "nativescript":
      return nativescriptIosPlan(input);
  }
}

/**
 * The long-lived NativeScript dev process for local previews: watch on, HMR
 * off (NS HMR is unreliable — verified by use; livesync restarts the app on
 * save instead), no --justlaunch so the process stays alive and keeps syncing.
 */
export function nativescriptDevRun(platform: "ios" | "android", deviceHandle: string): { command: string; args: string[] } {
  return { command: "ns", args: ["run", platform, "--no-hmr", "--device", deviceHandle] };
}

/**
 * The long-lived web dev-server process for a local web preview. Runs the
 * project's dev script (default "dev") and injects Vite's flags after `--`:
 *   --host 127.0.0.1  keeps the server loopback-only (only the share proxy reaches it)
 *   --port <p>        pins the port deckhand allocated
 *   --base <base>     serves every asset URL under the share path, so the reverse
 *                     proxy (and Vite's own HMR socket) sit under /s/<shareId>/web/
 * `base` must end with a slash (Vite requirement). Vite-first; other bundlers
 * (Next.js basePath, etc.) are a documented follow-up behind the same seam.
 */
export function webDevRun(devScript: string, base: string, port: number): { command: string; args: string[] } {
  return {
    command: "npm",
    // --strictPort: fail if the allocated port is taken rather than silently
    // drifting to another one (which would leave deckhand proxying the wrong server).
    args: ["run", devScript, "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort", "--base", base],
  };
}

/**
 * The long-lived web dev-server process for **subdomain hosting** — served at the
 * ROOT of a per-share subdomain, so there is NO base path (and therefore no
 * checkout config edit for frameworks that can't set base at runtime). Only the
 * loopback host + port are injected, with each framework's own flags:
 *   nuxt / next : `-H 127.0.0.1 -p <port>`
 *   vite        : `--host 127.0.0.1 --port <port>`  (base stays "/")
 * All bind `127.0.0.1` — only the share proxy reaches them. (See
 * docs/web-wildcard-hosting-plan.md.)
 */
export function webRootDevRun(
  framework: WebFramework,
  devScript: string,
  port: number,
): { command: string; args: string[] } {
  const p = String(port);
  // Vite can pin the port strictly; Nuxt/Next take the port but may drift if it's
  // taken — deckhand allocates from a private range so that won't happen in practice.
  const flags = framework === "vite" ? ["--host", "127.0.0.1", "--port", p, "--strictPort"] : ["-H", "127.0.0.1", "-p", p];
  return { command: "npm", args: ["run", devScript, "--", ...flags] };
}

/** Where the built debug APK lands after an Android build (for install-many). */
export function androidApkGlob(worktreePath: string, type: AppType): string {
  void type;
  return `${worktreePath}/android/app/build/outputs/apk/debug`;
}

/** Whether this app type launches via a Metro dev-client deep link after build. */
export function usesMetroDeepLink(type: AppType): boolean {
  return type === "expo";
}
