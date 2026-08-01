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
/** Metro's conventional port, and the range deckhand falls back through when a
 *  developer's own dev server already owns it (see MetroManager). */
export const METRO_PORT = 8081;
export const METRO_PORT_RANGE: [number, number] = [8081, 8099];

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
 * The package managers deckhand installs with, in detection order. A project is
 * installed with the manager that owns the lockfile it actually ships.
 *
 * bun has to be checked before npm: a bun project's private-registry scopes live
 * in `bunfig.toml`, which npm cannot read. Running npm there resolves those
 * scopes against the public registry and 404s, which reads as a missing package
 * rather than the wrong tool. yarn and pnpm are here for the same reason — being
 * forced through `npm ci`/`npm install` misreports whatever their own manager
 * would have tolerated. npm is last, as the fallback.
 *
 * `frozen` installs exactly what the lockfile pins and never rewrites it.
 * `loose` may update the lockfile, so it is only ever reachable in a disposable
 * git worktree — never in a borrowed local checkout.
 *
 * Detection stays in the emitted shell rather than being resolved here: this
 * module is a pure command builder (no filesystem access), and the test is `-f`
 * in the step's own cwd at run time.
 */
const PACKAGE_MANAGERS = [
  { name: "bun", test: "[ -f bun.lock ] || [ -f bun.lockb ]", frozen: "bun install --frozen-lockfile", loose: "bun install" },
  // yarn: `--frozen-lockfile`, NOT `--immutable`, and this is the one entry worth not
  // "modernising". Measured against yarn 1.22.22 and yarn 4.18.0 with a lockfile
  // deliberately out of sync (2026-08-01):
  //
  //                       yarn 1.22          yarn 4.18
  //   --frozen-lockfile   exit 1, untouched  exit 1, untouched (deprecation warning only)
  //   --immutable         EXIT 0, REWRITTEN  exit 1, untouched
  //
  // yarn 1 silently ignores flags it does not know, so `--immutable` there is not a
  // stricter spelling — it is no flag at all, and the lockfile in a BORROWED checkout gets
  // rewritten. `--frozen-lockfile` is deprecated on berry, not removed, and still enforces.
  // One spelling is correct on both; the modern-looking one is correct on one.
  { name: "yarn", test: "[ -f yarn.lock ]", frozen: "yarn install --frozen-lockfile", loose: "yarn install" },
  { name: "pnpm", test: "[ -f pnpm-lock.yaml ]", frozen: "pnpm install --frozen-lockfile", loose: "pnpm install" },
  { name: "npm", test: "[ -f package-lock.json ]", frozen: "npm ci", loose: "npm install" },
] as const;

/**
 * Deckhand does not install package managers. A lockfile whose manager is not on
 * PATH exits 127 saying exactly that, rather than silently falling through to npm
 * and failing later with an unrelated error — or dying as a bare "command not
 * found" in the middle of a build log.
 */
const PM_HELPERS = [
  'pm_need() { command -v "$1" >/dev/null 2>&1 || { echo "deckhand: this project ships a $1 lockfile, but $1 is not installed on this host — install it (e.g. brew install $1), or enable corepack" >&2; exit 127; }; }',
];

/**
 * Build the lockfile-dispatch chain. `policy` renders the install for one
 * manager, so the disposable-worktree and borrowed-checkout rules stay separate
 * (the difference between them is a correctness invariant, not a flag).
 */
function installChain(policy: (pm: (typeof PACKAGE_MANAGERS)[number]) => string, noLockfile: string): string {
  const branches = PACKAGE_MANAGERS.map(
    (pm, i) => `${i === 0 ? "if" : "elif"} ${pm.test}; then pm_need ${pm.name}; ${policy(pm)}`,
  );
  return [...PM_HELPERS, ...branches, `else ${noLockfile}; fi`].join("\n");
}

/**
 * The dependency-install step for a disposable git worktree: install what the
 * lockfile pins, and if the lockfile is out of sync with package.json (a frozen
 * install fails hard on that), fall back to an updating install rather than
 * bricking the preview. Rewriting a lockfile is harmless here — the worktree is
 * thrown away — and previewing a branch whose lockfile lags is exactly the case
 * deckhand exists to serve.
 */
export function installDepsStep(worktreePath: string, env: Record<string, string>): CommandStep {
  const script = installChain(
    (pm) =>
      `${pm.frozen} || { echo "deckhand: ${pm.name} could not install from the lockfile as-is (it is probably out of sync with package.json); retrying with an updating install" >&2; ${pm.loose}; }`,
    "npm install",
  );
  return {
    name: "install-deps",
    run: { kind: "shell", script },
    cwd: worktreePath,
    env,
    idleTimeoutMs: GENERAL_IDLE_MS,
  };
}

/**
 * Local-mode dependency install: leave an existing node_modules alone (it's the
 * dev's). Borrow-never-own extends to git, so this path has **no** updating
 * fallback — every manager runs in its frozen/read-only mode and a stale lockfile
 * fails with an instruction instead of deckhand editing a tracked file. With no
 * lockfile at all, `--no-package-lock` keeps npm from dropping a stray untracked
 * lockfile into the checkout. node_modules itself is gitignored, so the tracked
 * tree is untouched either way.
 *
 * "Leave it alone" cannot mean "never look at it", though: a manifest edited
 * since the last install (a dependency added on the branch, a merge that pulled
 * one in) leaves node_modules present but incomplete, and the build then fails
 * far downstream as a Metro "Unable to resolve module" — read as the app's bug,
 * not a stale checkout. So install when node_modules is missing OR older than
 * the manifest/lockfile. Still read-only, still the dev's directory.
 */
const STALE_DEPS = "[ -d node_modules ]" + ["package.json", "package-lock.json", "bun.lock", "bun.lockb", "yarn.lock", "pnpm-lock.yaml"].map((f) => ` && ! [ ${f} -nt node_modules ]`).join("");

export function installDepsIfMissingStep(worktreePath: string, env: Record<string, string>): CommandStep {
  const chain = installChain(
    (pm) =>
      `${pm.frozen} || { echo "deckhand: ${pm.name} could not install from this checkout's lockfile, and deckhand will not modify a borrowed checkout — run '${pm.loose}' here yourself, then retry" >&2; exit 1; }`,
    "npm install --no-package-lock",
  );
  return {
    name: "install-deps",
    // The staleness guard is main's; the chain inside it is this branch's. Both are needed:
    // a fresh-enough node_modules must be left alone, and when it is NOT fresh the install
    // has to use the project's own package manager.
    run: { kind: "shell", script: `${STALE_DEPS} || {\n${chain}\n}` },
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

/**
 * `expo run:android --device` matches on the *device name*, and for an emulator
 * that name is its AVD name — not the adb serial (see @expo/cli
 * AndroidDeviceManager.resolveFromNameAsync). Passing `emulator-5554` fails with
 * "Could not find device with name". Resolve the AVD name over adb and pass
 * that; fall back to the serial for physical devices, where `emu avd name` has
 * nothing to answer. `--no-bundler`: same reason as iOS — deckhand owns Metro.
 */
const expoAndroidRun = (serial: string): string =>
  [
    `_avd=$(adb -s '${serial}' emu avd name 2>/dev/null | tr -d '\\r' | head -1)`,
    `case "$_avd" in ""|OK|*error*) _avd='${serial}';; esac`,
    `npx expo run:android --device "$_avd" --no-bundler`,
  ].join("\n");

function androidPlan(i: BuildPlanInput): CommandStep[] {
  // `i.udid` carries the adb serial for Android.
  const serial = i.udid;
  const build = (): CommandStep => {
    if (i.type === "expo") {
      return {
        name: "build",
        run: { kind: "shell", script: expoAndroidRun(serial) },
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
