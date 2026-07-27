import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreviewEngine, PreviewError, type PreviewEngineDeps } from "./preview.ts";
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
  allowForkPRs: false,
  bundleId: "com.example.myapp",
  env: { EXPO_PUBLIC_API_URL: "https://staging" },
};

interface Harness {
  engine: PreviewEngine;
  simctlCalls: string[];
  buildEnvSeen: (Record<string, string> | undefined)[];
  removedWorktrees: string[];
  worktreeCalls: string[];
  devProcCalls: string[];
  detached: string[];
}

function makeEngine(overrides: Partial<PreviewEngineDeps> = {}, runStepResult: (step: CommandStep) => RunResult = () => ({ code: 0, timedOut: false, aborted: false })): Harness {
  const simctlCalls: string[] = [];
  const buildEnvSeen: (Record<string, string> | undefined)[] = [];
  const removedWorktrees: string[] = [];
  const worktreeCalls: string[] = [];
  const devProcCalls: string[] = [];
  const detached: string[] = [];

  const devAlive = new Set<string>();
  const devProcs = {
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
  } as unknown as PreviewEngineDeps["devProcs"];

  const simctl = {
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
  } as unknown as PreviewEngineDeps["simctl"];

  const fakeStream: AttachedStream = {
    origin: "http://127.0.0.1:3100",
    helperBasePath: "/helper/x",
    waitForFirstFrame: async () => true,
    describe: async () => "tree",
    detach: async () => {
      detached.push("x");
    },
  };
  const streaming = {
    attach: async (_d: StreamDeviceRef) => fakeStream,
    reapOrphans: async () => {},
  };

  const android = {
    listSystemImages: async () => [{ pkg: "system-images;android-34;google_apis;arm64-v8a", api: 34 }],
    createAvd: async () => {
      simctlCalls.push("avd create");
    },
    bootEmulator: async () => {
      simctlCalls.push("emu boot");
      return "emulator-5554";
    },
    packagePath: async () => "/data/app/base.apk",
    installApk: async (serial: string) => {
      simctlCalls.push(`apk install ${serial}`);
    },
    launch: async () => {},
    screenshotPng: async () => Buffer.from([0x89, 0x50]),
    findApk: async () => "/wt/app-debug.apk",
    shutdown: async () => {},
    deleteAvd: async () => {},
    describe: async () => "tree",
  } as unknown as PreviewEngineDeps["android"];

  const deps: PreviewEngineDeps = {
    config: overrides.config ?? config,
    android,
    worktrees: {
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
    } as unknown as PreviewEngineDeps["worktrees"],
    simctl,
    streaming: streaming as unknown as PreviewEngineDeps["streaming"],
    metro: { ensure: async () => ({ manifestUrl: "http://127.0.0.1:8081" }), stop: async () => {} } as unknown as PreviewEngineDeps["metro"],
    store: new StateStore(`/tmp/deckhand-noop-${Math.random().toString(36).slice(2)}.json`),
    audit: { record: () => {} } as unknown as PreviewEngineDeps["audit"],
    devProcs,
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
  return { engine: new PreviewEngine(deps), simctlCalls, buildEnvSeen, removedWorktrees, worktreeCalls, devProcCalls, detached };
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
    allowForkPRs: false,
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
      devProcs: {
        start: () => {},
        isAlive: () => false,
        exitCode: () => 1,
        restart: () => false,
        stop: () => {},
        stopAll: () => {},
      } as unknown as PreviewEngineDeps["devProcs"],
    });
    startLocal(h);
    const phase = await waitForPhase(h.engine, "pv1", ["ready", "failed"]);
    assert.equal(phase, "failed");
    assert.match(h.engine.getStatus("pv1")!.devices[0]!.error ?? "", /livesync process exited/);
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

      const sourceApp: App = { id: "old-app", repo: "github.com/okam/old", type: "react-native", defaultBranch: "main", allowForkPRs: false, bundleId: "com.example.old", env: {} };
      const targetApp: App = { id: "new-app", path: dir, repo: "github.com/okam/new", type: "react-native", defaultBranch: "main", allowForkPRs: false, bundleId: "com.example.new", migratesFrom: "old-app", env: {} };

      const src = h.engine.startPreview({ app: sourceApp, source: "git", spec: { kind: "branch", branch: "main" }, devices: [{ platform: "ios" }], access: "public" });
      await waitForPhase(h.engine, src.previewId, ["ready", "failed"]);
      const tgt = h.engine.startPreview({ app: targetApp, source: "local", devices: [{ platform: "ios" }], access: "public" });

      const s = h.engine.shareState(tgt.shareId)!;
      assert.ok(s, "target shareState resolves");
      assert.ok(s.pairedWith, "target shareState carries pairedWith");
      assert.equal(s.pairedWith!.shareId, src.shareId);
      assert.equal(s.pairedWith!.repo, "github.com/okam/old");
      assert.equal(s.pairedWith!.devices.length, 1);
      assert.ok(s.ledger, "target shareState carries the ledger");
      assert.equal(s.ledger!.screens.length, 2);
      assert.equal(s.ledger!.screens[0]!.name, "Onboarding");
      assert.equal(s.ledger!.screens[0]!.status, "matches");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("omits pairedWith and ledger for an ordinary (non-migration) app", async () => {
    const h = makeEngine();
    h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "main" }, devices: [{ platform: "ios" }], access: "public" });
    await waitForPhase(h.engine, "pv1", ["ready", "failed"]);
    const s = h.engine.shareState("share-abc")!;
    assert.equal(s.pairedWith, undefined);
    assert.equal(s.ledger, undefined);
  });
});

describe("PreviewEngine compare session", () => {
  const uniqIds = () => {
    let pid = 0;
    let sid = 0;
    return { genPreviewId: () => `pv${++pid}`, genShareId: () => `share-${++sid}` };
  };

  it("links a working preview to a live reference and surfaces pairedWith + ledger", () => {
    const h = makeEngine(uniqIds());
    const ref = h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "main" }, devices: [{ platform: "ios" }], access: "public" });
    const work = h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "feature" }, devices: [{ platform: "ios" }], access: "public" });
    assert.notEqual(ref.shareId, work.shareId);

    const counts = h.engine.startCompare(work.previewId, { shareId: ref.shareId, repo: "acme/app", ref: "main" }, ["Login", "Home"]);
    assert.deepEqual(counts, { pending: 2, doing: 0, matches: 0, adjusted: 0, regression: 0 });

    const s = h.engine.shareState(work.shareId)!;
    assert.equal(s.pairedWith?.shareId, ref.shareId);
    assert.equal(s.pairedWith?.ref, "main");
    assert.equal(s.pairedWith?.devices.length, 1);
    assert.deepEqual(
      s.ledger?.screens.map((x) => [x.name, x.status]),
      [
        ["Login", "pending"],
        ["Home", "pending"],
      ],
    );
  });

  it("sets a verdict, appends an unknown item, and recounts", () => {
    const h = makeEngine(uniqIds());
    const work = h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "main" }, devices: [{ platform: "ios" }], access: "public" });
    h.engine.startCompare(work.previewId, { shareId: "ref-x", repo: "r", ref: "main" }, ["A", "B"]);
    assert.equal(h.engine.setCompareItem(work.previewId, { item: "A", verdict: "matches" }).matches, 1);
    assert.equal(h.engine.setCompareItem(work.previewId, { item: "C", verdict: "adjusted", note: "redesigned" }).adjusted, 1);
    const st = h.engine.compareStatus(work.previewId)!;
    assert.equal(st.items.length, 3);
    assert.equal(st.items.find((i) => i.name === "C")?.note, "redesigned");
    assert.deepEqual(st.counts, { pending: 1, doing: 0, matches: 1, adjusted: 1, regression: 0 });
  });

  it("surfaces the ledger even when the reference isn't live (no pairedWith)", () => {
    const h = makeEngine();
    const work = h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "main" }, devices: [{ platform: "ios" }], access: "public" });
    h.engine.startCompare(work.previewId, { shareId: "not-live", repo: "r", ref: "main" }, ["A"]);
    const s = h.engine.shareState("share-abc")!;
    assert.equal(s.pairedWith, undefined);
    assert.equal(s.ledger?.screens.length, 1);
  });

  it("tears down the paired reference preview when the working preview stops", async () => {
    const h = makeEngine(uniqIds());
    const ref = h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "main" }, devices: [{ platform: "ios" }], access: "public" });
    const work = h.engine.startPreview({ app: rnApp, source: "git", spec: { kind: "branch", branch: "feature" }, devices: [{ platform: "ios" }], access: "public" });
    await waitForPhase(h.engine, ref.previewId, ["ready", "failed"]);
    await waitForPhase(h.engine, work.previewId, ["ready", "failed"]);
    h.engine.startCompare(work.previewId, { shareId: ref.shareId, repo: "acme/app", ref: "main" }, [], ref.previewId);

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
    h.engine.startCompare(w1.previewId, { shareId: ref.shareId, repo: "r", ref: "main" }, [], ref.previewId);
    h.engine.startCompare(w2.previewId, { shareId: ref.shareId, repo: "r", ref: "main" }, [], ref.previewId);

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
    const simctl = {
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
    } as unknown as PreviewEngineDeps["simctl"];
    const android = {
      listSystemImages: async () => [{ pkg: "system-images;android-34;google_apis;arm64-v8a", api: 34 }],
      listAvds: async () => avds,
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
    } as unknown as PreviewEngineDeps["android"];
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
      simctl: {
        listRuntimes: async () => [{ identifier: "rt.26", name: "iOS 26.0", version: "26.0", isAvailable: true }],
        listDeviceTypes: async () => [{ identifier: "dt.16pro", name: "iPhone 16 Pro" }],
        create: async () => {
          throw new Error("simctl create failed: Invalid runtime");
        },
        shutdown: async () => {},
        delete: async () => {},
      } as unknown as PreviewEngineDeps["simctl"],
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
      simctl: {
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
      } as unknown as PreviewEngineDeps["simctl"],
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
