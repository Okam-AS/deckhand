import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { paths } from "../paths.ts";
import { mergeTunnelConfig, renderTunnelConfig, parseTunnelConfig, tunnelIdFor, needsLogin } from "./tunnelConfig.ts";

// ---------------------------------------------------------------------------
// `deckhand setup` — one command from a bare Mac to a working connector URL.
//
// The pieces all existed; what did not exist was anything that ran them in order. A new user
// had to know that `init` needs a hostname they do not have yet, that the hostname comes from
// a Cloudflare named tunnel nothing in the repo mentions how to create, and that
// ops/install-services.sh exists at all (it appears only in a doctor warning). Six manual
// steps, none documented, before step one of the README worked.
//
// Every step is idempotent and says what it found, so this doubles as a repair tool: run it
// again after moving the checkout, changing the port, or losing a launch agent.
//
// The one thing it cannot do is `cloudflared tunnel login` — that opens a browser and is a
// human's decision about their own Cloudflare account. It detects that case and stops with
// the exact command, rather than failing three steps later with something unrelated.
// ---------------------------------------------------------------------------

const TUNNEL_NAME = "deckhand";

interface Run {
  code: number;
  out: string;
}

function run(cmd: string, args: string[]): Run {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

const say = (s: string): void => console.log(s);
const step = (s: string): void => console.log(`\n▸ ${s}`);
const ok = (s: string): void => console.log(`  ✓ ${s}`);
const info = (s: string): void => console.log(`  · ${s}`);

class SetupError extends Error {
  constructor(
    message: string,
    readonly fix: string,
  ) {
    super(message);
  }
}

export interface SetupOptions {
  hostname?: string;
  webHost?: string;
  port?: number;
  tokenName?: string;
  /** Skip the LaunchAgents (useful when running deckhand by hand). */
  noServices?: boolean;
}

/**
 * Find or create the named tunnel, and return its id.
 *
 * Adopts an existing tunnel rather than creating a second with the same name: cloudflared
 * allows that, and connections then split between the two at random — far harder to diagnose
 * than to avoid.
 */
function ensureTunnel(): string {
  const list = run("cloudflared", ["tunnel", "list"]);
  if (needsLogin(list.out, list.code)) {
    throw new SetupError(
      "cloudflared is not logged in to Cloudflare",
      "Run `cloudflared tunnel login` (it opens a browser, and needs a domain you control on Cloudflare), then run `deckhand setup` again.",
    );
  }
  if (list.code !== 0) throw new SetupError(`cloudflared tunnel list failed: ${list.out}`, "Fix the above, then re-run.");

  const existing = tunnelIdFor(list.out, TUNNEL_NAME);
  if (existing) {
    ok(`tunnel "${TUNNEL_NAME}" already exists (${existing.slice(0, 8)}…) — adopting it`);
    return existing;
  }
  const created = run("cloudflared", ["tunnel", "create", TUNNEL_NAME]);
  if (created.code !== 0) throw new SetupError(`could not create the tunnel: ${created.out}`, "Fix the above, then re-run.");
  const id = tunnelIdFor(run("cloudflared", ["tunnel", "list"]).out, TUNNEL_NAME);
  if (!id) throw new SetupError("created the tunnel but could not read its id back", "Run `cloudflared tunnel list` and check.");
  ok(`created tunnel "${TUNNEL_NAME}" (${id.slice(0, 8)}…)`);
  return id;
}

/** Point a hostname at the tunnel. Already-routed is success, not failure. */
function ensureRoute(tunnelId: string, hostname: string): void {
  const r = run("cloudflared", ["tunnel", "route", "dns", tunnelId, hostname]);
  if (r.code === 0) {
    ok(`DNS route ${hostname} → tunnel`);
    return;
  }
  if (/already exists|record with that host/i.test(r.out)) {
    ok(`DNS route ${hostname} already points at a tunnel`);
    return;
  }
  throw new SetupError(`could not route ${hostname}: ${r.out}`, "Check the domain is on Cloudflare and you own it.");
}

/**
 * Add deckhand's hostnames to ~/.cloudflared/config.yml, keeping everything already in it.
 *
 * Backed up before writing. This file routinely carries rules for unrelated services — the
 * machine this was written on had one on another port — and losing those is silent until
 * something stops answering.
 */
function ensureTunnelConfig(tunnelId: string, hostnames: string[], port: number): void {
  const dir = join(homedir(), ".cloudflared");
  const file = join(dir, "config.yml");
  const before = existsSync(file) ? readFileSync(file, "utf8") : null;
  const merged = mergeTunnelConfig(parseTunnelConfig(before), {
    tunnelId,
    credentialsFile: join(dir, `${tunnelId}.json`),
    hostnames,
    port,
  });
  const body = renderTunnelConfig(merged);
  if (before === body) {
    ok("cloudflared config already correct");
    return;
  }
  mkdirSync(dir, { recursive: true });
  if (before !== null) {
    const backup = `${file}.bak`;
    copyFileSync(file, backup);
    info(`previous config saved to ${backup}`);
  }
  writeFileSync(file, body);
  ok(`cloudflared config points ${hostnames.join(", ")} at 127.0.0.1:${port}`);
}

function deckhandCli(args: string[]): Run {
  // The same entry point the user would type, so setup cannot drift from it.
  const cli = join(dirname(new URL(import.meta.url).pathname), "..", "cli.ts");
  return run(process.execPath, ["--import", "tsx", cli, ...args]);
}

export async function cmdSetup(opts: SetupOptions): Promise<void> {
  const port = opts.port ?? 4300;
  say("deckhand setup — from a bare Mac to a connector URL.\n");

  try {
    step("Cloudflare tunnel");
    if (!run("which", ["cloudflared"]).out) {
      throw new SetupError("cloudflared is not installed", "brew install cloudflared");
    }
    if (!opts.hostname) {
      throw new SetupError(
        "no --hostname given",
        "Pick a hostname on a domain you have on Cloudflare, e.g. `deckhand setup --hostname deckhand.example.com`. " +
          "Add `--web-host previews.example.com` too if you want to preview web apps.",
      );
    }
    const tunnelId = ensureTunnel();
    const hostnames = [opts.hostname, ...(opts.webHost ? [opts.webHost] : [])];
    for (const h of hostnames) ensureRoute(tunnelId, h);
    ensureTunnelConfig(tunnelId, hostnames, port);

    step("The `deckhand` command");
    if (run("which", ["deckhand"]).out.trim()) {
      ok("`deckhand` is on your PATH");
    } else {
      // Every document in this repo tells people to type `deckhand <something>`, and until
      // there was a bin entry no such command existed. `npm link` puts it in the same prefix
      // npm/npx already use, so it needs no sudo and no PATH edit; undo with `npm unlink -g
      // @deckhand/server`.
      const repoRoot = join(dirname(new URL(import.meta.url).pathname), "..", "..", "..");
      const linked = spawnSync("npm", ["link", "--workspace", "@deckhand/server"], { cwd: repoRoot, encoding: "utf8" });
      if ((linked.status ?? 1) === 0 && run("which", ["deckhand"]).out.trim()) ok("linked `deckhand` onto your PATH");
      else info(`could not link it — keep using \`npx tsx ${join(repoRoot, "server/src/cli.ts")}\`, or add server/bin to PATH.`);
    }

    step("deckhand config");
    if (existsSync(paths.config())) {
      ok(`${paths.config()} already exists — leaving it alone`);
    } else {
      const init = deckhandCli(["init", "--hostname", opts.hostname, "--port", String(port)]);
      if (init.code !== 0) throw new SetupError(`deckhand init failed: ${init.out}`, "Fix the above, then re-run.");
      ok(`wrote ${paths.config()}`);
    }

    step("Admin token");
    let printedToken = false;
    const list = deckhandCli(["token", "list"]);
    if (list.code === 0 && /admin/.test(list.out)) {
      ok("an admin token already exists — `deckhand token url <name>` prints its connector URL");
    } else {
      const name = opts.tokenName ?? process.env.USER ?? "me";
      const added = deckhandCli(["token", "add", name, "--role", "admin"]);
      if (added.code !== 0) throw new SetupError(`could not create a token: ${added.out}`, "Fix the above, then re-run.");
      say(added.out.split("\n").map((l) => `  ${l}`).join("\n"));
      printedToken = true;
    }

    if (!opts.noServices) {
      step("Keep it running (LaunchAgents)");
      const repoRoot = join(dirname(new URL(import.meta.url).pathname), "..", "..", "..");
      const script = join(repoRoot, "ops", "install-services.sh");
      if (!existsSync(script)) {
        info(`${script} not found — skipping. Start deckhand by hand with \`deckhand serve\`.`);
      } else {
        const r = run("bash", [script]);
        if (r.code !== 0) throw new SetupError(`installing the LaunchAgents failed: ${r.out}`, "Fix the above, or re-run with --no-services.");
        ok("server + tunnel survive crashes, sleep and reboot");
      }
    }

    step("Check");
    const doctor = deckhandCli(["doctor"]);
    say(doctor.out.split("\n").map((l) => `  ${l}`).join("\n"));

    say("\nDone. Next: register an app, then ask your agent for a preview.");
    say(`  deckhand app add <id> --path /abs/path/to/a/checkout    (local — no GitHub needed)`);
    say(`  deckhand app add <id> github.com/owner/repo             (from git)`);
    say(
      printedToken
        ? `\nGive the connector URL above to claude.ai as an MCP connector.`
        : `\nYour connector URL: \`deckhand token url <name>\` (\`deckhand token list\` shows the names). Give it to claude.ai as an MCP connector.`,
    );
  } catch (e) {
    if (e instanceof SetupError) {
      console.error(`\n✗ ${e.message}\n\n  ${e.fix}\n`);
      process.exit(1);
    }
    throw e;
  }
}
