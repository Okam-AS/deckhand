import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { paths } from "../paths.ts";
import { mergeTunnelConfig, renderTunnelConfig, parseTunnelConfig, tunnelIdFor, needsLogin } from "./tunnelConfig.ts";
import { checkPrereqs, humanInput, formatPrereqs, blocking, type Probe } from "./preflight.ts";
import { manualInstructions, normalizeTeamDomain } from "./accessApp.ts";
import { allowEmail, setAccessApplication } from "./configWrite.ts";
import { loadConfig } from "../config.ts";

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
  /** The address allowed to connect. Everything else about the connector follows from this one answer. */
  email?: string;
  /** Zero Trust team domain and Application Audience tag, read off the Access application. */
  accessTeam?: string;
  accessAud?: string;
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

/** The allowlist as it stands, or [] when there is no readable config yet. */
function currentAllowlist(): string[] {
  try {
    return loadConfig().connector.allowedEmails;
  } catch {
    return [];
  }
}

function accessConfigured(): boolean {
  try {
    return Boolean(loadConfig().connector.access);
  } catch {
    return false;
  }
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
    // Everything a bare Mac might be missing, and — the part that matters for an agent that
    // was handed a repo URL and nothing else — WHO can fix each one. An agent that runs
    // `cloudflared tunnel login` blocks on a browser prompt nobody sees; one that claims to
    // install Xcode does not install Xcode. Better to say plainly which is which.
    step("Prerequisites");
    const probe: Probe = {
      which: (cmd) => Boolean(run("which", [cmd]).out.trim()),
      run: (cmd, args) => run(cmd, args),
      nodeMajor: Number(process.versions.node.split(".")[0]),
      env: process.env,
    };
    const prereqs = checkPrereqs(probe);
    const human = humanInput(probe, { hostnameGiven: Boolean(opts.hostname) });
    say(formatPrereqs(prereqs, human));

    const stoppers = blocking(prereqs);
    if (stoppers.length || human.blockers.length || human.questions.length) {
      const agentFixable = stoppers.filter((c) => c.fix?.who === "agent");
      // The message is written for whoever runs this — most often an agent — and says which
      // of the three things to DO, in the order that gets to a working install fastest.
      const parts: string[] = [];
      if (agentFixable.length) parts.push(`Run: ${agentFixable.map((c) => c.fix!.how).join(" && ")}`);
      if (human.blockers.length) parts.push("Relay the BLOCKED items to the user and stop — you cannot do those.");
      if (human.questions.length && !human.blockers.length && !stoppers.length) {
        // Nothing is broken and nothing is blocked: the ONLY thing left is an answer. Say so
        // in one line, so an agent asks a question instead of filing a status report.
        parts.push(
          `Nothing is missing. Ask the user this, in these words: "${human.questions[0]!.ask}" — then run ` +
            `\`setup --hostname <their answer>\`. That is the whole remaining step; do not report status.`,
        );
      } else if (human.questions.length) {
        parts.push("Then ask the ASK THE USER questions above and re-run with the answers.");
      }
      throw new SetupError(
        stoppers.length
          ? `missing: ${stoppers.map((c) => c.name).join(", ")}`
          : human.blockers.length
            ? "blocked on something only the user can do"
            : "one answer needed",
        parts.join("\n  "),
      );
    }

    step("Cloudflare tunnel");
    // Unreachable: humanOnlySteps above already stops when there is no hostname. Stated
    // rather than assumed, so the invariant survives someone editing the preflight.
    const hostname = opts.hostname;
    if (!hostname) throw new SetupError("no --hostname given", "Pass --hostname deckhand.yourdomain.com");
    const tunnelId = ensureTunnel();
    const hostnames = [hostname, ...(opts.webHost ? [opts.webHost] : [])];
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
      const init = deckhandCli(["init", "--hostname", hostname, "--port", String(port)]);
      if (init.code !== 0) throw new SetupError(`deckhand init failed: ${init.out}`, "Fix the above, then re-run.");
      ok(`wrote ${paths.config()}`);
    }

    // Who may connect, and the Access application that proves it. This lives in the
    // tunnel half of setup on purpose: the tunnel is what makes deckhand reachable
    // from a Claude organisation, so the answer to "who" belongs in the same breath
    // as "reachable". Until it is answered, nobody can connect at all — the
    // allowlist starts empty and an empty allowlist admits no one.
    step("Who may connect");
    const emails = opts.email ? [opts.email.trim().toLowerCase()] : currentAllowlist();
    if (opts.email) {
      const { emails: after } = allowEmail(opts.email);
      ok(`only ${after.join(", ")} may connect this deckhand`);
    } else if (emails.length) {
      ok(`allowlist: ${emails.join(", ")} (change it with \`deckhand allow\`)`);
    } else {
      throw new SetupError(
        "nobody is allowed to connect yet",
        `Ask the user this, in these words: "Which email address should be allowed to connect to deckhand?" — ` +
          `then re-run with \`setup --hostname ${hostname} --email <their answer>\`. ` +
          `A connector URL added in Claude is visible to their whole organisation, so this address is what keeps everyone else out.`,
      );
    }

    if (opts.accessTeam && opts.accessAud) {
      setAccessApplication({ teamDomain: normalizeTeamDomain(opts.accessTeam), aud: opts.accessAud.trim() });
      ok(`Cloudflare Access application recorded — sign-ins are verified against ${normalizeTeamDomain(opts.accessTeam)}`);
    } else if (accessConfigured()) {
      ok("Cloudflare Access application already recorded");
    } else {
      // BLOCKED, in the preflight's sense: it needs their Cloudflare account and a
      // browser. Never attempt it, and never continue as if it were done — without
      // it `/oauth/authorize` refuses every request and the connector cannot be
      // authorized by anyone, including them.
      say("");
      say(manualInstructions({ hostname, emails }).split("\n").map((l) => `  ${l}`).join("\n"));
      throw new SetupError(
        "the Cloudflare Access application does not exist yet",
        "Relay the steps above to the user and stop — they need their own Cloudflare Zero Trust dashboard for this. " +
          "Everything else is done; re-running setup with --access-team and --access-aud finishes it.",
      );
    }

    step("Local credential");
    const list = deckhandCli(["token", "list"]);
    // `token list` is NOT silent on an empty install — it prints "no tokens yet — create one
    // with `deckhand token`", by design, because silence reads as a broken command. So a
    // non-empty stdout is not the existence test: that version took the "already exists"
    // branch on every fresh install, minted nothing, and ignored --token. Match the empty
    // state itself. (The check before that grepped for the word "admin", which stopped
    // meaning anything when roles went away — same class, twice.)
    if (list.code === 0 && !/no tokens yet/.test(list.out)) {
      ok("a token already exists — `deckhand token` prints its connector URL");
    } else {
      const name = opts.tokenName ?? process.env.USER ?? "me";
      const added = deckhandCli(["token", "add", name]);
      if (added.code !== 0) throw new SetupError(`could not create a token: ${added.out}`, "Fix the above, then re-run.");
      // Only the name. The URL is a credential and belongs in exactly one place: the single
      // step at the end, which the user is about to run deliberately.
      say(`  ✓ created a local credential for "${name}"`);
    }
    info("that one is for Claude Code on this Mac; claude.ai authorizes through Access instead");

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

    // ONE action, last, and impossible to miss.
    //
    // The previous ending listed three next steps and buried the only one that matters. An
    // agent relaying it produced a five-item status report with the actual instruction third
    // from the top, and people do not read that far — deckhand is installed and unusable
    // until the connector is pasted in, so that step is not one of several, it is the step.
    say("");
    say("  ┌─────────────────────────────────────────────────────────────┐");
    say("  │  ONE THING LEFT — deckhand does nothing until you do it.     │");
    say("  └─────────────────────────────────────────────────────────────┘");
    say("");
    say(`   1.  Paste  https://${hostname}/mcp  into claude.ai → Settings → Connectors → Add`);
    say("   2.  Click Connect. Cloudflare emails you a one-time code.");
    say("");
    say("   The URL is not a password — it is safe to share with your organisation.");
    say(`   Only ${emails.join(", ")} can actually connect through it.`);
    say("");
    say("   After that: `deckhand app add <id> --path /path/to/a/checkout`,");
    say("   then ask Claude for a preview.");
  } catch (e) {
    if (e instanceof SetupError) {
      console.error(`\n✗ ${e.message}\n\n  ${e.fix}\n`);
      process.exit(1);
    }
    throw e;
  }
}
