import type { MetroManager, MetroHandle } from "../engine/metro.ts";
import type { DevProcessManager, DevRunSpec } from "../engine/devProcess.ts";
import type { Simctl } from "../devices/ios.ts";
import type { AndroidManager } from "../devices/android.ts";
import type { WorktreeManager, PreparedWorktree } from "../engine/worktree.ts";
import type { Reaper } from "../engine/reaper.ts";
import type { App } from "../config.ts";

/**
 * Complete test doubles, one per injected dependency.
 *
 * Test files used to build these inline as object literals cast with
 * `as unknown as X`, which turns off BOTH excess-property and
 * missing-property checking. Adding a method to the real class then left every
 * fake silently behind, and the failure surfaced far from the cause:
 *
 *   - `proxy.test.ts`'s engine fake kept a renamed method, so the proxy called
 *     `undefined` at runtime with a clean typecheck.
 *   - the android fake lacked `attachedSerials`, the worktree fake lacked
 *     `localBranch` — the latter shipped 16 red tests.
 *   - worst, the metro and devProcs fakes lacked `livePids`, so `reapOrphans()`
 *     threw, the surrounding `catch` swallowed it, and **the entire orphan sweep
 *     was a no-op in every test using the base harness while reporting success**.
 *
 * The rule these enforce: a fake is a COMPLETE implementation plus an override,
 * declared as the real type. Adding a method to the real class is then one
 * compile error here, not silence in eleven files.
 *
 * Only for dependencies that are classes. `StreamingBackend` needs nothing like
 * this because it is a two-method interface — which is the deeper lesson: a dep
 * declared as the narrow interface its caller actually uses makes total fakes
 * free.
 *
 * `invariants.test.ts` fails a test file that hand-rolls a fake for any dependency
 * covered here, so the list below and that check's alternation move together.
 */

/**
 * The public surface of a class, as a plain object type.
 *
 * `keyof` on a class type yields only its PUBLIC members, so an object literal
 * declared as `PublicOf<Simctl>` must implement every public method — a missing
 * one is a compile error right here. The single `as unknown as T` afterwards is
 * then safe and deliberate: it only launders the private fields, which no caller
 * can reach anyway.
 *
 * Writing the fake as `{...} as unknown as T` directly is what this replaces —
 * that form silences the completeness check, which is the entire bug class.
 */
type PublicOf<T> = { [K in keyof T]: T[K] };

export function fakeMetro(over: Partial<MetroManager> = {}, log: string[] = []): MetroManager {
  const complete: PublicOf<MetroManager> = {
    livePids: () => [],
    portForApp: () => null,
    ensure: async () => {
      log.push("metro ensure");
      return { manifestUrl: "http://127.0.0.1:8081", port: 8081 } as unknown as MetroHandle;
    },
    stop: async () => {
      log.push("metro stop");
    },
    stopApp: async () => {
      log.push("metro stopApp");
    },
  };
  return Object.assign(complete as unknown as MetroManager, over);
}

export function fakeDevProcs(over: Partial<DevProcessManager> = {}, log: string[] = []): DevProcessManager {
  const complete: PublicOf<DevProcessManager> = {
    livePids: () => [],
    start: (spec: DevRunSpec) => {
      log.push(`dev start ${spec.key}`);
    },
    isAlive: () => true,
    exitCode: () => null,
    exitReason: () => "not started",
    restart: () => true,
    stop: (key: string) => {
      log.push(`dev stop ${key}`);
    },
    stopAll: () => {
      log.push("dev stopAll");
    },
  };
  return Object.assign(complete as unknown as DevProcessManager, over);
}

// ---------------------------------------------------------------------------
// The device and repo managers. These are the fakes that actually cost bugs:
// `Simctl` was faked with 10 of its 14 methods and the missing one was `erase`,
// the pooled-device tenant wipe — the guard for a cross-tenant storage leak.
// `AndroidManager` was missing `forceStop`, `openUrl` and `reversePort`, all
// three on the live Android launch path. `WorktreeManager` was missing
// `localBranch`, which shipped 16 red tests.
//
// Every one of them typechecked, because `as unknown as X` on a literal turns
// off missing-property checking. Declared as `PublicOf<T>` instead, a method
// added to the real class is a compile error here and nowhere else.
// ---------------------------------------------------------------------------

export function fakeSimctl(over: Partial<Simctl> = {}, log: string[] = []): Simctl {
  const complete: PublicOf<Simctl> = {
    listRuntimes: async () => [{ identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-0", name: "iOS 18.0", version: "18.0", isAvailable: true }],
    listDeviceTypes: async () => [{ identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16", name: "iPhone 16" }],
    create: async (name: string) => {
      log.push(`simctl create ${name}`);
      return `UDID-${name}`;
    },
    bootAndWait: async (udid: string) => void log.push(`simctl boot ${udid}`),
    listDevices: async () => [],
    isBooted: async () => true,
    install: async (udid: string) => void log.push(`simctl install ${udid}`),
    silenceDevOverlays: async () => {},
    launch: async (udid: string, bundleId: string) => void log.push(`simctl launch ${udid} ${bundleId}`),
    openUrl: async (udid: string, url: string) => void log.push(`simctl openUrl ${udid} ${url}`),
    appContainer: async () => "/tmp/container",
    screenshotPng: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    shutdown: async (udid: string) => void log.push(`simctl shutdown ${udid}`),
    // The one whose absence was the cross-tenant hazard: a pooled simulator handed to a new
    // app without an erase carries the previous tenant's storage.
    erase: async (udid: string) => void log.push(`simctl erase ${udid}`),
    delete: async (udid: string) => void log.push(`simctl delete ${udid}`),
  };
  return Object.assign(complete as unknown as Simctl, over);
}

export function fakeAndroid(over: Partial<AndroidManager> = {}, log: string[] = []): AndroidManager {
  const complete: PublicOf<AndroidManager> = {
    listSystemImages: async () => [{ api: 34, pkg: "system-images;android-34;google_apis;arm64-v8a", tag: "google_apis", abi: "arm64-v8a" }],
    listAvds: async () => [],
    attachedSerials: async () => [],
    createAvd: async (name: string) => void log.push(`avd create ${name}`),
    bootEmulator: async (avd: string, port: number) => {
      log.push(`emulator boot ${avd} :${port}`);
      return `emulator-${port}`;
    },
    installApk: async (serial: string) => void log.push(`apk install ${serial}`),
    packagePath: async () => "/data/app/base.apk",
    reversePort: async (serial: string, devicePort: number, hostPort: number) =>
      void log.push(`adb reverse ${serial} ${devicePort}->${hostPort}`),
    forceStop: async (serial: string, pkg: string) => void log.push(`force-stop ${serial} ${pkg}`),
    openUrl: async (serial: string, url: string) => void log.push(`open-url ${serial} ${url}`),
    launch: async (serial: string, pkg: string) => void log.push(`launch ${serial} ${pkg}`),
    screenshotPng: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    describe: async () => "<hierarchy/>",
    findApk: async () => "/wt/app-debug.apk",
    shutdown: async (serial: string) => {
      log.push(`emu kill ${serial}`);
      return true; // the fake emulator always goes away; override to exercise a timeout
    },
    deleteAvd: async (name: string) => void log.push(`avd delete ${name}`),
  };
  return Object.assign(complete as unknown as AndroidManager, over);
}

export function fakeWorktrees(over: Partial<WorktreeManager> = {}, log: string[] = []): WorktreeManager {
  const prepared = (previewId: string): PreparedWorktree =>
    ({ path: `/wt/${previewId}`, ref: "refs/x", description: "main", usedToken: false }) as PreparedWorktree;
  const complete: PublicOf<WorktreeManager> = {
    ensureBaseClone: async () => "/clone",
    prepareRef: async () => ({ localRef: "refs/x", usedToken: false }),
    createWorktree: async (_app: App, previewId: string) => {
      log.push(`create ${previewId}`);
      return prepared(previewId);
    },
    updateWorktree: async (_app: App, previewId: string) => {
      log.push(`update ${previewId}`);
      return { ...prepared(previewId), usedToken: true };
    },
    localBranch: async () => "main",
    defaultBranch: async () => "main",
    inspect: async () => ({ defaultBranch: "main", branches: [], tags: [] }) as unknown as Awaited<ReturnType<WorktreeManager["inspect"]>>,
    removeWorktree: async (_app: App, previewId: string) => void log.push(`remove ${previewId}`),
    pruneWorktrees: async () => [],
  };
  return Object.assign(complete as unknown as WorktreeManager, over);
}

export function fakeReaper(over: Partial<Reaper> = {}, log: string[] = []): Reaper {
  const complete: PublicOf<Reaper> = {
    reapOrphansByMarker: async (marker: string) => {
      log.push(`reap marker ${marker}`);
      return [];
    },
    reap: async () => ({ sims: [], avds: [], keptPooled: [] }),
  };
  return Object.assign(complete as unknown as Reaper, over);
}
