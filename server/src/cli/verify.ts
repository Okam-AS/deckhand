import { readFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { loadApps, loadConfig } from "../config.ts";
import { paths } from "../paths.ts";
import { Simctl } from "../devices/ios.ts";
import { MetroManager } from "../engine/metro.ts";
import { WorktreeManager } from "../engine/worktree.ts";
import { runStep } from "../engine/procs.ts";
import { buildTokenResolver } from "../github/credentials.ts";
import { loadSecretsEnv } from "../secrets.ts";
import { SimDeckControl } from "../testing/control.ts";
import { parseScenario } from "../verify/scenario.ts";
import { Verifier, type VerifySource } from "../verify/run.ts";
import { parseEnvAssignment } from "./configWrite.ts";

export const VERIFY_USAGE = `deckhand verify <appId> --scenario <file.yaml|json> [--ref <git ref> | --path <dir>]
                [--compare <git ref | /abs/dir>] [--out <dir>] [--env KEY=VALUE]...
                [--device <model>] [--runtime <iOS x.y>] [--orientation landscape|portrait]`;

export interface VerifyArgs {
  appId?: string;
  scenario?: string;
  ref?: string;
  path?: string;
  compare?: string;
  out?: string;
  env: string[];
  device?: string;
  runtime?: string;
  orientation?: string;
}

/** Repeated `--env` survives here; the shared parser keeps only the last value of a flag. */
export function parseVerifyArgs(argv: string[]): VerifyArgs {
  const a: VerifyArgs = { env: [] };
  const valued = new Set(["scenario", "ref", "path", "compare", "out", "env", "device", "runtime", "orientation"]);
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (!tok.startsWith("--")) {
      if (a.appId) throw new Error(`unexpected argument "${tok}"`);
      a.appId = tok;
      continue;
    }
    const key = tok.slice(2);
    if (!valued.has(key)) throw new Error(`unknown flag --${key}`);
    const v = argv[++i];
    if (v == null) throw new Error(`--${key} needs a value`);
    if (key === "env") a.env.push(v);
    else (a as unknown as Record<string, string>)[key] = v;
  }
  return a;
}

function toSource(v: string): VerifySource {
  return isAbsolute(v) ? { kind: "local", dir: v } : { kind: "git", ref: v };
}

export async function cmdVerify(argv: string[]): Promise<number> {
  const args = parseVerifyArgs(argv);
  if (!args.appId || !args.scenario) throw new Error(`usage: ${VERIFY_USAGE}`);
  if (args.ref && args.path) throw new Error("pass --ref or --path, not both");
  if (args.orientation && args.orientation !== "landscape" && args.orientation !== "portrait") {
    throw new Error("--orientation is landscape or portrait");
  }

  const config = loadConfig();
  const app = loadApps().find((x) => x.id === args.appId);
  if (!app) throw new Error(`no app "${args.appId}" — \`deckhand app list\` shows the registered ones`);

  const scenarioFile = resolve(args.scenario);
  const scenario = parseScenario(readFileSync(scenarioFile, "utf8"), basename(scenarioFile, extname(scenarioFile)));
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
  const env = Object.fromEntries(args.env.map((e) => {
    const { key, value } = parseEnvAssignment(e);
    return [key, value];
  }));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = resolve(args.out ?? join(paths.home(), "verify", "runs", `${stamp}-${scenario.name}`));

  const metro = new MetroManager();
  const stop = () => {
    void metro.stop().finally(() => process.exit(130));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const verifier = new Verifier({
    simctl: new Simctl(),
    metro,
    worktrees: new WorktreeManager({ tokenResolver: buildTokenResolver(config), allowAnonymous: config.allowPublicRepos }),
    simdeck: new SimDeckControl({ bin: config.simdeck?.bin, port: config.simdeck?.port, autostart: config.simdeck?.autostart }),
    runStep,
    secretsEnv: loadSecretsEnv,
    home: join(paths.home(), "verify"),
    log: (line) => console.error(line),
  });
  const r = await verifier.verify({
    app,
    source,
    compare: args.compare ? toSource(args.compare) : undefined,
    scenario,
    outDir,
    env,
  });
  console.log(JSON.stringify({ passed: r.passed, result: join(outDir, "result.json") }));
  return r.exitCode;
}
