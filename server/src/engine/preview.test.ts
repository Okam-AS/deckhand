import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeMetro, fakeDevProcs, fakeSimctl, fakeAndroid, fakeWorktrees, fakeReaper } from "../test-support/fakes.ts";
import { PreviewEngine, PreviewError, buildStepDetail, redactForShare, type PreviewEngineDeps } from "./preview.ts";
import type { SimDeckControl } from "../testing/control.ts";
import type { App, Config } from "../config.ts";
import type { RunResult } from "./procs.ts";
import type { CommandStep } from "./recipes.ts";
import type { DevRunSpec } from "./devProcess.ts";
import type { AttachedStream, StreamDeviceRef } from "../streaming/backend.ts";
import { StateStore } from "../state.ts";

const config: Config = {
  hostname: "mate.example.com",
  port: 4300,
  streaming: { serveSim: { version: "0.1.34", codec: "auto", helperPortRange: [3100, 3199] } },
  githubApp: { appId: 1, privateKeyPath: "k.pem" },
  githubAmbient: true,
  allowPublicRepos: false,
  modelHints: {},
  limits: {
    maxDevicesPerPreview: 4,
    maxTotalDevices: 2,
    idleMinutes: 45,
    failedGraceMinutes: 15,
    stuckMinutes: 90,
    reuseDevices: false,
    disk: { watch: 50, pressure: 35, critical: 20 },
  },
};

const rnApp: App = {
  id: "my-app",
  repo: "github.com/ainfrastructure/my-app",
  type: "react-native", // avoids the app.json/metro path — fully fakeable
  defaultBranch: "main",

  bundleId: "com.example.myapp",
  env: { EXPO_PUBLIC_API_URL: "https://staging" },
};

/** A real on-disk web project, minimal enough for the pipeline to accept it. */
function webDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "deckhand-webapp-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "my-web", scripts: { dev: "vite" }, devDependencies: { vite: "^5" } }));
  return dir;
}

/** A LOCAL web app: `path` source, so no worktree, and the web pipeline instead of a device. */
const webApp: App = {
  id: "my-web",
  repo: "github.com/ainfrastructure/my-web",
  type: "web",
  // A real directory: the web pipeline checks the local source exists, and this test is about
  // what happens AFTER the stream attaches, so it has to get that far.
  path: webDir(),
  defaultBranch: "main",
  env: {},
};

interface Harness {
  engine: PreviewEngine;
  /** The state store the engine persists into, so a test can read back what was written. */
  store: StateStore;
  simctlCalls: string[];
  buildEnvSeen: (Record<string, string> | undefined)[];
  removedWorktrees: string[];
  worktreeCalls: string[];
  devProcCalls: string[];
  detached: string[];
  audit: { tool: string; args: unknown }[];
  firstFrameResults: boolean[];
  attachCalls: string[];
}

/**
 * The default fake AndroidManager. Extracted so a test can override ONE method
 * (`...androidFake(calls), attachedSerials: …`) instead of restating a whole
 * device manager to change a single answer.
 */
function androidFake(calls: string[] = []) {
  return fakeAndroid({
    // No emulator is attached in the fake world, so every console port is free.
    // Tests about port collisions override this.
    attachedSerials: async () => [] as string[],
    listSystemImages: async () => [{ pkg: "system-images;android-34;google_apis;arm64-v8a", api: 34 }],
    listAvds: async () => [] as string[],
    createAvd: async () => {
      calls.push("avd create");
    },
    bootEmulator: async () => {
      calls.push("emu boot");
      return "emulator-5554";
    },
    packagePath: async () => "/data/app/base.apk",
    installApk: async (serial: string) => {
      calls.push(`apk install ${serial}`);
    },
    launch: async () => {},
    screenshotPng: async () => Buffer.from([0x89, 0x50]),
    findApk: async () => "/wt/app-debug.apk",
    shutdown: async () => {},
    deleteAvd: async () => {},
    describe: async () => "tree",
  });
}

function makeEngine(overrides: Partial<PreviewEngineDeps> = {}, runStepResult: (step: CommandStep) => RunResult = () => ({ code: 0, timedOut: false, aborted: false })): Harness {
  const simctlCalls: string[] = [];
  const buildEnvSeen: (Record<string, string> | undefined)[] = [];
  const removedWorktrees: string[] = [];
  const worktreeCalls: string[] = [];
  const devProcCalls: string[] = [];
  const detached: string[] = [];
  const audit: { tool: string; args: unknown }[] = [];

  const devAlive = new Set<string>();
  const devProcs = fakeDevProcs({
    start: (spec: DevRunSpec) => {
      devProcCalls.push(`start ${spec.key} ${spec.command} ${spec.args.join(" ")}`);
      devAlive.add(spec.key);
      spec.onLog?.("Project successfully prepared");
    },
    isAlive: (k: string) => devAlive.has(k),
    exitCode: () => null,
    restart: (k: string) => {
      devProcCalls.push(`restart ${k}`);
      return devAlive.has(k);
    },
    stop: (k: string) => {
      devProcCalls.push(`stop ${k}`);
      devAlive.delete(k);
    },
    stopAll: () => {},
  });
  // Completed through the shared fake so a new DevProcessManager method is a
  // compile error here rather than a silently swallowed throw at runtime.
  const devProcsComplete = fakeDevProcs(devProcs as Partial<PreviewEngineDeps["devProcs"]>);

  const simctl = fakeSimctl({
    listRuntimes: async () => [{ identifier: "rt.26", name: "iOS 26.0", version: "26.0", isAvailable: true }],
    listDeviceTypes: async () => [{ identifier: "dt.16pro", name: "iPhone 16 Pro" }],
    create: async (name: string) => {
      simctlCalls.push(`create ${name}`);
      const n = simctlCalls.filter((c) => c.startsWith("create ")).length;
      return `1111111${n}-1111-1111-1111-111111111111`;
    },
    bootAndWait: async (udid: string) => {
      simctlCalls.push(`boot ${udid}`);
    },
    appContainer: async () => "/path/to/App.app",
    install: async (udid: string, p: string) => {
      simctlCalls.push(`install ${udid} ${p}`);
    },
    launch: async (_udid: string, b: string) => {
      simctlCalls.push(`launch ${b}`);
    },
    openUrl: async () => {},
    shutdown: async (u: string) => {
      simctlCalls.push(`shutdown ${u}`);
    },
    delete: async (u: string) => {
      simctlCalls.push(`delete ${u}`);
    },
  });

  // Queue of probe outcomes; empty = healthy. Lets a test declare "the kept
  // helper is dead" for exactly one probe (attachAndReady's liveness check).
  const firstFrameResults: boolean[] = [];
  const attachCalls: string[] = [];
  const fakeStream: AttachedStream = {
    origin: "http://127.0.0.1:3100",
    helperBasePath: "/helper/x",
    waitForFirstFrame: async () => (firstFrameResults.length ? firstFrameResults.shift()! : true),
    describe: async () => "tree",
    detach: async () => {
      detached.push("x");
    },
  };
  const streaming = {
    attach: async (d: StreamDeviceRef) => {
      attachCalls.push(d.udid);
      return fakeStream;
    },
    reapOrphans: async () => {},
  };

  const android = androidFake(simctlCalls);
  // Named so a test can read back what was persisted; the engine has no snapshot accessor
  // and should not grow one just for tests.
  const store = new StateStore(`/tmp/deckhand-noop-${Math.random().toString(36).slice(2)}.json`);

  const deps: PreviewEngineDeps = {
    config: overrides.config ?? config,
    android,
    worktrees: fakeWorktrees({
      localBranch: async () => "main",
      createWorktree: async (_app: App, previewId: string) => {
        worktreeCalls.push(`create ${previewId}`);
        return { path: `/wt/${previewId}`, ref: "refs/x", description: "main", usedToken: false };
      },
      updateWorktree: async (_app: App, previewId: string) => {
        worktreeCalls.push(`update ${previewId}`);
        return { path: `/wt/${previewId}`, ref: "refs/x", description: "main", usedToken: true };
      },
      removeWorktree: async (_app: App, previewId: string) => {
        removedWorktrees.push(previewId);
      },
    }),
    simctl,
    streaming: streaming as unknown as PreviewEngineDeps["streaming"],
    metro: fakeMetro(),
    store,
    audit: { record: (e: { tool: string; args: unknown }) => void audit.push({ tool: e.tool, args: e.args }) } as unknown as PreviewEngineDeps["audit"],
    devProcs: devProcsComplete,
    runStep: async (step, opts) => {
      buildEnvSeen.push(step.env);
      opts?.onLog?.(`running ${step.name}`, "stdout");
      return runStepResult(step);
    },
    secretsEnv: () => ({ SECRET_TOKEN: "s3cr3t" }),
    genPreviewId: () => "pv1",
    genShareId: () => "share-abc",
    ...overrides,
  };
  return { engine: new PreviewEngine(deps), store, simctlCalls, buildEnvSeen, removedWorktrees, worktreeCalls, devProcCalls, detached, audit, firstFrameResults, attachCalls };
}

async function waitForPhase(engine: PreviewEngine, previewId: string, phases: string[], timeoutMs = 2000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = engine.getStatus(previewId);
    if (st && phases.includes(st.phase)) return st.phase;
    await new Promise((r) => setTimeout(r, 5));
  }
  return engine.getStatus(previewId)?.phase ?? "gone";
}

describe("redactForShare", () => {
  it("keeps the sentence and drops private repo names and host paths", () => {
    // The reason reaches whoever holds the share link, PUBLIC shares included.
    const out = redactForShare(
      "submodule checkout failed for github.com/acme/app: fatal: repository 'https://github.com/acme/secret-design-system.git/' not found",
    );
    assert.ok(!out.includes("secret-design-system"), out);
    assert.ok(out.startsWith("submodule checkout failed"), out);

    const wt = redactForShare("worktree add failed: fatal: cannot create /Users/dana/.deckhand/worktrees/app-a/main");
    assert.ok(!wt.includes("dana"), wt);
    assert.ok(!wt.includes("/Users"), wt);
    // The rest of the path stays: it is deckhand's own layout plus the app and
    // ref the share holder is already looking at.
    assert.ok(wt.includes("worktree add failed"), wt);
  });

  it("redacts a scheme-less repo reference too", () => {
    const out = redactForShare("clone failed: github.com/acme/secret-design-system not found");
    assert.ok(!out.includes("secret-design-system"), out);
  });

  it("redacts a path that is not preceded by a space or a quote", () => {
    const out = redactForShare("ld: framework not found at [/Users/dana/.deckhand/worktrees/app-a/ios/Pods]");
    assert.ok(!out.includes("dana"), out);
    assert.ok(out.includes("framework not found"), out);
  });

  it("keeps the actionable half: file:line:col, and Android component names", () => {
    // The reason is what a share holder relays back, so over-redaction costs as
    // much as under-redaction: WHERE it broke is the useful part.
    assert.equal(redactForShare("index.js:23:5: SyntaxError: unexpected token"), "index.js:23:5: SyntaxError: unexpected token");
    const swift = redactForShare("/Users/dana/wt/App.swift:12:3: error: no such module 'Foo'");
    assert.ok(!swift.includes("dana"), swift);
    assert.ok(swift.includes("App.swift:12:3"), swift);
    assert.equal(
      redactForShare("Starting com.acme.app/.MainActivity"),
      "Starting com.acme.app/.MainActivity",
    );
  });

  it("strips a bare home directory and a self-hosted host", () => {
    const home = redactForShare("HOME=/Users/dana is not writable");
    assert.ok(!home.includes("dana"), home);
    const gl = redactForShare("clone failed: gitlab.acme.internal/platform/private-core not found");
    assert.ok(!gl.includes("private-core"), gl);
  });

  it("leaves an ordinary build error untouched", () => {
    assert.equal(redactForShare("xcodebuild exited 65"), "xcodebuild exited 65");
  });
});

describe("PreviewEngine.startPreview", () => {
  it("returns immediately with a viewer url and drives one iOS device to ready", async () => {
    const h = makeEngine();
    const res = h.engine.startPreview({
      app: rnApp,
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [{ platform: "ios", runtime: "26", model: "iPhone 16 Pro" }],
      access: "public",
    });
    assert.equal(res.previewId, "pv1");
    assert.equal(res.url, "https://mate.example.com/s/share-abc");
    assert.equal(res.devices.length, 1);

    const phase = await waitForPhase(h.engine, "pv1", ["ready", "failed"]);
    assert.equal(phase, "ready");
    const st = h.engine.getStatus("pv1")!;
    assert.equal(st.ready, true);
    assert.equal(st.url, "https://mate.example.com/s/share-abc");
    assert.equal(st.devices[0]!.phase, "ready");
    assert.equal(st.devices[0]!.label, "iPhone 16 Pro · iOS 26.0");
  });

  it("merges app env and secrets into the build step", async () => {
    const h = makeEngine();
    h.engine.startPreview({
      app: rnApp,
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [{ platform: "ios" }],
      access: "public",
    });
    await waitForPhase(h.engine, "pv1", ["ready", "failed"]);
    const env = h.buildEnvSeen.find((e) => e && "EXPO_PUBLIC_API_URL" in e);
    assert.ok(env);
    assert.equal(env!.EXPO_PUBLIC_API_URL, "https://staging");
    assert.equal(env!.SECRET_TOKEN, "s3cr3t");
  });

  it("marks the device failed with a logTail when a build step fails", async () => {
    const h = makeEngine({}, (step) => ({ code: step.name === "build" ? 1 : 0, timedOut: false, aborted: false }));
    h.engine.startPreview({
      app: rnApp,
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [{ platform: "ios" }],
      access: "public",
    });
    const phase = await waitForPhase(h.engine, "pv1", ["failed"]);
    assert.equal(phase, "failed");
    const st = h.engine.getStatus("pv1")!;
    assert.match(st.devices[0]!.error ?? "", /build step "build" failed/);
    assert.ok((st.devices[0]!.logTail ?? "").length > 0);
  });

  it("fails the boot when the bundle id isn't a valid bundle id", async () => {
    // bundleId comes from the previewed repo's own config and reaches multi-arg
    // `adb shell` calls as an unquoted token adb joins into a shell command line.
    const h = makeEngine();
    h.engine.startPreview({
      app: { ...rnApp, bundleId: "com.example.app; id > /data/local/tmp/pwned" },
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [{ platform: "ios" }],
      access: "public",
    });
    const phase = await waitForPhase(h.engine, "pv1", ["failed"]);
    assert.equal(phase, "failed");
    assert.match(h.engine.getStatus("pv1")!.devices[0]!.error ?? "", /is not a valid bundle id/);
    // Nothing was launched with it.
    assert.equal(h.simctlCalls.filter((c) => c.startsWith("launch ")).length, 0);
  });

  it("builds once and installs to the second device (build-once-install-many)", async () => {
    const h = makeEngine();
    const res = h.engine.startPreview({
      app: rnApp,
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [
        { platform: "ios", runtime: "26" },
        { platform: "ios", runtime: "26" },
      ],
      access: "public",
    });
    assert.equal(res.devices.length, 2);
    const phase = await waitForPhase(h.engine, "pv1", ["ready", "failed"]);
    assert.equal(phase, "ready");
    const st = h.engine.getStatus("pv1")!;
    assert.equal(st.devices.length, 2);
    assert.ok(st.devices.every((d) => d.phase === "ready"));

    // rn plan = install-deps + pods + build = 3 steps. Built ONCE (not 6×).
    assert.equal(h.buildEnvSeen.length, 3, "build plan must run once, not per device");
    // The second (non-builder) device installs the built product.
    assert.equal(h.simctlCalls.filter((c) => c.startsWith("install ")).length, 1);
    // Two simulators were created.
    assert.equal(h.simctlCalls.filter((c) => c.startsWith("create ")).length, 2);
  });

  it("rejects requests over the total device capacity", () => {
    const h = makeEngine();
    // capacity is 2; ask for 3 in one preview → maxDevicesPerPreview(4) ok but total(2) exceeded
    assert.throws(
      () =>
        h.engine.startPreview({
          app: rnApp,
          source: "git",
          spec: { kind: "branch", branch: "main" },
          devices: [{ platform: "ios" }, { platform: "ios" }, { platform: "ios" }],
          access: "public",
        }),
      (e) => e instanceof PreviewError && /capacity/.test((e as Error).message),
    );
  });

  it("drives an Android device to ready (AVD create → emulator boot → apk build/install → launch)", async () => {
    const h = makeEngine();
    h.engine.startPreview({
      app: rnApp,
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [{ platform: "android", runtime: "34" }],
      access: "public",
    });
    const phase = await waitForPhase(h.engine, "pv1", ["ready", "failed"]);
    assert.equal(phase, "ready");
    const st = h.engine.getStatus("pv1")!;
    assert.equal(st.devices[0]!.phase, "ready");
    assert.match(st.devices[0]!.label, /Android 34/);
    assert.ok(h.simctlCalls.includes("emu boot"));
  });

  it("orchestrates a mixed iOS + Android preview in parallel groups", async () => {
    const h = makeEngine();
    h.engine.startPreview({
      app: rnApp,
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [
        { platform: "ios", runtime: "26" },
        { platform: "android", runtime: "34" },
      ],
      access: "public",
    });
    const phase = await waitForPhase(h.engine, "pv1", ["ready", "failed"]);
    assert.equal(phase, "ready");
    const st = h.engine.getStatus("pv1")!;
    assert.equal(st.devices.length, 2);
    assert.ok(st.devices.every((d) => d.phase === "ready"));
  });
});

describe("PreviewEngine.stopPreview", () => {
  it("stops the app's Metro once no preview needs it", async () => {
    // Teardown killed the dev processes but never Metro: every finished Expo
    // preview left one listening, and after a few app switches the whole
    // 8081-8099 range was spoken for and previews failed to start at all.
    const stoppedApps: string[] = [];
    let n = 0;
    const h = makeEngine({
      genPreviewId: () => `pv${++n}`,
      genShareId: () => `share-${n}`,
      metro: fakeMetro({
        // `port` is not optional on MetroHandle. The old inline cast hid that; declaring the
        // override as Partial<MetroManager> does not.
        ensure: async () => ({ manifestUrl: "http://127.0.0.1:8081", port: 8081 }),
        stop: async () => {},
        stopApp: async (appId: string) => void stoppedApps.push(appId),
      }),
    });
    // TWO live previews of the same app (different refs — one Metro serves
    // whichever is current). Stopping the first must NOT pull the dev server
    // out from under the second.
    for (const branch of ["main", "feature"]) {
      h.engine.startPreview({
        app: rnApp,
        source: "git",
        spec: { kind: "branch", branch },
        devices: [{ platform: "ios" }],
        access: "public",
      });
      await waitForPhase(h.engine, `pv${n}`, ["ready", "failed"]);
    }
    await h.engine.stopPreview("pv1");
    assert.deepEqual(stoppedApps, [], "another preview of this app is still live");
    await h.engine.stopPreview("pv2");
    assert.deepEqual(stoppedApps, [rnApp.id]);
  });

  it("tears down the sim + worktree and forgets the preview", async () => {
    const h = makeEngine();
    h.engine.startPreview({
      app: rnApp,
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [{ platform: "ios" }],
      access: "public",
    });
    await waitForPhase(h.engine, "pv1", ["ready", "failed"]);
    assert.ok(h.engine.findByShareId("share-abc"));

    const stopped = await h.engine.stopPreview("pv1");
    assert.equal(stopped, true);
    assert.equal(h.engine.findByShareId("share-abc"), null);
    assert.equal(h.engine.getStatus("pv1"), null);
    assert.ok(h.removedWorktrees.includes("pv1"));
    assert.ok(h.simctlCalls.some((c) => c.startsWith("delete ")));
  });
});

// ---------------------------------------------------------------------------
// Local (dev-mode) previews: build the developer's own dir in place — no
// worktree, livesync process instead of a one-shot build, teardown never
// touches the source dir. The daily-loop contract: idempotent start, stable
// share ids, restart-in-place.
// ---------------------------------------------------------------------------

describe("local (dev-mode) previews", () => {
  let localDir: string;
  before(() => {
    localDir = mkdtempSync(join(tmpdir(), "deckhand-local-"));
  });
  after(() => {
    rmSync(localDir, { recursive: true, force: true });
  });
  const localApp = (): App => ({
    id: "local-app",
    path: localDir,
    type: "nativescript",
    defaultBranch: "main",

    bundleId: "org.ns.demo",
    env: {},
  });
  const startLocal = (h: Harness) =>
    h.engine.startPreview({ app: localApp(), source: "local", devices: [{ platform: "ios" }], access: "public" });

  it("builds in place with a livesync process — no worktree", async () => {
    const h = makeEngine();
    const res = startLocal(h);
    assert.equal(res.source, "local");
    assert.equal(res.url, "https://mate.example.com/s/share-abc");
    const phase = await waitForPhase(h.engine, "pv1", ["ready", "failed"]);
    assert.equal(phase, "ready");
    assert.deepEqual(h.worktreeCalls, [], "local previews must not create worktrees");
    const start = h.devProcCalls.find((c) => c.startsWith("start local-app:ios"));
    assert.ok(start, "livesync process must start");
    assert.match(start!, /ns run ios --no-hmr --device 1111111/);
    assert.ok(!start!.includes("--no-watch"), "watch mode is the point of dev previews");
  });

  it("start_preview is idempotent: an equivalent running preview is returned as-is", async () => {
    const h = makeEngine();
    const first = startLocal(h);
    assert.equal(first.alreadyRunning, false);
    await waitForPhase(h.engine, "pv1", ["ready", "failed"]);
    const again = startLocal(h);
    assert.equal(again.alreadyRunning, true);
    assert.equal(again.previewId, first.previewId);
    assert.equal(again.url, first.url);
    assert.equal(h.simctlCalls.filter((c) => c.startsWith("create ")).length, 1, "no second simulator");
  });

  it("rejects two devices of the same platform (livesync targets one device)", () => {
    const h = makeEngine();
    assert.throws(
      () =>
        h.engine.startPreview({
          app: localApp(),
          source: "local",
          devices: [{ platform: "ios" }, { platform: "ios" }],
          access: "public",
        }),
      (e) => e instanceof PreviewError && /one device per platform/.test((e as Error).message),
    );
  });

  it("stop kills the livesync process and never touches the source dir or worktrees", async () => {
    const h = makeEngine();
    startLocal(h);
    await waitForPhase(h.engine, "pv1", ["ready", "failed"]);
    const stopped = await h.engine.stopPreview("pv1");
    assert.equal(stopped, true);
    assert.ok(h.devProcCalls.includes("stop local-app:ios"));
    assert.deepEqual(h.removedWorktrees, [], "stop must not remove anything for a local preview");
    assert.ok(existsSync(localDir), "the developer's dir must survive teardown");
  });

  it("restart re-runs the livesync build on the same simulator with the same url", async () => {
    const h = makeEngine();
    const first = startLocal(h);
    await waitForPhase(h.engine, "pv1", ["ready", "failed"]);
    const res = h.engine.restartPreview("pv1");
    assert.equal(res.url, first.url);
    const phase = await waitForPhase(h.engine, "pv1", ["ready", "failed"]);
    assert.equal(phase, "ready");
    assert.equal(h.devProcCalls.filter((c) => c.startsWith("start local-app:ios")).length, 2);
    assert.equal(h.simctlCalls.filter((c) => c.startsWith("create ")).length, 1, "restart must not boot new sims");
  });

  it("restart re-attaches when the kept helper no longer answers", async () => {
    const h = makeEngine();
    startLocal(h);
    await waitForPhase(h.engine, "pv1", ["ready", "failed"]);
    const before = h.attachCalls.length;
    // Kept-helper liveness probe fails once (dead process); the fresh attach's probe succeeds.
    h.firstFrameResults.push(false);
    h.engine.restartPreview("pv1");
    const phase = await waitForPhase(h.engine, "pv1", ["ready", "failed"]);
    assert.equal(phase, "ready");
    assert.ok(h.detached.includes("x"), "the dead helper must be detached");
    assert.equal(h.attachCalls.length, before + 1, "a fresh helper must be attached in its place");
  });

  it("restart while a build is in flight fails with an actionable error", () => {
    const h = makeEngine();
    startLocal(h);
    assert.throws(
      () => h.engine.restartPreview("pv1"),
      (e) => e instanceof PreviewError && /is running/.test((e as Error).message),
    );
  });

  it("fails the device with a livesync error when the dev process dies", async () => {
    const h = makeEngine({
      devProcs: fakeDevProcs({
        start: () => {},
        isAlive: () => false,
        exitCode: () => 1,
        // The engine reads exitReason now, not exitCode — "(code ?)" hid whether the process
        // had been killed, which is the one fact worth having.
        exitReason: () => "exit code 1",
        restart: () => false,
        stop: () => {},
        stopAll: () => {},
      }),
    });
    startLocal(h);
    const phase = await waitForPhase(h.engine, "pv1", ["ready", "failed"]);
    assert.equal(phase, "failed");
    // The message now names HOW it died — "(code ?)" hid the one fact worth having.
    assert.match(h.engine.getStatus("pv1")!.devices[0]!.error ?? "", /livesync process exit code 1/);
  });
});

describe("stable share ids", () => {
  it("keeps the app's shareId across stop/start and across engine restarts", async () => {
    const file = `/tmp/deckhand-stable-${Math.random().toString(36).slice(2)}.json`;
    let share = 0;
    let pv = 0;
    const mk = () =>
      makeEngine({
        store: new StateStore(file),
        genShareId: () => `share-${++share}`,
        genPreviewId: () => `pv${++pv}`,
      });

    const h1 = mk();
    const req = {
      app: rnApp,
      source: "git" as const,
      spec: { kind: "branch", branch: "main" } as const,
      devices: [{ platform: "ios" as const }],
      access: "public" as const,
    };
    const first = h1.engine.startPreview(req);
    assert.equal(first.shareId, "share-1");
    await waitForPhase(h1.engine, "pv1", ["ready", "failed"]);
    await h1.engine.stopPreview("pv1");

    const second = h1.engine.startPreview(req);
    assert.equal(second.shareId, "share-1", "restarting the app must reuse its share id");
    await waitForPhase(h1.engine, "pv2", ["ready", "failed"]);
    await h1.engine.stopPreview("pv2");

    // A fresh engine (server restart) loads the persisted map and still reuses it.
    const h2 = mk();
    const third = h2.engine.startPreview(req);
    assert.equal(third.shareId, "share-1", "the bookmark must survive a server restart");
    rmSync(file, { force: true });
  });

  it("a second concurrent preview of the same app gets a fresh shareId", async () => {
    let share = 0;
    let pv = 0;
    const h = makeEngine({
      genShareId: () => `share-${++share}`,
      genPreviewId: () => `pv${++pv}`,
    });
    const req = (branch: string) => ({
      app: rnApp,
      source: "git" as const,
      spec: { kind: "branch", branch } as const,
      devices: [{ platform: "ios" as const }],
      access: "public" as const,
    });
    const a = h.engine.startPreview(req("main"));
    const b = h.engine.startPreview(req("feature"));
    assert.equal(a.shareId, "share-1");
    assert.equal(b.shareId, "share-2", "concurrent previews must not collide on the stable id");
  });
});

describe("PreviewEngine.restartPreview (git)", () => {
  it("fetches the new tip, rebuilds on the same simulators, and keeps the url", async () => {
    const h = makeEngine();
    const first = h.engine.startPreview({
      app: rnApp,
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [{ platform: "ios" }],
      access: "public",
    });
    await waitForPhase(h.engine, "pv1", ["ready", "failed"]);
    const stepsAfterStart = h.buildEnvSeen.length;

    const res = h.engine.restartPreview("pv1");
    assert.equal(res.url, first.url);
    const phase = await waitForPhase(h.engine, "pv1", ["ready", "failed"]);
    assert.equal(phase, "ready");
    assert.ok(h.worktreeCalls.includes("update pv1"), "restart must refresh the worktree to the new tip");
    assert.ok(h.buildEnvSeen.length > stepsAfterStart, "restart must actually rebuild");
    assert.equal(h.simctlCalls.filter((c) => c.startsWith("create ")).length, 1, "restart must not boot new sims");
  });
});

describe("agent-driven testing (describe/ui + test runs)", () => {
  function fakeSimdeck() {
    const calls: { m: string; target: { platform: string; udid: string }; arg: unknown }[] = [];
    const control = {
      describe: async (target: { platform: string; udid: string }, opts: unknown) => {
        calls.push({ m: "describe", target, arg: opts });
        return { source: "native-ax", nodes: [] };
      },
      action: async (target: { platform: string; udid: string }, action: unknown) => {
        calls.push({ m: "action", target, arg: action });
        return { ok: true };
      },
    } as unknown as SimDeckControl;
    return { control, calls };
  }

  it("resolves the SimDeck target from the device: iOS UDID, and forwards describe/ui", async () => {
    const sd = fakeSimdeck();
    const h = makeEngine({ simdeck: sd.control });
    h.engine.startPreview({
      app: rnApp,
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [{ platform: "ios" }],
      access: "public",
    });
    await waitForPhase(h.engine, "pv1", ["ready", "failed"]);

    await h.engine.describe("pv1", "ios-0", { interactiveOnly: true });
    await h.engine.ui("pv1", "ios-0", { type: "tap", x: 0.5, y: 0.5 });

    assert.equal(sd.calls[0]!.m, "describe");
    assert.equal(sd.calls[0]!.target.platform, "ios");
    assert.ok(sd.calls[0]!.target.udid.length > 0, "iOS target should be the simulator UDID");
    assert.deepEqual(sd.calls[0]!.arg, { interactiveOnly: true });
    assert.equal(sd.calls[1]!.m, "action");
    assert.deepEqual(sd.calls[1]!.arg, { type: "tap", x: 0.5, y: 0.5 });
  });

  it("addresses an Android device as android:<avd>", async () => {
    const sd = fakeSimdeck();
    const h = makeEngine({ simdeck: sd.control });
    h.engine.startPreview({
      app: rnApp,
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [{ platform: "android" }],
      access: "public",
    });
    await waitForPhase(h.engine, "pv1", ["ready", "failed"]);
    await h.engine.describe("pv1", "android-0", {});
    assert.match(sd.calls[0]!.target.udid, /^android:/);
  });

  it("records a test run and surfaces it through shareState", async () => {
    const h = makeEngine();
    h.engine.startPreview({
      app: rnApp,
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [{ platform: "ios" }],
      access: "public",
    });
    await waitForPhase(h.engine, "pv1", ["ready", "failed"]);

    const { runId } = h.engine.startTestRun("pv1", "Login flow", ["Open app", "Enter creds", "Submit"]);
    assert.ok(runId);
    let s = h.engine.shareState("share-abc")!;
    assert.equal(s.testRun!.status, "running");
    assert.equal(s.testRun!.title, "Login flow");
    assert.equal(s.testRun!.steps.length, 3);
    assert.equal(s.testRun!.steps[0]!.status, "pending");

    h.engine.updateTestRun("pv1", { step: { n: 1, status: "running" } });
    h.engine.updateTestRun("pv1", { step: { n: 1, status: "passed" } });
    h.engine.updateTestRun("pv1", { step: { label: "Enter creds", status: "failed", detail: "field not found" } });
    s = h.engine.shareState("share-abc")!;
    assert.equal(s.testRun!.steps[0]!.status, "passed");
    assert.equal(s.testRun!.steps[1]!.status, "failed");
    assert.equal(s.testRun!.steps[1]!.detail, "field not found");

    // Step 3 is still running when the run finishes (e.g. the agent aborted).
    h.engine.updateTestRun("pv1", { step: { n: 3, status: "running" } });
    h.engine.finishTestRun("pv1", "failed", "1 of 3 steps failed");
    s = h.engine.shareState("share-abc")!;
    assert.equal(s.testRun!.status, "failed");
    assert.equal(s.testRun!.summary, "1 of 3 steps failed");
    // A finished run leaves no step spinning: the still-running step settles to
    // the run's verdict; already-settled steps are untouched.
    assert.equal(s.testRun!.steps[2]!.status, "failed");
    assert.equal(s.testRun!.steps[0]!.status, "passed");
  });

  it("a passed run settles a still-running step to passed, leaves pending steps pending", async () => {
    const h = makeEngine();
    h.engine.startPreview({
      app: rnApp,
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [{ platform: "ios" }],
      access: "public",
    });
    await waitForPhase(h.engine, "pv1", ["ready", "failed"]);

    h.engine.startTestRun("pv1", "Smoke", ["A", "B", "C"]);
    h.engine.updateTestRun("pv1", { step: { n: 1, status: "running" } });
    h.engine.finishTestRun("pv1", "passed", "ok");
    const s = h.engine.shareState("share-abc")!;
    assert.equal(s.testRun!.steps[0]!.status, "passed"); // was running → settled
    assert.equal(s.testRun!.steps[1]!.status, "pending"); // never reached → left calm
    assert.equal(s.testRun!.steps[2]!.status, "pending");
  });

  it("updateTestRun without a run throws an actionable error", async () => {
    const h = makeEngine();
    h.engine.startPreview({
      app: rnApp,
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [{ platform: "ios" }],
      access: "public",
    });
    assert.throws(() => h.engine.updateTestRun("pv1", { runStatus: "passed" }), /no test run/);
  });
});

describe("PreviewEngine migration pairing", () => {
  it("surfaces the live source preview and the target's ledger via shareState", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dh-mig-"));
    try {
      writeFileSync(
        join(dir, "deckhand.migration.yaml"),
        ["screens:", "  - name: Onboarding", "    status: matches", "  - name: Home", "    status: in-progress"].join("\n"),
      );

      let pv = 0;
      let sh = 0;
      const h = makeEngine({ genPreviewId: () => `pv-${++pv}`, genShareId: () => `sh-${++sh}` });

      const sourceApp: App = { id: "old-app", repo: "github.com/okam/old", type: "react-native", defaultBranch: "main", bundleId: "com.example.old", env: {} };
      const targetApp: App = { id: "new-app", path: dir, repo: "github.com/okam/new", type: "react-native", defaultBranch: "main", bundleId: "com.example.new", migratesFrom: "old-app", env: {} };

      const src = h.engine.startPreview({ app: sourceApp, source: "git", spec: { kind: "branch", branch: "main" }, devices: [{ platform: "ios" }], access: "public" });
      await waitForPhase(h.engine, src.previewId, ["ready", "failed"]);
      const tgt = h.engine.startPreview({ app: targetApp, source: "local", devices: [{ platform: "ios" }], access: "public" });

      const s = h.engine.shareState(tgt.shareId)!;
      assert.ok(s, "target shareState resolves");
      assert.equal(s.panes.length, 2, "target shareState carries the source as a second pane");
      assert.equal(s.panes[0]!.shareId, src.shareId, "the source comes first — the page reads old → new");
      assert.equal(s.panes[0]!.repo, "github.com/okam/old");
      assert.equal(s.panes[0]!.devices.length, 1);
      assert.equal(s.panes[1]!.self, true);
      assert.ok(s.ledger, "target shareState carries the ledger");
      assert.equal(s.ledger!.screens.length, 2);
      assert.equal(s.ledger!.screens[0]!.name, "Onboarding");
      assert.equal(s.ledger!.screens[0]!.status, "matches");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hides a migration source the target's viewer could never unlock", async () => {
    // Two REGISTERED apps with independent PINs — unlike a compare reference,
    // which is synthetic and always public. A public target must not carry a
    // PIN-protected source's pane: unlock only propagates out of a proven PIN on
    // the page's own share, so that pane would be refused every retry with no
    // pad to type into, and minting its cookie anyway would hand the source's
    // stream to anyone holding the target's public link.
    let pv = 0;
    let sh = 0;
    const h = makeEngine({ genPreviewId: () => `pv-${++pv}`, genShareId: () => `sh-${++sh}` });
    const sourceApp: App = { id: "old-app", repo: "github.com/okam/old", type: "react-native", defaultBranch: "main", bundleId: "com.example.old", env: {} };
    const targetApp: App = { id: "new-app", repo: "github.com/okam/new", type: "react-native", defaultBranch: "main", bundleId: "com.example.new", migratesFrom: "old-app", env: {} };

    const src = h.engine.startPreview({ app: sourceApp, source: "git", spec: { kind: "branch", branch: "main" }, devices: [{ platform: "ios" }], access: "public" });
    await waitForPhase(h.engine, src.previewId, ["ready", "failed"]);
    const tgt = h.engine.startPreview({ app: targetApp, source: "git", spec: { kind: "branch", branch: "main" }, devices: [{ platform: "ios" }], access: "public" });

    h.engine.setAppPin("old-app", "1234"); // source protected, target public
    assert.equal(h.engine.shareState(tgt.shareId)!.panes.length, 1, "an unreachable source pane must not be advertised");
    assert.deepEqual(h.engine.pairedShareIds(tgt.shareId), [], "and must not be handed an unlock cookie");

    // Protect the target too and the pane comes back: the unlock now rides on a
    // PIN this page actually proves, instead of being granted from nothing.
    h.engine.setAppPin("new-app", "4321");
    assert.equal(h.engine.shareState(tgt.shareId)!.panes[0]!.shareId, src.shareId);
    assert.deepEqual(h.engine.pairedShareIds(tgt.shareId), [src.shareId]);

    // The source's own page never renders a target pane, so it must never mint
    // the target's cookie — that would be pure gratuitous widening.
    assert.deepEqual(h.engine.pairedShareIds(src.shareId), []);
  });

  it("gives an ordinary (non-migration) app one pane and no ledger", async () => {
    const h = makeEngine();
    h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "main" }, devices: [{ platform: "ios" }], access: "public" });
    await waitForPhase(h.engine, "pv1", ["ready", "failed"]);
    const s = h.engine.shareState("share-abc")!;
    assert.equal(s.panes.length, 1, "just its own pane — nothing to compare against");
    assert.equal(s.ledger, undefined);
  });
});

describe("PreviewEngine compare session", () => {
  const uniqIds = () => {
    let pid = 0;
    let sid = 0;
    return { genPreviewId: () => `pv${++pid}`, genShareId: () => `share-${++sid}` };
  };

  it("links a working preview to a live reference and surfaces both panes + ledger", () => {
    const h = makeEngine(uniqIds());
    const ref = h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "main" }, devices: [{ platform: "ios" }], access: "public" });
    const work = h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "feature" }, devices: [{ platform: "ios" }], access: "public" });
    assert.notEqual(ref.shareId, work.shareId);

    const counts = h.engine.startCompare(work.previewId, [{ shareId: ref.shareId, repo: "acme/app", ref: "main" }], ["Login", "Home"]);
    assert.deepEqual(counts, { pending: 2, doing: 0, done: 0, adjusted: 0, regression: 0 });

    const s = h.engine.shareState(work.shareId)!;
    assert.deepEqual(
      s.panes.map((x) => x.shareId),
      [ref.shareId, work.shareId],
    );
    assert.equal(s.panes[0]!.ref, "main");
    assert.equal(s.panes[0]!.devices.length, 1);
    assert.deepEqual(
      s.ledger?.screens.map((x) => [x.name, x.status]),
      [
        ["Login", "pending"],
        ["Home", "pending"],
      ],
    );
  });

  it("mints a page's panes, and never the other way round", () => {
    // The viewer streams each pane from that pane's own shareId, whose unlock
    // cookie is path-scoped to it, so unlocking the PAGE has to mint for its
    // panes — else they sit on "Connecting…" with the WS refused every second.
    //
    // The reverse must NOT hold. Panes are keyed by content, so two pages naming
    // the same source share one pane; a reverse mint would hand whoever holds
    // one page's PIN a valid cookie for the other page — different app,
    // different owner, no PIN proven. See the cross-page test below.
    const h = makeEngine(uniqIds());
    const ref = h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "main" }, devices: [{ platform: "ios" }], access: "public" });
    const work = h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "feature" }, devices: [{ platform: "ios" }], access: "public" });
    h.engine.startCompare(work.previewId, [{ shareId: ref.shareId, repo: "acme/app", ref: "main" }], []);

    assert.deepEqual(h.engine.pairedShareIds(work.shareId), [ref.shareId]);
    assert.deepEqual(h.engine.pairedShareIds(ref.shareId), [], "a pane does not unlock the page holding it");
    assert.deepEqual(h.engine.pairedShareIds("no-such-share"), []);
  });

  it("tears down a pane the page stopped referencing, unless another page has it", async () => {
    // start_preview is idempotent and is the documented way to re-answer "what's
    // the link?", so re-calling it with a different `alongside` is expected. The
    // dropped pane used to keep its simulator, Metro port and worktree with no
    // previewId ever returned to the agent and no way for stop_preview to reach
    // it — only the idle sweep, an hour later.
    const h = makeEngine({ ...uniqIds(), config: { ...config, limits: { ...config.limits, maxTotalDevices: 8 } } });
    const mk = (branch: string) =>
      h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch }, devices: [{ platform: "ios" }], access: "public" });
    const old = mk("v1");
    const next = mk("v2");
    const page = mk("feature");
    for (const p of [old, next, page]) await waitForPhase(h.engine, p.previewId, ["ready", "failed"]);

    h.engine.startCompare(page.previewId, [{ shareId: old.shareId, repo: "r", ref: "v1", previewId: old.previewId }], []);
    h.engine.startCompare(page.previewId, [{ shareId: next.shareId, repo: "r", ref: "v2", previewId: next.previewId }], []);
    await new Promise((r) => setTimeout(r, 50)); // the teardown is fire-and-forget
    assert.equal(h.engine.getStatus(old.previewId), null, "the dropped pane is collected");
    assert.ok(h.engine.getStatus(next.previewId), "and the new one is not");
  });

  it("keeps a dropped pane alive while another page still shows it", async () => {
    const h = makeEngine({ ...uniqIds(), config: { ...config, limits: { ...config.limits, maxTotalDevices: 8 } } });
    const mk = (branch: string) =>
      h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch }, devices: [{ platform: "ios" }], access: "public" });
    const shared = mk("v1");
    const pageA = mk("a");
    const pageB = mk("b");
    for (const p of [shared, pageA, pageB]) await waitForPhase(h.engine, p.previewId, ["ready", "failed"]);
    const ref = { shareId: shared.shareId, repo: "r", ref: "v1", previewId: shared.previewId };

    h.engine.startCompare(pageA.previewId, [ref], []);
    h.engine.startCompare(pageB.previewId, [ref], []);
    h.engine.startCompare(pageA.previewId, [], []); // A drops it; B still has it
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(h.engine.getStatus(shared.previewId), "content-keyed panes are shared, so dropping one reference is not enough");
  });

  it("hides a pane the page can no longer unlock, instead of hanging it", () => {
    // Panes inherit the page's access at boot, so the two normally match — until
    // `set_pin --remove` makes the page public while the pane keeps its PIN. The
    // pane was still advertised but no longer minted for, so the viewer mounted
    // it and had its WS refused once a second forever, with no pad: the pad only
    // renders for the page's own shareId. The migratesFrom branch had guarded
    // this from the start; the compare branch never did.
    const h = makeEngine(uniqIds());
    const pane = h.engine.startPreview({ app: { ...rnApp, id: "pane-app" }, source: "git", spec: { kind: "branch", branch: "main" }, devices: [{ platform: "ios" }], access: "password" });
    const page = h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "feature" }, devices: [{ platform: "ios" }], access: "password" });
    h.engine.setAppPin("pane-app", "1111");
    h.engine.setAppPin(rnApp.id, "2222");
    h.engine.startCompare(page.previewId, [{ shareId: pane.shareId, repo: "acme/app", ref: "main" }], []);

    assert.equal(h.engine.shareState(page.shareId)!.panes.length, 2, "both protected: the pane shows");
    assert.deepEqual(h.engine.pairedShareIds(page.shareId), [pane.shareId]);

    h.engine.setAppPin(rnApp.id, null); // the page goes public; the pane does not
    assert.equal(h.engine.shareState(page.shareId)!.panes.length, 1, "an unreachable pane is not advertised");
    assert.deepEqual(h.engine.pairedShareIds(page.shareId), [], "…and not minted for either");
  });

  it("never lets one page's PIN reach another page that shares a pane", () => {
    // The escalation this replaced: pages A and B both name the same source, so
    // they land on ONE pane P (content-keyed, deliberately — it is what makes
    // reuse possible). A holder of B's link and PIN unlocked P, and the mint
    // then handed them a cookie for A, with A's shareId disclosed in its Path.
    const h = makeEngine({ ...uniqIds(), config: { ...config, limits: { ...config.limits, maxTotalDevices: 8 } } });
    const mk = (branch: string) =>
      h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch }, devices: [{ platform: "ios" }], access: "public" });
    const shared = mk("main");
    const pageA = mk("a");
    const pageB = mk("b");
    const ref = { shareId: shared.shareId, repo: "acme/app", ref: "main" };
    h.engine.startCompare(pageA.previewId, [ref], []);
    h.engine.startCompare(pageB.previewId, [ref], []);

    assert.deepEqual(h.engine.pairedShareIds(pageA.shareId), [shared.shareId], "each page reaches its own pane");
    assert.deepEqual(h.engine.pairedShareIds(pageB.shareId), [shared.shareId]);
    assert.deepEqual(
      h.engine.pairedShareIds(shared.shareId),
      [],
      "and the shared pane reaches NEITHER page — that was the escalation",
    );
  });

  it("keeps recorded verdicts when the checklist is seeded again", () => {
    // start_preview is idempotent and is the documented way to re-answer
    // "what's the link?", so an agent asking for it again mid-port used to reset
    // every verdict to pending and lose the whole session's judgements.
    const h = makeEngine(uniqIds());
    const work = h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "main" }, devices: [{ platform: "ios" }], access: "public" });
    h.engine.startCompare(work.previewId, [], ["Login", "Home"]);
    h.engine.setCompareItem(work.previewId, { item: "Login", verdict: "done", note: "checked" });

    // The same call again, as an idempotent re-invocation makes it.
    h.engine.startCompare(work.previewId, [], ["Login", "Home"]);
    const st = h.engine.compareStatus(work.previewId)!;
    assert.equal(st.items.find((i) => i.name === "Login")!.verdict, "done");
    assert.equal(st.items.find((i) => i.name === "Login")!.note, "checked");
    assert.equal(st.items.find((i) => i.name === "Home")!.verdict, "pending");

    // An item recorded but not re-seeded is kept — the list only ever grows.
    h.engine.setCompareItem(work.previewId, { item: "Profile", verdict: "regression" });
    h.engine.startCompare(work.previewId, [], ["Login"]);
    assert.equal(h.engine.compareStatus(work.previewId)!.items.length, 3);
  });

  it("surfaces every live source as a pane, own share last", () => {
    // The page is a set of panes, and the order is old → new: references first,
    // this share's own last, so a migration reads left-to-right as before→after.
    const h = makeEngine({ ...uniqIds(), config: { ...config, limits: { ...config.limits, maxTotalDevices: 8 } } });
    const mk = (branch: string) =>
      h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch }, devices: [{ platform: "ios" }], access: "public" });
    const old = mk("old");
    const main = mk("main");
    const work = mk("feature");
    h.engine.startCompare(
      work.previewId,
      [
        { shareId: old.shareId, repo: "acme/old", ref: "old" },
        { shareId: main.shareId, repo: "acme/app", ref: "main" },
      ],
      [],
    );

    const panes = h.engine.shareState(work.shareId)!.panes;
    assert.deepEqual(
      panes.map((x) => x.shareId),
      [old.shareId, main.shareId, work.shareId],
    );
    // repo + ref is what names a pane; there is no separate label to set.
    assert.deepEqual(
      panes.slice(0, 2).map((x) => [x.repo, x.ref]),
      [
        ["acme/old", "old"],
        ["acme/app", "main"],
      ],
    );
    assert.equal(panes[2]!.ref, "feature", "the page's own pane is named from its own app + ref");
    assert.ok(panes[2]!.repo, "…and always has a repo to show");
    assert.deepEqual(
      panes.map((x) => x.self),
      [undefined, undefined, true],
      "exactly one pane is the page's own",
    );
    assert.equal(panes[0]!.devices.length, 1);
  });

  it("gives an ordinary preview a single self pane", () => {
    const h = makeEngine(uniqIds());
    const solo = h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "main" }, devices: [{ platform: "ios" }], access: "public" });
    const panes = h.engine.shareState(solo.shareId)!.panes;
    assert.equal(panes.length, 1);
    assert.equal(panes[0]!.self, true);
    assert.equal(panes[0]!.shareId, solo.shareId);
  });

  it("drops a dead reference from panes but keeps the live ones", () => {
    const h = makeEngine(uniqIds());
    const live = h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "main" }, devices: [{ platform: "ios" }], access: "public" });
    const work = h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "feature" }, devices: [{ platform: "ios" }], access: "public" });
    h.engine.startCompare(
      work.previewId,
      [
        { shareId: "not-live", repo: "r", ref: "gone" },
        { shareId: live.shareId, repo: "acme/app", ref: "main" },
      ],
      [],
    );
    assert.deepEqual(
      h.engine.shareState(work.shareId)!.panes.map((x) => x.shareId),
      [live.shareId, work.shareId],
    );
  });

  it("keeps every pane's idle clock alive while the page is being watched", async () => {
    // The viewer polls ONE shareId — the page's own. The extra panes have nobody
    // polling them directly, so a single markActive let them age out on their own
    // idle timer and get torn down underneath a page someone was actively
    // watching: the reference column simply vanished mid-session.
    const clock = { t: Date.now() };
    const h = makeEngine({
      ...uniqIds(),
      now: () => clock.t,
      config: { ...config, limits: { ...config.limits, maxTotalDevices: 8, idleMinutes: 1 } },
    });
    const mk = (branch: string) =>
      h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch }, devices: [{ platform: "ios" }], access: "public" });
    const ref = mk("main");
    const work = mk("feature");
    for (const p of [ref, work]) await waitForPhase(h.engine, p.previewId, ["ready", "failed"]);
    h.engine.startCompare(work.previewId, [{ shareId: ref.shareId, repo: "acme/app", ref: "main", previewId: ref.previewId }], []);

    // Age everything past the idle window, then poll the page exactly as a viewer does.
    clock.t += 5 * 60_000;
    assert.ok(h.engine.shareState(work.shareId), "the page still answers");

    assert.deepEqual(await h.engine.sweepIdle(), [], "polling the page must reprieve every pane on it, not just its own");
    assert.ok(h.engine.getStatus(ref.previewId), "the reference pane survives");
    assert.ok(h.engine.getStatus(work.previewId));
  });

  it("unlocks every pane of a three-source compare", () => {
    // The whole point of the pane model: old app + main + this branch is three
    // sources on one page, and one PIN has to reach all of them. Each extra pane
    // streams from its own shareId, so each needs its own path-scoped cookie.
    const h = makeEngine({ ...uniqIds(), config: { ...config, limits: { ...config.limits, maxTotalDevices: 8 } } });
    const mk = (branch: string) =>
      h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch }, devices: [{ platform: "ios" }], access: "public" });
    const a = mk("main");
    const b = mk("old");
    const work = mk("feature");
    h.engine.startCompare(
      work.previewId,
      [
        { shareId: a.shareId, repo: "acme/app", ref: "main" },
        { shareId: b.shareId, repo: "acme/old", ref: "old" },
      ],
      [],
    );

    assert.deepEqual(h.engine.pairedShareIds(work.shareId).sort(), [a.shareId, b.shareId].sort());
    // …and no pane mints for the page, in either direction.
    assert.deepEqual(h.engine.pairedShareIds(a.shareId), []);
    assert.deepEqual(h.engine.pairedShareIds(b.shareId), []);
  });

  it("skips a dead pane when minting cookies but keeps the live ones", () => {
    const h = makeEngine(uniqIds());
    const live = h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "main" }, devices: [{ platform: "ios" }], access: "public" });
    const work = h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "feature" }, devices: [{ platform: "ios" }], access: "public" });
    h.engine.startCompare(
      work.previewId,
      [
        { shareId: "not-live", repo: "r", ref: "gone" },
        { shareId: live.shareId, repo: "acme/app", ref: "main" },
      ],
      [],
    );
    assert.deepEqual(h.engine.pairedShareIds(work.shareId), [live.shareId]);
  });

  it("de-dupes references naming the same share twice", () => {
    const h = makeEngine(uniqIds());
    const ref = h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "main" }, devices: [{ platform: "ios" }], access: "public" });
    const work = h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "feature" }, devices: [{ platform: "ios" }], access: "public" });
    h.engine.startCompare(
      work.previewId,
      [
        { shareId: ref.shareId, repo: "acme/app", ref: "main" },
        { shareId: ref.shareId, repo: "acme/app", ref: "main" },
      ],
      [],
    );
    assert.equal(h.engine.compareStatus(work.previewId)!.references.length, 1);
    assert.deepEqual(h.engine.pairedShareIds(work.shareId), [ref.shareId]);
  });

  it("reports no pairing when the reference isn't live (nothing to unlock)", () => {
    const h = makeEngine(uniqIds());
    const work = h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "main" }, devices: [{ platform: "ios" }], access: "public" });
    h.engine.startCompare(work.previewId, [{ shareId: "not-live", repo: "r", ref: "main" }], ["A"]);
    assert.deepEqual(h.engine.pairedShareIds(work.shareId), []);
  });

  it("sets a verdict, appends an unknown item, and recounts", () => {
    const h = makeEngine(uniqIds());
    const work = h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "main" }, devices: [{ platform: "ios" }], access: "public" });
    h.engine.startCompare(work.previewId, [{ shareId: "ref-x", repo: "r", ref: "main" }], ["A", "B"]);
    assert.equal(h.engine.setCompareItem(work.previewId, { item: "A", verdict: "done" }).done, 1);
    assert.equal(h.engine.setCompareItem(work.previewId, { item: "C", verdict: "adjusted", note: "redesigned" }).adjusted, 1);
    const st = h.engine.compareStatus(work.previewId)!;
    assert.equal(st.items.length, 3);
    assert.equal(st.items.find((i) => i.name === "C")?.note, "redesigned");
    assert.deepEqual(st.counts, { pending: 1, doing: 0, done: 1, adjusted: 1, regression: 0 });
  });

  it("surfaces the ledger even when the reference isn't live (no second pane)", () => {
    const h = makeEngine();
    const work = h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "main" }, devices: [{ platform: "ios" }], access: "public" });
    h.engine.startCompare(work.previewId, [{ shareId: "not-live", repo: "r", ref: "main" }], ["A"]);
    const s = h.engine.shareState("share-abc")!;
    assert.equal(s.panes.length, 1, "a dead reference is not advertised as a pane");
    assert.equal(s.ledger?.screens.length, 1);
  });

  it("tears down the paired reference preview when the working preview stops", async () => {
    const h = makeEngine(uniqIds());
    const ref = h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "main" }, devices: [{ platform: "ios" }], access: "public" });
    const work = h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "feature" }, devices: [{ platform: "ios" }], access: "public" });
    await waitForPhase(h.engine, ref.previewId, ["ready", "failed"]);
    await waitForPhase(h.engine, work.previewId, ["ready", "failed"]);
    h.engine.startCompare(work.previewId, [{ shareId: ref.shareId, repo: "acme/app", ref: "main", previewId: ref.previewId }], []);

    assert.equal(await h.engine.stopPreview(work.previewId), true);
    assert.equal(h.engine.getStatus(work.previewId), null);
    assert.equal(h.engine.getStatus(ref.previewId), null); // cascaded — no orphaned reference preview
  });

  it("keeps a shared reference alive until the last compare using it stops", async () => {
    const h = makeEngine({ ...uniqIds(), config: { ...config, limits: { ...config.limits, maxTotalDevices: 8 } } });
    const ref = h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "main" }, devices: [{ platform: "ios" }], access: "public" });
    const w1 = h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "f1" }, devices: [{ platform: "ios" }], access: "public" });
    const w2 = h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "f2" }, devices: [{ platform: "ios" }], access: "public" });
    for (const p of [ref, w1, w2]) await waitForPhase(h.engine, p.previewId, ["ready", "failed"]);
    h.engine.startCompare(w1.previewId, [{ shareId: ref.shareId, repo: "r", ref: "main", previewId: ref.previewId }], []);
    h.engine.startCompare(w2.previewId, [{ shareId: ref.shareId, repo: "r", ref: "main", previewId: ref.previewId }], []);

    await h.engine.stopPreview(w1.previewId);
    assert.equal(h.engine.getStatus(w1.previewId), null);
    assert.ok(h.engine.getStatus(ref.previewId), "reference stays up while w2 still pairs against it");

    await h.engine.stopPreview(w2.previewId);
    assert.equal(h.engine.getStatus(ref.previewId), null); // last user gone → cascaded
  });
});

// ---------------------------------------------------------------------------
// Auto-teardown. A preview only ever ended on an explicit stop_preview, so
// forgotten ones kept a simulator booted (and, on Android, a QEMU process on a
// core) until the machine ran out. The janitor collects them; failed previews
// keep a short grace window so the viewer's Rebuild button still works.
// ---------------------------------------------------------------------------

describe("PreviewEngine idle sweep", () => {
  const clock = { t: 1_700_000_000_000 };
  const ids = { n: 0 };
  const makeSwept = (runStepResult?: (step: CommandStep) => RunResult) =>
    makeEngine(
      { now: () => clock.t, genPreviewId: () => `pv${++ids.n}`, genShareId: () => `share-${ids.n}` },
      runStepResult,
    );

  beforeEach(() => {
    clock.t = 1_700_000_000_000;
    ids.n = 0;
  });

  it("stops a ready preview nobody has watched for idleMinutes", async () => {
    const h = makeSwept();
    h.engine.startPreview({
      app: rnApp,
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [{ platform: "ios" }],
      access: "public",
    });
    await waitForPhase(h.engine, "pv1", ["ready", "failed"]);

    clock.t += 44 * 60_000; // still inside the window
    assert.deepEqual(await h.engine.sweepIdle(), []);

    clock.t += 2 * 60_000; // now past 45 minutes of silence
    assert.deepEqual(await h.engine.sweepIdle(), ["pv1"]);
    assert.equal(h.engine.findByShareId("share-1"), null);
    assert.ok(h.simctlCalls.some((c) => c.startsWith("delete ")));
  });

  it("keeps a preview alive while the viewer is polling it", async () => {
    const h = makeSwept();
    h.engine.startPreview({
      app: rnApp,
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [{ platform: "ios" }],
      access: "public",
    });
    await waitForPhase(h.engine, "pv1", ["ready", "failed"]);

    for (let i = 0; i < 3; i++) {
      clock.t += 40 * 60_000;
      assert.ok(h.engine.shareState("share-1"), "viewer poll"); // resets the idle clock
      assert.deepEqual(await h.engine.sweepIdle(), []);
    }
  });

  it("keeps a preview alive while an agent drives it (no viewer, no status poll)", async () => {
    const h = makeSwept();
    h.engine.startPreview({
      app: rnApp,
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [{ platform: "ios" }],
      access: "public",
    });
    await waitForPhase(h.engine, "pv1", ["ready", "failed"]);

    // An agent's testing loop: logs/screenshot/test-run only. Nobody has the
    // viewer open, so if these don't count as activity the sweep deletes the
    // simulators out from under the run.
    for (let i = 0; i < 3; i++) {
      clock.t += 40 * 60_000;
      assert.equal(typeof h.engine.logs("pv1", undefined, "build"), "string");
      h.engine.startTestRun("pv1", "smoke", ["open app"]);
      assert.deepEqual(await h.engine.sweepIdle(), []);
    }
  });

  it("does not call a long build stuck while it is still producing output", async () => {
    // The phases are coarse: a cold CocoaPods/Gradle build sits in "building"
    // for well over stuckMinutes while streaming healthy output. Judging
    // progress by phase transitions alone tore it down mid-build.
    let releaseBuild: (() => void) | null = null;
    const building = new Promise<void>((r) => (releaseBuild = r));
    const h = makeEngine({
      now: () => clock.t,
      genPreviewId: () => `pv${++ids.n}`,
      genShareId: () => `share-${ids.n}`,
      runStep: async (step: CommandStep, opts?: { onLog?: (line: string, src: string) => void }) => {
        if (step.name !== "build") return { code: 0, timedOut: false, aborted: false };
        for (let i = 0; i < 4; i++) {
          clock.t += 30 * 60_000; // half an hour between lines; stuckMinutes is 90
          opts?.onLog?.(`Compiling chunk ${i}`, "stdout");
          assert.deepEqual(await h.engine.sweepIdle(), [], "output means it is alive");
        }
        await building;
        return { code: 0, timedOut: false, aborted: false };
      },
    } as unknown as Partial<PreviewEngineDeps>);

    h.engine.startPreview({
      app: rnApp,
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [{ platform: "ios" }],
      access: "public",
    });
    await waitForPhase(h.engine, "pv1", ["building", "ready", "failed"]);
    // Now go quiet past the window: silence IS stuck.
    clock.t += 100 * 60_000;
    assert.deepEqual(await h.engine.sweepIdle(), ["pv1"]);
    releaseBuild!();
  });

  it("releases a device whose boot finished after the sweep collected its preview", async () => {
    // `simctl create` can't be cancelled. If it returns after teardown already
    // ran and saw no udid, the simulator survives as an orphan — and with
    // pooling on, as a slot a newer preview can lease and boot underneath.
    let releaseCreate: (() => void) | null = null;
    const creating = new Promise<void>((r) => (releaseCreate = r));
    const simCalls: string[] = [];
    const h = makeEngine({
      now: () => clock.t,
      genPreviewId: () => `pv${++ids.n}`,
      genShareId: () => `share-${ids.n}`,
      simctl: fakeSimctl({
        listRuntimes: async () => [{ identifier: "rt.26", name: "iOS 26.0", version: "26.0", isAvailable: true }],
        listDeviceTypes: async () => [{ identifier: "dt.16pro", name: "iPhone 16 Pro" }],
        listDevices: async () => [],
        create: async (name: string) => {
          simCalls.push(`create ${name}`);
          await creating; // still running when the sweep collects the preview
          return "UDID-LATE";
        },
        bootAndWait: async () => void simCalls.push("boot"),
        appContainer: async () => "/path/to/App.app",
        install: async () => {},
        launch: async () => {},
        openUrl: async () => {},
        shutdown: async (u: string) => void simCalls.push(`shutdown ${u}`),
        delete: async (u: string) => void simCalls.push(`delete ${u}`),
      }),
    } as unknown as Partial<PreviewEngineDeps>);

    h.engine.startPreview({
      app: rnApp,
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [{ platform: "ios" }],
      access: "public",
    });
    await new Promise((r) => setTimeout(r, 20));
    await h.engine.stopPreview("pv1"); // aborts mid-create

    releaseCreate!();
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(simCalls.includes("create deckhand-pv1-ios-0"));
    assert.ok(!simCalls.includes("boot"), "an abandoned device must not go on to boot");
    assert.ok(simCalls.includes("shutdown UDID-LATE"), "the late simulator is shut down");
    assert.ok(simCalls.includes("delete UDID-LATE"), "…and deleted, not left as an orphan");
  });

  it("tears a failed preview down only after its rebuild grace window", async () => {
    const h = makeSwept((step) => ({ code: step.name === "build" ? 1 : 0, timedOut: false, aborted: false }));
    h.engine.startPreview({
      app: rnApp,
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [{ platform: "ios" }],
      access: "public",
    });
    assert.equal(await waitForPhase(h.engine, "pv1", ["ready", "failed"]), "failed");

    clock.t += 10 * 60_000; // inside the grace window: the sim stays for a Rebuild
    assert.deepEqual(await h.engine.sweepIdle(), []);
    assert.ok(!h.simctlCalls.some((c) => c.startsWith("delete ")));

    clock.t += 10 * 60_000;
    assert.deepEqual(await h.engine.sweepIdle(), ["pv1"]);
    assert.ok(h.simctlCalls.some((c) => c.startsWith("delete ")));
  });

  it("re-wipes a pooled AVD when the boot that should have wiped it failed", async () => {
    // The tenant was recorded BEFORE the wipe ran — the wipe is a `-wipe-data`
    // flag on a boot that can throw or time out after 240s. A failed boot
    // therefore left the new app recorded as the owner, so the retry computed
    // wipeData=false and handed it an AVD still holding the PREVIOUS tenant's
    // app storage, accounts and cookies, across owner scopes, in silence.
    const wipes: boolean[] = [];
    let failNext = true;
    const cfg = { ...config, limits: { ...config.limits, reuseDevices: true, maxTotalDevices: 8 } };
    const h = makeEngine({
      config: cfg,
      android: fakeAndroid({
        ...(androidFake() as object),
        bootEmulator: async (_avd: string, port: number, _img: unknown, opts: { wipeData?: boolean } = {}) => {
          wipes.push(!!opts.wipeData);
          if (failNext) throw new Error("emulator: timed out waiting for boot");
          return `emulator-${port}`;
        },
      }),
    });

    const android = () => ({ platform: "android" as const, runtime: "34" });
    // App A takes the pooled AVD (nothing to wipe — it is fresh).
    h.engine.startPreview({ app: { ...rnApp, id: "app-a" }, source: "git", spec: { kind: "branch", branch: "main" }, devices: [android()], access: "public" });
    await waitForPhase(h.engine, "pv1", ["ready", "failed"]);
    // Release the lease, or app B is handed a SECOND (fresh) pool slot and never
    // exercises the reuse path at all.
    await h.engine.stopPreview("pv1");

    // App B takes the same slot next: the wipe is requested, and the boot fails.
    h.engine.startPreview({ app: { ...rnApp, id: "app-b" }, source: "git", spec: { kind: "branch", branch: "main" }, devices: [android()], access: "public" });
    await waitForPhase(h.engine, "pv2", ["ready", "failed"]);
    assert.equal(wipes[wipes.length - 1], true, "app B asked for a wipe");
    await h.engine.stopPreview("pv2");

    // App B retries. The wipe never actually happened, so it must be asked for again.
    failNext = false;
    h.engine.startPreview({ app: { ...rnApp, id: "app-b" }, source: "git", spec: { kind: "branch", branch: "main" }, devices: [android()], access: "public" });
    await waitForPhase(h.engine, "pv3", ["ready", "failed"]);
    assert.equal(wipes[wipes.length - 1], true, "a boot that failed cannot count as the wipe having run");
  });

  it("recovers a device whose first helper never produced a frame", async () => {
    // A helper that comes up and then stays silent is usually the helper, not
    // the device — a cold sim under load, or a daemon adopted from a previous
    // process. It used to be fatal on the first try: the pane read "This device
    // didn't start" for the life of the preview and only restart_preview cleared
    // it. The viewer already retried on its side; the server did not.
    const h = makeEngine();
    h.firstFrameResults.push(false, false); // two silent helpers, then a good one
    h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "main" }, devices: [{ platform: "ios" }], access: "public" });

    assert.equal(await waitForPhase(h.engine, "pv1", ["ready", "failed"]), "ready");
    assert.equal(h.attachCalls.length, 3, "each attempt asks for a fresh helper");
    assert.ok(h.detached.length >= 2, "and discards the silent one first — attach is idempotent per device");
  });

  it("gives up after a bounded number of silent helpers", async () => {
    const h = makeEngine();
    h.firstFrameResults.push(false, false, false, false);
    h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "main" }, devices: [{ platform: "ios" }], access: "public" });

    assert.equal(await waitForPhase(h.engine, "pv1", ["ready", "failed"]), "failed");
    assert.match(h.engine.getStatus("pv1")!.devices[0]!.error ?? "", /no first frame \(3 attempts\)/);
  });

  it("will not unprotect a web preview whose dev server is still attached", async () => {
    // The guard used to key on PHASE, and the proxy's web resolver keys on the ATTACHED
    // STREAM — it never looks at the phase. Those are different questions, and the gap was an
    // auth hole: a `failed` web preview whose dev server was still running stayed fully
    // reachable, while this guard skipped it and let `set_pin remove:true` make it public —
    // exactly the state startPreview refuses to create at boot.
    const h = makeEngine();
    h.engine.setAppPin(webApp.id, "1234"); // a web app may not be previewed without one
    h.engine.startPreview({ app: webApp, source: "local", devices: [{ platform: "web" }], access: "password" });
    assert.equal(await waitForPhase(h.engine, "pv1", ["ready", "failed"], 8000), "ready");

    assert.throws(
      () => h.engine.setAppPin(webApp.id, null),
      /cannot be made public/,
      "while a dev server is attached, removing the PIN exposes it",
    );

    // Once torn down there is nothing attached and nothing to protect, so it is allowed.
    await h.engine.stopPreview("pv1");
    h.engine.setAppPin(webApp.id, null);
  });

  it("stops a failed web device's dev server instead of leaving it running", async () => {
    // attachWebAndReady attaches the stream BEFORE waiting for the dev server, and failDevice
    // used to do neither of these — so a failure left a live dev server on its port with an
    // attached stream. Driven through an early failure (a source dir that does not exist),
    // because the real readiness timeout is 180s and not worth waiting for here.
    const h = makeEngine();
    const missing: App = { ...webApp, id: "gone-web", path: "/definitely/not/here" };
    h.engine.setAppPin(missing.id, "1234");
    h.engine.startPreview({ app: missing, source: "local", devices: [{ platform: "web" }], access: "password" });
    assert.equal(await waitForPhase(h.engine, "pv1", ["ready", "failed"], 8000), "failed");
    assert.ok(
      h.devProcCalls.some((c) => c === "stop gone-web:web"),
      `the web dev process is stopped on failure — saw ${JSON.stringify(h.devProcCalls)}`,
    );
  });

  it("does not tear down a preview that was reactivated mid-sweep", async () => {
    // `doomed` is decided for the whole set before the first await, and each stopPreview takes
    // seconds — it shuts down and deletes simulators. So when several previews go idle
    // together (the normal case: a session's previews all age out while the user is away),
    // someone can open the viewer on the second one while the first is still being torn down.
    // Tearing it down anyway is the worst thing this sweep can do: a preview somebody is
    // actively watching vanishes under them, and recovery costs a full rebuild.
    let clock = 1_000_000;
    let n = 0;
    const h = makeEngine({
      now: () => clock,
      genPreviewId: () => `pv${++n}`,
      genShareId: () => `share-${n}`,
      config: { ...config, limits: { ...config.limits, idleMinutes: 10 } },
    });
    for (const ref of ["a", "b"]) {
      h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: ref }, devices: [{ platform: "ios" }], access: "public" });
    }
    assert.equal(await waitForPhase(h.engine, "pv1", ["ready", "failed"]), "ready");
    assert.equal(await waitForPhase(h.engine, "pv2", ["ready", "failed"]), "ready");

    clock += 20 * 60_000; // both are now well past idleMinutes

    // Somebody opens pv2 the instant the sweep starts working through the list.
    const realStop = h.engine.stopPreview.bind(h.engine);
    h.engine.stopPreview = async (id: string) => {
      if (id === "pv1") h.engine.getStatus("pv2"); // a status poll counts as activity
      return realStop(id);
    };

    const stopped = await h.engine.sweepIdle();
    assert.deepEqual(stopped, ["pv1"], "the idle one goes; the reactivated one does not");
    assert.ok(h.engine.getStatus("pv2"), "pv2 is still alive");
    assert.ok(
      h.audit.some((e) => e.tool === "auto_stop_skipped"),
      "and the skip is recorded — a sweep that silently changes its mind is unexplainable later",
    );
  });

  it("says so when an idempotent start could not add the devices asked for", async () => {
    // findReusable matches app + source + ref and ignores the device list — right for the
    // daily loop, wrong for a genuinely different request. Asking for iOS + Android while an
    // iOS preview was live returned alreadyRunning:true and silently dropped Android. The
    // caller saw success and no Android, and the only way anyone found to get it was
    // stop_preview + start again, which reboots the simulators that were working.
    const h = makeEngine();
    h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "main" }, devices: [{ platform: "ios" }], access: "public" });
    assert.equal(await waitForPhase(h.engine, "pv1", ["ready", "failed"]), "ready");

    const again = h.engine.startPreview({
      app: rnApp,
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [{ platform: "ios" }, { platform: "android" }],
      access: "public",
    });
    assert.equal(again.alreadyRunning, true, "still the same preview — we do not mint a second");
    assert.deepEqual(again.notAdded, ["android"], "and it admits what it did not do");
    assert.match(again.nextStep ?? "", /stop_preview/, "with the way to get it");
    assert.match(again.nextStep ?? "", /reboots/, "and the cost, so the agent warns the user first");
  });

  it("stays quiet when the request is already satisfied", () => {
    // The daily loop must not grow a warning it does not need.
    const h = makeEngine();
    h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "main" }, devices: [{ platform: "ios" }], access: "public" });
    const again = h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "main" }, devices: [{ platform: "ios" }], access: "public" });
    assert.equal(again.alreadyRunning, true);
    assert.equal(again.notAdded, undefined);
    assert.equal(again.nextStep, undefined);
  });

  it("forgets an unregistered app's share id and PIN hash", () => {
    // Both are keyed by app id and were written on first preview but never removed, so
    // state.json grew an entry per app that ever existed — including the scrypt hash of a PIN
    // for a share nobody can reach any more. Neither is reachable without the app.
    const h = makeEngine();
    h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "main" }, devices: [{ platform: "ios" }], access: "public" });
    h.engine.setAppPin(rnApp.id, "1234");

    const before = h.store.load();
    assert.ok(before.shareIds[rnApp.id], "fixture sanity: the app has a stable share id");
    assert.ok(before.pins[rnApp.id], "fixture sanity: and a PIN hash");

    h.engine.forgetApp(rnApp.id);

    const after = h.store.load();
    assert.equal(after.shareIds[rnApp.id], undefined, "the share id is gone");
    assert.equal(after.pins[rnApp.id], undefined, "and so is the credential hash");
    assert.ok(
      h.audit.some((e) => e.tool === "forget_app"),
      "recorded — dropping a share id is a state change somebody may need to explain later",
    );
  });

  it("is a no-op for an app it never knew, and does not churn state", () => {
    const h = makeEngine();
    const audits = h.audit.length;
    h.engine.forgetApp("never-registered");
    assert.equal(h.audit.length, audits, "nothing happened, so nothing is recorded");
  });

  it("spares its own live processes when reaping orphans by marker", async () => {
    // The boot sweep runs AFTER the port is bound, so a start_preview that
    // landed in the meantime has children carrying the same env marker the sweep
    // hunts for. Called without keepPids it killed the server's own brand-new
    // bundler and left the preview `ready` with nothing serving — the device
    // reap guards this exact window with liveDeviceHandles(); this one did not.
    const keepSeen: Record<string, number[]> = {};
    const h = makeEngine({
      // Through the complete fakes, not an inline cast: the literal that used to sit here
      // declared `stopIfUnused` and `stopAll`, neither of which exists on MetroManager —
      // dead method names hidden by the very cast this harness was written to eliminate,
      // in the test for the bug that motivated it.
      metro: fakeMetro({ livePids: () => [4242] }),
      devProcs: fakeDevProcs({ livePids: () => [7777] }),
      reaper: fakeReaper({
        reap: async () => ({ sims: [], avds: [], keptPooled: [] }),
        reapOrphansByMarker: async (marker: string, keep: Iterable<number> = []) => {
          keepSeen[marker] = [...keep];
          return [];
        },
      }),
    });

    await h.engine.reapOrphans();
    assert.deepEqual(keepSeen["DECKHAND_METRO"], [4242], "the running Metro is spared");
    assert.deepEqual(keepSeen["DECKHAND_DEV_RUN"], [7777], "and the running livesync tree");
  });

  it("sweeps streaming helpers at boot, sparing the devices a live preview holds", async () => {
    // serve-sim daemonizes ITSELF (`--detach`), so it carries no `detached: true` in our
    // source and no env marker — the marker sweep above cannot see it, and neither can the
    // guardrail that enforces markers. It needs this explicit call, and for a while it had
    // none: StreamingRouter.reapOrphans() was written, tested, and never reached from boot,
    // so the orphan that motivated it (a helper 2h48m old serving a dead simulator's last
    // frame forever) survived every restart. Nothing failed, because nothing asked.
    const reapKeep: (readonly string[])[] = [];
    const h = makeEngine({
      streaming: {
        attach: async () => ({
          origin: "http://127.0.0.1:3100",
          helperBasePath: "/helper/x",
          waitForFirstFrame: async () => true,
          describe: async () => "tree",
          detach: async () => {},
        }),
        reapOrphans: async (keep?: ReadonlySet<string>) => void reapKeep.push([...(keep ?? [])]),
      },
    });

    await h.engine.reapOrphans();
    assert.equal(reapKeep.length, 1, "the boot sweep must reach the streaming backends");
    assert.deepEqual(reapKeep[0], [], "at boot nothing is live, so nothing is spared");

    // And with a preview holding a device, that device's helper survives the sweep — the
    // same window liveDeviceHandles() guards for simulators.
    h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "main" }, devices: [{ platform: "ios" }], access: "public" });
    assert.equal(await waitForPhase(h.engine, "pv1", ["ready", "failed"]), "ready");
    await h.engine.reapOrphans();
    assert.ok(reapKeep[1]!.length > 0, "a live preview's device must be named, or the sweep kills its own helper");
  });

  it("never allocates a console port an emulator already holds", async () => {
    // The worst-behaved bug in the audit. `emulator -port <busy>` fails to bind
    // and exits, but `adb -s emulator-<port> wait-for-device` resolves INSTANTLY
    // against the device already there and sys.boot_completed is already 1 — so
    // the boot looks perfect while every step after it (installApk -r -g,
    // forceStop, adb reverse, screenrecord on a public share, `adb emu kill` on
    // teardown) is aimed at a machine deckhand does not own. Typically the
    // developer's own Android Studio AVD, which the reaper deliberately spares.
    const booted: string[] = [];
    const h = makeEngine({
      android: fakeAndroid({
        ...(androidFake() as object),
        attachedSerials: async () => ["emulator-5554", "emulator-5556"], // not ours
        bootEmulator: async (_avd: string, port: number) => {
          booted.push(`emulator-${port}`);
          return `emulator-${port}`;
        },
      }),
    });
    h.engine.startPreview({
      app: rnApp,
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [{ platform: "android", runtime: "34" }],
      access: "public",
    });
    await waitForPhase(h.engine, "pv1", ["ready", "failed"]);
    assert.deepEqual(booted, ["emulator-5558"], "the first two ports are occupied by devices we did not start");
  });

  it("refuses to boot Android rather than guess when adb cannot be listed", async () => {
    // An unreadable device list is indistinguishable from an empty one, and
    // guessing "empty" is precisely the permissive direction that hijacks a
    // stranger's emulator. Fail loudly instead.
    const h = makeEngine({
      android: fakeAndroid({
        ...(androidFake() as object),
        attachedSerials: async () => {
          throw new Error("adb: not found");
        },
      }),
    });
    h.engine.startPreview({
      app: rnApp,
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [{ platform: "android", runtime: "34" }],
      access: "public",
    });
    assert.equal(await waitForPhase(h.engine, "pv1", ["ready", "failed"]), "failed");
    assert.match(h.engine.getStatus("pv1")!.devices[0]!.error ?? "", /list attached Android devices/);
  });

  it("counts a failed preview's still-booted devices against capacity", async () => {
    const h = makeSwept((step) => ({ code: step.name === "build" ? 1 : 0, timedOut: false, aborted: false }));
    h.engine.startPreview({
      app: rnApp,
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [{ platform: "ios" }, { platform: "ios" }], // fills maxTotalDevices (2)
      access: "public",
    });
    assert.equal(await waitForPhase(h.engine, "pv1", ["ready", "failed"]), "failed");

    // A different app, so the failed preview isn't reaped as "same app" first.
    assert.throws(
      () =>
        h.engine.startPreview({
          app: { ...rnApp, id: "other-app" },
          source: "git",
          spec: { kind: "branch", branch: "main" },
          devices: [{ platform: "ios" }],
          access: "public",
        }),
      /device capacity reached/,
    );
  });

  it("spares an in-flight device from the boot reap with pooling OFF", async () => {
    // With pooling off there is no lease to spare the device by, and the boot
    // reap runs after the port is bound — so a start_preview mid-`simctl create`
    // had its brand-new simulator shut down and deleted underneath it.
    let releaseCreate: (() => void) | null = null;
    const creating = new Promise<void>((r) => (releaseCreate = r));
    let keepSeen: { udids?: Iterable<string>; avds?: Iterable<string>; names?: Iterable<string> } = {};
    const h = makeEngine({
      config: { ...config, limits: { ...config.limits, reuseDevices: false } },
      reaper: fakeReaper({
        reap: async (keep: typeof keepSeen = {}) => {
          keepSeen = keep;
          return { sims: [], avds: [], keptPooled: [] };
        },
      }),
      simctl: fakeSimctl({
        listRuntimes: async () => [{ identifier: "rt.26", name: "iOS 26.0", version: "26.0", isAvailable: true }],
        listDeviceTypes: async () => [{ identifier: "dt.16pro", name: "iPhone 16 Pro" }],
        listDevices: async () => [],
        create: async () => {
          await creating;
          return "UDID-LATE";
        },
        bootAndWait: async () => {},
        appContainer: async () => "/path/to/App.app",
        install: async () => {},
        launch: async () => {},
        openUrl: async () => {},
        shutdown: async () => {},
        delete: async () => {},
      }),
    } as unknown as Partial<PreviewEngineDeps>);

    h.engine.startPreview({
      app: rnApp,
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [{ platform: "ios" }],
      access: "public",
    });
    await new Promise((r) => setTimeout(r, 20)); // now parked inside create()
    await h.engine.reapOrphans();

    assert.ok(
      [...(keepSeen.names ?? [])].includes("deckhand-pv1-ios-0"),
      "the name must be spared even though no UDID exists yet",
    );
    releaseCreate!();
  });

  it("kills the emulator by port when its boot throws, before freeing the port", async () => {
    // bootEmulator launches QEMU detached and only waits here. On a throw,
    // record.serial was never set, so nothing else can address the running
    // emulator — and returning the port to the pool lets the next preview
    // collide with it and stream the abandoned device.
    const androidCalls: string[] = [];
    const h = makeEngine({
      android: fakeAndroid({
        listSystemImages: async () => [{ pkg: "system-images;android-34;google_apis;arm64-v8a", api: 34 }],
        listAvds: async () => [],
        attachedSerials: async () => [],
        createAvd: async () => void androidCalls.push("createAvd"),
        bootEmulator: async () => {
          androidCalls.push("bootEmulator");
          throw new Error("did not finish booting");
        },
        shutdown: async (serial: string) => void androidCalls.push(`shutdown ${serial}`),
        deleteAvd: async (n: string) => void androidCalls.push(`deleteAvd ${n}`),
        packagePath: async () => "/data/app/base.apk",
        installApk: async () => {},
        launch: async () => {},
        findApk: async () => "/wt/app-debug.apk",
        describe: async () => "tree",
      }),
    } as unknown as Partial<PreviewEngineDeps>);

    h.engine.startPreview({
      app: rnApp,
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [{ platform: "android" }],
      access: "public",
    });
    assert.equal(await waitForPhase(h.engine, "pv1", ["ready", "failed"]), "failed");

    assert.ok(
      androidCalls.some((c) => c.startsWith("shutdown emulator-")),
      `the abandoned emulator must be killed by its port — saw ${JSON.stringify(androidCalls)}`,
    );
  });

  it("does not over-admit when the failed preview never booted anything", async () => {
    // A clone/build failure has no device to await, so its release completes
    // synchronously and is already out of `tearingDown`. Discounting it a second
    // time let the retry start more devices than the machine allows.
    const h = makeEngine(
      { config: { ...config, limits: { ...config.limits, maxTotalDevices: 4 } } },
      (step) => ({ code: step.name === "checkout" || step.name === "install-deps" ? 1 : 0, timedOut: false, aborted: false }),
    );
    h.engine.startPreview({
      app: { ...rnApp, id: "app-a" },
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [{ platform: "ios" }],
      access: "public",
    });
    assert.equal(await waitForPhase(h.engine, "pv1", ["ready", "failed"]), "failed");

    // Fill 3 of 4 with a healthy second app.
    const h2 = h; // same engine
    h2.engine.startPreview({
      app: { ...rnApp, id: "app-b" },
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [{ platform: "ios" }, { platform: "ios" }, { platform: "ios" }],
      access: "public",
    });

    // Retrying app-a for 2 devices would be 3 + 2 = 5 > 4. It must be refused,
    // not admitted by discounting a device that was never booted or held.
    assert.throws(
      () =>
        h.engine.startPreview({
          app: { ...rnApp, id: "app-a" },
          source: "git",
          spec: { kind: "branch", branch: "main" },
          devices: [{ platform: "ios" }, { platform: "ios" }],
          access: "public",
        }),
      /device capacity reached/,
    );
  });

  it("lets a failed preview be retried immediately, even while its teardown drags", async () => {
    // Android's shutdown polls `get-state` for up to 20 s per device. Charging
    // the whole preview to `tearingDown` until the LAST device finished made the
    // retry throw "device capacity reached" — the exact flow reapTerminalForApp
    // exists to serve. Devices must be uncharged one at a time, as each lands.
    let releaseSecond: (() => void) | null = null;
    const gate = new Promise<void>((r) => (releaseSecond = r));
    let shutdowns = 0;
    const h = makeEngine(
      {
        simctl: fakeSimctl({
          listRuntimes: async () => [{ identifier: "rt.26", name: "iOS 26.0", version: "26.0", isAvailable: true }],
          listDeviceTypes: async () => [{ identifier: "dt.16pro", name: "iPhone 16 Pro" }],
          listDevices: async () => [],
          create: async () => `udid-${++shutdowns}`,
          bootAndWait: async () => {},
          appContainer: async () => "/path/to/App.app",
          install: async () => {},
          launch: async () => {},
          openUrl: async () => {},
          // The second device's shutdown hangs, standing in for the 20 s poll.
          shutdown: async (u: string) => {
            if (u.endsWith("2")) await gate;
          },
          delete: async () => {},
        }),
      },
      (step) => ({ code: step.name === "build" ? 1 : 0, timedOut: false, aborted: false }),
    );

    h.engine.startPreview({
      app: rnApp,
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [{ platform: "ios" }, { platform: "ios" }], // fills maxTotalDevices (2)
      access: "public",
    });
    assert.equal(await waitForPhase(h.engine, "pv1", ["ready", "failed"]), "failed");

    // Same app, so reapTerminalForApp releases the failed preview in background.
    // The first device is already torn down; only the second is still in flight,
    // so there is room for one.
    await new Promise((r) => setTimeout(r, 20));
    assert.doesNotThrow(() =>
      h.engine.startPreview({
        app: rnApp,
        source: "git",
        spec: { kind: "branch", branch: "main" },
        devices: [{ platform: "ios" }],
        access: "public",
      }),
    );
    releaseSecond!();
  });
});

// ---------------------------------------------------------------------------
// Device pool. Creating a throwaway simulator/AVD per preview meant a full
// create+delete cycle (and a fresh ~2 GB AVD image) every run. Pooled devices
// are named by shape and outlive the preview that booted them.
// ---------------------------------------------------------------------------

describe("device pool", () => {
  const poolConfig: Config = { ...config, limits: { ...config.limits, reuseDevices: true } };

  /** A simctl/android pair backed by a mutable inventory, so reuse is observable. */
  function makePooled() {
    const sims: { udid: string; name: string; state: string }[] = [];
    const avds: string[] = [];
    const calls: string[] = [];
    const simctl = fakeSimctl({
      listRuntimes: async () => [{ identifier: "rt.26", name: "iOS 26.0", version: "26.0", isAvailable: true }],
      listDeviceTypes: async () => [{ identifier: "dt.16pro", name: "iPhone 16 Pro" }],
      listDevices: async () => sims,
      create: async (name: string) => {
        calls.push(`create ${name}`);
        const udid = `udid-${sims.length + 1}`;
        sims.push({ udid, name, state: "Shutdown" });
        return udid;
      },
      erase: async (u: string) => void calls.push(`erase ${u}`),
      bootAndWait: async (u: string) => void calls.push(`boot ${u}`),
      appContainer: async () => "/path/to/App.app",
      install: async () => {},
      launch: async () => {},
      openUrl: async () => {},
      shutdown: async (u: string) => void calls.push(`shutdown ${u}`),
      delete: async (u: string) => {
        calls.push(`delete ${u}`);
        const i = sims.findIndex((s) => s.udid === u);
        if (i >= 0) sims.splice(i, 1);
      },
    });
    const android = fakeAndroid({
      listSystemImages: async () => [{ pkg: "system-images;android-34;google_apis;arm64-v8a", api: 34 }],
      listAvds: async () => avds,
      attachedSerials: async () => [],
      createAvd: async (name: string) => {
        calls.push(`avd create ${name}`);
        avds.push(name);
      },
      bootEmulator: async (name: string, _port: number, _t: unknown, opts?: { wipeData?: boolean }) => {
        calls.push(`avd boot ${name}${opts?.wipeData ? " wipe" : ""}`);
        return "emulator-5554";
      },
      packagePath: async () => "/data/app/base.apk",
      installApk: async () => {},
      launch: async () => {},
      findApk: async () => "/wt/app-debug.apk",
      shutdown: async () => void calls.push("avd shutdown"),
      deleteAvd: async (n: string) => {
        calls.push(`avd delete ${n}`);
        const i = avds.indexOf(n);
        if (i >= 0) avds.splice(i, 1);
      },
    });
    return { simctl, android, calls, sims, avds };
  }

  const ids = { n: 0 };
  beforeEach(() => {
    ids.n = 0;
  });

  const start = async (h: Harness, app: App) => {
    const res = h.engine.startPreview({
      app,
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [{ platform: "ios" }],
      access: "public",
    });
    assert.equal(await waitForPhase(h.engine, res.previewId, ["ready", "failed"]), "ready");
    return res.previewId;
  };

  it("names the simulator by shape and reuses it for the next preview", async () => {
    const pooled = makePooled();
    const h = makeEngine({
      config: poolConfig,
      ...pooled,
      genPreviewId: () => `pv${++ids.n}`,
      genShareId: () => `share-${ids.n}`,
    });

    const first = await start(h, rnApp);
    assert.deepEqual(
      pooled.sims.map((s) => s.name),
      ["deckhand-pool-iphone-16-pro-ios-26-0"],
    );
    await h.engine.stopPreview(first);
    // Released, not destroyed.
    assert.equal(pooled.sims.length, 1);
    assert.ok(pooled.calls.includes("shutdown udid-1"));
    assert.ok(!pooled.calls.includes("delete udid-1"));

    pooled.calls.length = 0;
    await start(h, rnApp);
    assert.ok(!pooled.calls.some((c) => c.startsWith("create ")), "second preview reuses the pooled simulator");
    assert.ok(pooled.calls.includes("boot udid-1"));
    assert.ok(!pooled.calls.some((c) => c.startsWith("erase ")), "same app keeps its state");
  });

  it("wipes a pooled device when it changes hands", async () => {
    const pooled = makePooled();
    const h = makeEngine({
      config: poolConfig,
      ...pooled,
      genPreviewId: () => `pv${++ids.n}`,
      genShareId: () => `share-${ids.n}`,
    });
    await h.engine.stopPreview(await start(h, rnApp));

    pooled.calls.length = 0;
    await start(h, { ...rnApp, id: "other-app" });
    assert.ok(pooled.calls.includes("erase udid-1"), "a different app gets a factory-reset device");
  });

  it("gives two concurrent previews of one shape separate devices", async () => {
    const pooled = makePooled();
    const h = makeEngine({
      config: poolConfig,
      ...pooled,
      genPreviewId: () => `pv${++ids.n}`,
      genShareId: () => `share-${ids.n}`,
    });
    await start(h, rnApp);
    await start(h, { ...rnApp, id: "other-app" });
    assert.deepEqual(
      pooled.sims.map((s) => s.name),
      ["deckhand-pool-iphone-16-pro-ios-26-0", "deckhand-pool-iphone-16-pro-ios-26-0-2"],
    );
  });

  it("refuses to reuse a pooled device when both erase AND delete fail (no duplicate)", async () => {
    // Tenant separation rests on the erase. If it fails, we delete + rebuild —
    // but only if delete SUCCEEDS. A wedged simctl where both throw must fail the
    // boot, not create() a second device sharing the name (two devices, one name
    // → the untracked-orphan / cross-tenant hazard the erase exists to prevent).
    const pooled = makePooled();
    (pooled.simctl as unknown as { erase: () => Promise<void> }).erase = async () => {
      throw new Error("erase wedged");
    };
    (pooled.simctl as unknown as { delete: () => Promise<void> }).delete = async () => {
      throw new Error("delete wedged");
    };
    const h = makeEngine({
      config: poolConfig,
      ...pooled,
      genPreviewId: () => `pv${++ids.n}`,
      genShareId: () => `share-${ids.n}`,
    });
    await h.engine.stopPreview(await start(h, rnApp)); // app A leases + releases the pooled sim

    pooled.calls.length = 0;
    // app B wants the same shape → tenant mismatch → erase (fails) → delete (fails) → must fail.
    h.engine.startPreview({
      app: { ...rnApp, id: "other-app" },
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [{ platform: "ios" }],
      access: "public",
    });
    assert.equal(await waitForPhase(h.engine, "pv2", ["ready", "failed"]), "failed");
    assert.ok(!pooled.calls.some((c) => c.startsWith("create ")), "must NOT create a duplicate of the wedged device");
    assert.equal(pooled.sims.length, 1, "still exactly one device with this name");
  });
});

// ---------------------------------------------------------------------------
// Regressions found in review of the auto-teardown/pool change.
// ---------------------------------------------------------------------------

describe("auto-teardown edge cases", () => {
  const clock = { t: 1_700_000_000_000 };
  const ids = { n: 0 };
  beforeEach(() => {
    clock.t = 1_700_000_000_000;
    ids.n = 0;
  });
  const makeSwept = (overrides: Partial<PreviewEngineDeps> = {}) =>
    makeEngine({ now: () => clock.t, genPreviewId: () => `pv${++ids.n}`, genShareId: () => `share-${ids.n}`, ...overrides });

  it("does not charge capacity for a preview that failed before booting anything", async () => {
    // Boot itself fails (an unavailable runtime, a full disk): no simulator is
    // ever created, so these devices occupy nothing on the machine.
    const h = makeSwept({
      simctl: fakeSimctl({
        listRuntimes: async () => [{ identifier: "rt.26", name: "iOS 26.0", version: "26.0", isAvailable: true }],
        listDeviceTypes: async () => [{ identifier: "dt.16pro", name: "iPhone 16 Pro" }],
        create: async () => {
          throw new Error("simctl create failed: Invalid runtime");
        },
        shutdown: async () => {},
        delete: async () => {},
      }),
    });
    h.engine.startPreview({
      app: rnApp,
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [{ platform: "ios" }, { platform: "ios" }], // would fill maxTotalDevices (2)
      access: "public",
    });
    assert.equal(await waitForPhase(h.engine, "pv1", ["ready", "failed"]), "failed");

    // Nothing booted, so a different app must still be able to start.
    assert.doesNotThrow(() =>
      h.engine.startPreview({
        app: { ...rnApp, id: "other-app" },
        source: "git",
        spec: { kind: "branch", branch: "main" },
        devices: [{ platform: "ios" }],
        access: "public",
      }),
    );
  });

  it("listing previews does not count as watching them", async () => {
    const h = makeSwept();
    h.engine.startPreview({
      app: rnApp,
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [{ platform: "ios" }],
      access: "public",
    });
    await waitForPhase(h.engine, "pv1", ["ready", "failed"]);

    clock.t += 46 * 60_000;
    h.engine.list(); // an agent enumerating previews must not resurrect idle ones
    assert.deepEqual(await h.engine.sweepIdle(), ["pv1"]);
  });
});

describe("pool leases and wedged previews", () => {
  const clock = { t: 1_700_000_000_000 };
  const ids = { n: 0 };
  beforeEach(() => {
    clock.t = 1_700_000_000_000;
    ids.n = 0;
  });

  it("releases the pool slot when the device fails to come up", async () => {
    const created: string[] = [];
    let failNext = true;
    const h = makeEngine({
      config: { ...config, limits: { ...config.limits, reuseDevices: true } },
      now: () => clock.t,
      genPreviewId: () => `pv${++ids.n}`,
      genShareId: () => `share-${ids.n}`,
      simctl: fakeSimctl({
        listRuntimes: async () => [{ identifier: "rt.26", name: "iOS 26.0", version: "26.0", isAvailable: true }],
        listDeviceTypes: async () => [{ identifier: "dt.16pro", name: "iPhone 16 Pro" }],
        listDevices: async () => [],
        create: async (name: string) => {
          created.push(name);
          if (failNext) {
            failNext = false;
            throw new Error("simctl create failed: disk full");
          }
          return "udid-1";
        },
        erase: async () => {},
        bootAndWait: async () => {},
        appContainer: async () => "/path/to/App.app",
        install: async () => {},
        launch: async () => {},
        openUrl: async () => {},
        shutdown: async () => {},
        delete: async () => {},
      }),
    });

    h.engine.startPreview({
      app: rnApp,
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [{ platform: "ios" }],
      access: "public",
    });
    assert.equal(await waitForPhase(h.engine, "pv1", ["ready", "failed"]), "failed");
    await h.engine.stopPreview("pv1");

    h.engine.startPreview({
      app: rnApp,
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [{ platform: "ios" }],
      access: "public",
    });
    assert.equal(await waitForPhase(h.engine, "pv2", ["ready", "failed"]), "ready");
    // The retry takes the same slot back — a leaked lease would have pushed it to "…-2".
    assert.deepEqual(created, ["deckhand-pool-iphone-16-pro-ios-26-0", "deckhand-pool-iphone-16-pro-ios-26-0"]);
  });

  it("collects a preview wedged mid-build so its devices come back", async () => {
    const h = makeEngine(
      { now: () => clock.t, genPreviewId: () => "pv1", genShareId: () => "share-1" },
      // A build step that never returns: the preview stays "running" forever.
      () => new Promise<RunResult>(() => {}) as unknown as RunResult,
    );
    h.engine.startPreview({
      app: rnApp,
      source: "git",
      spec: { kind: "branch", branch: "main" },
      devices: [{ platform: "ios" }],
      access: "public",
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.engine.getStatus("pv1")!.phase, "running");

    clock.t += 60 * 60_000; // an hour in: a long build, still allowed
    assert.deepEqual(await h.engine.sweepIdle(), []);

    clock.t += 40 * 60_000; // past stuckMinutes with no phase change at all
    assert.deepEqual(await h.engine.sweepIdle(), ["pv1"]);
    assert.equal(h.engine.getStatus("pv1"), null);
  });
});

describe("PreviewEngine share PIN records", () => {
  it("keeps the stored record when the same PIN is set again (viewers stay unlocked)", () => {
    // start_preview is idempotent and re-applies the PIN on every call, including
    // "what's the link?" re-calls. Re-hashing would mint a new salt, hence a new
    // pinFingerprint, hence reject every live unlock cookie mid-session.
    const h = makeEngine();
    h.engine.setAppPin("app-1", "1234");
    const first = h.engine.pinRecordForApp("app-1");
    h.engine.setAppPin("app-1", "1234");
    assert.deepEqual(h.engine.pinRecordForApp("app-1"), first);

    // ...but a genuinely different PIN must re-hash, revoking old cookies.
    h.engine.setAppPin("app-1", "5678");
    const changed = h.engine.pinRecordForApp("app-1");
    assert.notDeepEqual(changed, first);
  });

  it("records a compensating audit entry when a PIN is rolled back", () => {
    const h = makeEngine();
    h.engine.setAppPin("app-2", "1234");
    const rec = h.engine.pinRecordForApp("app-2");
    h.engine.setAppPin("app-2", null); // the pre-boot "make it public" step
    h.engine.restoreAppPin("app-2", rec); // ...boot threw
    const entries = h.audit.filter((e) => e.tool === "set_pin" && (e.args as { app?: string }).app === "app-2");
    const last = entries.at(-1)!;
    assert.equal((last.args as { protected?: boolean }).protected, true);
    assert.equal((last.args as { rollback?: boolean }).rollback, true);
  });
});

describe("buildStepDetail", () => {
  it("keeps the verb and the PACKAGE, not the churning file name", () => {
    // The file after \u00bb changes many times a second and is an unbreakable
    // 45-char token that overflows the device frame; the package does neither.
    assert.equal(
      buildStepDetail("\u001b[32m\u203a Compiling react-native-svg Pods/RNSVG \u00bb RNSVGUse.mm\u001b[0m"),
      "Compiling react-native-svg",
    );
    assert.equal(
      buildStepDetail("\u203a Packaging lottie-react-native Pods/lottie-react-native \u00bb liblottie-react-native.a"),
      "Packaging lottie-react-native",
    );
    assert.equal(
      buildStepDetail("\u203a Compiling @rnmapbox/maps Pods/rnmapbox-maps \u00bb RNMBXCustomLocationProviderComponentView.mm"),
      "Compiling @rnmapbox/maps",
    );
  });

  it("keeps a whole line that has no artifact separator", () => {
    assert.equal(buildStepDetail("Installing pods..."), "Installing pods...");
    assert.equal(buildStepDetail("Downloading dependencies"), "Downloading dependencies");
  });

  it("ignores lines that are not progress", () => {
    // Warnings and stack-trace noise must not overwrite the last real step.
    assert.equal(buildStepDetail(""), null);
    assert.equal(buildStepDetail("\u26a0\ufe0f  Script has ambiguous dependencies"), null);
    assert.equal(buildStepDetail("    at Object.onError (undici.js:12)"), null);
    assert.equal(buildStepDetail("\u203a 0 error(s), and 2 warning(s)"), null);
  });

  it("never exceeds what the device frame can show", () => {
    const d = buildStepDetail("Compiling " + "x".repeat(200))!;
    assert.equal(d.length, 40);
    assert.match(d, /\u2026$/);
  });
});
