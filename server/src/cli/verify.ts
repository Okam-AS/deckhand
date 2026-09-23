import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { loadApps, loadConfig, loadTokens, type App } from "../config.ts";
import { paths } from "../paths.ts";
import { Simctl } from "../devices/ios.ts";
import { MetroManager } from "../engine/metro.ts";
import { WorktreeManager } from "../engine/worktree.ts";
import { runStep } from "../engine/procs.ts";
import { buildTokenResolver } from "../github/credentials.ts";
import { loadSecretsEnv } from "../secrets.ts";
import { SimDeckControl } from "../testing/control.ts";
import { lintScenario, parseScenario, type Diagnostic, type Scenario } from "../verify/scenario.ts";
import { Verifier, type VerifySource } from "../verify/run.ts";
import { parseEnvAssignment } from "./configWrite.ts";
import { LiveShareClient } from "./liveShare.ts";

export const VERIFY_USAGE = `deckhand verify <appId> --scenario <file.yaml|json> [--ref <git ref> | --path <dir>]
                [--compare <git ref | /abs/dir>] [--max-diff-ratio 0..1] [--out <dir>] [--env KEY=VALUE]...
                [--device <model>] [--runtime <iOS x.y>] [--orientation landscape|portrait] [--timeout <seconds>]
                [--share public]   watch the run live: prints DECKHAND_LIVE_URL=<url> on stderr, revoked at the end
       deckhand verify --lint --scenario <file.yaml|json>     validate only; JSON diagnostics on stdout
exit: 0 passed, 1 a step or the diff budget failed, 2 build/device/launch, 3 bad arguments or scenario
scenario schema: docs/verify-scenarios.md`;

export const DEFAULT_TIMEOUT_S = 30 * 60;

/** Bad arguments or a bad scenario: exit 3, before anything is built. */
export class VerifyInputError extends Error {}

export interface VerifyArgs {
  appId?: string;
  scenario?: string;
  ref?: string;
  path?: string;
  compare?: string;
  out?: string;
  env: string[];
  lint?: boolean;
  device?: string;
  runtime?: string;
  orientation?: string;
  timeout?: string;
  "max-diff-ratio"?: string;
  share?: string;
}

/** Repeated `--env` survives here; the shared parser keeps only the last value of a flag. */
export function parseVerifyArgs(argv: string[]): VerifyArgs {
  const a: VerifyArgs = { env: [] };
  const valued = new Set(["scenario", "ref", "path", "compare", "out", "env", "device", "runtime", "orientation", "timeout", "max-diff-ratio", "share"]);
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (!tok.startsWith("--")) {
      if (a.appId) throw new VerifyInputError(`unexpected argument "${tok}"`);
      a.appId = tok;
      continue;
    }
    const key = tok.slice(2);
    if (key === "lint") {
      a.lint = true;
      continue;
    }
    if (!valued.has(key)) throw new VerifyInputError(`unknown flag --${key}`);
    const v = argv[++i];
    if (v == null) throw new VerifyInputError(`--${key} needs a value`);
    if (key === "env") a.env.push(v);
    else (a as unknown as Record<string, string>)[key] = v;
  }
  return a;
}

function toSource(v: string): VerifySource {
  return isAbsolute(v) ? { kind: "local", dir: v } : { kind: "git", ref: v };
}

function positive(v: string | undefined, flag: string, max = Infinity): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new VerifyInputError(`--${flag} must be a number between 0 and ${max}`);
  return n;
}

interface Prepared {
  config: ReturnType<typeof loadConfig>;
  app: App;
  scenario: Scenario;
  source: VerifySource;
  compare?: VerifySource;
  env: Record<string, string>;
  outDir: string;
  timeoutS: number;
  maxDiffRatio?: number;
  share: boolean;
}

function prepare(argv: string[]): Prepared {
  const args = parseVerifyArgs(argv);
  if (!args.appId || !args.scenario) throw new VerifyInputError(`usage: ${VERIFY_USAGE}`);
  if (args.ref && args.path) throw new VerifyInputError("pass --ref or --path, not both");
  if (args.orientation && args.orientation !== "landscape" && args.orientation !== "portrait") {
    throw new VerifyInputError("--orientation is landscape or portrait");
  }
  if (args.share != null && args.share !== "public") throw new VerifyInputError("--share takes public (a view-only link anyone holding it can watch)");
  const timeoutS = positive(args.timeout, "timeout") ?? DEFAULT_TIMEOUT_S;
  const maxDiffRatio = positive(args["max-diff-ratio"], "max-diff-ratio", 1);

  const config = loadConfig();
  const app = loadApps().find((x) => x.id === args.appId);
  if (!app) throw new VerifyInputError(`no app "${args.appId}" — \`deckhand app list\` shows the registered ones`);

  const scenarioFile = resolve(args.scenario);
  let scenario: Scenario;
  try {
    scenario = parseScenario(readFileSync(scenarioFile, "utf8"), basename(scenarioFile, extname(scenarioFile)));
  } catch (e) {
    throw new VerifyInputError(`${scenarioFile}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (args.device) scenario.device.model = args.device;
  if (args.runtime) scenario.device.runtime = args.runtime;
  if (args.orientation) scenario.device.orientation = args.orientation as "landscape" | "portrait";

  const source: VerifySource = args.path
    ? { kind: "local", dir: resolve(args.path) }
    : args.ref
      ? { kind: "git", ref: args.ref }
      : app.path
        ? { kind: "local", dir: app.path }
        : { kind: "git", ref: app.defaultBranch };
  let env: Record<string, string>;
  try {
    env = Object.fromEntries(args.env.map((e) => {
      const { key, value } = parseEnvAssignment(e);
      return [key, value];
    }));
  } catch (e) {
    throw new VerifyInputError(e instanceof Error ? e.message : String(e));
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = resolve(args.out ?? join(paths.home(), "verify", "runs", `${stamp}-${scenario.name}`));
  return { config, app, scenario, source, compare: args.compare ? toSource(args.compare) : undefined, env, outDir, timeoutS, maxDiffRatio, share: args.share === "public" };
}

/** Exit 0 or 3, and always one JSON object on stdout, bad arguments included: a caller parses it rather than scraping stderr. */
function lint(argv: string[]): number {
  const emit = (ok: boolean, scenario: string | null, steps: number, diagnostics: Diagnostic[]) => {
    console.log(JSON.stringify({ ok, scenario, steps, diagnostics }));
    return ok ? 0 : 3;
  };
  const refuse = (message: string, file: string | null = null) => emit(false, file, 0, [{ step: null, field: "arguments", message }]);
  let args: VerifyArgs;
  try {
    args = parseVerifyArgs(argv);
  } catch (e) {
    return refuse(e instanceof Error ? e.message : String(e));
  }
  if (!args.scenario) return refuse("--lint needs --scenario <file>");
  const extra = (["ref", "path", "compare", "out", "device", "runtime", "orientation", "timeout", "max-diff-ratio", "share"] as const).filter((k) => args[k] != null);
  const stray = [args.appId, ...(args.env.length ? ["--env"] : []), ...extra.map((k) => `--${k}`)].filter(Boolean);
  const file = resolve(args.scenario);
  if (stray.length) return refuse(`--lint takes only --scenario; drop ${stray.join(", ")}`, file);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    return emit(false, file, 0, [{ step: null, field: "scenario", message: `cannot read the scenario: ${e instanceof Error ? e.message : String(e)}` }]);
  }
  const r = lintScenario(text);
  return emit(r.ok, file, r.steps, r.diagnostics);
}

export async function cmdVerify(argv: string[]): Promise<number> {
  if (argv.includes("--lint")) return lint(argv);
  let p: Prepared;
  try {
    p = prepare(argv);
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return e instanceof VerifyInputError ? 3 : 2;
  }
  const home = join(paths.home(), "verify");
  const verifier = new Verifier({
    simctl: new Simctl(),
    metro: new MetroManager(),
    worktrees: new WorktreeManager({
      tokenResolver: buildTokenResolver(p.config),
      allowAnonymous: p.config.allowPublicRepos,
      root: join(home, "worktrees"),
    }),
    simdeck: new SimDeckControl({ bin: p.config.simdeck?.bin, port: p.config.simdeck?.port, autostart: p.config.simdeck?.autostart }),
    runStep,
    secretsEnv: loadSecretsEnv,
    home,
    log: (line) => console.error(line),
  });

  const live = p.share
    ? new LiveShareClient({ port: p.config.port, token: firstToken(), appId: p.app.id, pid: process.pid, log: (line) => console.error(line) })
    : null;
  let liveUrl: string | null = null;
  const bail = (code: number, why: string) => {
    void Promise.all([verifier.abort(), live?.close()]).finally(() => {
      mkdirSync(p.outDir, { recursive: true });
      const shared = live ? { liveUrl } : {};
      writeFileSync(join(p.outDir, "result.json"), JSON.stringify({ passed: false, outcome: "infra", exitCode: code, error: why, ...shared }, null, 2));
      console.error(`error: ${why}`);
      process.exit(code);
    });
  };
  process.once("SIGINT", () => bail(130, "interrupted (SIGINT)"));
  process.once("SIGTERM", () => bail(143, "terminated (SIGTERM)"));
  const timer = setTimeout(() => bail(2, `timed out after ${p.timeoutS}s (--timeout)`), p.timeoutS * 1000);
  timer.unref();

  try {
    const r = await verifier.verify({
      app: p.app,
      source: p.source,
      compare: p.compare,
      scenario: p.scenario,
      outDir: p.outDir,
      env: p.env,
      maxDiffRatio: p.maxDiffRatio,
      ...(live ? { share: async (udid: string) => (liveUrl = await live.open(udid)) } : {}),
    });
    console.log(JSON.stringify({ passed: r.passed, exitCode: r.exitCode, result: join(p.outDir, "result.json") }));
    return r.exitCode;
  } catch (e) {
    await verifier.abort();
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  } finally {
    clearTimeout(timer);
    await live?.close();
  }
}

function firstToken(): string | null {
  try {
    return loadTokens()[0]?.token ?? null;
  } catch {
    return null;
  }
}
