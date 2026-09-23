import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeMetro, fakeSimctl, fakeWorktrees } from "../test-support/fakes.ts";
import type { App } from "../config.ts";
import type { CommandStep } from "../engine/recipes.ts";
import type { SimDeckTarget, UiAction } from "../testing/control.ts";
import { encodePng, type Rgba } from "./png.ts";
import { parseScenario } from "./scenario.ts";
import { Verifier, type SimDeckLike } from "./run.ts";

const root = mkdtempSync(join(tmpdir(), "verify-run-"));
after(() => rmSync(root, { recursive: true, force: true }));

function solidPng(w: number, h: number, v: number): Buffer {
  const img: Rgba = { width: w, height: h, data: Buffer.alloc(w * h * 4, v) };
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
  return encodePng(img);
}

function checkout(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "app.json"), JSON.stringify({ expo: { slug: "mobile" } }));
  return dir;
}

function harness(opts: { fingerprint: (dir: string) => string; shot?: (n: number) => Buffer; answer?: (a: UiAction) => unknown }) {
  const log: string[] = [];
  const steps: string[] = [];
  const built = join(root, "derived", "Mobile.app");
  mkdirSync(built, { recursive: true });
  let shots = 0;
  const simdeck: SimDeckLike = {
    action: async (_t: SimDeckTarget, a: UiAction) => {
      log.push(`ui ${a.type}`);
      return a.type === "rotate" || !opts.answer ? { ok: true } : opts.answer(a);
    },
    describe: async () => ({ roots: [{ label: "Home", frame: { width: 1080, height: 810 } }] }),
    screenshot: async () => (opts.shot ?? (() => solidPng(4, 2, 200)))(++shots),
  };
  const verifier = new Verifier({
    simctl: fakeSimctl(
      {
        listRuntimes: async () => [{ identifier: "rt", name: "iOS 26.5", version: "26.5", isAvailable: true }],
        listDeviceTypes: async () => [{ identifier: "dt", name: "iPad (9th generation)" }],
        appContainer: async () => built,
      },
      log,
    ),
    metro: fakeMetro({}, log),
    worktrees: fakeWorktrees(
      {
        createWorktree: async (_app, id) => {
          log.push(`create ${id}`);
          const repo = join(root, "wt-repo");
          checkout(join("wt-repo", "apps", "mobile"));
          return { path: repo, ref: "refs/remotes/origin/main", description: "main", usedToken: false };
        },
      },
      log,
    ),
    gitToplevel: async (dir) => (dir === app.path ? join(root, "monorepo") : null),
    simdeck,
    runStep: async (step: CommandStep) => {
      steps.push(`${step.name} ${step.cwd}`);
      return { code: 0, timedOut: false, aborted: false };
    },
    secretsEnv: () => ({}),
    fingerprint: async (dir) => opts.fingerprint(dir),
    home: join(root, "home"),
    log: () => {},
    sleep: async () => {},
  });
  return { verifier, log, steps };
}

const app: App = { id: "mobile", type: "expo", repo: "example/mobile", path: join(root, "monorepo", "apps", "mobile"), defaultBranch: "main", bundleId: "com.example.mobile", env: {} };
const scenario = parseScenario("steps:\n  - screenshot: first");

describe("Verifier", () => {
  it("builds on a cache miss, then reuses the binary for a JS-only change and only swaps Metro", async () => {
    const a = checkout("a");
    const b = checkout("b");
    const h = harness({ fingerprint: () => "same-native" });
    const first = await h.verifier.verify({ app, source: { kind: "local", dir: a }, scenario, outDir: join(root, "out1") });
    assert.equal(first.exitCode, 0);
    assert.deepEqual(h.steps, [`install-deps ${a}`, `build ${a}`]);
    const order = ["simctl terminate", "simctl openUrl"].map((p) => h.log.findIndex((l) => l.startsWith(p)));
    assert.ok(order[0]! >= 0 && order[0]! < order[1]!, "the app the build launched is stopped so the deep link cold-starts it");
    const r1 = JSON.parse(readFileSync(join(root, "out1", "result.json"), "utf8"));
    assert.equal(r1.cache.hit, false);
    assert.equal(typeof r1.timings.buildMs, "number");
    assert.ok(existsSync(join(root, "out1", "first.png")));
    assert.ok(existsSync(join(root, "out1", "first.ax.json")));

    h.steps.length = 0;
    h.log.length = 0;
    const second = await h.verifier.verify({ app, source: { kind: "local", dir: b }, scenario, outDir: join(root, "out2") });
    assert.equal(second.exitCode, 0);
    assert.deepEqual(h.steps, [`install-deps ${b}`], "no native build on a fingerprint hit");
    const install = h.log.find((l) => l.startsWith("simctl install "));
    assert.match(install ?? "", /home\/builds\/[0-9a-f]{32}\/Mobile\.app$/);
    assert.ok(h.log.indexOf("simctl uninstall UDID-verify-ipad-9th-generation-ios-26-5 com.example.mobile") < h.log.indexOf(install!));
    assert.deepEqual(h.log.filter((l) => l.startsWith("metro")), ["metro ensure", "metro stop"]);
    const r2 = JSON.parse(readFileSync(join(root, "out2", "result.json"), "utf8"));
    assert.equal(r2.cache.hit, true);
    assert.equal(r2.timings.buildMs, null);
  });

  it("rebuilds when the native fingerprint changes", async () => {
    const h = harness({ fingerprint: (dir) => `native-${dir}` });
    await h.verifier.verify({ app, source: { kind: "local", dir: checkout("c") }, scenario, outDir: join(root, "out3") });
    await h.verifier.verify({ app, source: { kind: "local", dir: checkout("d") }, scenario, outDir: join(root, "out4") });
    assert.equal(h.steps.filter((s) => s.startsWith("build ")).length, 2);
  });

  it("compares two sources screenshot by screenshot", async () => {
    const h = harness({ fingerprint: () => "cmp", shot: (n) => solidPng(4, 2, n === 1 ? 200 : 20) });
    const r = await h.verifier.verify({
      app,
      source: { kind: "local", dir: checkout("e") },
      compare: { kind: "git", ref: "main" },
      scenario,
      outDir: join(root, "cmp"),
    });
    assert.equal(r.exitCode, 0);
    const cmp = JSON.parse(readFileSync(join(root, "cmp", "compare.json"), "utf8"));
    assert.equal(cmp.screenshots[0].name, "first");
    assert.equal(cmp.screenshots[0].ratio, 1);
    assert.ok(existsSync(join(root, "cmp", "first.diff.png")));
    assert.ok(existsSync(join(root, "cmp", "ref", "first.png")));
    assert.ok(existsSync(join(root, "cmp", "compare", "first.png")));
    assert.ok(h.log.includes("create verify"), "the git side checks the ref out through the worktree manager");
    assert.ok(h.steps.includes(`install-deps ${join(root, "wt-repo", "apps", "mobile")}`), "a monorepo app keeps its place inside the checkout");
  });

  it("fails with exit code 1 and the failure screen when a step fails", async () => {
    const h = harness({ fingerprint: () => "f", answer: () => ({ ok: false, message: "not found" }) });
    const failing = parseScenario("steps:\n  - assert: text=Nowhere");
    const r = await h.verifier.verify({ app, source: { kind: "local", dir: checkout("g") }, scenario: failing, outDir: join(root, "fail") });
    assert.equal(r.exitCode, 1);
    assert.ok(existsSync(join(root, "fail", "failure.png")));
    const result = JSON.parse(readFileSync(join(root, "fail", "result.json"), "utf8"));
    assert.equal(result.passed, false);
    assert.deepEqual(result.steps.map((x: { ok: boolean }) => x.ok), [false]);
  });
});
