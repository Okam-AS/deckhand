import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { App } from "../config.ts";
import type { Simctl } from "../devices/ios.ts";
import type { MetroManager } from "../engine/metro.ts";
import type { WorktreeManager } from "../engine/worktree.ts";
import { parseRefSpec, worktreeKey } from "../engine/worktree.ts";
import { buildPlan, usesMetroDeepLink, type CommandStep } from "../engine/recipes.ts";
import type { RunResult } from "../engine/procs.ts";
import { buildFailureCause } from "../engine/preview.ts";
import { detectBundleIdFromDir, expoDevClientUrl, expoSlug, resolveExpoConfigFromDir } from "../engine/detect.ts";
import type { SimDeckTarget, UiAction, DescribeOptions } from "../testing/control.ts";
import { acquireDevice, type VerifyDevice } from "./device.ts";
import { BuildCache, buildCacheKey, expoFingerprint, xcodeVersion, type FingerprintRunner } from "./buildCache.ts";
import { waitForLock } from "./lock.ts";
import { killBuildGroups, reapVerifyOrphans } from "./procs.ts";
import { VERIFY_MARKER_ENV } from "../engine/reaper.ts";
import { decodePng, encodePng, rotateCcw } from "./png.ts";
import { diffImages, PIXEL_COLOR_THRESHOLD } from "./compare.ts";
import { captureFailure, confirmOpenPrompt, runSteps, waitForSettle, type Artifacts, type StepResult, type VerifyControl } from "./steps.ts";
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
  xcodeVersion?: () => Promise<string>;
  /** Kill what a dead verify run left running; the server's sweep leaves verify's processes alone. */
  reapOrphans?: () => Promise<number[]>;
  gitToplevel?: (dir: string) => Promise<string | null>;
  /** ~/.deckhand/verify: devices, locks, build cache, and the checkouts `worktrees` was built with (`<home>/worktrees`). */
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
  /** With --compare: fail when any screenshot's changed-pixel ratio exceeds this. */
  maxDiffRatio?: number;
  /** `--share`: called once, when the app has launched on the run's simulator; resolves to the live URL or null. */
  share?: (udid: string) => Promise<string | null>;
}

/** 0 passed, 1 a step or the compare budget failed, 2 infrastructure (build, device, launch), 3 bad input. */
export type ExitCode = 0 | 1 | 2 | 3;
export type Outcome = "passed" | "failed" | "infra";

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
  outcome: Outcome;
  source: string;
  sourceDir: string | null;
  steps: StepResult[];
  cache: { key: string | null; hit: boolean; fingerprint: string | null; note?: string } | null;
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
  error?: string;
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
  private readonly held = new Set<() => void>();
  private xcode: Promise<string> | null = null;
  private shared: Promise<string | null> | null = null;

  constructor(private readonly d: VerifyDeps) {
    this.now = d.now ?? Date.now;
    this.cache = new BuildCache(join(d.home, "builds"));
  }

  private hold(release: () => void): () => void {
    this.held.add(release);
    return () => {
      this.held.delete(release);
      release();
    };
  }

  /** For a signal or the run timeout: nothing this run started may outlive it or land on the next run's simulator. */
  async abort(): Promise<void> {
    killBuildGroups();
    await this.d.metro.stop().catch(() => {});
    for (const release of [...this.held]) release();
    this.held.clear();
  }

  private worktreeRoot(): string {
    return join(this.d.home, "worktrees");
  }

  /** Checkouts a verify run holds right now; the prune must not take them. */
  private lockedCheckouts(): Set<string> {
    let names: string[] = [];
    try {
      names = readdirSync(this.worktreeRoot());
    } catch {
      return new Set();
    }
    return new Set(names.filter((n) => n.startsWith("dh-") && n.endsWith(".lock")).map((n) => n.slice(3, -5)));
  }

  /** The app directory a source resolves to; a git ref of a monorepo app keeps the app's place in the repo. */
  private async sourceDir(app: App, source: VerifySource): Promise<{ dir: string; local: boolean; release: () => void }> {
    if (source.kind === "local") return { dir: source.dir, local: true, release: () => {} };
    if (!app.repo) throw new Error(`app "${app.id}" has no repo, so it cannot be verified at a git ref — pass --path instead`);
    let sub = "";
    if (app.path) {
      const top = await (this.d.gitToplevel ?? defaultToplevel)(app.path);
      if (top) sub = relative(top, app.path);
    }
    const spec = parseRefSpec({ ref: source.ref });
    mkdirSync(this.worktreeRoot(), { recursive: true });
    const lock = await waitForLock(join(this.worktreeRoot(), `dh-${worktreeKey(app.id, spec)}.lock`), 10 * 60_000, this.d.sleep, this.now);
    if (!lock) throw new Error(`another verify run has held the checkout of ${source.ref} for 10 minutes`);
    const release = this.hold(lock);
    try {
      const wt = await this.d.worktrees.createWorktree(app, "verify", spec);
      return { dir: join(wt.path, sub), local: false, release };
    } catch (e) {
      release();
      throw e;
    }
  }

  private control(device: VerifyDevice): VerifyControl {
    const target: SimDeckTarget = { platform: "ios", udid: device.udid };
    return {
      quarterTurns: device.quarterTurns,
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
    const result: RunResultJson = {
      passed: false,
      outcome: "infra",
      source: describeSource(source),
      sourceDir: null,
      steps: [],
      cache: null,
      launch: null,
      timings: t,
    };
    const buildLog: string[] = [];
    const control = this.control(device);
    const app = req.app;
    let releaseCheckout = () => {};
    try {
      if (app.type !== "expo" && app.type !== "react-native") throw new Error(`verify runs expo and react-native apps; "${app.id}" is ${app.type}`);
      const locale: Record<string, string> = process.env.LC_ALL || process.env.LANG ? {} : { LANG: "en_US.UTF-8" };
      const appEnv = {
        ...locale,
        ...app.env,
        ...this.d.secretsEnv(app.id),
        ...req.scenario.env,
        ...req.env,
        [VERIFY_MARKER_ENV]: String(process.pid),
      };
      let t0 = this.now();
      const src = await this.sourceDir(app, source);
      releaseCheckout = src.release;
      const { dir, local } = src;
      result.sourceDir = dir;
      t.sourceMs = this.now() - t0;

      const bundleId = app.bundleId ?? detectBundleIdFromDir(dir, app.type, "ios");
      if (!bundleId) throw new Error(`could not find the iOS bundle id in ${dir}; register the app with --bundle-id`);
      const [deps, ...build] = buildPlan({ type: app.type, platform: "ios", udid: device.udid, worktreePath: dir, appEnv, local });

      this.d.log(`[${result.source}] dependencies`);
      t0 = this.now();
      await this.runPlanSteps([deps!], out, buildLog);
      t.depsMs = this.now() - t0;

      const cacheable = usesMetroDeepLink(app.type);
      let hit: { app: string; done: () => void } | null = null;
      let key: string | null = null;
      if (cacheable) {
        t0 = this.now();
        const fingerprint = await (this.d.fingerprint ?? expoFingerprint)(dir, appEnv);
        if (fingerprint) {
          this.xcode ??= (this.d.xcodeVersion ?? xcodeVersion)();
          key = buildCacheKey({ appId: app.id, bundleId, fingerprint, xcode: await this.xcode, runtime: device.runtime });
          hit = this.cache.lookup(key);
          result.cache = { key, hit: Boolean(hit), fingerprint };
        } else {
          result.cache = { key: null, hit: false, fingerprint: null, note: "@expo/fingerprint did not answer in this project, so this build was made fresh and not cached" };
        }
        t.fingerprintMs = this.now() - t0;
      }

      await this.d.simctl.uninstall(device.udid, bundleId).catch(() => {});
      if (hit) {
        this.d.log(`[${result.source}] native build cached (${key!.slice(0, 12)}) — installing`);
        t0 = this.now();
        try {
          await this.d.simctl.install(device.udid, hit.app);
        } finally {
          hit.done();
        }
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
        if (key) this.cache.store(key, built, { appId: app.id, bundleId, source: result.source });
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
        await confirmOpenPrompt(control, { sleep: this.d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), now: this.now });
      } else {
        await this.d.simctl.launch(device.udid, bundleId);
      }
      const settleMs = this.d.settleTimeoutMs ?? 180_000;
      if (req.scenario.ready) {
        const ready = await runSteps([{ action: "waitFor", selector: req.scenario.ready, absent: false, timeoutMs: settleMs }], control, out, this.now, this.d.sleep);
        if (!ready.passed) throw new Error(`the app never showed the ready selector: ${ready.steps[0]?.observed ?? ""}`);
        result.launch = { settled: true, labels: 0 };
      } else {
        result.launch = await waitForSettle(control, { timeoutMs: settleMs, sleep: this.d.sleep, now: this.d.now });
        if (!result.launch.settled) throw new Error(`the app's screen never settled within ${Math.round(settleMs / 1000)}s`);
      }
      t.launchMs = this.now() - t0;
      if (req.share) this.shared ??= req.share(device.udid).catch(() => null);

      t0 = this.now();
      const run = await runSteps(req.scenario.steps, control, out, this.now, this.d.sleep);
      t.stepsMs = this.now() - t0;
      result.steps = run.steps;
      result.passed = run.passed;
      result.outcome = run.passed ? "passed" : "failed";
    } catch (e) {
      result.error = e instanceof Error ? e.message : String(e);
      await captureFailure(control, out);
    } finally {
      await this.d.metro.stop().catch(() => {});
      releaseCheckout();
      t.totalMs = this.now() - start;
      out.write("result.json", JSON.stringify(result, null, 2));
    }
    return result;
  }

  async verify(req: VerifyRequest): Promise<{ passed: boolean; exitCode: ExitCode; summary: Record<string, unknown> }> {
    const t0 = this.now();
    this.shared = null;
    mkdirSync(req.outDir, { recursive: true });
    const finish = async (summary: Record<string, unknown>, exitCode: ExitCode) => {
      const live = req.share ? { liveUrl: this.shared ? await this.shared : null } : {};
      writeFileSync(join(req.outDir, "result.json"), JSON.stringify({ ...summary, ...live, exitCode, totalMs: this.now() - t0 }, null, 2));
      return { passed: exitCode === 0, exitCode, summary: { ...summary, ...live } };
    };
    const base = { scenario: req.scenario.name, app: req.app.id };

    let device: VerifyDevice;
    try {
      await (this.d.reapOrphans ?? reapVerifyOrphans)().catch(() => []);
      await this.d.worktrees.pruneWorktrees(this.lockedCheckouts()).catch(() => []);
      device = await acquireDevice(req.scenario.device, {
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
    } catch (e) {
      return await finish({ ...base, passed: false, outcome: "infra", error: `no simulator: ${e instanceof Error ? e.message : String(e)}` }, 2);
    }
    const releaseDevice = this.hold(device.release);
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
        return await finish({ ...r, ...base, device: deviceInfo }, exitFor([r.outcome]));
      }
      const a = await this.runOne(req, req.source, device, join(req.outDir, "ref"));
      const b = await this.runOne(req, req.compare, device, join(req.outDir, "compare"));
      const shots = req.scenario.steps.flatMap((s) => (s.action === "screenshot" ? [s.name] : []));
      const entries = compareShots(shots, join(req.outDir, "ref"), join(req.outDir, "compare"), req.outDir);
      const overBudget =
        req.maxDiffRatio == null ? [] : entries.filter((e) => e.missing || e.error || e.ratio > req.maxDiffRatio!).map((e) => e.name);
      writeFileSync(
        join(req.outDir, "compare.json"),
        JSON.stringify(
          { ref: a.source, compare: b.source, pixelColorThreshold: PIXEL_COLOR_THRESHOLD, maxDiffRatio: req.maxDiffRatio ?? null, overBudget, screenshots: entries },
          null,
          2,
        ),
      );
      let exitCode = exitFor([a.outcome, b.outcome]);
      if (exitCode === 0 && overBudget.length) exitCode = 1;
      return await finish(
        {
          ...base,
          passed: exitCode === 0,
          outcome: exitCode === 2 ? "infra" : exitCode === 0 ? "passed" : "failed",
          device: deviceInfo,
          runs: { ref: a, compare: b },
          compare: entries.map(({ name, ratio, sizeMismatch, missing, error }) => ({ name, ratio, sizeMismatch, missing, error })),
          overBudget,
        },
        exitCode,
      );
    } finally {
      releaseDevice();
    }
  }
}

export function exitFor(outcomes: Outcome[]): ExitCode {
  if (outcomes.includes("infra")) return 2;
  if (outcomes.includes("failed")) return 1;
  return 0;
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
    try {
      const d = diffImages(decodePng(a), decodePng(b));
      let diff: string | null = null;
      if (d.image) {
        diff = join(outDir, `${name}.diff.png`);
        writeFileSync(diff, encodePng(d.image));
      }
      entries.push({ name, changedPixels: d.changedPixels, totalPixels: d.totalPixels, ratio: d.ratio, sizeMismatch: d.sizeMismatch, missing: false, diff });
    } catch (e) {
      entries.push({ name, changedPixels: 0, totalPixels: 0, ratio: 1, sizeMismatch: false, missing: false, diff: null, error: e instanceof Error ? e.message : String(e) });
    }
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
