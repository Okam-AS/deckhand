import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { App } from "../config.ts";
import type { Simctl } from "../devices/ios.ts";
import type { MetroManager } from "../engine/metro.ts";
import type { WorktreeManager } from "../engine/worktree.ts";
import { parseRefSpec } from "../engine/worktree.ts";
import { buildPlan, usesMetroDeepLink, type CommandStep } from "../engine/recipes.ts";
import type { RunResult } from "../engine/procs.ts";
import { buildFailureCause } from "../engine/preview.ts";
import { detectBundleIdFromDir, expoDevClientUrl, expoSlug, resolveExpoConfigFromDir } from "../engine/detect.ts";
import type { SimDeckTarget, UiAction, DescribeOptions } from "../testing/control.ts";
import { acquireDevice, type VerifyDevice } from "./device.ts";
import { BuildCache, buildCacheKey, nativeFingerprint, type FingerprintRunner } from "./buildCache.ts";
import { decodePng, encodePng, rotateCcw } from "./png.ts";
import { diffImages } from "./compare.ts";
import { captureFailure, runSteps, waitForSettle, type Artifacts, type StepResult, type VerifyControl } from "./steps.ts";
import type { Scenario } from "./scenario.ts";

export type VerifySource = { kind: "local"; dir: string } | { kind: "git"; ref: string };

export interface SimDeckLike {
  action(target: SimDeckTarget, a: UiAction): Promise<unknown>;
  describe(target: SimDeckTarget, opts?: DescribeOptions): Promise<unknown>;
  screenshot(target: SimDeckTarget): Promise<Buffer>;
}

export interface VerifyDeps {
  simctl: Simctl;
  metro: MetroManager;
  worktrees: WorktreeManager;
  simdeck: SimDeckLike;
  runStep: (step: CommandStep, opts?: { onLog?: (l: string, s: "stdout" | "stderr") => void }) => Promise<RunResult>;
  secretsEnv: (appId: string) => Record<string, string>;
  fingerprint?: FingerprintRunner;
  gitToplevel?: (dir: string) => Promise<string | null>;
  /** ~/.deckhand/verify: devices, locks, build cache. */
  home: string;
  log: (line: string) => void;
  now?: () => number;
  settleTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface VerifyRequest {
  app: App;
  source: VerifySource;
  compare?: VerifySource;
  scenario: Scenario;
  outDir: string;
  /** Extra env from the command line; wins over the scenario's. */
  env?: Record<string, string>;
}

export interface RunTimings {
  sourceMs: number;
  depsMs: number;
  fingerprintMs: number;
  buildMs: number | null;
  installMs: number;
  launchMs: number;
  stepsMs: number;
  totalMs: number;
}

export interface RunResultJson {
  passed: boolean;
  source: string;
  sourceDir: string | null;
  steps: StepResult[];
  cache: { key: string; hit: boolean; fingerprint: string; fingerprintSource: string } | null;
  launch: { settled: boolean; labels: number } | null;
  timings: Partial<RunTimings>;
  error?: string;
}

export interface CompareEntry {
  name: string;
  changedPixels: number;
  totalPixels: number;
  ratio: number;
  sizeMismatch: boolean;
  /** A run failed before taking this screenshot, so there is nothing to compare. */
  missing: boolean;
  diff: string | null;
}

function describeSource(s: VerifySource): string {
  return s.kind === "git" ? `ref ${s.ref}` : `path ${s.dir}`;
}

const defaultToplevel = (dir: string): Promise<string | null> =>
  new Promise((resolve) =>
    execFile("git", ["rev-parse", "--show-toplevel"], { cwd: dir, timeout: 10_000 }, (err, out) =>
      resolve(err ? null : String(out).trim() || null),
    ),
  );

function dirArtifacts(dir: string): Artifacts {
  mkdirSync(dir, { recursive: true });
  return { write: (name, data) => writeFileSync(join(dir, name), data) };
}

export class Verifier {
  private readonly now: () => number;
  private readonly cache: BuildCache;

  constructor(private readonly d: VerifyDeps) {
    this.now = d.now ?? Date.now;
    this.cache = new BuildCache(join(d.home, "builds"));
  }

  /** The app directory a source resolves to; a git ref of a monorepo app keeps the app's place in the repo. */
  private async sourceDir(app: App, source: VerifySource): Promise<{ dir: string; local: boolean }> {
    if (source.kind === "local") return { dir: source.dir, local: true };
    if (!app.repo) throw new Error(`app "${app.id}" has no repo, so it cannot be verified at a git ref — pass --path instead`);
    let sub = "";
    if (app.path) {
      const top = await (this.d.gitToplevel ?? defaultToplevel)(app.path);
      if (top) sub = relative(top, app.path);
    }
    const wt = await this.d.worktrees.createWorktree(app, "verify", parseRefSpec({ ref: source.ref }));
    return { dir: join(wt.path, sub), local: false };
  }

  private control(device: VerifyDevice): VerifyControl {
    const target: SimDeckTarget = { platform: "ios", udid: device.udid };
    return {
      action: (a) => this.d.simdeck.action(target, a),
      describe: () => this.d.simdeck.describe(target),
      screenshot: async () => {
        const raw = await this.d.simdeck.screenshot(target);
        return device.quarterTurns % 4 === 0 ? raw : encodePng(rotateCcw(decodePng(raw), device.quarterTurns));
      },
    };
  }

  private async runPlanSteps(steps: CommandStep[], logFile: Artifacts, log: string[]): Promise<void> {
    for (const step of steps) {
      this.d.log(`  ${step.name}…`);
      const res = await this.d.runStep(step, { onLog: (line) => log.push(`[${step.name}] ${line}`) });
      logFile.write("build.log", log.join("\n"));
      if (res.code !== 0 && !step.optional) {
        const cause = buildFailureCause(log);
        throw new Error(`build step "${step.name}" failed${res.timedOut ? " (idle timeout)" : ""}${cause ? ` — ${cause}` : ""}`);
      }
    }
  }

  /** One scenario on one source, on an already-acquired device. Never throws: failures land in the result. */
  async runOne(req: VerifyRequest, source: VerifySource, device: VerifyDevice, outDir: string): Promise<RunResultJson> {
    const out = dirArtifacts(outDir);
    const t: Partial<RunTimings> = {};
    const start = this.now();
    const result: RunResultJson = { passed: false, source: describeSource(source), sourceDir: null, steps: [], cache: null, launch: null, timings: t };
    const buildLog: string[] = [];
    const control = this.control(device);
    const app = req.app;
    try {
      if (app.type !== "expo" && app.type !== "react-native") throw new Error(`verify runs expo and react-native apps; "${app.id}" is ${app.type}`);
      const locale: Record<string, string> = process.env.LC_ALL || process.env.LANG ? {} : { LANG: "en_US.UTF-8" };
      const appEnv = { ...locale, ...app.env, ...this.d.secretsEnv(app.id), ...req.scenario.env, ...req.env };
      let t0 = this.now();
      const { dir, local } = await this.sourceDir(app, source);
      result.sourceDir = dir;
      t.sourceMs = this.now() - t0;

      const bundleId = app.bundleId ?? detectBundleIdFromDir(dir, app.type, "ios");
      if (!bundleId) throw new Error(`could not find the iOS bundle id in ${dir}; register the app with --bundle-id`);
      const plan = buildPlan({ type: app.type, platform: "ios", udid: device.udid, worktreePath: dir, appEnv, local });
      const [deps, ...build] = plan;

      this.d.log(`[${result.source}] dependencies`);
      t0 = this.now();
      await this.runPlanSteps([deps!], out, buildLog);
      t.depsMs = this.now() - t0;

      const cacheable = usesMetroDeepLink(app.type);
      let cached: string | null = null;
      let key = "";
      if (cacheable) {
        t0 = this.now();
        const fp = await nativeFingerprint(dir, appEnv, this.d.fingerprint);
        key = buildCacheKey({ appId: app.id, bundleId, platform: "ios-simulator", fingerprint: fp });
        cached = this.cache.lookup(key);
        t.fingerprintMs = this.now() - t0;
        result.cache = { key, hit: Boolean(cached), fingerprint: fp.hash, fingerprintSource: fp.source };
      }

      await this.d.simctl.uninstall(device.udid, bundleId).catch(() => {});
      if (cached) {
        this.d.log(`[${result.source}] native build cached (${key.slice(0, 12)}) — installing`);
        t0 = this.now();
        await this.d.simctl.install(device.udid, cached);
        t.installMs = this.now() - t0;
        t.buildMs = null;
      } else {
        this.d.log(`[${result.source}] native build`);
        t0 = this.now();
        await this.runPlanSteps(build, out, buildLog);
        t.buildMs = this.now() - t0;
        t0 = this.now();
        const built = await this.d.simctl.appContainer(device.udid, bundleId);
        if (!built) throw new Error(`the build finished but ${bundleId} is not installed on ${device.name}`);
        if (cacheable) this.cache.store(key, built, { appId: app.id, bundleId, source: result.source });
        t.installMs = this.now() - t0;
      }
      await this.d.simctl.silenceDevOverlays(device.udid, bundleId).catch(() => {});
      // `expo run:ios` launches the app before the overlay preferences exist; only a cold start reads them.
      await this.d.simctl.terminate(device.udid, bundleId).catch(() => {});

      this.d.log(`[${result.source}] launch`);
      t0 = this.now();
      if (cacheable) {
        const { config, error } = await resolveExpoConfigFromDir(dir, appEnv);
        const slug = expoSlug(config);
        if (!slug) throw new Error(`could not resolve the Expo slug in ${dir}${error ? `: ${error}` : ""}`);
        const metro = await this.d.metro.ensure(`verify-${app.id}`, dir, appEnv);
        await this.d.simctl.openUrl(device.udid, expoDevClientUrl(slug, metro.manifestUrl));
      } else {
        await this.d.simctl.launch(device.udid, bundleId);
      }
      if (req.scenario.ready) {
        const ready = await runSteps([{ action: "waitFor", selector: req.scenario.ready, absent: false, timeoutMs: this.d.settleTimeoutMs ?? 180_000 }], control, out, this.now);
        if (!ready.passed) throw new Error(`the ready selector never appeared: ${ready.steps[0]?.observed ?? ""}`);
        result.launch = { settled: true, labels: 0 };
      } else {
        result.launch = await waitForSettle(control, { timeoutMs: this.d.settleTimeoutMs ?? 180_000, sleep: this.d.sleep, now: this.d.now });
      }
      t.launchMs = this.now() - t0;

      t0 = this.now();
      const run = await runSteps(req.scenario.steps, control, out, this.now);
      t.stepsMs = this.now() - t0;
      result.steps = run.steps;
      result.passed = run.passed;
    } catch (e) {
      result.error = e instanceof Error ? e.message : String(e);
      await captureFailure(control, out);
    } finally {
      await this.d.metro.stop().catch(() => {});
      t.totalMs = this.now() - start;
      out.write("result.json", JSON.stringify(result, null, 2));
    }
    return result;
  }

  async verify(req: VerifyRequest): Promise<{ passed: boolean; exitCode: 0 | 1; summary: Record<string, unknown> }> {
    const t0 = this.now();
    const device = await acquireDevice(req.scenario.device, {
      simctl: this.d.simctl,
      home: this.d.home,
      now: this.d.now,
      sleep: this.d.sleep,
      action: (udid, a) => this.d.simdeck.action({ platform: "ios", udid }, a),
      rootFrame: async (udid) => {
        const tree = (await this.d.simdeck.describe({ platform: "ios", udid }, { maxDepth: 1 }).catch(() => null)) as {
          roots?: { frame?: { width?: number; height?: number } }[];
        } | null;
        const f = tree?.roots?.[0]?.frame;
        return f && typeof f.width === "number" && typeof f.height === "number" ? { width: f.width, height: f.height } : null;
      },
    });
    const deviceInfo = {
      name: device.name,
      udid: device.udid,
      model: device.model,
      runtime: device.runtime,
      orientation: device.orientation,
      orientationVerified: device.orientationVerified,
      bootMs: device.bootMs,
      orientationMs: device.orientationMs,
    };
    try {
      if (!req.compare) {
        const r = await this.runOne(req, req.source, device, req.outDir);
        const summary = { ...r, scenario: req.scenario.name, app: req.app.id, device: deviceInfo, totalMs: this.now() - t0 };
        writeFileSync(join(req.outDir, "result.json"), JSON.stringify(summary, null, 2));
        return { passed: r.passed, exitCode: r.passed ? 0 : 1, summary };
      }
      const a = await this.runOne(req, req.source, device, join(req.outDir, "ref"));
      const b = await this.runOne(req, req.compare, device, join(req.outDir, "compare"));
      const shots = req.scenario.steps.flatMap((s) => (s.action === "screenshot" ? [s.name] : []));
      const entries = compareShots(shots, join(req.outDir, "ref"), join(req.outDir, "compare"), req.outDir);
      const compare = { ref: a.source, compare: b.source, threshold: 0.1, screenshots: entries };
      writeFileSync(join(req.outDir, "compare.json"), JSON.stringify(compare, null, 2));
      const passed = a.passed && b.passed;
      const summary = {
        passed,
        scenario: req.scenario.name,
        app: req.app.id,
        device: deviceInfo,
        runs: { ref: a, compare: b },
        compare: entries.map(({ name, ratio, sizeMismatch, missing }) => ({ name, ratio, sizeMismatch, missing })),
        totalMs: this.now() - t0,
      };
      writeFileSync(join(req.outDir, "result.json"), JSON.stringify(summary, null, 2));
      return { passed, exitCode: passed ? 0 : 1, summary };
    } finally {
      device.release();
    }
  }
}

export function compareShots(names: string[], dirA: string, dirB: string, outDir: string, read = readPng): CompareEntry[] {
  const entries: CompareEntry[] = [];
  for (const name of names) {
    const a = read(join(dirA, `${name}.png`));
    const b = read(join(dirB, `${name}.png`));
    if (!a || !b) {
      entries.push({ name, changedPixels: 0, totalPixels: 0, ratio: 1, sizeMismatch: false, missing: true, diff: null });
      continue;
    }
    const d = diffImages(decodePng(a), decodePng(b));
    let diff: string | null = null;
    if (d.image) {
      diff = join(outDir, `${name}.diff.png`);
      writeFileSync(diff, encodePng(d.image));
    }
    entries.push({ name, changedPixels: d.changedPixels, totalPixels: d.totalPixels, ratio: d.ratio, sizeMismatch: d.sizeMismatch, missing: false, diff });
  }
  return entries;
}

function readPng(p: string): Buffer | null {
  try {
    return readFileSync(p);
  } catch {
    return null;
  }
}
