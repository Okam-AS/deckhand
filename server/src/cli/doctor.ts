import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createPrivateKey } from "node:crypto";
import { loadConfig, loadApps, loadTokens, githubPatPath, githubPrivateKeyPath, type App, type Config } from "../config.ts";
import { GitHubAppAuth } from "../github/appAuth.ts";
import { ghCliToken } from "../github/credentials.ts";
import { Simctl, selectRuntime, selectDeviceType } from "../devices/ios.ts";
import { ServeSimBackend } from "../streaming/serveSim.ts";
import { detectWebFrameworkFromDir, webHostingMode } from "../engine/detect.ts";

// ---------------------------------------------------------------------------
// `deckhand doctor` — independently-reportable checks. Default runs the fast
// checks (config, toolchains, GitHub); `--smoke` adds the real end-to-end test
// (boot a sim, attach serve-sim, confirm a first frame, tear down).
// ---------------------------------------------------------------------------

export interface Check {
  name: string;
  ok: boolean;
  skipped?: boolean;
  /** A non-failing advisory (rendered ⚠, does not make doctor exit non-zero). */
  warn?: boolean;
  detail?: string;
}

function which(cmd: string, args: readonly string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args as string[], { timeout: 15_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (stdout || stderr || "").toString().trim().split("\n")[0] ?? "" });
    });
  });
}

async function checkToolchains(): Promise<Check[]> {
  const checks: Check[] = [];
  const node = process.versions.node;
  checks.push({ name: "node >= 22", ok: Number(node.split(".")[0]) >= 22, detail: `v${node}` });
  for (const [name, cmd, args] of [
    ["xcodebuild", "xcodebuild", ["-version"]],
    ["simctl", "xcrun", ["simctl", "help"]],
  ] as const) {
    const r = await which(cmd, args);
    checks.push({ name, ok: r.ok, detail: r.ok ? r.out : "not found" });
  }
  return checks;
}

async function checkServeSim(config: Config): Promise<Check> {
  // serve-sim has no --version; `-l` (list streams) exits 0 when installed.
  const r = await which("serve-sim", ["-l"]);
  return {
    name: `serve-sim (pinned ${config.streaming.serveSim.version})`,
    ok: r.ok,
    detail: r.ok ? "installed" : "not installed — run `deckhand init`",
  };
}

async function checkGitHub(config: Config): Promise<Check> {
  // A fine-grained PAT (if present) is the active credential; the App is the alternative.
  try {
    const pat = readFileSync(githubPatPath(config), "utf8").trim();
    if (pat) return { name: "github credential", ok: true, detail: "fine-grained PAT" };
  } catch {
    // no PAT file; fall through to the App
  }

  const pemPath = githubPrivateKeyPath(config);
  if (!pemPath || !config.githubApp) {
    if (config.githubAmbient) {
      const gh = await ghCliToken();
      // A token exists; its scopes and host are not checked here, so say so rather
      // than implying every repo will resolve.
      if (gh) return { name: "github credential", ok: true, detail: "ambient gh CLI session (scopes not verified)" };
    }
    return {
      name: "github credential",
      ok: false,
      detail: config.githubAmbient
        ? "no PAT, no GitHub App, and no gh CLI session on this machine — run `gh auth login`, paste a PAT via the setup URL, or run `deckhand init` with a GitHub App"
        : "none configured — paste a PAT via the setup URL or run `deckhand init` with a GitHub App",
    };
  }
  let pem: string;
  try {
    pem = readFileSync(pemPath, "utf8");
  } catch {
    return { name: "github app", ok: false, detail: "private key not readable" };
  }
  try {
    const auth = new GitHubAppAuth({ appId: config.githubApp.appId, privateKey: createPrivateKey(pem) });
    const installs = await auth.listInstallations();
    return { name: "github app", ok: true, detail: `${installs.length} installation(s)` };
  } catch (e) {
    return { name: "github app", ok: false, detail: (e as Error).message.slice(0, 120) };
  }
}

/**
 * Web hosting readiness — only relevant if web apps are registered, so it's
 * skipped otherwise (a mobile-only install never sees it). A subdomain-hosted
 * framework (Nuxt/Next/static) with no `webHost` configured is a WARNING, not a
 * failure: the preview still works on loopback, it just isn't publicly shareable.
 */
function checkWebHost(config: Config, apps: App[]): Check {
  const webApps = apps.filter((a) => a.type === "web");
  if (webApps.length === 0) return { name: "web host", ok: true, skipped: true, detail: "no web apps" };
  const subdomain = webApps.filter((a) => a.path && webHostingMode(detectWebFrameworkFromDir(a.path)) === "subdomain");
  if (subdomain.length === 0) return { name: "web host", ok: true, detail: `${webApps.length} web app(s), all path-based (Vite) — no webHost needed` };
  if (config.webHost) return { name: "web host", ok: true, detail: `webHost ${config.webHost} → ${subdomain.length} subdomain-web app(s)` };
  return {
    name: "web host",
    ok: true,
    warn: true,
    detail: `${subdomain.length} web app(s) (Nuxt/Next/static) need subdomain hosting but no webHost is set — previews work on loopback only. Set webHost (+ a DNS route/ingress) to share them publicly.`,
  };
}

async function smokeTest(config: Config): Promise<Check> {
  const simctl = new Simctl();
  let udid: string | undefined;
  const backend = new ServeSimBackend({ portRange: config.streaming.serveSim.helperPortRange });
  try {
    const runtime = selectRuntime(await simctl.listRuntimes());
    const deviceType = selectDeviceType(await simctl.listDeviceTypes());
    udid = await simctl.create("deckhand-doctor", deviceType.identifier, runtime.identifier);
    await simctl.bootAndWait(udid);
    const stream = await backend.attach({ platform: "ios", udid });
    const framed = await stream.waitForFirstFrame();
    await stream.detach();
    return { name: "smoke: sim + serve-sim first frame", ok: framed, detail: framed ? "got a frame" : "no first frame" };
  } catch (e) {
    return { name: "smoke: sim + serve-sim first frame", ok: false, detail: (e as Error).message.slice(0, 160) };
  } finally {
    if (udid) {
      await simctl.shutdown(udid).catch(() => {});
      await simctl.delete(udid).catch(() => {});
    }
  }
}

export async function runDoctor(opts: { smoke?: boolean } = {}): Promise<{ checks: Check[]; ok: boolean }> {
  const checks: Check[] = [];

  // config
  let config: Config | null = null;
  let apps: App[] = [];
  try {
    config = loadConfig();
    apps = loadApps();
    loadTokens();
    checks.push({ name: "config files", ok: true, detail: `hostname ${config.hostname}` });
  } catch (e) {
    checks.push({ name: "config files", ok: false, detail: (e as Error).message });
  }

  checks.push(...(await checkToolchains()));

  if (config) {
    checks.push(await checkServeSim(config));
    checks.push(await checkGitHub(config));
    checks.push(checkWebHost(config, apps));
    if (opts.smoke) checks.push(await smokeTest(config));
  }

  // warn is advisory: it never makes doctor fail.
  return { checks, ok: checks.every((c) => c.ok || c.skipped || c.warn) };
}

export function formatChecks(checks: Check[]): string {
  return checks
    .map((c) => `${c.skipped ? "•" : c.warn ? "⚠" : c.ok ? "✓" : "✗"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`)
    .join("\n");
}
