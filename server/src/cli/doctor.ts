import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createPrivateKey } from "node:crypto";
import { join, dirname } from "node:path";
import { loadConfig, loadApps, loadTokens, githubPatPath, githubPrivateKeyPath, type App, type Config } from "../config.ts";
import { GitHubAppAuth } from "../github/appAuth.ts";
import { ghCliToken } from "../github/credentials.ts";
import { Simctl, selectRuntime, selectDeviceType } from "../devices/ios.ts";
import { ServeSimBackend, vendoredServeSimBin } from "../streaming/serveSim.ts";
import { AndroidAdbBackend } from "../streaming/androidAdb.ts";
import { AndroidManager, selectSystemImage, serialForPort } from "../devices/android.ts";
import { detectWebFrameworkFromDir, webHostingMode } from "../engine/detect.ts";

/** Helper ports for the Android smoke leg — outside the configured preview range, so a gate run cannot evict a live preview's helper. */
const ANDROID_SMOKE_PORTS: [number, number] = [3290, 3299];
/** Console port for the gate's emulator, clear of the 5554-5584 band a developer's own AVD lands in. */
const ANDROID_SMOKE_CONSOLE_PORT = 5680;

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
  /** The check that actually boots a device, tagged by platform. Its absence must fail the gate, not pass it. */
  smoke?: SmokePlatform;
}

/** Both must appear in a gate run. A device gate that covered one platform is half a gate. */
export const SMOKE_PLATFORMS = ["ios", "android"] as const;
export type SmokePlatform = (typeof SMOKE_PLATFORMS)[number];

/**
 * The `--device-only` exit code, as a pure decision so it can be tested without hardware.
 *
 * Two rules beyond "nothing gated is red", and both exist because they were missing:
 *
 *  1. A gate that produced no smoke check has not passed, it has not run. `runDoctor` pushes
 *     the smoke tests only inside `if (config)`, so a config-load failure left this with
 *     nothing but toolchain checks — which pass on any Mac with Xcode — and
 *     `npm run test:device` reported success having booted nothing.
 *  2. Every platform must be represented. The gate was iOS-only while `ci.yml` justified
 *     excluding it from CI *because* CI cannot do Android — the same "half the devices,
 *     reading as all of them" one layer down.
 */
export function deviceGateExit(checks: readonly Check[]): { code: 0 | 1; failed: Check[]; reason?: string } {
  const failed = checks.filter((c) => c.gate && !c.ok && !c.skipped && !c.warn);
  if (failed.length) return { code: 1, failed };
  const missing = SMOKE_PLATFORMS.filter((p) => !checks.some((c) => c.smoke === p));
  if (missing.length) {
    return {
      code: 1,
      failed,
      reason: `no device was booted for: ${missing.join(", ")} — the gate did not run for ${
        missing.length === SMOKE_PLATFORMS.length ? "any platform" : "every platform"
      }`,
    };
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
  // Android, which doctor was blind to entirely — half the product, and an install could
  // report itself healthy while no emulator could ever boot. A WARNING rather than a failure:
  // an iOS-only deckhand is a legitimate, working install, and failing it would train people
  // to ignore a red doctor. Not gated either: `test:device` has its own Android leg.
  for (const [name, cmd, args] of [
    ["adb", "adb", ["version"]],
    ["emulator", "emulator", ["-version"]],
  ] as const) {
    const r = await which(cmd, args);
    checks.push({
      name: `android: ${name}`,
      ok: r.ok,
      warn: !r.ok,
      detail: r.ok ? r.out.slice(0, 60) : "not found — iOS previews work, Android will not (brew install --cask android-commandlinetools)",
    });
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

/**
 * The three things a device must do before anything built on it can be called tested:
 * **boot**, **stream** a first frame, and answer a **describe** — the read half of the
 * control path, which is what the `describe`/`ui` tools and the viewer's input both ride on.
 *
 * One per platform, because the two share almost no code below the seam: iOS is a native
 * simulator behind serve-sim, Android is a CPU-bound QEMU emulator behind adb screencap and
 * an in-process helper. Every bug this gate was written after was on exactly one of them.
 *
 * NOT covered, deliberately and stated rather than implied: input INJECTION (a tap landing on
 * the device). That rides the WebSocket bridge, which needs a viewer on the other end, and a
 * check that pretended to cover it would be the same lie as a green gate that booted nothing.
 */
async function smokeIos(config: Config): Promise<Check[]> {
  const label = (cap: string) => `smoke ios: ${cap}`;
  const simctl = new Simctl();
  const backend = new ServeSimBackend({ portRange: config.streaming.serveSim.helperPortRange });
  let udid: string | undefined;
  const checks: Check[] = [];
  try {
    const runtime = selectRuntime(await simctl.listRuntimes());
    const deviceType = selectDeviceType(await simctl.listDeviceTypes());
    udid = await simctl.create("deckhand-doctor", deviceType.identifier, runtime.identifier);
    await simctl.bootAndWait(udid);
    checks.push({ name: label("boot"), ok: true, gate: true, smoke: "ios", detail: `${deviceType.name}, ${runtime.name}` });

    const stream = await backend.attach({ platform: "ios", udid });
    try {
      const framed = await stream.waitForFirstFrame();
      checks.push({ name: label("stream"), ok: framed, gate: true, detail: framed ? "first frame" : "no first frame" });
      // Only ask for the tree if a frame arrived: a describe against a helper that never
      // attached fails for the reason we already reported, and two red lines for one cause
      // is how a gate starts getting skimmed.
      if (framed) {
        const tree = await stream.describe();
        const ok = typeof tree === "string" && tree.length > 0;
        checks.push({ name: label("describe"), ok, gate: true, detail: ok ? `${tree.length} chars` : "empty tree" });
      }
    } finally {
      await stream.detach().catch(() => {});
    }
  } catch (e) {
    // Whatever stage threw, the capabilities after it did not run — and "did not run" must
    // read as failure here, not as absence. Name the missing ones explicitly.
    const done = new Set(checks.map((c) => c.name));
    for (const cap of ["boot", "stream", "describe"]) {
      if (!done.has(label(cap))) {
        checks.push({
          name: label(cap),
          ok: false,
          gate: true,
          ...(cap === "boot" ? { smoke: "ios" as const } : {}),
          detail: (e as Error).message.slice(0, 160),
        });
      }
    }
  } finally {
    if (udid) {
      await simctl.shutdown(udid).catch(() => {});
      await simctl.delete(udid).catch(() => {});
    }
  }
  return checks;
}

/**
 * The Android leg — the one that did not exist.
 *
 * `ci.yml` justifies keeping the device gate out of CI *because* GitHub runners cannot do
 * Android emulators, and the gate it points to instead was iOS-only: the same "half the
 * devices, reading as all of them" it warns about, one layer down. Both bugs that motivated
 * `androidAdbBackend.test.ts` were Android, and neither was reachable from here.
 *
 * A missing Android SDK fails this rather than skipping it. On a machine that serves Android
 * previews, "adb is not installed" is a real answer to "is streaming verified", and it is no.
 */
async function smokeAndroid(): Promise<Check[]> {
  const label = (cap: string) => `smoke android: ${cap}`;
  const android = new AndroidManager();
  const backend = new AndroidAdbBackend({ portRange: ANDROID_SMOKE_PORTS });
  const avd = "deckhand-doctor";
  let serial: string | undefined;
  const checks: Check[] = [];
  try {
    const image = selectSystemImage(await android.listSystemImages());
    // A previous gate run's emulator may still be exiting on this port. `adb wait-for-device`
    // would answer INSTANTLY against it and every check after would be aimed at a machine that
    // is shutting down — the same class as the console-port hijack in the engine, which is why
    // that one consults adb rather than trusting its own bookkeeping. Wait it out.
    const leftover = serialForPort(ANDROID_SMOKE_CONSOLE_PORT);
    if ((await android.attachedSerials()).includes(leftover)) {
      await android.shutdown(leftover).catch(() => {});
      for (let i = 0; i < 30 && (await android.attachedSerials()).includes(leftover); i++) {
        await new Promise((r) => setTimeout(r, 1000));
      }
      if ((await android.attachedSerials()).includes(leftover)) {
        throw new Error(`${leftover} is still attached — a previous gate run has not exited; \`adb -s ${leftover} emu kill\``);
      }
    }
    await android.createAvd(avd, image);
    // A console port well clear of the default 5554-5584 band, so the gate cannot collide
    // with — or be answered by — an emulator the developer started themselves.
    serial = await android.bootEmulator(avd, ANDROID_SMOKE_CONSOLE_PORT);
    checks.push({ name: label("boot"), ok: true, gate: true, smoke: "android", detail: `${avd} (API ${image.api}) → ${serial}` });

    const stream = await backend.attach({ platform: "android", udid: serial, serial });
    try {
      const framed = await stream.waitForFirstFrame();
      checks.push({ name: label("stream"), ok: framed, gate: true, detail: framed ? "first frame" : "no first frame" });
      if (framed) {
        // 90s, not the tool's default: this is the hardest case the method ever sees — an
        // emulator that finished booting seconds ago, whose launcher is still animating, so
        // `uiautomator dump` refuses with "could not get idle state" and each refusal costs
        // ~7s to find out. Measured: 15s allowed two attempts and the gate failed on one run
        // and passed on the next. A gate that is red half the time teaches people to re-run
        // it, which is worse than not having it.
        const tree = await android.describe(serial, 90_000);
        const ok = typeof tree === "string" && tree.length > 0;
        checks.push({ name: label("describe"), ok, gate: true, detail: ok ? `${tree.length} chars` : "empty tree" });
      }
    } finally {
      await stream.detach().catch(() => {});
    }
  } catch (e) {
    const done = new Set(checks.map((c) => c.name));
    for (const cap of ["boot", "stream", "describe"]) {
      if (!done.has(label(cap))) {
        checks.push({
          name: label(cap),
          ok: false,
          gate: true,
          ...(cap === "boot" ? { smoke: "android" as const } : {}),
          detail: (e as Error).message.slice(0, 160),
        });
      }
    }
  } finally {
    if (serial) await android.shutdown(serial).catch(() => {});
    await android.deleteAvd(avd).catch(() => {});
    await backend.reapOrphans().catch(() => {});
  }
  return checks;
}

export async function runDoctor(opts: { smoke?: boolean } = {}): Promise<{ checks: Check[]; ok: boolean }> {
  const checks: Check[] = [];

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
    if (opts.smoke) {
      // Sequential, not parallel: both legs create and boot a device, and an emulator booting
      // beside a simulator on the same machine is exactly the CPU contention that made the
      // Android stream look broken in the first place. The gate is allowed to be slow.
      checks.push(...(await smokeIos(config)));
      checks.push(...(await smokeAndroid()));
    }
  }

  // warn is advisory: it never makes doctor fail.
  return { checks, ok: checks.every((c) => c.ok || c.skipped || c.warn) };
}

export function formatChecks(checks: Check[]): string {
  return checks
    .map((c) => `${c.skipped ? "•" : c.warn ? "⚠" : c.ok ? "✓" : "✗"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`)
    .join("\n");
}
