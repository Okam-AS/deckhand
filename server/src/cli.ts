#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { stringify as toYaml } from "yaml";
import { loadConfig, loadApps, loadTokens, parseRepo } from "./config.ts";
import { paths } from "./paths.ts";
import {
  addTokenEntry,
  removeTokenEntry,
  addAppEntry,
  buildInitConfig,
  parseEnvAssignment,
  writeTokens,
  writeApps,
  writeSecretEnv,
} from "./cli/configWrite.ts";
import { runDoctor, formatChecks, deviceGateExit } from "./cli/doctor.ts";

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

New here? One command does the whole install:

  deckhand setup --hostname deckhand.example.com [--web-host previews.example.com]

  It creates the Cloudflare tunnel and DNS route, writes the config, mints your
  connector URL, installs the LaunchAgents, and runs doctor. Re-runnable:
  every step reports what it found and changes only what is missing.

Everything else, for when you already know what you want:
  deckhand serve                                   run the server
  deckhand doctor [--smoke | --device-only]        verify the install
  deckhand init --hostname H [--github-app-id N --github-app-pem P] [--port 4300]
                                                   the App is optional: without it
                                                   deckhand uses your gh CLI session
  deckhand approve [CODE]                          approve a waiting connection (bare: list what waits)
  deckhand deny CODE                               refuse one
  deckhand connections                             clients that hold a grant now
  deckhand revoke <client-id>                      take a client's access away
  deckhand token add <name>                        another LOCAL credential (Claude Code on this Mac)
  deckhand token                                   your connector URL
  deckhand token list                              the local credentials that exist (values masked)
  deckhand token rm <name>                         revoke one, effective immediately
  deckhand token url <name>                        print one local credential in full
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
      // `--device-only` is the regression gate (`npm run test:device`): it runs
      // the same checks but its EXIT CODE reflects only the ones a code change
      // can break. Plain `doctor` also fails on install problems — no GitHub
      // credential, no launchd agent — which are real, and are exactly the wrong
      // reason for a code gate to go red. A gate that fails for reasons the
      // author cannot fix gets ignored within a week.
      const deviceOnly = Boolean(flags["device-only"]);
      const { checks, ok } = await runDoctor({ smoke: Boolean(flags.smoke) || deviceOnly });
      console.log(formatChecks(checks));
      if (!deviceOnly) {
        process.exit(ok ? 0 : 1);
        return;
      }
      const gate = deviceGateExit(checks);
      for (const c of gate.failed) console.error(`gate failed: ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
      if (gate.reason) console.error(`gate did not run: ${gate.reason}`);
      process.exit(gate.code);
    }

    case "setup": {
      // The one command a new user runs. Everything else is for when you already know what
      // you are doing — see ops/README.md and the usage above.
      const { cmdSetup } = await import("./cli/setup.ts");
      return cmdSetup({
        hostname: str(flags.hostname),
        webHost: str(flags["web-host"]),
        port: flags.port ? Number(flags.port) : undefined,
        tokenName: str(flags.token),
        noServices: Boolean(flags["no-services"]),
      });
    }

    case "approve":
      return cmdApprove(sub);

    case "deny":
      return cmdDeny(sub);

    case "connections":
      return cmdConnections();

    case "revoke":
      return cmdRevoke(sub);

    case "init":
      return cmdInit(flags);

    case "token":
      // Bare `deckhand token` is the answer to "what do I paste into claude.ai" — now just the
      // endpoint, since the credential left the URL. The subcommands manage LOCAL credentials
      // for clients on this Mac that cannot run a browser sign-in.
      if (!sub) return cmdTokenMine();
      if (sub === "add") return cmdTokenAdd(_[2]);
      if (sub === "rm") return cmdTokenRm(_[2]);
      if (sub === "list") return cmdTokenList();
      if (sub === "url") return cmdTokenUrl(_[2]);
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
  const { config, pemPath } = buildInitConfig({
    hostname: str(flags.hostname),
    port: str(flags.port),
    githubAppId: str(flags["github-app-id"]),
    githubAppPem: str(flags["github-app-pem"]),
  });
  mkdirSync(paths.home(), { recursive: true });
  mkdirSync(paths.secretsDir(), { recursive: true });

  const homePem = join(paths.home(), "github-app.pem");
  if (pemPath) {
    writeFileSync(homePem, readFileSync(pemPath, "utf8"), { mode: 0o600 });
  } else if (existsSync(homePem)) {
    console.log(`note: ${homePem} is still on disk but this config has no githubApp — it will be ignored.`);
  }
  // 0600: the schema permits an inline `shareSecret`, and that key signs every
  // unlock cookie. Cheaper to protect the file than to rely on nobody using it.
  writeFileSync(paths.config(), toYaml(config), { mode: 0o600 });
  if (!existsSync(paths.apps())) writeApps([]);
  if (!existsSync(paths.tokens())) writeTokens([]);
  console.log(`initialized ${paths.home()}`);
  if (!config.githubApp) {
    console.log("no GitHub App configured — deckhand will use your `gh` CLI session (githubAmbient) to read repos.");
  }
  console.log("next: `deckhand token`, then set up the cloudflared tunnel (Phase 4 automates this).");
}

function cmdTokenAdd(name: string | undefined): void {
  if (!name) fail("usage: deckhand token add <name>");
  const { tokens, created } = addTokenEntry(loadTokensForWrite(), { name: name! });
  writeTokens(tokens);
  const hostname = tryHostname();
  console.log(`created token "${created.name}"`);
  if (hostname) console.log(`connector URL:  https://${hostname}/mcp/${created.token}`);
  else console.log(`token: ${created.token}`);
}

/**
 * Revoke a credential. The connector URL carries the token as a path segment, so it lands in
 * every proxy log, screen share and scrollback it ever passes through — this is the way back
 * from that, and until it existed the answer was "hand-edit tokens.yaml".
 *
 * Takes effect immediately: the running server watches the file (`tokensWatcher.ts`) and the
 * watcher compares CONTENT, so rotating a value under the same name applies too.
 */
function cmdTokenRm(name: string | undefined): void {
  if (!name) fail("usage: deckhand token rm <name>   (`deckhand token list` shows the names)");
  let result;
  try {
    result = removeTokenEntry(loadTokensForWrite(), name!);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  writeTokens(result.tokens);
  console.log(`revoked "${result.removed.name}" — that connector URL stops working now.`);
  if (result.tokens.length === 0) console.log("no tokens left; `deckhand token` mints a new one.");
}

function cmdTokenList(): void {
  const tokens = loadTokensSafe();
  const hostname = tryHostname();
  for (const t of tokens) {
    // Masked, not full. `list` is what you run to see WHO has access; printing every
    // credential in full to answer that puts them in a scrollback, a screen share and a
    // screenshot. The one you actually want goes through `token url <name>`, which is a
    // deliberate act rather than a side effect.
    const hint = hostname ? `https://${hostname}/mcp/${t.token.slice(0, 6)}…` : `${t.token.slice(0, 6)}…`;
    console.log(`${t.name}\t${hint}`);
  }
  if (tokens.length) console.log(`\nFull connector URL for one of them:  deckhand token url <name>`);
  else console.log(`no tokens yet — create one with \`deckhand token\``);
}

/**
 * "What do I paste into claude.ai" — the only token command most installs need.
 *
 * The answer no longer contains a secret. The credential used to be a path segment in this
 * URL, which was safe only while the URL was, and a connector added in Claude Enterprise is
 * visible to the whole organisation. Now the URL names the endpoint and nothing else; who may
 * actually connects is decided one request at a time, by the operator, with `deckhand approve`.
 */
function cmdTokenMine(): void {
  const hostname = tryHostname();
  if (!hostname) fail("no hostname in config.yaml — run `deckhand setup --hostname ...` first");
  console.log(`https://${hostname}/mcp`);
  console.error(`\nPaste that into claude.ai → Settings → Connectors → Add, then click Connect.`);
  console.error(`Claude will show a code and wait. AGENT: ask the user for that code, then run`);
  console.error(`\`deckhand approve <CODE>\` yourself — do not hand them the command.`);
  console.error(`The URL itself is not a credential — sharing it with your organisation is fine,`);
  console.error(`because nothing connects until somebody at this Mac approves it.`);
}

/**
 * Print one LOCAL credential in full.
 *
 * Local means a client on this Mac with no browser to wait in — Claude Code, a script.
 * It is a bearer token: it goes in an `Authorization: Bearer` header, never in a URL, and
 * never into a connector anyone else can see.
 */
function cmdTokenUrl(name: string | undefined): void {
  if (!name) fail("usage: deckhand token url <name>   (see `deckhand token list`)");
  const found = loadTokensSafe().find((t) => t.name === name);
  if (!found) fail(`no token named "${name}" — \`deckhand token list\` shows them`);
  console.log(found!.token);
  console.error(`\nA LOCAL credential, for a client on this Mac: send it as \`Authorization: Bearer <token>\` to`);
  console.error(`https://${tryHostname() ?? "<hostname>"}/mcp. Treat it like a password — it needs no approval.`);
}

// --- who may connect -------------------------------------------------------

/**
 * Talk to the running server with this machine's own credential.
 *
 * Pairing state is in memory in the server, not on disk, so the CLI cannot answer these
 * questions by reading a file the way `token list` does — and should not: a pending request is
 * worth seconds, and a file would make an approval outlive the browser waiting for it.
 */
async function pairCall(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const token = loadTokensSafe()[0]?.token;
  if (!token) fail("no local credential yet — run `deckhand token add me` first");
  const port = tryPort() ?? 4300;
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/pair/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token!}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    fail(`the deckhand server is not answering on 127.0.0.1:${port} — \`deckhand doctor\` says why`);
    throw new Error("unreachable");
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) fail(typeof json.detail === "string" ? json.detail : `the server refused: ${res.status}`);
  return json;
}

const waited = (ms: number): string => (ms < 60_000 ? `${Math.round(ms / 1000)}s ago` : `${Math.round(ms / 60_000)}m ago`);

/**
 * Approve a waiting connection — the one place a new client is let in.
 *
 * Bare `deckhand approve` LISTS rather than approving anything. Approving whatever happens to
 * be waiting is exactly the mistake this whole mechanism exists to prevent: the operator has
 * to match the code on their own screen against the one in the browser, or a colleague's
 * request is indistinguishable from their own.
 */
async function cmdApprove(code: string | undefined): Promise<void> {
  if (!code) {
    const { pending } = (await pairCall("pending")) as { pending: { code: string; clientName: string; waitingMs: number }[] };
    if (!pending.length) {
      console.log("nothing is waiting. Paste your connector URL into claude.ai and click Connect, then run this again.");
      return;
    }
    for (const p of pending) console.log(`${p.code}   ${p.clientName}   ${waited(p.waitingMs)}`);
    console.error(`\nApprove the one whose code matches YOUR browser: \`deckhand approve <CODE>\``);
    console.error(`If none of them is yours, approve none of them — somebody else has your connector URL.`);
    return;
  }
  const { approved } = (await pairCall("approve", { code })) as { approved: { code: string; clientName: string } };
  console.log(`approved ${approved.code} (${approved.clientName}) — the browser waiting on it will continue.`);
}

async function cmdDeny(code: string | undefined): Promise<void> {
  if (!code) fail("usage: deckhand deny <CODE>   (`deckhand approve` lists what is waiting)");
  const { denied } = (await pairCall("deny", { code: code! })) as { denied: { code: string; clientName: string } };
  console.log(`refused ${denied.code} (${denied.clientName}). Nothing was connected.`);
}

async function cmdConnections(): Promise<void> {
  const { connections } = (await pairCall("connections")) as { connections: { clientId: string; label: string }[] };
  if (!connections.length) {
    console.log("no client holds a grant. Local credentials are separate — `deckhand token list`.");
    return;
  }
  for (const c of connections) console.log(`${c.clientId}   ${c.label}`);
  console.error(`\nTake one away with \`deckhand revoke <client-id>\`.`);
}

async function cmdRevoke(clientId: string | undefined): Promise<void> {
  if (!clientId) fail("usage: deckhand revoke <client-id>   (`deckhand connections` lists them)");
  const { revoked } = (await pairCall("revoke", { clientId: clientId! })) as { revoked: number };
  // No restart and no waiting for expiry: the grant is gone, so the next call fails.
  if (!revoked) fail(`no grant for "${clientId}" — \`deckhand connections\` shows them`);
  console.log(`revoked ${revoked} grant${revoked === 1 ? "" : "s"} — that client is out as of its next call.`);
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
    const { detectAppTypeFromDir, detectBundleIdFromDir, resolveExpoConfigFromDir, expoBundleId } =
      await import("./engine/detect.ts");
    type = type ?? detectAppTypeFromDir(path) ?? undefined;
    if (type === "expo") {
      // Expo apps may declare the bundle id in a dynamic app.config.* — resolve it.
      const { config, error } = await resolveExpoConfigFromDir(path);
      bundleId = bundleId ?? expoBundleId(config, "ios") ?? undefined;
      if (!bundleId && error) console.error(`warning: could not evaluate this project's Expo config: ${error}`);
    } else if (type === "react-native" || type === "nativescript") {
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
  const existing = loadAppsForWrite();
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

/**
 * The token list for a command that WRITES it back.
 *
 * `loadTokensSafe` answers "" with an empty list, which is right for a read-only view and wrong
 * here twice over: `token add` would write a file containing only the new entry, silently
 * destroying every other credential (principle 2), and `token rm` would report `no token named
 * X` for a credential that is still live in the running server (principle 3 — a failed lookup
 * and an empty result must not be the same value). A missing file is genuinely empty; an
 * unreadable one is an error the operator has to see, because the watcher keeps serving the old
 * set either way.
 */
function loadTokensForWrite() {
  if (!existsSync(paths.tokens())) return [];
  try {
    return loadTokens();
  } catch (e) {
    fail(
      `${e instanceof Error ? e.message : String(e)}\n` +
        `refusing to rewrite ${paths.tokens()} from a copy that would not load back — ` +
        `fix the file first. The running server is still using the last good list.`,
    );
  }
}
/** Read-only paths (`app list`): an unreadable file honestly shows nothing. */
function loadAppsSafe() {
  try {
    return loadApps();
  } catch {
    return [];
  }
}

/**
 * Read for a path that will WRITE the file back.
 *
 * Treating an unreadable apps.yaml as empty is fine when listing and
 * catastrophic when adding: `addAppEntry([], newApp)` then writes a file
 * containing ONLY the new app, silently deregistering every other one — and the
 * command prints "registered app" as if nothing happened. A YAML typo, a
 * half-written file or a permissions blip is enough to trigger it, and the
 * original is gone.
 *
 * A MISSING file is still fine: that is the first-run case, and `init` writes an
 * empty list for exactly that reason.
 */
function loadAppsForWrite() {
  if (!existsSync(paths.apps())) return [];
  try {
    return loadApps();
  } catch (e) {
    fail(
      `apps.yaml could not be read (${e instanceof Error ? e.message : String(e)}).\n` +
        `Refusing to rewrite it — doing so would deregister every app already in it.\n` +
        `Fix ${paths.apps()} first, then run this again.`,
    );
  }
}
function tryHostname(): string | null {
  try {
    return loadConfig().hostname;
  } catch {
    return null;
  }
}

/** The port the server is on, or null when there is no readable config to say. */
function tryPort(): number | null {
  try {
    return loadConfig().port;
  } catch {
    return null;
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
