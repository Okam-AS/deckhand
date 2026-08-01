import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createPrivateKey } from "node:crypto";
import { join, dirname } from "node:path";
import { loadConfig, loadApps, loadTokens, githubPatPath, githubPrivateKeyPath, type App, type Config } from "../config.ts";
import { GitHubAppAuth } from "../github/appAuth.ts";
import { Simctl, selectRuntime, selectDeviceType } from "../devices/ios.ts";
import { ServeSimBackend, vendoredServeSimBin } from "../streaming/serveSim.ts";
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
  /**
   * Part of the `--device-only` regression gate (`npm run test:device`): this check can be
   * broken by a code change, as opposed to by a missing install. Set here rather than matched
   * on the name — `serve-sim (vendored, 1.2.3)` builds its own label at runtime, so a
   * name-prefix filter is coupled to a display string nobody thinks of as an interface.
   */
  gate?: true;
  /** The check that actually boots a device. Its absence must fail the gate, not pass it. */
  smoke?: true;
}

/**
 * The `--device-only` exit code, as a pure decision so it can be tested without a simulator.
 *
 * Two rules, and the second is the one that was missing: a gate that produced no smoke check
 * has not passed, it has not run. `runDoctor` pushes the smoke test only inside `if (config)`,
 * so a config-load failure left this with nothing but toolchain checks — which pass on any Mac
 * with Xcode — and `npm run test:device` reported success having booted nothing.
 */
export function deviceGateExit(checks: readonly Check[]): { code: 0 | 1; failed: Check[]; reason?: string } {
  const failed = checks.filter((c) => c.gate && !c.ok && !c.skipped && !c.warn);
  if (failed.length) return { code: 1, failed };
  if (!checks.some((c) => c.smoke)) {
    return { code: 1, failed, reason: "no smoke check was produced (config load failed?) — the gate did not run" };
  }
  return { code: 0, failed };
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
    checks.push({ name, ok: r.ok, gate: true, detail: r.ok ? r.out : "not found" });
  }
  return checks;
}

function checkServeSim(): Check {
  // Deckhand runs its OWN vendored serve-sim, patched to strip the host
  // shell-exec routes (see server.ts). Check THAT copy — a serve-sim on PATH is
  // irrelevant, and would be unpatched. Verify it exists and that the patch is
  // actually applied (patch-package can silently no-op after a version bump).
  // Read the version from the vendored package itself, not config — config's
  // serveSim.version is display-only and drifts from the real pin on a bump.
  let name = "serve-sim (vendored)";
  try {
    const bin = vendoredServeSimBin();
    if (!existsSync(bin)) return { name, ok: false, gate: true, detail: "not installed — run `npm install`" };
    // Best-effort version for the label; a truncated package.json must not mask
    // the real state of the bundle (which we check next), so don't let it throw.
    const pkgRoot = dirname(dirname(bin)); // .../dist/serve-sim.js → .../dist → pkg root
    let version = "unknown version";
    try {
      version = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")).version ?? version;
    } catch {
      /* keep the fallback label */
    }
    name = `serve-sim (vendored, ${version})`;
    const patched = readFileSync(bin, "utf8").includes("deckhand:exec disabled");
    return patched
      ? { name, ok: true, gate: true, detail: "installed, exec routes stripped" }
      : { name, ok: false, gate: true, detail: "UNPATCHED (exec route present) — run `npx patch-package`" };
  } catch {
    return { name, ok: false, gate: true, detail: "not resolvable — run `npm install`" };
  }
}

/**
 * The LaunchAgents that keep deckhand + the tunnel alive across crash/sleep/
 * reboot. Advisory (⚠, never fails doctor): a dev machine may run them by hand.
 * But it TELLS a setup agent the step exists — ops/install-services.sh — which
 * nothing runs automatically (auto-loading agents on npm install would restart
 * the server mid-work).
 */
async function checkServices(): Promise<Check> {
  const name = "auto-restart services (launchd)";
  const loaded = await Promise.all(
    ["no.deckhand.server", "no.deckhand.tunnel"].map(async (label) => (await which("launchctl", ["list", label])).ok),
  );
  const [server, tunnel] = loaded;
  if (server && tunnel) return { name, ok: true, detail: "server + tunnel agents loaded" };
  const missing = [!server && "server", !tunnel && "tunnel"].filter(Boolean).join(" + ");
  return { name, ok: false, warn: true, detail: `${missing} not loaded — run \`./ops/install-services.sh\` so it survives sleep/reboot` };
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
    return { name: "github credential", ok: false, detail: "none configured — paste a PAT via the setup URL or run `deckhand init` with a GitHub App" };
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
    return {
      name: "smoke: sim + serve-sim first frame",
      ok: framed,
      gate: true,
      smoke: true,
      detail: framed ? "got a frame" : "no first frame",
    };
  } catch (e) {
    return {
      name: "smoke: sim + serve-sim first frame",
      ok: false,
      gate: true,
      smoke: true,
      detail: (e as Error).message.slice(0, 160),
    };
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
    checks.push(checkServeSim());
    checks.push(await checkServices());
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
