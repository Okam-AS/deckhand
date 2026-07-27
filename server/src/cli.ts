#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { stringify as toYaml } from "yaml";
import { loadConfig, loadApps, loadTokens, parseRepo, type Role } from "./config.ts";
import { paths } from "./paths.ts";
import { addTokenEntry, addAppEntry, parseEnvAssignment, writeTokens, writeApps, writeSecretEnv } from "./cli/configWrite.ts";
import { runDoctor, formatChecks } from "./cli/doctor.ts";

// Minimal, dependency-free arg parsing: positionals + `--key value` / `--flag`.
interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}
function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else _.push(a);
  }
  return { _, flags };
}

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const USAGE = `deckhand — simulator previews over MCP

Usage:
  deckhand serve                                   run the server
  deckhand doctor [--smoke]                        verify the install
  deckhand init --hostname H --github-app-id N --github-app-pem P [--port 4300]
  deckhand token add <name> [--role admin|member] [--owners a,b]
  deckhand token list
  deckhand app add <id> <repo> --type expo|react-native|nativescript [--branch main] [--bundle-id ID]
  deckhand app add <id> --path /abs/dir [--repo owner/name] [--type ...]   local dev mode (type auto-detected)
  deckhand app add <id> --path /abs/dir --type web                        local web dev server (Vite)
  deckhand app list
  deckhand env set <appId> KEY=VALUE`;

/**
 * Keep one bad request from taking every live preview down with it.
 *
 * This one process runs the spawn-heavy build/device/WS-bridge code, two
 * byte-stream parsers fed by device-controlled input, AND undici-backed proxy
 * fetches. All three routinely produce ASYNC faults that are NOT process-fatal:
 * a stray rejection in a WS bridge, a parse fault on a malformed NAL, and —
 * observed in the wild — undici surfacing a client-aborted proxy fetch as an
 * *uncaughtException* ("TypeError: terminated" from Fetch.onAborted). Every one
 * of those would otherwise drop every simulator on the machine.
 *
 * So both handlers log and keep serving. An earlier version exited on
 * uncaughtException for a "clean launchd restart" — but the dominant
 * uncaughtException here is a routine client-disconnect, so exiting turned every
 * dropped stream into a full server restart storm. launchd still catches genuine
 * process death; it must not be triggered by transient I/O. (The real fix is
 * catching those fetch/stream errors at the source; this is the backstop.)
 *
 * `serve` only: a CLI command that throws SHOULD still exit non-zero.
 */
function installCrashGuards(): void {
  const log = (kind: string, e: unknown) =>
    console.error(`[deckhand] ${kind} (kept serving): ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.on("unhandledRejection", (reason) => log("unhandled rejection", reason));
  process.on("uncaughtException", (err) => log("uncaught exception", err));
}

async function main(): Promise<void> {
  const { _, flags } = parseArgs(process.argv.slice(2));
  const [cmd, sub] = _;

  switch (cmd) {
    case "serve": {
      installCrashGuards();
      const { createServer } = await import("./server.ts");
      const s = createServer();
      await s.listen();
      console.log(`deckhand listening on 127.0.0.1:${s.config.port}`);
      console.log(`viewer/MCP reachable at https://${s.config.hostname} through the tunnel`);
      return;
    }

    case "doctor": {
      const { checks, ok } = await runDoctor({ smoke: Boolean(flags.smoke) });
      console.log(formatChecks(checks));
      process.exit(ok ? 0 : 1);
      return;
    }

    case "init":
      return cmdInit(flags);

    case "token":
      if (sub === "add") return cmdTokenAdd(_[2], flags);
      if (sub === "list") return cmdTokenList();
      return fail(`unknown token subcommand; see 'deckhand'`);

    case "app":
      if (sub === "add") return cmdAppAdd(_[2], _[3], flags);
      if (sub === "list") return cmdAppList();
      return fail(`unknown app subcommand; see 'deckhand'`);

    case "env":
      if (sub === "set") return cmdEnvSet(_[2], _[3]);
      return fail(`unknown env subcommand; see 'deckhand'`);

    default:
      console.log(USAGE);
      process.exit(cmd ? 1 : 0);
  }
}

function cmdInit(flags: Args["flags"]): void {
  const hostname = str(flags.hostname);
  const appId = Number(flags["github-app-id"]);
  const pemPath = str(flags["github-app-pem"]);
  if (!hostname || !appId || !pemPath) {
    fail("init requires --hostname, --github-app-id, and --github-app-pem");
  }
  mkdirSync(paths.home(), { recursive: true });
  mkdirSync(paths.secretsDir(), { recursive: true });
  // Copy the PEM into ~/.deckhand (0600).
  const pem = readFileSync(pemPath!, "utf8");
  writeFileSync(join(paths.home(), "github-app.pem"), pem, { mode: 0o600 });

  const config = {
    hostname,
    port: Number(flags.port) || 4300,
    streaming: { serveSim: { version: "0.1.34", codec: "auto", helperPortRange: [3100, 3199] } },
    githubApp: { appId, privateKeyPath: "github-app.pem" },
    githubAmbient: true,
    allowPublicRepos: false,
    limits: { maxDevicesPerPreview: 4, maxTotalDevices: 6, disk: { watch: 50, pressure: 35, critical: 20 } },
  };
  // 0600: the schema permits an inline `shareSecret`, and that key signs every
  // unlock cookie. Cheaper to protect the file than to rely on nobody using it.
  writeFileSync(paths.config(), toYaml(config), { mode: 0o600 });
  if (!existsSync(paths.apps())) writeApps([]);
  if (!existsSync(paths.tokens())) writeTokens([]);
  console.log(`initialized ${paths.home()}`);
  console.log("next: `deckhand token add <you> --role admin`, then set up the cloudflared tunnel (Phase 4 automates this).");
}

function cmdTokenAdd(name: string | undefined, flags: Args["flags"]): void {
  if (!name) fail("usage: deckhand token add <name> [--role admin|member] [--owners a,b]");
  const role = (str(flags.role) ?? "member") as Role;
  if (role !== "admin" && role !== "member") fail("role must be admin or member");
  const owners = str(flags.owners)?.split(",").map((s) => s.trim()).filter(Boolean);
  const { tokens, created } = addTokenEntry(loadTokensSafe(), { name: name!, role, ...(owners ? { owners } : {}) });
  writeTokens(tokens);
  const hostname = tryHostname();
  console.log(`created token for "${created.name}" (${created.role})`);
  if (hostname) console.log(`connector URL:  https://${hostname}/mcp/${created.token}`);
  else console.log(`token: ${created.token}`);
}

function cmdTokenList(): void {
  for (const t of loadTokensSafe()) {
    console.log(`${t.name}\t${t.role}${t.owners ? `\towners=${t.owners.join(",")}` : ""}`);
  }
}

async function cmdAppAdd(id: string | undefined, repo: string | undefined, flags: Args["flags"]): Promise<void> {
  const path = str(flags.path);
  repo = repo ?? str(flags.repo);
  if (!id || (!repo && !path)) {
    fail("usage: deckhand app add <id> <repo> --type ...   |   deckhand app add <id> --path /abs/dir");
  }
  let type = str(flags.type);
  let bundleId = str(flags["bundle-id"]);
  if (path) {
    // Local dev mode: the folder is right here — detect what the CLI can.
    if (!existsSync(path)) fail(`--path ${path} does not exist`);
    const { detectAppTypeFromDir, detectBundleIdFromDir } = await import("./engine/detect.ts");
    type = type ?? detectAppTypeFromDir(path) ?? undefined;
    if (type === "expo" || type === "react-native" || type === "nativescript") {
      bundleId = bundleId ?? detectBundleIdFromDir(path, type) ?? undefined;
    }
    // Auto-detect the checkout's origin remote (unless overridden or web) so this
    // local app ALSO records its repo — enabling git branch/PR previews later
    // without re-registering. Silent if there's no git remote (local-only is fine).
    if (!repo && type !== "web") {
      try {
        const remote = execFileSync("git", ["-C", path, "remote", "get-url", "origin"], {
          stdio: ["ignore", "pipe", "ignore"],
        })
          .toString()
          .trim();
        if (remote) {
          const { host, owner, name } = parseRepo(remote);
          repo = host === "github.com" ? `${owner}/${name}` : `${host}/${owner}/${name}`;
        }
      } catch {
        // no origin remote / not a git repo → a local-only app, which is fine
      }
    }
  }
  if (type !== "expo" && type !== "react-native" && type !== "nativescript" && type !== "web") {
    fail("--type must be expo, react-native, nativescript, or web (auto-detection found none)");
  }
  if (type === "web" && !path) {
    fail("a web app is a local dev server — pass --path /abs/dir");
  }
  const existing = loadAppsSafe();
  const migratesFrom = str(flags["migrates-from"]);
  if (migratesFrom) {
    if (migratesFrom === id) fail("--migrates-from can't point at the app itself");
    if (!existing.some((a) => a.id === migratesFrom)) {
      fail(`--migrates-from "${migratesFrom}" is not a registered app — register the source app first (deckhand app list)`);
    }
  }
  const apps = addAppEntry(existing, {
    id: id!,
    ...(repo ? { repo } : {}),
    ...(path ? { path } : {}),
    type,
    ...(str(flags.branch) ? { defaultBranch: str(flags.branch)! } : {}),
    ...(bundleId ? { bundleId } : {}),
    ...(migratesFrom ? { migratesFrom } : {}),
  });
  writeApps(apps);
  console.log(
    `registered app "${id}" (${type}${path ? `, local: ${path}` : ""}${repo ? `, repo: ${repo}` : ""}${migratesFrom ? `, migrates from: ${migratesFrom}` : ""})`,
  );
}

function cmdAppList(): void {
  for (const a of loadAppsSafe()) console.log(`${a.id}\t${a.type}\t${a.repo ?? a.path}`);
}

function cmdEnvSet(appId: string | undefined, assignment: string | undefined): void {
  if (!appId || !assignment) fail("usage: deckhand env set <appId> KEY=VALUE");
  const { key, value } = parseEnvAssignment(assignment!);
  writeSecretEnv(appId!, key, value);
  console.log(`set ${key} for app "${appId}" (stored 0600, never exposed via MCP)`);
}

// helpers
function str(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function loadTokensSafe() {
  try {
    return loadTokens();
  } catch {
    return [];
  }
}
function loadAppsSafe() {
  try {
    return loadApps();
  } catch {
    return [];
  }
}
function tryHostname(): string | null {
  try {
    return loadConfig().hostname;
  } catch {
    return null;
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
