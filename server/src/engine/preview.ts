import { randomBytes, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { publicBaseUrl, type App, type AppType, type Config } from "../config.ts";
import type { AuditLog } from "../audit.ts";
import {
  StateStore,
  type PersistedDevice,
  type PersistedPreview,
  type PinRecord,
  type Platform,
  type PreviewPhase,
  type PreviewSource,
} from "../state.ts";
import { hashPassword, verifyPassword } from "../share/shares.ts";
import { WorktreeManager, worktreeKey, type RefSpec, refDescription } from "./worktree.ts";
import { pruneDerivedData } from "./derivedData.ts";
import { Simctl, selectRuntime, selectDeviceType, deviceLabel, type SimDevice } from "../devices/ios.ts";
import { AndroidManager, selectSystemImage, portForSerial, serialForPort } from "../devices/android.ts";
import { resolveAndroidEnv } from "../devices/toolEnv.ts";
import { Reaper, POOL_SIM_PREFIX, POOL_AVD_PREFIX } from "./reaper.ts";
import { MetroManager } from "./metro.ts";
import { buildPlan, usesMetroDeepLink, nativescriptDevRun, webDevRun, webRootDevRun, GENERAL_IDLE_MS, METRO_PORT } from "./recipes.ts";
import { runStep as defaultRunStep, type RunResult } from "./procs.ts";
import type { CommandStep } from "./recipes.ts";
import {
  detectBundleIdFromDir,
  detectFromRepo,
  detectWebFrameworkFromDir,
  webHostingMode,
  expoSlug,
  expoDevClientUrl,
  type WebFramework,
} from "./detect.ts";
import { loadSecretsEnv } from "../secrets.ts";
import { readMigrationLedger } from "./migrationLedger.ts";
import { DevProcessManager } from "./devProcess.ts";
import type { AttachedStream, StreamingBackend } from "../streaming/backend.ts";
import { SimDeckControl, type SimDeckTarget, type DescribeOptions, type UiAction } from "../testing/control.ts";

// ---------------------------------------------------------------------------
// Preview engine: the orchestrator. Holds live previews in memory, persists to
// state.json on every transition, and runs the per-device pipeline (boot/prep
// overlap → build → install-verify → launch → attach stream → first-frame
// gate). Sources: a git ref in a disposable worktree, or a LOCAL dir (the
// developer's own working copy) built in place — never wiped, never removed.
// start_preview is idempotent per (app, source, ref) and share ids are stable
// per app, so the daily loop keeps one URL alive across restarts.
// ---------------------------------------------------------------------------

const LOG_CAP = 500;
// "stream" is the diagnostic trace for the path between the browser and the
// device: helper attach, first-frame probes, every proxied request and its
// upstream result, WebSocket upgrades, and what the viewer's player reports back.
// A device can be `ready` (deckhand saw a frame) while the viewer still says
// "Connecting…", and without this source there was no way to tell the two apart.
export type LogSource = "build" | "metro" | "app" | "stream";

/** How long the first livesync build may take before we give up on install. */
const DEV_INSTALL_TIMEOUT_MS = GENERAL_IDLE_MS;

/** How long to wait for a web dev server to start answering before failing.
 *  Generous: a cold Nuxt/webpack build can take a couple of minutes. */
const WEB_READY_TIMEOUT_MS = 180_000;
/** Loopback port range for web dev servers (Vite defaults to 5173). */
const WEB_PORT_RANGE: [number, number] = [5170, 5199];

/** Android's package grammar — dot-separated segments, each starting with a letter. */
const ANDROID_PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
/** Apple's bundle-id grammar — same shape, hyphens additionally allowed. Underscores
 *  are legal too: NativeScript/Expo apps carry ids like `org.acme.my_app`, and the one
 *  `id:` in nativescript.config.ts is used for BOTH platforms — rejecting `_` here
 *  failed only the iOS half of such an app while Android booted fine. Each segment
 *  must START alphanumeric: a leading `-` would reach `simctl install/launch` as a
 *  positional argument the CLI parses as an option flag. */
const IOS_BUNDLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9][A-Za-z0-9_-]*)+$/;

/** Verbs a build tool uses for the work it is doing right now. */
const BUILD_VERBS =
  /^(compiling|packaging|linking|signing|executing|copying|installing|downloading|generating|bundling|building|analyzing|preparing|processing|fetching|resolving|planning|running|creating|writing|checking)\b/i;

/**
 * A short "what is it doing right now" label from a build log line, or null for
 * a line that isn't progress. Feeds the viewer's build overlay: a spinner with
 * a frozen caption is indistinguishable from a hang, and the whole log is far
 * too wide for a phone-sized frame.
 *
 * Xcode/Expo lines look like `› Compiling react-native-svg Pods/RNSVG » RNSVGUse.mm`.
 * Keep the verb and the PACKAGE, not the file after `»`: a per-file caption
 * flickers many times a second and produces unbreakable 45-character tokens that
 * overflow a phone-sized frame, while the package name changes at a readable
 * pace and still proves the build is moving.
 */
const DETAIL_MAX = 40;

/**
 * Lift the actionable cause of a failed build out of the log we already captured.
 *
 * `build step "build" failed` is a dead end: the agent has to go read 500 lines of Gradle or
 * Xcode chatter to learn anything, and the viewer shows the user one line they cannot act on.
 * The cause is always in the tail, in a shape each toolchain repeats — so name it.
 *
 * Gradle prints `* What went wrong:` followed by the task and, when it has one, `Caused by:`.
 * Xcode/clang mark real failures with `error:`. Anything else falls back to the last non-noise
 * lines, which beats saying nothing.
 */
export function buildFailureCause(lines: readonly string[], max = 400): string | null {
  const strip = (l: string): string => l.replace(/\x1b\[[0-9;]*m/g, "").replace(/^\[[a-z-]+\]\s?/, "").trimEnd();
  const tail = lines.slice(-300).map(strip);

  const gradleAt = tail.findLastIndex((l) => l.startsWith("* What went wrong:"));
  if (gradleAt >= 0) {
    const stop = tail.findIndex((l, i) => i > gradleAt && l.startsWith("* Try:"));
    const block = tail.slice(gradleAt + 1, stop > 0 ? stop : gradleAt + 6).filter((l) => l.trim());
    const caused = tail.filter((l) => l.trim().startsWith("Caused by:")).slice(-2);
    const out = [...block, ...caused].join(" ").replace(/\s+/g, " ").trim();
    if (out) return clip(out, max);
  }

  const errors = tail.filter((l) => /(^|\s)error:/i.test(l) || /^FAILURE:|^fatal error:/i.test(l)).slice(-3);
  if (errors.length) return clip(errors.join(" ").replace(/\s+/g, " ").trim(), max);

  const last = tail.filter((l) => l.trim()).slice(-3).join(" ").replace(/\s+/g, " ").trim();
  return last ? clip(last, max) : null;
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export function buildStepDetail(line: string): string | null {
  const clean = line
    .replace(/\x1b\[[0-9;]*m/g, "") // ANSI colour
    .replace(/^[\s›>❯•*-]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean || !BUILD_VERBS.test(clean)) return null;
  // `<Verb> <package> Pods/<target> » <artifact>` → "<Verb> <package>".
  const scoped = /^(\S+) (\S+) \S+ » /.exec(clean);
  const text = scoped ? `${scoped[1]} ${scoped[2]}` : clean.split(" » ")[0]!.trim();
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX - 1)}…` : text;
}

interface LiveDevice {
  record: PersistedDevice;
  logs: Record<LogSource, string[]>;
  abort: AbortController;
  /** Pool slot held by this device (see leaseName) — released, not deleted, on teardown. */
  poolName?: string;
  /**
   * The simulator/AVD name deckhand asked for, pooled or not. Recorded before
   * the create that may not return, so the reaper can spare a device that
   * exists on the machine but has no handle in our records yet.
   */
  deviceName?: string;
  /** Emulator console port, reserved before the boot that may never return one. */
  androidPort?: number;
}

interface LivePreview {
  record: PersistedPreview;
  app: App;
  spec?: RefSpec; // git source only; kept for restart_preview re-fetches
  devices: LiveDevice[];
  prep?: Promise<string>; // memoized source dir (shared across devices)
  sourceDir?: string;
  attached: Map<string, AttachedStream>;
  /** Ephemeral: the agent's current end-to-end test run, surfaced to the viewer. */
  testRun?: TestRun;
  /** Set once the agent has been reminded to open a test run; cleared when it opens one. */
  testRunNudged?: boolean;
  /** Ephemeral: pairing + parity checklist for a compare session, surfaced to the viewer. */
  compare?: CompareSession;
  /** Epoch ms of the last viewer/agent touch — the idle sweep's clock. */
  lastActivityAt: number;
  /**
   * Epoch ms of the last sign of forward motion — the stuck sweep's clock.
   * Deliberately NOT `record.updatedAt`: that only moves on phase transitions,
   * and the phases are coarse. A cold CocoaPods or Gradle build sits in
   * "building" for well over an hour while streaming healthy output, and used
   * to be torn down mid-build, worktree and all. Build output counts as
   * progress; it just doesn't get persisted on every line.
   */
  lastProgressAt: number;
}

// An agent-driven test run: the brain (the coding agent) reports what it's
// testing; deckhand records it and the viewer renders a calm spinner + step
// popover. Ephemeral (in-memory) — a run is a transient activity, not state.
export type TestStepStatus = "pending" | "running" | "passed" | "failed";
export type TestRunStatus = "running" | "passed" | "failed";
export interface TestStep {
  n: number;
  label: string;
  status: TestStepStatus;
  detail?: string;
}
export interface TestRun {
  id: string;
  title: string;
  status: TestRunStatus;
  steps: TestStep[];
  summary?: string;
  startedAt: string;
  finishedAt?: string;
}

// A compare session: the working preview paired against a reference preview
// (another app, the same app at another ref, a worktree, or an arbitrary repo),
// with an agent-declared per-item verdict checklist. Local + ephemeral (in-memory,
// per session) — Deckhand owns only the visual verdict; the plan lives in the
// team's tracker (e.g. Linear). `adjusted` = deliberately different-and-fine, so
// an intentional redesign isn't flagged as a `regression`.
export type CompareVerdict = "pending" | "doing" | "done" | "adjusted" | "regression";
export interface CompareItem {
  name: string;
  verdict: CompareVerdict;
  note?: string;
}
export interface CompareReference {
  shareId: string;
  repo: string;
  ref: string;
  /** Engine-internal: the booted reference preview, torn down with the working one. */
  previewId?: string;
}
export interface CompareSession {
  /**
   * The panes shown alongside the working one, in display order. A list rather
   * than a single reference because the page is a set of panes, not a pair:
   * old app + `main` + this branch is three sources, and every layer below
   * (shareState, unlock minting, teardown refcount) fans out over the same list.
   */
  references: CompareReference[];
  items: CompareItem[];
}
export interface CompareCounts {
  pending: number;
  doing: number;
  done: number;
  adjusted: number;
  regression: number;
}

export interface DeviceRequest {
  platform: Platform;
  runtime?: string;
  model?: string;
}

export interface StartPreviewRequest {
  app: App;
  source: PreviewSource;
  /** Required for git-source previews; unused for local. */
  spec?: RefSpec;
  devices: DeviceRequest[];
  access: "public" | "password";
  /** Mark this as a public compare/migration reference pane (see PersistedPreview.reference). */
  reference?: boolean;
}

export interface StartPreviewResult {
  previewId: string;
  shareId: string;
  url: string;
  source: PreviewSource;
  /** True when an equivalent preview was already live and was returned as-is. */
  alreadyRunning: boolean;
  devices: { deviceId: string; label: string; phase: string }[];
}

export interface PreviewStatus {
  previewId: string;
  phase: PreviewPhase;
  ready: boolean;
  url: string | null;
  source: PreviewSource;
  devices: {
    deviceId: string;
    label: string;
    phase: string;
    detail?: string;
    error?: string;
    logTail?: string;
  }[];
}

export interface PreviewEngineDeps {
  config: Config;
  worktrees: WorktreeManager;
  simctl: Simctl;
  android?: AndroidManager;
  streaming: StreamingBackend;
  metro: MetroManager;
  store: StateStore;
  audit: AuditLog;
  devProcs?: DevProcessManager;
  /** Orphan sweeper (see reapOrphans). Constructed from simctl/android when absent. */
  reaper?: Reaper;
  /** Agent-driven testing backend (describe/ui). Lazily constructed from config if absent. */
  simdeck?: SimDeckControl;
  runStep?: (step: CommandStep, opts?: { onLog?: (l: string, s: "stdout" | "stderr") => void; signal?: AbortSignal }) => Promise<RunResult>;
  secretsEnv?: (appId: string) => Record<string, string>;
  now?: () => number;
  genPreviewId?: () => string;
  genShareId?: () => string;
}

export class PreviewError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "PreviewError";
  }
}

/**
 * Strip host-identifying material out of a failure reason before it crosses
 * into `shareState`.
 *
 * The reason is shown to whoever holds the share link — including a PUBLIC
 * share — while the unredacted text stays on `dev.record.error` for MCP and the
 * audit log. Left alone it hands out things the share holder has no business
 * with: `fatal: repository 'https://github.com/acme/secret-design-system.git/'
 * not found` names a private repo, and any `/Users/<user>/.deckhand/worktrees/…`
 * names the operator's account and disk layout. Keep the sentence — "submodule
 * checkout failed", "xcodebuild exited 65" is the part that helps — and drop
 * the identifiers.
 */
export function redactForShare(text: string): string {
  return (
    // Bounded before the regexes run: the host pattern backtracks quadratically
    // on a single very long dotted token, and this is called on the event loop
    // from `failDevice`, which every live stream shares. The caller truncates to
    // 160 anyway, so nothing readable is lost.
    text
      .slice(0, 400)
      // scheme://host/path
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, "<url>")
      // scp-form git remote, git@github.com:acme/repo.git. The `user@` is what
      // distinguishes it from `App.swift:12:3`, which MUST survive — a
      // compiler error's file and line is the actionable half of the sentence.
      .replace(/\b[\w.-]+@[\w.-]+\.[a-z]{2,}:[^\s'"]+/gi, "<url>")
      // scheme-less host/path, as in "submodule checkout failed for
      // github.com/acme/private-thing". The TLD list is deliberate rather than
      // `[a-z]{2,}`: that also swallows Android component names
      // (`com.acme.app/.MainActivity`), which are ours to show.
      // (`internal`/`local`/`lan`/`corp` are in the list because a self-hosted
      // GitLab is exactly where the private repo names are.)
      .replace(
        /\b[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|io|dev|co|no|se|dk|uk|de|fr|nl|ch|ai|sh|gg|me|xyz|internal|local|lan|corp)\/[^\s'"]*/gi,
        "<url>",
      )
      // A bare hostname, no path — the other half of "Failed to connect to
      // gitlab.acme.internal port 443" and "Could not resolve hostname
      // git.acme.internal", and of `mac-mini-dana.local`, which names the
      // operator as squarely as a home directory does.
      .replace(
        /\b[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|io|dev|co|no|se|dk|uk|de|fr|nl|ch|ai|sh|gg|me|xyz|internal|local|lan|corp)\b/gi,
        "<host>",
      )
      // HOME directories only — anywhere in the line, not just after a space or
      // a quote ("framework not found at [/Users/dana/…]", "error,/Users/dana/…"
      // leak the account just as well). Deliberately NOT every absolute path:
      // `/bin/sh: gradle: not found` and `Can't resolve '../../packages/x/src'`
      // say where the build broke and name nobody.
      .replace(/(^|[^\w])(?:~|\/(?:Users|home)\/[^\s'"/]+)(\/[^\s'"]*)?/g, (_m, lead: string, rest?: string) =>
        // The rest of the path is kept: it is deckhand's own worktree layout and
        // the previewed app's name, which the share holder is already looking at.
        `${lead}…${rest ?? ""}`,
      )
  );
}

/** One dev process per app+platform. */
function devKey(appId: string, platform: Platform): string {
  return `${appId}:${platform}`;
}

/**
 * The app env plus the resolved Android toolchain. Gradle locates the SDK from
 * ANDROID_HOME/ANDROID_SDK_ROOT (or a local.properties deckhand refuses to write
 * into a borrowed checkout) — having platform-tools on PATH is not enough, and a
 * LaunchAgent starts with neither. The app's own env still wins on conflict.
 */
export function androidBuildEnv(appEnv: Record<string, string>): Record<string, string> {
  const a = resolveAndroidEnv();
  return {
    ANDROID_HOME: a.ANDROID_HOME,
    ANDROID_SDK_ROOT: a.ANDROID_HOME,
    ...(a.JAVA_HOME ? { JAVA_HOME: a.JAVA_HOME } : {}),
    PATH: a.PATH,
    ...appEnv,
  };
}

export class PreviewEngine {
  private readonly previews = new Map<string, LivePreview>();
  private readonly d: Required<
    Pick<PreviewEngineDeps, "config" | "worktrees" | "simctl" | "streaming" | "metro" | "store" | "audit">
  > &
    PreviewEngineDeps;
  /** Emulator console ports currently in use (deterministic serials). */
  private readonly androidPorts = new Set<number>();
  /** Web dev-server loopback ports currently in use. */
  private readonly webPorts = new Set<number>();
  /** appId → stable shareId, persisted so a bookmarked viewer URL never rots. */
  private readonly stableShareIds: Record<string, string>;
  /** appId → share PIN (scrypt), persisted so a bookmarked protected URL stays protected. */
  private readonly pins: Record<string, PinRecord>;
  /** Idle-sweep timer (see startJanitor). */
  private janitor?: ReturnType<typeof setInterval>;
  /** Pool names currently held by a live preview (never two previews on one device). */
  private readonly leased = new Set<string>();
  /** poolName → the appId that last ran there, so a reused device is only wiped when it changes hands. */
  private readonly poolTenants = new Map<string, string>();
  /** Devices whose teardown is still in flight (they hold real resources until it finishes). */
  private tearingDown = 0;

  constructor(deps: PreviewEngineDeps) {
    this.d = {
      ...deps,
      runStep: deps.runStep ?? defaultRunStep,
      secretsEnv: deps.secretsEnv ?? loadSecretsEnv,
      now: deps.now ?? (() => Date.now()),
      genPreviewId: deps.genPreviewId ?? (() => randomBytes(8).toString("hex")),
      genShareId: deps.genShareId ?? (() => randomBytes(18).toString("base64url")),
    };
    const loaded = this.d.store.load();
    this.stableShareIds = loaded.shareIds;
    this.pins = loaded.pins;
  }

  private android(): AndroidManager {
    if (!this.d.android) this.d.android = new AndroidManager();
    return this.d.android;
  }

  private devProcs(): DevProcessManager {
    if (!this.d.devProcs) this.d.devProcs = new DevProcessManager();
    return this.d.devProcs;
  }

  /**
   * Claim a free emulator console port.
   *
   * The in-process set is not enough on its own: it knows only about emulators
   * THIS process started, and the reaper deliberately never touches a device the
   * developer created (PLAN §12 "Devices the developer created themselves are
   * never touched"). Allocating over an existing `emulator-<port>` was silently
   * catastrophic rather than merely wrong — the freshly launched emulator fails
   * to bind and exits, but `adb -s emulator-<port> wait-for-device` resolves
   * INSTANTLY against the stranger's device and `sys.boot_completed` is already
   * 1, so the boot looks successful. Everything after that is aimed at the wrong
   * machine: `installApk -r -g`, `forceStop`, `adb reverse` over its Metro port,
   * screenrecord published on a share link, and finally `adb emu kill` on
   * teardown. The developer's own emulator gets hijacked and then destroyed,
   * with no error anywhere.
   *
   * It also closes the in-process race: `shutdown` gives up waiting after 20s
   * without failing, while teardown returns the port to the pool unconditionally,
   * so a QEMU still exiting under load could hand its live port to the next boot.
   */
  private async allocAndroidPort(): Promise<number> {
    // A listing failure must not silently reopen the hazard, so treat "adb did
    // not answer" as "every port might be taken" only for ports we don't own —
    // an empty list is indistinguishable from a broken adb, and guessing wrong
    // in the permissive direction is what this exists to prevent.
    const attached = await this.android().attachedSerials().catch(() => null);
    if (attached === null) throw new PreviewError("could not list attached Android devices", "check that `adb devices` works, then retry");
    const taken = new Set(attached);
    for (let p = 5554; p <= 5680; p += 2) {
      if (this.androidPorts.has(p)) continue;
      if (taken.has(`emulator-${p}`)) continue;
      this.androidPorts.add(p);
      return p;
    }
    throw new PreviewError("no free Android emulator console port");
  }

  private allocWebPort(): number {
    for (let p = WEB_PORT_RANGE[0]; p <= WEB_PORT_RANGE[1]; p++) {
      if (!this.webPorts.has(p)) {
        this.webPorts.add(p);
        return p;
      }
    }
    throw new PreviewError("no free web dev-server port", "stop an existing web preview to free a port");
  }

  /** The share base path a web preview's dev server serves under (no trailing slash). */
  private webBase(shareId: string): string {
    return `/s/${shareId}/web`;
  }

  private iso(): string {
    return new Date(this.d.now!()).toISOString();
  }

  private viewerUrl(shareId: string): string {
    return `${publicBaseUrl(this.d.config)}/s/${shareId}`;
  }

  /** Subdomain-hosted web (Nuxt/Next/static): served at the root of a per-share subdomain. */
  private isSubdomainWeb(p: LivePreview): boolean {
    return p.record.webFramework != null && webHostingMode(p.record.webFramework as WebFramework) === "subdomain";
  }

  /**
   * A stable, DNS-legal host label for a subdomain-web preview, derived from the
   * (already stable-per-app) shareId — so the subdomain URL is bookmarkable and
   * needs no extra persistence. Lowercase hex, no underscores.
   */
  private hostIdForShare(shareId: string): string {
    return createHash("sha256").update(shareId).digest("hex").slice(0, 24);
  }

  /** The public URL for a preview: the configured web host for subdomain-web, else the viewer path. */
  private previewUrl(p: LivePreview): string {
    if (!this.isSubdomainWeb(p)) return this.viewerUrl(p.record.shareId);
    const wh = this.d.config.webHost;
    // Configured host (public); otherwise a loopback <hostId>.localhost form for local testing.
    return wh ? `https://${wh}/` : `http://${this.hostIdForShare(p.record.shareId)}.localhost:${this.d.config.port}/`;
  }

  /** Look up a live preview by its shareId (used by the share proxy). */
  findByShareId(
    shareId: string,
  ): { previewId: string; devices: { deviceId: string; platform: Platform; stream?: AttachedStream }[] } | null {
    for (const p of this.previews.values()) {
      if (p.record.shareId === shareId) {
        this.markActive(p); // a proxied request/stream attach means someone is watching
        return {
          previewId: p.record.previewId,
          devices: p.devices.map((dv) => ({
            deviceId: dv.record.deviceId,
            platform: dv.record.platform,
            stream: p.attached.get(dv.record.deviceId),
          })),
        };
      }
    }
    return null;
  }

  /**
   * Resolve a request's Host header to a live subdomain-web preview's dev-server
   * origin (used by the host proxy). Matches the configured `webHost` (public,
   * serves the single active subdomain-web preview) or a `<hostId>.<...>` label
   * (loopback/testing, matched to the preview whose shareId derives it). Returns
   * the origin once ready, `ready:false` while starting, or null if no match.
   */
  resolveWebHost(hostHeader: string | undefined): { origin: string | null; ready: boolean; shareId: string } | null {
    if (!hostHeader) return null;
    const host = hostHeader.split(":")[0]!.toLowerCase(); // strip any port
    const webHost = this.d.config.webHost?.toLowerCase();
    if (webHost && host === webHost) return this.activeSubdomainWeb();
    const dot = host.indexOf(".");
    const label = dot > 0 ? host.slice(0, dot) : null;
    if (!label) return null;
    for (const p of this.previews.values()) {
      if (this.isSubdomainWeb(p) && this.hostIdForShare(p.record.shareId) === label) return this.webOriginOf(p);
    }
    return null;
  }

  /** The single active (newest, non-terminal) subdomain-web preview — webHost serves one at a time. */
  private activeSubdomainWeb(): { origin: string | null; ready: boolean; shareId: string } | null {
    let best: LivePreview | null = null;
    for (const p of this.previews.values()) {
      const ph = p.record.phase;
      if (!this.isSubdomainWeb(p) || ph === "stopped" || ph === "failed" || ph === "stopping") continue;
      if (!best || p.record.createdAt > best.record.createdAt) best = p;
    }
    return best ? this.webOriginOf(best) : null;
  }

  private webOriginOf(p: LivePreview): { origin: string | null; ready: boolean; shareId: string } {
    // Subdomain-hosted web is browsed at its own host, with no /s/<id> viewer
    // polling behind it — this resolver is the only signal that anyone is using
    // it, so it must reset the idle clock or the sweep would stop a preview
    // someone is actively looking at.
    this.markActive(p);
    const dev = p.devices[0];
    const stream = dev ? p.attached.get(dev.record.deviceId) : undefined;
    return {
      origin: stream ? stream.origin : null,
      ready: Boolean(stream) && p.record.phase === "ready",
      shareId: p.record.shareId,
    };
  }

  /** Sanitized public state for the viewer (no udids, no logs). */
  shareState(shareId: string): {
    ready: boolean;
    ref: string;
    repo: string;
    source: PreviewSource;
    /** Local previews can be rebuilt from the viewer's refresh button. */
    canRestart: boolean;
    devices: { deviceId: string; platform: Platform; label: string; phase: string; detail?: string; step?: string }[];
    /** The agent's live test run (calm spinner + step popover in the viewer), if any. */
    testRun?: {
      status: TestRunStatus;
      title: string;
      steps: { n: number; label: string; status: TestStepStatus; detail?: string }[];
      summary?: string;
    };
    /**
     * Every pane on this page, in display order — always at least one (this
     * share's own). Extra panes come from a live compare session or a live
     * `migratesFrom` source.
     *
     * Order is old-to-new: reference panes first, this share's own LAST, so a
     * migration reads left-to-right as before → after. Each pane streams from
     * its OWN shareId (see `pairedShareIds`, which is what makes one PIN reach
     * all of them) — the page is a set of panes, not a preview with an
     * attachment bolted on.
     */
    panes: {
      shareId: string;
      repo: string;
      ref: string;
      /** True for this page's own share — the one `devices`/`canRestart` describe. */
      self?: true;
      devices: { deviceId: string; platform: Platform; label: string; phase: string; detail?: string; step?: string }[];
    }[];
    /** Migration target only: the agent-maintained parity ledger, if the file exists. */
    ledger?: { screens: { name: string; status: string; note?: string }[] };
  } | null {
    const sanitizeDevices = (pv: LivePreview) =>
      pv.devices.map((d) => ({
        deviceId: d.record.deviceId,
        platform: d.record.platform,
        label: d.record.label,
        phase: d.record.phase,
        detail: d.record.detail,
        // Same treatment as `detail`: `step` is a raw build-tool line
        // ("Copying /Users/<user>/.deckhand/worktrees/…", "Downloading
        // https://github.com/acme/private-thing"), and this function is what
        // stands between it and a public share holder.
        step: d.record.step ? redactForShare(d.record.step) : d.record.step,
      }));
    for (const p of this.previews.values()) {
      if (p.record.shareId === shareId) {
        // The viewer polls this — it is the idle clock's heartbeat. It has to beat
        // for EVERY pane the page will render, not just this share's own preview:
        // the extra panes have no viewer polling them directly, so with a single
        // markActive they aged out on their own idle timer and were torn down
        // underneath a page someone was actively watching. Marked before the
        // panes are built so a pane that is about to be advertised cannot be
        // reaped in the same tick.
        this.markActive(p);
        for (const r of p.compare?.references ?? []) {
          const live = this.liveByShareId(r.shareId);
          if (live) this.markActive(live);
        }
        if (p.app.migratesFrom) {
          const src = this.livePreviewForApp(p.app.migratesFrom);
          if (src) this.markActive(src);
        }
        // Pair the working preview with its reference and surface the checklist.
        // A live compare session (explicit reference + in-memory items) wins; else
        // fall back to the legacy migration path (migratesFrom + repo-file ledger).
        // Both are gated so an ordinary preview does zero extra work.
        type Pane = NonNullable<ReturnType<PreviewEngine["shareState"]>>["panes"][number];
        // Reference panes first, this share's own appended last (below), so the
        // page reads before → after.
        const refPanes: Pane[] = [];
        let ledger;
        if (p.compare) {
          for (const r of p.compare.references) {
            // Only LIVE panes are advertised — the viewer never mounts a dead
            // one, and pairedShareIds won't mint a cookie for it either.
            const live = this.liveByShareId(r.shareId);
            if (!live) continue;
            refPanes.push({
              shareId: r.shareId,
              repo: r.repo,
              ref: r.ref,
              devices: sanitizeDevices(live),
            });
          }
          if (p.compare.items.length) {
            ledger = { screens: p.compare.items.map((i) => ({ name: i.name, status: i.verdict, note: i.note })) };
          }
        } else if (p.app.migratesFrom) {
          const src = this.livePreviewForApp(p.app.migratesFrom);
          // A migration pairs two REAL apps, each with its own PIN — unlike a
          // compare session, whose reference is a synthetic always-public app.
          // So the source pane is only mountable when this page can actually
          // unlock it: the unlock propagates from a proven PIN on this share,
          // and the pad only ever renders for the page's own shareId. Showing
          // the pane anyway (a public target beside a PIN-protected source) got
          // its socket refused once a second, forever, with nothing on screen
          // and no way to authenticate — so don't advertise it.
          if (src && this.partnerIsReachable(p.record.shareId, src.record.shareId)) {
            refPanes.push({
              shareId: src.record.shareId,
              repo: src.app.repo ?? src.app.id,
              ref: src.record.ref,
              devices: sanitizeDevices(src),
            });
          }
          const led = readMigrationLedger(p.sourceDir ?? p.app.path);
          if (led) ledger = led;
        }
        const panes: Pane[] = [
          ...refPanes,
          {
            shareId: p.record.shareId,
            repo: p.app.repo ?? p.app.id,
            ref: p.record.ref,
            self: true,
            devices: sanitizeDevices(p),
          },
        ];
        return {
          ready: p.record.phase === "ready",
          ref: p.record.ref,
          repo: p.app.repo ?? p.app.id,
          source: p.record.source,
          canRestart: p.record.source === "local" && (p.record.phase === "ready" || p.record.phase === "failed"),
          devices: sanitizeDevices(p),
          panes,
          ...(p.testRun
            ? {
                testRun: {
                  status: p.testRun.status,
                  title: p.testRun.title,
                  steps: p.testRun.steps.map((s) => ({ n: s.n, label: s.label, status: s.status, detail: s.detail })),
                  summary: p.testRun.summary,
                },
              }
            : {}),
          ...(ledger ? { ledger } : {}),
        };
      }
    }
    return null;
  }

  /**
   * Every shareId this share shares a page with, so one PIN unlocks all of them.
   *
   * The viewer is ONE page showing several shares: it renders each extra pane
   * from this share's compare session, but streams it from that pane's OWN
   * shareId, whose unlock cookie is scoped to its own path. So a PIN on the
   * working share left every other pane stuck on "Connecting…" forever (the WS
   * refused once a second, silently). The unlock route uses this to mint each
   * partner's cookie too.
   *
   * Symmetric on purpose: whichever pane the viewer is opened from has to
   * unlock the others.
   */
  pairedShareIds(shareId: string): string[] {
    const out = new Set<string>();
    for (const p of this.previews.values()) {
      // Mirror shareState's two pairing sources: a live compare session wins,
      // else the legacy migratesFrom link. Anything shareState will render as
      // another pane must be unlockable, or that pane hangs.
      if (p.compare) {
        if (p.record.shareId === shareId) {
          // Forward: this page's own panes. Only a LIVE one counts — the viewer
          // never mounts a dead pane, so don't mint a cookie for it either.
          for (const r of p.compare.references) {
            if (this.liveByShareId(r.shareId)) out.add(r.shareId);
          }
        } else if (p.compare.references.some((r) => r.shareId === shareId)) {
          // The reverse direction is a compare-session-only affair. A compare
          // reference is a synthetic app the operator just booted as one pane of
          // one page, so unlocking any pane unlocks the page. `migratesFrom`
          // instead names another REGISTERED app with its own PIN and its own
          // repo — and only the target's page renders a source pane, never the
          // other way round, so minting the target's cookie for whoever holds
          // the source's PIN unlocks an app they were never given access to, for
          // nothing.
          out.add(p.record.shareId);
        }
        continue;
      }
      if (!p.app.migratesFrom || p.record.shareId !== shareId) continue;
      const src = this.livePreviewForApp(p.app.migratesFrom);
      // A migration source pane is only advertised when it is reachable from
      // here (see shareState) — don't mint a cookie for a pane we hid.
      if (src && this.partnerIsReachable(shareId, src.record.shareId)) out.add(src.record.shareId);
    }
    // Never hand a share its own cookie: harmless, but it would let a caller
    // read "I am paired" off a page that is alone.
    out.delete(shareId);
    return [...out];
  }

  /**
   * Whether a viewer on `shareId` may be shown — and handed the unlock cookie
   * for — a migration source pane on `partnerShareId`.
   *
   * Unlock only ever propagates OUT of a PIN proven on the page's own share, so
   * a PUBLIC target can never reach a protected source: advertising that pane
   * would either hang it forever (refused every retry, and the pad only renders
   * for the page's own shareId) or, if we minted the cookie anyway, hand the
   * source's stream and input to anyone holding the target's public link.
   *
   * When both sides are protected the pane is shown and the unlock propagates.
   * Residual, accepted: PIN records are salted per app, so "same PIN on both"
   * is not detectable here — whoever holds the TARGET's PIN can therefore reach
   * the source too. That is inherent to one page, two apps and one pad, and the
   * operator asked for exactly that by declaring `migratesFrom`. What it must
   * never do is grant access from nothing, which is the case above.
   */
  private partnerIsReachable(shareId: string, partnerShareId: string): boolean {
    return !this.pinInfoForShare(partnerShareId).required || this.pinInfoForShare(shareId).required;
  }

  private persist(): void {
    this.d.store.persist(
      [...this.previews.values()].map((p) => p.record),
      this.stableShareIds,
      this.pins,
    );
  }

  // --- share PIN protection ---------------------------------------------------

  /** The appId whose live preview owns this shareId (PINs are keyed per app). */
  private appIdForShare(shareId: string): string | null {
    for (const p of this.previews.values()) {
      if (p.record.shareId === shareId) return p.record.appId;
    }
    return null;
  }

  /** Set (`pin`), change, or clear (`null`) an app's share PIN. Persists; does not re-orchestrate. */
  setAppPin(appId: string, pin: string | null): void {
    if (pin == null && this.hasLiveWebPreview(appId)) {
      throw new PreviewError(
        `the web preview of "${appId}" cannot be made public`,
        "web shares are always PIN-protected — set a new PIN instead, or stop the preview first",
      );
    }
    if (pin == null) {
      delete this.pins[appId];
    } else {
      const existing = this.pins[appId];
      // Re-hashing an UNCHANGED pin would mint a fresh salt, hence a fresh
      // pinFingerprint, hence reject every unlock cookie issued under the old
      // one — kicking live viewers back to the PIN pad. start_preview is
      // idempotent and sets the PIN on every call (including "what's the link?"
      // re-calls), so that would happen in normal use. Keep the record when the
      // PIN is the same.
      if (!(existing && verifyPassword(pin, existing))) {
        const { salt, hash } = hashPassword(pin);
        this.pins[appId] = { salt, hash, length: pin.length };
      }
    }
    for (const p of this.previews.values()) {
      if (p.record.appId === appId) p.record.passwordProtected = pin != null;
    }
    this.persist();
    this.d.audit.record({ actor: "engine", tool: "set_pin", args: { app: appId, protected: pin != null }, result: "ok" });
  }

  /**
   * The stored PIN record for an app, for snapshot/restore around a boot that may
   * throw. Share ids are stable per app, so clearing a PIN and then failing to boot
   * would leave an already-live share open (see `restoreAppPin`).
   */
  pinRecordForApp(appId: string): PinRecord | null {
    return this.pins[appId] ?? null;
  }

  /** Put back a record captured by `pinRecordForApp` verbatim (rollback path — no re-hashing). */
  restoreAppPin(appId: string, rec: PinRecord | null): void {
    if (rec) this.pins[appId] = rec;
    else delete this.pins[appId];
    for (const p of this.previews.values()) {
      if (p.record.appId === appId) p.record.passwordProtected = rec != null;
    }
    this.persist();
    // Compensating entry: setAppPin already recorded the (now undone) change, so
    // without this the audit log claims a share was made public when it wasn't.
    this.d.audit.record({ actor: "engine", tool: "set_pin", args: { app: appId, protected: rec != null, rollback: true }, result: "ok" });
  }

  /** Whether the share behind `shareId` requires a PIN, and its digit length (for the pad). */
  pinInfoForShare(shareId: string): { required: boolean; length: number } {
    const appId = this.appIdForShare(shareId);
    const rec = appId ? this.pins[appId] : undefined;
    return rec ? { required: true, length: rec.length } : { required: false, length: 0 };
  }

  /** Whether the app has a live (non-terminal) preview serving a web device. */
  private hasLiveWebPreview(appId: string): boolean {
    for (const p of this.previews.values()) {
      const ph = p.record.phase;
      if (p.record.appId !== appId || ph === "stopped" || ph === "failed") continue;
      if (p.devices.some((d) => d.record.platform === "web")) return true;
    }
    return false;
  }

  /**
   * The PIN record in force for a share, or null when the share is public.
   * The proxy folds this into every unlock cookie (see `pinFingerprint`) so a
   * PIN change revokes cookies issued under the previous one.
   */
  pinRecordForShare(shareId: string): PinRecord | null {
    const appId = this.appIdForShare(shareId);
    return (appId ? this.pins[appId] : undefined) ?? null;
  }

  /** Verify a PIN attempt against the share's stored hash (timing-safe). */
  verifyPin(shareId: string, pin: string): boolean {
    const appId = this.appIdForShare(shareId);
    const rec = appId ? this.pins[appId] : undefined;
    return rec ? verifyPassword(pin, rec) : false;
  }

  private recomputePreviewPhase(p: LivePreview): void {
    const phases = p.devices.map((d) => d.record.phase);
    let next: PreviewPhase;
    if (phases.every((ph) => ph === "ready")) next = "ready";
    else if (phases.some((ph) => ph === "failed") && phases.every((ph) => ph === "failed" || ph === "ready")) {
      next = phases.every((ph) => ph === "failed") ? "failed" : "ready";
    } else next = "running";
    if (p.record.phase !== "stopping" && p.record.phase !== "stopped") {
      p.record.phase = next;
    }
    p.record.updatedAt = this.iso();
  }

  private touch(p: LivePreview): void {
    p.lastProgressAt = this.d.now!();
    this.recomputePreviewPhase(p);
    this.persist();
  }

  /**
   * A sign of life from a running build. Cheap on purpose — it moves the stuck
   * clock without persisting, so it can be called per log line.
   */
  private noteProgress(p: LivePreview): void {
    p.lastProgressAt = this.d.now!();
  }

  // --- start -----------------------------------------------------------------

  startPreview(req: StartPreviewRequest): StartPreviewResult {
    if (req.devices.length === 0) throw new PreviewError("no devices requested");
    if (req.source === "local" && !req.app.path) {
      throw new PreviewError(
        `app "${req.app.id}" has no local path configured`,
        `register it on this machine: deckhand app add ${req.app.id} --path <dir>`,
      );
    }
    if (req.source === "git" && !req.spec) throw new PreviewError("git previews need a ref");
    if (req.app.type === "web" && req.source !== "local") {
      throw new PreviewError(
        "web apps preview their local files only",
        "omit ref/pr — a web app previews its local working copy (a live dev server)",
      );
    }
    // A web share is never public. Enforced HERE, not only in the MCP tool, so
    // no caller can boot one PIN-less: a web preview exposes the dev server's
    // whole route surface (including `@fs` if the repo relaxed Vite's
    // `server.fs.strict`), and a subdomain-hosted framework serves at a bare
    // public hostname with no shareId in the URL to keep it secret.
    if (req.devices.some((d) => d.platform === "web") && !this.pins[req.app.id]) {
      throw new PreviewError(
        `web app "${req.app.id}" needs a share PIN before it can be previewed`,
        "ask the user for a 4–6 digit PIN and pass share: { access: \"pin\", pin: \"<code>\" }",
      );
    }
    if (req.source === "local") {
      const seen = new Set<Platform>();
      for (const d of req.devices) {
        if (seen.has(d.platform)) {
          throw new PreviewError(
            "local previews run one device per platform",
            "the livesync process targets a single device; request one iOS and/or one Android device",
          );
        }
        seen.add(d.platform);
      }
    }

    // The daily loop: an equivalent live preview is THE preview — return it
    // (same shareId, same URL) instead of minting a second simulator.
    const stillReleasing = this.reapTerminalForApp(req.app.id);
    const existing = this.findReusable(req);
    if (existing) return this.resultFor(existing, true);

    if (req.devices.length > this.d.config.limits.maxDevicesPerPreview) {
      throw new PreviewError(
        `too many devices (${req.devices.length} > ${this.d.config.limits.maxDevicesPerPreview})`,
        "request fewer devices or raise limits.maxDevicesPerPreview",
      );
    }
    // Devices still being released for THIS app are already spoken for by this
    // request — don't make it queue behind its own teardown. Only what is still
    // held is discounted; releases that already completed are out of the tally
    // anyway, and discounting them twice would over-admit.
    const totalActive = Math.max(0, this.devicesInUse() - stillReleasing());
    if (totalActive + req.devices.length > this.d.config.limits.maxTotalDevices) {
      throw new PreviewError(
        `device capacity reached (${totalActive}/${this.d.config.limits.maxTotalDevices} in use)`,
        "stop an existing preview or raise limits.maxTotalDevices",
      );
    }

    const previewId = this.d.genPreviewId!();
    const shareId = this.claimShareId(req.app.id);
    const now = this.iso();
    // Web: detect the framework so orchestration/URL know whether it hosts
    // path-based (Vite) or at the root of a per-share subdomain (Nuxt/Next/…).
    const webFramework = req.app.type === "web" && req.app.path ? detectWebFrameworkFromDir(req.app.path) : null;
    const devices: LiveDevice[] = req.devices.map((dev, i) => ({
      record: {
        deviceId: `${dev.platform}-${i}`,
        platform: dev.platform,
        label:
          dev.platform === "web"
            ? "Web app"
            : dev.model && dev.runtime
              ? `${dev.model} · ${dev.runtime}`
              : `${dev.platform} device ${i}`,
        runtime: dev.runtime,
        model: dev.model,
        phase: "pending",
      },
      logs: { build: [], metro: [], app: [], stream: [] },
      abort: new AbortController(),
    }));

    const record: PersistedPreview = {
      previewId,
      shareId,
      appId: req.app.id,
      ref: req.source === "local" ? "local" : refDescription(req.spec!),
      source: req.source,
      phase: "pending",
      devices: devices.map((d) => d.record),
      createdAt: now,
      updatedAt: now,
      passwordProtected: req.access === "password",
      ...(req.reference ? { reference: true } : {}),
      ...(webFramework ? { webFramework } : {}),
    };
    const preview: LivePreview = {
      record,
      app: req.app,
      spec: req.spec,
      devices,
      attached: new Map(),
      lastActivityAt: this.d.now!(),
      lastProgressAt: this.d.now!(),
    };
    this.previews.set(previewId, preview);
    this.persist();

    this.d.audit.record({
      actor: "engine",
      tool: "start_preview",
      args: { app: req.app.id, ref: record.ref, source: req.source, devices: req.devices.length },
      result: "ok",
    });

    // Kick off orchestration; do not await (start_preview returns immediately).
    record.phase = "running";
    void this.orchestratePreview(preview).catch(() => {
      /* per-device errors are captured onto the device records */
    });

    return this.resultFor(preview, false);
  }

  private resultFor(p: LivePreview, alreadyRunning: boolean): StartPreviewResult {
    this.markActive(p); // an idempotent start_preview is someone using it
    return {
      previewId: p.record.previewId,
      shareId: p.record.shareId,
      url: this.previewUrl(p),
      source: p.record.source,
      alreadyRunning,
      devices: p.devices.map((d) => ({ deviceId: d.record.deviceId, label: d.record.label, phase: d.record.phase })),
    };
  }

  /** An equivalent live preview (same app + source, and same ref for git). */
  private findReusable(req: StartPreviewRequest): LivePreview | null {
    for (const p of this.previews.values()) {
      const ph = p.record.phase;
      if (ph === "stopped" || ph === "failed" || ph === "stopping") continue;
      if (p.record.appId !== req.app.id || p.record.source !== req.source) continue;
      if (req.source === "git" && p.record.ref !== refDescription(req.spec!)) continue;
      return p;
    }
    return null;
  }

  /**
   * Drop terminal previews of an app so its stable shareId can be reclaimed.
   * A failed preview still holds a booted simulator/AVD, so release the devices
   * before forgetting it — dropping the record first made them unreachable
   * (nothing left to stop) and leaked them for the life of the machine.
   *
   * Returns a live count of how many of the released devices are STILL held.
   * The caller needs it for the capacity check: the teardown is asynchronous and
   * starts in this very tick, so those devices can still be counted in
   * `tearingDown` when the retry that caused their release is checked — and
   * "start it again after it failed" would fail with "device capacity reached"
   * on a machine whose only devices are the ones being freed.
   *
   * Live, not a fixed count: a preview that failed before booting anything has
   * nothing to await, so its release completes synchronously inside this call
   * and `tearingDown` is already back down by the time the caller reads it.
   * Subtracting a fixed `p.devices.length` on top of that under-counted, and let
   * a retry start more devices than the machine is allowed to run.
   */
  private reapTerminalForApp(appId: string): () => number {
    const held: (() => number)[] = [];
    for (const [id, p] of this.previews) {
      if (p.record.appId === appId && (p.record.phase === "failed" || p.record.phase === "stopped")) {
        this.previews.delete(id);
        if (p.record.phase === "failed") held.push(this.releaseInBackground(p));
      }
    }
    return () => held.reduce((n, stillHeld) => n + stillHeld(), 0);
  }

  /**
   * Release everything a forgotten preview still holds — dev processes, devices,
   * worktree — without blocking the caller (startPreview is synchronous). The
   * device count is held in `tearingDown` for the duration so a preview starting
   * right now can't claim capacity that is still occupied — but released one
   * device at a time, not all at the end. Android's shutdown polls `get-state`
   * for up to 20 s per device; charging the whole preview for that whole window
   * made the immediate retry of a failed preview fail with "device capacity
   * reached", which is precisely the flow this path exists to serve.
   */
  /**
   * Stop the app's Metro once nothing is using it any more.
   *
   * Teardown killed the dev processes but never Metro, so every finished Expo
   * preview left one listening for the rest of the server's life and `freePort`
   * simply moved to the next port — the 8081-8099 range emptied out over a few
   * app switches and previews started failing with "no free Metro port".
   * App-scoped on purpose: one manager, one Metro, and another app's live
   * preview may be the one holding it.
   */
  private stopMetroIfUnused(appId: string): void {
    for (const other of this.previews.values()) if (other.app.id === appId) return;
    void this.d.metro.stopApp(appId).catch(() => {});
  }

  private releaseInBackground(p: LivePreview): () => number {
    let held = p.devices.length;
    this.tearingDown += held;
    const releaseOne = (): void => {
      if (held <= 0) return;
      held--;
      this.tearingDown--;
    };
    // Nothing awaits this, so an escaping rejection is fatal to the process:
    // devProcs.stop() or an AndroidManager constructor throw would turn an
    // ordinary "start it again after it failed" into a server crash.
    void (async () => {
      try {
        for (const dev of p.devices) dev.abort.abort();
        if (p.record.source === "local") {
          for (const platform of new Set(p.devices.map((d) => d.record.platform))) {
            this.d.devProcs?.stop(devKey(p.app.id, platform));
          }
        }
        await this.teardownDevices(p, releaseOne);
        this.stopMetroIfUnused(p.app.id);
        if (p.record.source !== "local") {
          await this.d.worktrees.removeWorktree(p.app, p.record.previewId).catch(() => {});
        }
      } finally {
        // Whatever teardownDevices didn't reach (it threw part-way through).
        while (held > 0) releaseOne();
      }
    })().catch(() => {});
    return () => held;
  }

  /**
   * The stable per-app shareId when free, else a fresh one (a second concurrent
   * preview of the same app must not collide with the bookmarked URL).
   */
  private claimShareId(appId: string): string {
    const stable = this.stableShareIds[appId];
    if (stable) {
      const inUse = [...this.previews.values()].some((p) => p.record.shareId === stable);
      return inUse ? this.d.genShareId!() : stable;
    }
    const minted = this.d.genShareId!();
    this.stableShareIds[appId] = minted;
    return minted;
  }

  private setPhase(p: LivePreview, dev: LiveDevice, phase: PersistedDevice["phase"], detail?: string): void {
    // "failed" is terminal until a restart explicitly resets the device. Steps
    // started before the failure (a boot racing a failed checkout) finish later
    // and used to write their phase over it, leaving the preview stuck in
    // "running" forever — never ready, never failed, and invisible to both the
    // idle sweep and the grace-window sweep.
    if (dev.record.phase === "failed" && phase !== "pending") return;
    dev.record.phase = phase;
    dev.record.detail = detail;
    // The build sub-step belongs to the phase that produced it — leaving it up
    // would caption "installing the app" with the last file that compiled.
    dev.record.step = undefined;
    this.touch(p);
  }

  private appEnv(app: App): Record<string, string> {
    // A UTF-8 locale, unless the environment already set one. Ruby-based build
    // tooling reads paths as ASCII-8BIT without it: `pod install` dies with
    // "Unicode Normalization not appropriate for ASCII-8BIT", which NativeScript
    // reports only as a livesync exit code. A LaunchAgent inherits no locale from
    // a login shell, so the server itself usually has none to pass on.
    const locale: Record<string, string> = process.env.LC_ALL || process.env.LANG ? {} : { LANG: "en_US.UTF-8" };
    return { ...locale, ...app.env, ...this.d.secretsEnv!(app.id) };
  }

  /**
   * Memoized per preview. Git: worktree created once, shared across devices.
   * Local: the app's own dir — used in place, and NEVER created or removed.
   */
  private prepareSource(p: LivePreview): Promise<string> {
    if (!p.prep) {
      p.prep =
        p.record.source === "local"
          ? Promise.resolve(this.localSourceDir(p.app))
          : this.d.worktrees.createWorktree(p.app, p.record.previewId, p.spec!).then((wt) => {
              p.record.worktreePath = wt.path;
              this.persist();
              return wt.path;
            });
      void p.prep.then((dir) => (p.sourceDir = dir)).catch(() => {});
    }
    return p.prep;
  }

  private localSourceDir(app: App): string {
    if (!app.path) throw new PreviewError(`app "${app.id}" has no local path configured`);
    if (!existsSync(app.path)) {
      throw new PreviewError(
        `local source dir ${app.path} does not exist on this machine`,
        `fix the app's path (deckhand app add) or use a git preview instead`,
      );
    }
    return app.path;
  }

  /** The build/install handle for a device: simulator UDID (iOS) or adb serial (Android). */
  private handle(dev: LiveDevice): string {
    return (dev.record.platform === "android" ? dev.record.serial : dev.record.udid) ?? "";
  }

  private async bootDevice(p: LivePreview, dev: LiveDevice): Promise<string> {
    return dev.record.platform === "android" ? this.bootAndroid(p, dev) : this.bootIos(p, dev);
  }

  private async bootIos(p: LivePreview, dev: LiveDevice): Promise<string> {
    const runtimes = await this.d.simctl.listRuntimes();
    const runtime = selectRuntime(runtimes, dev.record.runtime);
    const deviceTypes = await this.d.simctl.listDeviceTypes();
    const deviceType = selectDeviceType(deviceTypes, dev.record.model);
    dev.record.label = deviceLabel(deviceType, runtime);
    dev.record.runtime = runtime.name;
    dev.record.model = deviceType.name;

    let udid: string;
    if (this.pooling()) {
      // Record the lease on the device *before* anything that can throw, so a
      // failed create releases the slot on teardown instead of stranding it
      // (leaked slots push every later preview onto `…-2`, `…-3` forever).
      const name = this.leaseName(POOL_SIM_PREFIX, `${deviceType.name}-${runtime.name}`, "-");
      dev.poolName = name;
      dev.deviceName = name;
      // "Couldn't list" is not "no such device": swallowing a transient simctl
      // failure into [] used to fall through to create(), and simctl will
      // happily make a *second* simulator with the same name. From then on the
      // lookup picks one arbitrarily and the other is an untracked orphan.
      const devices = await this.d.simctl.listDevices();
      const existing = devices.find((d) => d.name === name);
      if (existing) {
        udid = existing.udid;
        // Unknown predecessor (a restart lost the tenant map) ⇒ factory reset.
        //
        // NOT best-effort. Pooling keys devices by shape, not by app or owner,
        // so this erase is the ONLY thing separating two tenants. Swallowing a
        // failure handed app B a simulator still holding app A's container,
        // keychain and cookies — across owner scopes, silently. If the reset
        // won't complete, throw the device away and build a clean one.
        // (Android is already correct here: a failed wipe fails the boot.)
        if (this.poolTenants.get(name) !== p.app.id) {
          try {
            await this.d.simctl.erase(udid);
          } catch (err) {
            // Erase failed — the device may still hold the prior tenant's data.
            // Delete it and build fresh. But `delete` must SUCCEED before we
            // create, or a wedged simctl leaves the old device AND a new one
            // sharing this name — two devices, one name, the untracked-orphan /
            // cross-tenant hazard again. If delete fails too, refuse the reuse.
            this.poolTenants.delete(name);
            try {
              await this.d.simctl.delete(udid);
            } catch (delErr) {
              throw new PreviewError(
                `couldn't reset pooled simulator "${name}" for a new tenant (erase and delete both failed)`,
                "the machine's simulator state is wedged — `xcrun simctl shutdown all` / restart, or disable reuseDevices",
              );
            }
            udid = await this.d.simctl.create(name, deviceType.identifier, runtime.identifier);
            this.appendLog(dev, "build", `[pool] reset of ${name} failed (${String(err)}); rebuilt it clean`);
          }
        }
      } else {
        udid = await this.d.simctl.create(name, deviceType.identifier, runtime.identifier);
      }
      this.poolTenants.set(name, p.app.id);
    } else {
      // Record before creating: with pooling off there is no lease to spare it
      // by, and the reap that runs just after the port is bound would otherwise
      // delete a simulator whose `create` has not returned yet.
      const name = `deckhand-${p.record.previewId}-${dev.record.deviceId}`;
      dev.deviceName = name;
      udid = await this.d.simctl.create(name, deviceType.identifier, runtime.identifier);
    }
    dev.record.udid = udid;
    // The sweep may have collected this preview while `create` was running. Its
    // teardown already ran and saw no udid, so unless we release the device here
    // it survives as an orphan — and, with pooling on, as a device a newer
    // preview can lease and boot underneath us.
    await this.abandonIfAborted(dev, async () => {
      await this.d.simctl.shutdown(udid).catch(() => {});
      if (!dev.poolName) await this.d.simctl.delete(udid).catch(() => {});
    });
    this.setPhase(p, dev, "booting", "booting simulator");
    await this.d.simctl.bootAndWait(udid, undefined, dev.abort.signal);
    await this.abandonIfAborted(dev, async () => {
      await this.d.simctl.shutdown(udid).catch(() => {});
      if (!dev.poolName) await this.d.simctl.delete(udid).catch(() => {});
    });
    return udid;
  }

  /**
   * Throw if this device's preview was collected while an un-cancellable step
   * was in flight, running `release` first so whatever that step produced does
   * not outlive the preview that asked for it.
   */
  private async abandonIfAborted(dev: LiveDevice, release: () => Promise<void>): Promise<void> {
    if (!dev.abort.signal.aborted) return;
    await release().catch(() => {});
    if (dev.poolName) {
      this.leased.delete(dev.poolName);
      dev.poolName = undefined;
    }
    if (dev.androidPort != null) {
      this.androidPorts.delete(dev.androidPort);
      dev.androidPort = undefined;
    }
    dev.record.udid = undefined;
    dev.record.serial = undefined;
    throw new PreviewError("preview was stopped while its device was starting");
  }

  private async bootAndroid(p: LivePreview, dev: LiveDevice): Promise<string> {
    const android = this.android();
    const image = selectSystemImage(await android.listSystemImages(), dev.record.runtime);
    const profile = dev.record.model ?? "pixel_7";
    let avdName: string;
    let wipeData = false;
    if (this.pooling()) {
      avdName = this.leaseName(POOL_AVD_PREFIX, `${profile}_api${image.api}`, "_");
      dev.poolName = avdName; // claim before createAvd, which can throw — see bootIos
      dev.deviceName = avdName;
      const exists = (await safeList<string>(() => android.listAvds())).includes(avdName);
      wipeData = this.poolTenants.get(avdName) !== p.app.id;
      if (!exists) await android.createAvd(avdName, image, profile);
      this.poolTenants.set(avdName, p.app.id);
    } else {
      avdName = `deckhand_${p.record.previewId}_${dev.record.deviceId}`.replace(/[^A-Za-z0-9_]/g, "_");
      dev.deviceName = avdName; // see bootIos: spare it by name while createAvd runs
      await android.createAvd(avdName, image, profile);
    }
    dev.record.udid = avdName; // remember the AVD name for teardown
    dev.record.model = profile;
    dev.record.runtime = `Android ${image.api}`;
    dev.record.label = `${profile} · Android ${image.api}`;
    // Remember the port on the device, not just via its serial: bootEmulator can
    // time out (240 s) or throw, and a port only released when a serial came back
    // is a port lost for the life of the process.
    const port = await this.allocAndroidPort();
    dev.androidPort = port;
    // createAvd can't be cancelled, so check before paying for a 240 s boot.
    await this.abandonIfAborted(dev, async () => {
      if (!dev.poolName) await android.deleteAvd(avdName).catch(() => {});
    });
    this.setPhase(p, dev, "booting", "booting emulator");
    let serial: string;
    try {
      serial = await android.bootEmulator(avdName, port, undefined, { wipeData, signal: dev.abort.signal });
    } catch (err) {
      // bootEmulator launches QEMU detached and only *waits* here, so a throw —
      // abort or timeout — leaves an emulator running that nothing can address:
      // record.serial was never set, so teardown can't reach it either. Kill it
      // by the port we know before that port goes back in the pool, or the next
      // preview allocates 5554, collides, and streams the abandoned device.
      await android.shutdown(serialForPort(port)).catch(() => {});
      this.androidPorts.delete(port);
      dev.androidPort = undefined;
      throw err;
    }
    dev.record.serial = serial;
    await this.abandonIfAborted(dev, async () => {
      await android.shutdown(serial).catch(() => {});
      if (!dev.poolName) await android.deleteAvd(avdName).catch(() => {});
    });
    return serial;
  }

  private pooling(): boolean {
    return this.d.config.limits.reuseDevices;
  }

  /**
   * Claim a pool slot for a device *shape* (model + runtime). Two previews
   * wanting the same shape at once get `…`, `…2`, `…3` — a pooled device is
   * reused across previews, never shared by two at the same time.
   */
  private leaseName(prefix: string, shape: string, sep: string): string {
    const base = prefix + shape.toLowerCase().replace(/[^a-z0-9]+/g, sep).replace(new RegExp(`\\${sep}+$`), "");
    for (let i = 1; ; i++) {
      const name = i === 1 ? base : `${base}${sep}${i}`;
      if (!this.leased.has(name)) {
        this.leased.add(name);
        return name;
      }
    }
  }

  private resolveBundleId(app: App, worktreePath: string, platform: Platform): string {
    const label = platform === "android" ? "package" : "bundle id";
    // Only reached for iOS/Android builds; web has no bundle id.
    const value = app.bundleId ?? detectBundleIdFromDir(worktreePath, app.type, platform === "android" ? "android" : "ios");
    if (!value) {
      throw new PreviewError(
        `could not determine the ${platform} ${label} for ${app.id}`,
        `set bundleId for app "${app.id}" (deckhand app ...) or ensure the config declares it`,
      );
    }
    // Validate before use: this value comes from the previewed repo's own
    // config and reaches multi-arg `adb shell` calls (`pm path`,
    // `resolve-activity`, `am start`, `monkey -p`) as an unquoted token that adb
    // joins into a device-side shell command line.
    if (!(platform === "android" ? ANDROID_PACKAGE_RE : IOS_BUNDLE_ID_RE).test(value)) {
      throw new PreviewError(
        `${platform} ${label} ${JSON.stringify(value)} for ${app.id} is not a valid ${label}`,
        `set a valid bundleId for app "${app.id}" — reverse-DNS segments only, e.g. com.example.app`,
      );
    }
    return value;
  }

  /**
   * Record a line on a device's `stream` trace, timestamped. This is the log an
   * agent reads when the viewer is stuck on "Connecting…" — so it must say what
   * was tried and what came back, never just that something failed.
   */
  private streamLog(dev: LiveDevice, line: string): void {
    this.appendLog(dev, "stream", `${this.iso()} ${line}`);
  }

  /**
   * Public entry point for the share proxy and the viewer's own client reports,
   * addressed by shareId (the proxy has no previewId). Unknown share/device is
   * silently ignored — a request for an ended preview must not throw in a
   * request handler.
   */
  logStreamEvent(shareId: string, deviceId: string, line: string): void {
    for (const p of this.previews.values()) {
      if (p.record.shareId !== shareId) continue;
      const dev = p.devices.find((d) => d.record.deviceId === deviceId);
      if (dev) this.streamLog(dev, line);
      return;
    }
  }

  private appendLog(dev: LiveDevice, source: LogSource, line: string): void {
    const buf = dev.logs[source];
    buf.push(line);
    if (buf.length > LOG_CAP) buf.splice(0, buf.length - LOG_CAP);
  }

  /** Orchestrate a whole preview: one platform group at a time, in parallel. */
  private async orchestratePreview(p: LivePreview): Promise<void> {
    const groups = this.platformGroups(p);
    await Promise.all([...groups.values()].map((group) => this.orchestrateGroup(p, group)));
  }

  private platformGroups(p: LivePreview): Map<Platform, LiveDevice[]> {
    const groups = new Map<Platform, LiveDevice[]>();
    for (const dev of p.devices) {
      const g = groups.get(dev.record.platform) ?? [];
      g.push(dev);
      groups.set(dev.record.platform, g);
    }
    return groups;
  }

  /** First line of a failure, capped — enough to act on, short enough for a device frame. */
  private failureDetail(error: string): string | undefined {
    const first = error.split("\n").find((l) => l.trim().length)?.trim();
    if (!first) return undefined;
    const safe = redactForShare(first);
    return safe.length > 160 ? `${safe.slice(0, 159)}…` : safe;
  }

  private failDevice(p: LivePreview, dev: LiveDevice, e: unknown): void {
    if (dev.record.phase === "ready" || dev.record.phase === "failed") return;
    dev.record.error = e instanceof Error ? e.message : String(e);
    // Carry the reason into `detail`, the one field shareState sanitizes through
    // to the viewer. Without it a failed device read as a bare "This device
    // didn't start." with no way to tell a build error from a dead simulator —
    // the share holder had nothing to relay and no next step. First line only,
    // capped: a build error's stack is for `logs`, not for a device frame.
    this.setPhase(p, dev, "failed", this.failureDetail(dev.record.error));
    this.d.audit.record({
      actor: "engine",
      tool: "device_failed",
      args: { preview: p.record.previewId, device: dev.record.deviceId },
      result: "error",
      error: dev.record.error,
    });
  }

  /**
   * One platform group, from cold: boots run concurrently with worktree prep
   * and (for non-builders) with the shared build, so wall-clock ≈ slowest
   * device, not the sum.
   */
  private async orchestrateGroup(p: LivePreview, group: LiveDevice[]): Promise<void> {
    // Web is device-less: it has a single pseudo-device and its own pipeline
    // (start a dev server, health-check) that never boots or builds a device.
    if (group[0]!.record.platform === "web") {
      await this.orchestrateWebGroup(p, group[0]!);
      return;
    }
    for (const dev of group) this.setPhase(p, dev, "preparing", "checking out and booting");

    // Start source prep (shared across all groups) and every device's boot.
    const sourceP = this.prepareSource(p);
    const boots = group.map((dev) =>
      this.bootDevice(p, dev).then(
        (udid) => ({ dev, udid }) as const,
        (err) => ({ dev, err }) as const,
      ),
    );
    const handleOf = async (i: number): Promise<string> => {
      const boot = await boots[i]!;
      if ("err" in boot) throw boot.err;
      return boot.udid;
    };

    let sourceDir: string;
    try {
      sourceDir = await sourceP;
    } catch (e) {
      for (const dev of group) this.failDevice(p, dev, e);
      return;
    }
    await this.buildGroup(p, group, handleOf, sourceDir);
  }

  /**
   * Build once on a "builder" device, install the built product to the rest in
   * parallel. `handleOf(i)` resolves group[i]'s device handle — a fresh boot on
   * start, the already-booted device on restart. Local NativeScript diverges:
   * the long-lived livesync process builds+installs+launches and keeps syncing.
   */
  private async buildGroup(
    p: LivePreview,
    group: LiveDevice[],
    handleOf: (i: number) => Promise<string>,
    sourceDir: string,
  ): Promise<void> {
    const builder = group[0]!;
    const platform = builder.record.platform;
    const local = p.record.source === "local";
    let bundleId: string;
    let appEnv: Record<string, string>;
    let builderHandle: string;

    try {
      appEnv = this.appEnv(p.app);
      bundleId = this.resolveBundleId(p.app, sourceDir, platform);
      builderHandle = await handleOf(0);

      // Mark the whole group building (non-builders wait on the shared build).
      for (const dev of group) {
        this.setPhase(p, dev, "building", dev === builder ? "building the app" : "building the app (shared)");
      }
      await this.runBuildPlan(p, builder, platform, builderHandle, sourceDir, appEnv, local);

      if (local && p.app.type === "nativescript") {
        // Livesync builds, installs, launches, then keeps watching for saves.
        this.setPhase(p, builder, "building", "first livesync build");
        this.startDevProcess(p, builder, platform, builderHandle, sourceDir, appEnv);
        this.setPhase(p, builder, "installing-app", "waiting for the app to install");
        await this.verifyInstalled(platform, builderHandle, bundleId, DEV_INSTALL_TIMEOUT_MS, () =>
          this.devProcessDead(p.app.id, platform),
        );
      } else {
        this.setPhase(p, builder, "installing-app", "verifying install");
        await this.verifyInstalled(platform, builderHandle, bundleId);
        this.setPhase(p, builder, "launching", "launching app");
        await this.launch(p, builder, builderHandle, bundleId, sourceDir, appEnv);
      }

      await this.attachAndReady(p, builder, platform, builderHandle);
    } catch (e) {
      // A shared-build failure fails the whole group.
      for (const dev of group) this.failDevice(p, dev, e);
      return;
    }

    // Single-device group: the builder is the only device — nothing to install-many.
    // (Locating the built product is only needed to copy it to *other* devices, so
    // don't let that step fail a device that already built, launched, and streamed.)
    if (group.length === 1) return;

    let appPath: string;
    try {
      appPath = await this.locateBuiltProduct(platform, builderHandle, bundleId, sourceDir);
    } catch (e) {
      for (const dev of group.slice(1)) this.failDevice(p, dev, e);
      return;
    }

    // Install the built product to the remaining devices in parallel.
    await Promise.all(
      group.slice(1).map(async (dev, i) => {
        try {
          const handle = await handleOf(i + 1);
          this.setPhase(p, dev, "installing-app", "installing");
          await this.installProduct(platform, handle, appPath);
          await this.verifyInstalled(platform, handle, bundleId);
          this.setPhase(p, dev, "launching", "launching app");
          await this.launch(p, dev, handle, bundleId, sourceDir, appEnv);
          await this.attachAndReady(p, dev, platform, handle);
        } catch (e) {
          this.failDevice(p, dev, e);
        }
      }),
    );
  }

  private startDevProcess(
    p: LivePreview,
    dev: LiveDevice,
    platform: Platform,
    handle: string,
    cwd: string,
    appEnv: Record<string, string>,
  ): void {
    // Only called for local NativeScript (iOS/Android); web uses startWebDevProcess.
    const { command, args } = nativescriptDevRun(platform === "android" ? "android" : "ios", handle);
    this.devProcs().start({
      key: devKey(p.app.id, platform),
      command,
      args,
      cwd,
      // `ns run android` shells out to Gradle, which needs ANDROID_HOME just as
      // much as the plan-driven builds do.
      env: platform === "android" ? androidBuildEnv(appEnv) : appEnv,
      onLog: (line) => {
        this.appendLog(dev, "build", `[livesync] ${line}`);
        this.noteProgress(p);
      },
    });
  }

  /** Error message when the app's livesync process has died, else null. */
  private devProcessDead(appId: string, platform: Platform): string | null {
    const key = devKey(appId, platform);
    if (this.devProcs().isAlive(key)) return null;
    return `livesync process exited (code ${this.devProcs().exitCode(key) ?? "?"})`;
  }

  // --- web preview pipeline (device-less; a long-lived dev server) -------------

  /**
   * A web preview: no simulator. Install deps (guarded, in place), start the
   * dev server as a long-lived process on an allocated loopback port, and mark
   * ready once it answers on its base path. `restart` re-runs deps + respawns
   * the dev server on the same port (the reused viewer URL stays valid).
   */
  private async orchestrateWebGroup(p: LivePreview, dev: LiveDevice, restart = false): Promise<void> {
    try {
      dev.record.error = undefined;
      // "failed" is sticky in setPhase, so a Rebuild of a failed web preview has
      // to clear it here — otherwise every phase below is a silent no-op and the
      // device reads as failed forever (and stops being touched, so the idle
      // sweep eventually kills a dev server that came back up fine).
      dev.record.phase = "pending";
      this.setPhase(p, dev, "preparing", restart ? "restarting the dev server" : "starting the dev server");
      const sourceDir = await this.prepareSource(p); // local, in place — never wiped
      const appEnv = this.appEnv(p.app);

      this.setPhase(p, dev, "building", restart ? "reinstalling dependencies" : "installing dependencies");
      await this.runBuildPlan(p, dev, "web", "", sourceDir, appEnv, true);

      const port = dev.record.webPort ?? this.allocWebPort();
      dev.record.webPort = port;
      this.setPhase(p, dev, "launching", "starting the dev server");
      this.startWebDevProcess(p, dev, port, sourceDir, appEnv);

      this.setPhase(p, dev, "installing-app", "waiting for the dev server");
      await this.attachWebAndReady(p, dev, port);
    } catch (e) {
      this.failDevice(p, dev, e);
    }
  }

  private startWebDevProcess(
    p: LivePreview,
    dev: LiveDevice,
    port: number,
    cwd: string,
    appEnv: Record<string, string>,
  ): void {
    const devScript = p.app.devScript ?? "dev";
    // Subdomain-hosted frameworks run at root (no --base, no checkout edit);
    // Vite runs path-based with --base set to the share path.
    const { command, args } = this.isSubdomainWeb(p)
      ? webRootDevRun(p.record.webFramework as WebFramework, devScript, port)
      : webDevRun(devScript, `${this.webBase(p.record.shareId)}/`, port);
    this.devProcs().start({
      key: devKey(p.app.id, "web"),
      command,
      args,
      cwd,
      env: appEnv,
      onLog: (line) => {
        this.appendLog(dev, "build", `[web] ${line}`);
        this.noteProgress(p);
      },
    });
  }

  /** Attach the web stream and gate ready on the dev server actually answering. */
  private async attachWebAndReady(p: LivePreview, dev: LiveDevice, port: number): Promise<void> {
    let stream = p.attached.get(dev.record.deviceId);
    if (!stream) {
      // Subdomain hosting serves at root → empty base; path hosting serves under /s/<id>/web.
      const basePath = this.isSubdomainWeb(p) ? "" : this.webBase(p.record.shareId);
      stream = await this.d.streaming.attach({ platform: "web", udid: "", port, basePath });
      p.attached.set(dev.record.deviceId, stream);
    }
    const deadline = this.d.now!() + WEB_READY_TIMEOUT_MS;
    while (this.d.now!() < deadline) {
      const dead = this.devProcessDead(p.app.id, "web");
      if (dead)
        throw new PreviewError(
          dead.replace("livesync", "dev-server"),
          "check the build logs for the dev-server error, then restart the preview",
        );
      if (await stream.waitForFirstFrame(2000)) {
        this.setPhase(p, dev, "ready", undefined);
        return;
      }
    }
    throw new PreviewError(
      "the web dev server did not start responding in time",
      "check the build logs (a failed dev command or a wrong dev script), then restart the preview",
    );
  }

  /** Locate the just-built product to install to other devices: iOS `.app`, Android `.apk`. */
  private async locateBuiltProduct(platform: Platform, handle: string, bundleId: string, worktreePath: string): Promise<string> {
    if (platform === "android") {
      const apk = await this.android().findApk(worktreePath);
      if (!apk) throw new PreviewError("could not locate the built APK to install to other devices");
      return apk;
    }
    const built = await this.d.simctl.appContainer(handle, bundleId);
    if (!built) throw new PreviewError("could not locate the built app to install to other devices");
    return built;
  }

  private async installProduct(platform: Platform, handle: string, productPath: string): Promise<void> {
    if (platform === "android") await this.android().installApk(handle, productPath);
    else await this.d.simctl.install(handle, productPath);
  }

  private async runBuildPlan(
    p: LivePreview,
    dev: LiveDevice,
    platform: Platform,
    udid: string,
    worktreePath: string,
    appEnv: Record<string, string>,
    local = false,
  ): Promise<void> {
    // Gradle finds the SDK through ANDROID_HOME (or sdk.dir in a local.properties
    // deckhand must not write into the developer's checkout) — never through PATH.
    // A LaunchAgent inherits no shell env, so without this every Android build dies
    // at "SDK location not found" even with platform-tools on PATH.
    const env = platform === "android" ? androidBuildEnv(appEnv) : appEnv;
    const plan = buildPlan({ type: p.app.type, platform, udid, worktreePath, appEnv: env, local });
    for (const step of plan) {
      const res = await this.d.runStep!(step, {
        signal: dev.abort.signal,
        onLog: (line) => {
          this.appendLog(dev, "build", `[${step.name}] ${line}`);
          this.noteProgress(p);
          // Live build sub-step for the viewer: the phase headline alone can't be
          // told apart from a hang. In-memory only — the viewer reads the live
          // record, and persisting per log line would hammer state.json.
          const sub = buildStepDetail(line);
          if (sub && dev.record.phase === "building") dev.record.step = sub;
        },
      });
      if (res.code !== 0 && !step.optional) {
        // `build step "build" failed` is true and useless: the agent gets a dead end and the
        // viewer shows one line with no way to act on it. The cause is always in the log we
        // just captured, so lift it into the error itself.
        const cause = buildFailureCause(dev.logs.build);
        throw new PreviewError(
          `build step "${step.name}" failed${res.timedOut ? " (idle timeout)" : ""}${res.aborted ? " (aborted)" : ""}` +
            (cause ? ` — ${cause}` : ""),
        );
      }
    }
  }

  private async attachAndReady(p: LivePreview, dev: LiveDevice, platform: Platform, handle: string): Promise<void> {
    // A restarted preview keeps its stream: it captures the device's screen,
    // which survives app reinstalls — no reason to detach and reattach. But
    // only after verifying the helper still answers: a kept record can point at
    // a dead process (helper crash, external kill, adoption across a server
    // restart), and trusting it blindly declared "ready" panes whose bridge
    // then failed silently forever.
    const kept = p.attached.get(dev.record.deviceId);
    if (kept) {
      const alive = await kept.waitForFirstFrame(4000).catch(() => false);
      if (alive) {
        this.setPhase(p, dev, "ready", undefined);
        return;
      }
      this.streamLog(dev, `kept helper at ${kept.origin}${kept.helperBasePath} is not answering — re-attaching`);
      p.attached.delete(dev.record.deviceId);
      await kept.detach().catch(() => {});
    }
    const ref = platform === "android" ? { platform, udid: handle, serial: handle } : { platform, udid: handle };
    const t0 = this.d.now!();
    let stream: AttachedStream;
    try {
      stream = await this.d.streaming.attach(ref);
    } catch (e) {
      this.streamLog(dev, `attach FAILED after ${this.d.now!() - t0}ms: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
    this.streamLog(dev, `attached in ${this.d.now!() - t0}ms → ${stream.origin}${stream.helperBasePath}`);
    p.attached.set(dev.record.deviceId, stream);
    const t1 = this.d.now!();
    const framed = await stream.waitForFirstFrame();
    this.streamLog(dev, `first frame ${framed ? "ok" : "NOT SEEN"} after ${this.d.now!() - t1}ms`);
    if (!framed) {
      throw new PreviewError(
        "stream attached but produced no first frame",
        "read the device's `stream` log (logs tool, source=stream) — it records the helper URL and every probe",
      );
    }
    this.setPhase(p, dev, "ready", undefined);
  }

  private async verifyInstalled(
    platform: Platform,
    handle: string,
    bundleId: string,
    timeoutMs = 30_000,
    deadProbe?: () => string | null,
  ): Promise<void> {
    const deadline = this.d.now!() + timeoutMs;
    while (this.d.now!() < deadline) {
      const dead = deadProbe?.();
      if (dead) throw new PreviewError(dead, "check the build logs for the livesync error, then restart the preview");
      const installed =
        platform === "android"
          ? await this.android().packagePath(handle, bundleId)
          : await this.d.simctl.appContainer(handle, bundleId);
      if (installed) return;
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new PreviewError(
      `app ${bundleId} did not appear installed on the device`,
      "the build may have failed to install; check the build logTail",
    );
  }

  private async launch(
    p: LivePreview,
    dev: LiveDevice,
    handle: string,
    bundleId: string,
    worktreePath: string,
    appEnv: Record<string, string>,
  ): Promise<void> {
    if (dev.record.platform === "android") {
      if (usesMetroDeepLink(p.app.type)) {
        const slug = expoSlug(safeReadJson(join(worktreePath, "app.json")));
        if (!slug) throw new PreviewError("could not read the Expo slug from app.json");
        const metro = await this.d.metro.ensure(p.app.id, worktreePath, appEnv);
        await this.reverseMetroPorts(handle, metro.port);
        // Cold start, then name the server explicitly. Both halves are needed:
        // `expo run:android` already launched the app at the end of the build,
        // pointed at whatever answered 8081 then — and a dev client that is
        // ALREADY showing another project ignores the deep link rather than
        // switching to it, so the preview would keep serving someone else's JS
        // under the right app icon.
        await this.android().forceStop(handle, bundleId);
        await this.android().openUrl(handle, expoDevClientUrl(slug, `http://localhost:${metro.port}`));
        return;
      }
      // The build already launched the builder; (re)launch is idempotent and
      // covers install-many devices.
      await this.android().launch(handle, bundleId);
      return;
    }
    if (usesMetroDeepLink(p.app.type)) {
      const slug = expoSlug(safeReadJson(join(worktreePath, "app.json")));
      if (!slug) throw new PreviewError("could not read the Expo slug from app.json");
      const metro = await this.d.metro.ensure(p.app.id, worktreePath, appEnv);
      await this.d.simctl.openUrl(handle, expoDevClientUrl(slug, metro.manifestUrl));
    } else {
      await this.d.simctl.launch(handle, bundleId);
    }
  }

  // --- restart (same devices, same shareId, fresh code) -----------------------

  /**
   * Rebuild a preview in place: local → re-run livesync against the current
   * files; git → fetch the ref's new tip, reset the worktree, rebuild. Devices
   * stay booted and the shareId (and so the URL) is unchanged. Returns
   * immediately like startPreview; poll getStatus until ready.
   */
  restartPreview(previewId: string): StartPreviewResult {
    const p = this.previews.get(previewId);
    if (!p) throw new PreviewError(`no active preview "${previewId}"`);
    if (p.record.phase !== "ready" && p.record.phase !== "failed") {
      throw new PreviewError(
        `preview ${previewId} is ${p.record.phase}`,
        "wait for the current build to finish (poll preview_status), then restart",
      );
    }
    p.record.phase = "running";
    p.record.updatedAt = this.iso();
    this.persist();
    this.d.audit.record({ actor: "engine", tool: "restart_preview", args: { preview: previewId }, result: "ok" });
    void this.orchestrateRestart(p).catch(() => {
      /* per-device errors are captured onto the device records */
    });
    return this.resultFor(p, false);
  }

  /** Restart the live preview behind a share (the viewer's refresh button; local only). */
  restartByShareId(shareId: string): StartPreviewResult {
    for (const p of this.previews.values()) {
      if (p.record.shareId !== shareId) continue;
      if (p.record.source !== "local") {
        throw new PreviewError("only local (dev-mode) previews can be restarted from the viewer");
      }
      return this.restartPreview(p.record.previewId);
    }
    throw new PreviewError(`no active preview for share "${shareId}"`);
  }

  private async orchestrateRestart(p: LivePreview): Promise<void> {
    let sourceDir = p.sourceDir;
    if (p.record.source === "git") {
      try {
        const wt = await this.d.worktrees.updateWorktree(p.app, p.record.previewId, p.spec!);
        sourceDir = wt.path;
      } catch (e) {
        for (const dev of p.devices) this.failDevice(p, dev, e);
        return;
      }
    }
    if (!sourceDir) {
      for (const dev of p.devices) this.failDevice(p, dev, new PreviewError("preview has no prepared source dir"));
      return;
    }
    const dir = sourceDir;

    const groups = this.platformGroups(p);
    await Promise.all(
      [...groups.values()].map((group) => {
        // Web restart: re-run deps + respawn the dev server on the same port.
        if (group[0]!.record.platform === "web") return this.orchestrateWebGroup(p, group[0]!, true);
        // Clear terminal phases so failDevice/setPhase transitions apply cleanly.
        for (const dev of group) {
          dev.record.error = undefined;
          dev.record.phase = "pending"; // clear the terminal "failed" so setPhase applies again
          this.setPhase(p, dev, "preparing", "restarting");
        }
        const handleOf = async (i: number): Promise<string> => {
          const h = this.handle(group[i]!);
          if (!h) {
            throw new PreviewError(
              "device was never booted",
              "stop this preview and start a new one to boot fresh devices",
            );
          }
          return h;
        };
        return this.buildGroup(p, group, handleOf, dir);
      }),
    );
  }

  // --- status / logs ---------------------------------------------------------

  /**
   * `touch: false` reads a preview without claiming it is in use — `list()`
   * enumerates every preview, so touching from there would have let one agent's
   * status poll reset the idle clock on all the others.
   */
  getStatus(previewId: string, opts: { touch?: boolean } = {}): PreviewStatus | null {
    const p = this.previews.get(previewId);
    if (!p) return null;
    if (opts.touch !== false) this.markActive(p); // an agent polling this preview counts as use
    const ready = p.record.phase === "ready";
    return {
      previewId,
      phase: p.record.phase,
      ready,
      url: ready ? this.previewUrl(p) : null,
      source: p.record.source,
      devices: p.devices.map((dv) => ({
        deviceId: dv.record.deviceId,
        label: dv.record.label,
        phase: dv.record.phase,
        detail: dv.record.detail,
        step: dv.record.step,
        error: dv.record.error,
        logTail: dv.record.phase === "failed" ? dv.logs.build.slice(-20).join("\n") : undefined,
      })),
    };
  }

  logs(previewId: string, deviceId: string | undefined, source: LogSource, tailLines = 200): string | null {
    const p = this.active(previewId);
    if (!p) return null;
    const dev = deviceId ? p.devices.find((d) => d.record.deviceId === deviceId) : p.devices[0];
    if (!dev) return null;
    return dev.logs[source].slice(-tailLines).join("\n");
  }

  /** The simulator UDID for a device (for the screenshot/ui tools). */
  udidFor(previewId: string, deviceId: string): string | null {
    const p = this.active(previewId);
    const dev = p?.devices.find((d) => d.record.deviceId === deviceId);
    return dev?.record.udid ?? null;
  }

  /** The app id backing a preview (for owner-scope checks). */
  appIdFor(previewId: string): string | null {
    return this.previews.get(previewId)?.record.appId ?? null;
  }

  /**
   * The app config a preview booted from. A reference pane's app is synthetic (not
   * in apps.yaml) but still carries the real `repo`, which is what owner-scoping a
   * reference has to check against.
   */
  appFor(previewId: string): App | null {
    return this.previews.get(previewId)?.app ?? null;
  }

  /**
   * Whether a preview is a compare/migration reference pane — deliberately
   * public, and deliberately not backed by an app in apps.yaml. The only case
   * where "no app found" is legitimate rather than a reason to deny.
   */
  isReference(previewId: string): boolean {
    return this.previews.get(previewId)?.record.reference === true;
  }

  /** The live (non-terminal) preview for an app, if any — newest first. */
  private livePreviewForApp(appId: string): LivePreview | null {
    let best: LivePreview | null = null;
    for (const p of this.previews.values()) {
      const ph = p.record.phase;
      if (p.record.appId !== appId || ph === "stopped" || ph === "failed") continue;
      if (!best || p.record.createdAt > best.record.createdAt) best = p;
    }
    return best;
  }

  previewIdForApp(appId: string): string | null {
    return this.livePreviewForApp(appId)?.record.previewId ?? null;
  }

  /** The live (non-terminal) preview carrying a given shareId, if any. */
  private liveByShareId(shareId: string): LivePreview | null {
    for (const p of this.previews.values()) {
      const ph = p.record.phase;
      if (p.record.shareId === shareId && ph !== "stopped" && ph !== "failed") return p;
    }
    return null;
  }

  /** Enumerate available iOS runtimes/models, Android API levels, and current capacity. */
  async listDevices(): Promise<{
    ios: { runtimes: { version: string; name: string }[]; models: string[] };
    android: { apiLevels: number[] };
    capacity: { inUse: number; max: number };
  }> {
    const [runtimes, deviceTypes] = await Promise.all([this.d.simctl.listRuntimes(), this.d.simctl.listDeviceTypes()]);
    let apiLevels: number[] = [];
    try {
      apiLevels = [...new Set((await this.android().listSystemImages()).map((i) => i.api))].sort((a, b) => b - a);
    } catch {
      apiLevels = []; // Android SDK not installed / not configured
    }
    const inUse = this.devicesInUse();
    return {
      ios: {
        runtimes: runtimes.filter((r) => r.isAvailable).map((r) => ({ version: r.version, name: r.name })),
        models: deviceTypes.map((d) => d.name),
      },
      android: { apiLevels },
      capacity: { inUse, max: this.d.config.limits.maxTotalDevices },
    };
  }

  /**
   * Inspect a repo at its default branch to detect app type + bundle id, without
   * a checkout. Used by add_app before registering. Propagates credential/ref
   * errors so the caller can turn them into onboarding steps.
   */
  async inspectAppRepo(app: App, spec: RefSpec): Promise<{ type: AppType | null; bundleId: string | null }> {
    const insp = await this.d.worktrees.inspect(app, spec);
    return detectFromRepo(insp.read, insp.hasEntry);
  }

  /** The repo's default branch (for add_app), or null if undeterminable. */
  detectDefaultBranch(app: App): Promise<string | null> {
    return this.d.worktrees.defaultBranch(app);
  }

  /** PNG screenshot of a device (for the screenshot tool). */
  async screenshot(previewId: string, deviceId: string): Promise<Buffer> {
    const p = this.active(previewId);
    const dev = p?.devices.find((d) => d.record.deviceId === deviceId);
    if (!dev) throw new PreviewError(`device ${deviceId} not found in preview ${previewId}`);
    if (dev.record.platform === "web") {
      throw new PreviewError(
        "screenshots aren't supported for web previews",
        "open the share link in a browser to see the web app (deckhand has no headless browser)",
      );
    }
    if (dev.record.platform === "android") {
      if (!dev.record.serial) throw new PreviewError(`device ${deviceId} has no emulator yet`);
      return this.android().screenshotPng(dev.record.serial);
    }
    if (!dev.record.udid) throw new PreviewError(`device ${deviceId} has no simulator yet`);
    return this.d.simctl.screenshotPng(dev.record.udid);
  }

  attachedFor(previewId: string, deviceId: string): AttachedStream | null {
    return this.active(previewId)?.attached.get(deviceId) ?? null;
  }

  // --- agent-driven testing: describe (eyes) + ui (hands), via SimDeck --------

  private simdeckControl(): SimDeckControl {
    if (!this.d.simdeck) {
      this.d.simdeck = new SimDeckControl({
        bin: this.d.config.simdeck?.bin,
        port: this.d.config.simdeck?.port,
        autostart: this.d.config.simdeck?.autostart,
      });
    }
    return this.d.simdeck;
  }

  /** Resolve a device to the way SimDeck addresses it: iOS UDID, or `android:<avd>`. */
  private simdeckTarget(previewId: string, deviceId: string): SimDeckTarget {
    const p = this.active(previewId);
    const dev = p?.devices.find((d) => d.record.deviceId === deviceId);
    if (!dev) throw new PreviewError(`device ${deviceId} not found in preview ${previewId}`);
    if (dev.record.platform === "web") {
      throw new PreviewError("describe/ui aren't supported for web previews", "open the share link in a browser to drive the web app");
    }
    if (dev.record.platform === "android") {
      // record.udid holds the AVD name for Android; SimDeck resolves the adb serial from it.
      if (!dev.record.udid) throw new PreviewError(`device ${deviceId} has no emulator yet`);
      return { platform: "android", udid: `android:${dev.record.udid}` };
    }
    if (!dev.record.udid) throw new PreviewError(`device ${deviceId} has no simulator yet`);
    return { platform: "ios", udid: dev.record.udid };
  }

  /** Accessibility tree for a device (SimDeck describe) — the agent's "eyes". */
  describe(previewId: string, deviceId: string, opts: DescribeOptions = {}): Promise<unknown> {
    return this.simdeckControl().describe(this.simdeckTarget(previewId, deviceId), opts);
  }

  /** Drive one UI action on a device (SimDeck action) — the agent's "hands". */
  ui(previewId: string, deviceId: string, action: UiAction): Promise<unknown> {
    return this.simdeckControl().action(this.simdeckTarget(previewId, deviceId), action);
  }

  // --- agent-driven test runs (ephemeral; rendered live in the viewer) --------

  /**
   * Should this preview's next driving action remind the agent to open a run?
   *
   * A run is not only for formal testing — it is the label on whatever the agent is doing to
   * the app right now. Any driving with no run open shows the user a cursor moving over a
   * silent app: they can see something is happening but not what, or why, or whether it
   * worked. So the reminder fires from the first action, whether the agent is verifying a
   * change, reproducing a bug or just having a look — the title is what tells them which.
   *
   * Fires once per stretch (a hint repeated on every tap is one the model learns to skip),
   * stays quiet while a run is live, and re-arms when one opens so the next untracked stretch
   * is caught too.
   *
   * The bookkeeping lives here rather than in the MCP layer because that layer is stateless:
   * `createMcpRouter` builds a fresh `McpServer` and re-runs `registerTools` on every POST, so
   * a closure-local flag there would reset between calls and nudge on every single action.
   */
  shouldNudgeTestRun(previewId: string): boolean {
    const p = this.previews.get(previewId);
    if (!p || p.testRun?.status === "running") return false;
    if (p.testRunNudged) return false;
    p.testRunNudged = true;
    return true;
  }

  /**
   * Step tallies for the current run, or null if there is none. The MCP layer reports these
   * back on every update so the agent can see what it has left unmarked, and uses them to
   * catch a closing verdict that contradicts the steps.
   */
  testRunCounts(previewId: string): { total: number; passed: number; failed: number; pending: number; running: number } | null {
    const run = this.previews.get(previewId)?.testRun;
    if (!run) return null;
    const by = (s: TestStepStatus): number => run.steps.filter((x) => x.status === s).length;
    return { total: run.steps.length, passed: by("passed"), failed: by("failed"), pending: by("pending"), running: by("running") };
  }

  /**
   * Drop the current run so the viewer goes back to showing no run at all.
   *
   * A finished run otherwise lingers for the life of the preview — which is right while it is
   * the record of what just happened, and wrong once it is stale or was recorded badly. There
   * was no way to take it back: `startTestRun` only replaces one run with another, so the only
   * escape was to leave a misleading verdict on screen.
   */
  clearTestRun(previewId: string): boolean {
    const p = this.previews.get(previewId);
    if (!p?.testRun) return false;
    p.testRun = undefined;
    p.testRunNudged = false;
    return true;
  }

  /** Begin a test run on a preview (replacing any prior one). Steps start pending. */
  startTestRun(previewId: string, title: string, steps: string[] = []): { runId: string } {
    const p = this.active(previewId);
    if (!p) throw new PreviewError(`no active preview "${previewId}"`);
    const id = this.d.genPreviewId!();
    p.testRun = {
      id,
      title,
      status: "running",
      steps: steps.map((label, i) => ({ n: i + 1, label, status: "pending" as const })),
      startedAt: this.iso(),
    };
    // Re-arm the reminder: the agent did the right thing here, so the NEXT stretch of driving
    // with no run open is a fresh lapse and deserves to be caught. Without this the nudge fires
    // at most once per preview, and everything after the first run goes unreported in silence.
    p.testRunNudged = false;
    return { runId: id };
  }

  /** Patch a step (by n or label; appends if new) and/or the overall run status. */
  updateTestRun(
    previewId: string,
    patch: { step?: { n?: number; label?: string; status: TestStepStatus; detail?: string }; runStatus?: TestRunStatus },
  ): void {
    const run = this.active(previewId)?.testRun;
    if (!run) throw new PreviewError(`no test run for preview "${previewId}"`, "call start_test_run first");
    if (patch.step) {
      const s = patch.step;
      let step =
        s.n != null ? run.steps.find((x) => x.n === s.n) : s.label != null ? run.steps.find((x) => x.label === s.label) : undefined;
      if (!step) {
        // Agents can add steps as they discover them mid-flow.
        step = { n: run.steps.length + 1, label: s.label ?? `step ${run.steps.length + 1}`, status: s.status };
        run.steps.push(step);
      }
      step.status = s.status;
      if (s.label != null) step.label = s.label;
      if (s.detail != null) step.detail = s.detail;
    }
    if (patch.runStatus) run.status = patch.runStatus;
  }

  /** Conclude a test run with a verdict + one-line summary. */
  finishTestRun(previewId: string, status: TestRunStatus, summary?: string): void {
    const run = this.active(previewId)?.testRun;
    if (!run) throw new PreviewError(`no test run for preview "${previewId}"`, "call start_test_run first");
    run.status = status;
    if (summary != null) run.summary = summary;
    run.finishedAt = this.iso();
    // A finished run must not leave a step spinning: a step still "running" when
    // the run ends never got its verdict, so settle it to match the run — failed
    // run ⇒ failed step, otherwise passed. Pending (not-yet-reached) steps are
    // left as-is; they render calmly, not as a spinner.
    const settled: TestStepStatus = status === "failed" ? "failed" : "passed";
    for (const step of run.steps) {
      if (step.status === "running") step.status = settled;
    }
  }

  // --- compare sessions (ephemeral; pairing + parity checklist for the viewer) -

  private static countCompare(items: CompareItem[]): CompareCounts {
    const c: CompareCounts = { pending: 0, doing: 0, done: 0, adjusted: 0, regression: 0 };
    for (const i of items) c[i.verdict]++;
    return c;
  }

  /** Link a working preview to its reference panes + seed the item checklist (replacing any prior). */
  startCompare(
    previewId: string,
    references: CompareReference[],
    items: string[] = [],
  ): CompareCounts {
    const p = this.active(previewId);
    if (!p) throw new PreviewError(`no active preview "${previewId}"`);
    const seen = new Set<string>();
    const uniq = items.map((s) => s.trim()).filter((s) => s.length > 0 && !seen.has(s) && (seen.add(s), true));
    // De-dupe by shareId: the same reference named twice is one pane, and a
    // duplicate would otherwise be torn down twice and unlocked twice.
    const byShare = new Set<string>();
    const refs = references.filter((r) => !byShare.has(r.shareId) && (byShare.add(r.shareId), true));
    p.compare = {
      references: refs,
      items: uniq.map((name) => ({ name, verdict: "pending" as const })),
    };
    return PreviewEngine.countCompare(p.compare.items);
  }

  /** Set one item's verdict (by exact name; appends if new). Returns the new counts. */
  setCompareItem(previewId: string, patch: { item: string; verdict: CompareVerdict; note?: string }): CompareCounts {
    const c = this.active(previewId)?.compare;
    if (!c) throw new PreviewError(`no parity checklist for preview "${previewId}"`, "seed one with start_preview's `items`");
    let item = c.items.find((x) => x.name === patch.item);
    if (!item) {
      item = { name: patch.item, verdict: patch.verdict };
      c.items.push(item);
    }
    item.verdict = patch.verdict;
    if (patch.note != null) item.note = patch.note || undefined;
    return PreviewEngine.countCompare(c.items);
  }

  /** The current compare session (reference panes + items + counts), or null. */
  compareStatus(
    previewId: string,
  ): { references: CompareReference[]; items: CompareItem[]; counts: CompareCounts } | null {
    const c = this.active(previewId)?.compare;
    if (!c) return null;
    return {
      references: c.references,
      items: c.items,
      counts: PreviewEngine.countCompare(c.items),
    };
  }

  // --- reaping / idle sweep --------------------------------------------------

  /**
   * Clear out whatever the previous process left behind. Deckhand's devices do
   * not survive its own exit — a crash or a plain `serve` restart orphans every
   * booted simulator, emulator and helper it owned, and nothing ever collected
   * them. Called once, before the server starts listening.
   */
  async reapOrphans(): Promise<{ sims: number; avds: number; previews: number }> {
    const stale = this.d.store.load().previews.filter((p) => p.phase !== "stopped");
    // Spare whatever is already live. The map is normally empty at boot, but
    // this runs *after* the port is bound (see server.ts) — so an agent's
    // start_preview can already be mid-`simctl create`, and sweeping "everything
    // deckhand-named" would delete the simulator it is booting right now.
    // Guard the construction too: `new AndroidManager()` resolves tool env and
    // can throw, and that must never cost us the stale-preview cleanup below.
    const report = await (async () => {
      try {
        const reaper = this.d.reaper ?? new Reaper({ simctl: this.d.simctl, android: this.android() });
        return await reaper.reap(this.liveDeviceHandles());
      } catch {
        return { sims: [], avds: [], keptPooled: [] };
      }
    })();
    if (stale.length) this.persist(); // drops the stale previews, keeps shareIds + pins

    // Disk: checkouts are keyed by app+ref and outlive the preview that made
    // them (that's what keeps the next build warm), so nothing else reclaims
    // them. Same for Xcode's DerivedData, which lives outside ~/.deckhand
    // entirely. The checkout prune spares anything used recently as well as
    // anything live — at boot the live set is empty, so an ungraced prune would
    // delete exactly the warm checkouts it exists to preserve. The janitor
    // repeats it (see sweepIdle); a server that runs for weeks must not need a
    // restart to reclaim disk.
    const { worktrees, derived } = await this.pruneDisk();

    if (stale.length || report.sims.length || report.avds.length || worktrees.length || derived.length) {
      this.d.audit.record({
        actor: "engine",
        tool: "reap_orphans",
        args: {
          previews: stale.length,
          sims: report.sims.length,
          avds: report.avds.length,
          worktrees: worktrees.length,
          derivedData: derived.length,
        },
        result: "ok",
      });
    }
    return { sims: report.sims.length, avds: report.avds.length, previews: stale.length };
  }

  /**
   * Every device handle a live preview holds or is about to hold. Pool leases
   * are included by name because a device between `simctl create` and the
   * engine recording its UDID has a name but no handle yet.
   */
  private liveDeviceHandles(): { udids: string[]; avds: string[]; names: string[] } {
    const udids: string[] = [];
    const avds: string[] = [];
    // Pool leases cover the pooled config; `deviceName` covers both, including
    // the non-pooled `deckhand-<previewId>-<n>` names that no lease ever holds.
    const names = new Set<string>(this.leased);
    for (const p of this.previews.values()) {
      for (const dev of p.devices) {
        if (dev.deviceName) names.add(dev.deviceName);
        if (!dev.record.udid) continue;
        // record.udid holds the AVD name on Android, the simulator UDID on iOS.
        (dev.record.platform === "android" ? avds : udids).push(dev.record.udid);
      }
    }
    return { udids, avds, names: [...names] };
  }

  /** Note that someone is actually watching this preview (resets the idle clock). */
  private markActive(p: LivePreview): void {
    p.lastActivityAt = this.d.now!();
  }

  /**
   * Look up a preview and count the lookup as activity. An agent driving a
   * preview purely through screenshot/describe/ui/logs — no browser tab, no
   * status poll — is using it just as much as a viewer is, and used to get its
   * simulators deleted out from under it mid-run by the idle sweep.
   */
  private active(previewId: string): LivePreview | undefined {
    const p = this.previews.get(previewId);
    if (p) this.markActive(p);
    return p;
  }

  /**
   * Stop previews nobody is using: idle ones (no viewer traffic for
   * `limits.idleMinutes`) and failed ones past their Rebuild grace window.
   * Returns the previewIds stopped.
   */
  async sweepIdle(): Promise<string[]> {
    const { idleMinutes, failedGraceMinutes, stuckMinutes } = this.d.config.limits;
    const now = this.d.now!();
    const doomed: { id: string; reason: string }[] = [];
    for (const [id, p] of this.previews) {
      const ph = p.record.phase;
      if (ph === "stopped" || ph === "stopping") continue;
      const sinceProgress = now - Date.parse(p.record.updatedAt);
      if (ph === "failed") {
        if (failedGraceMinutes > 0 && sinceProgress > failedGraceMinutes * 60_000) doomed.push({ id, reason: "failed" });
        continue;
      }
      // A build in flight is never idle — nobody watches a preview that isn't up
      // yet — but one that has stopped making progress entirely is wedged, and
      // holds its devices until something collects it. "Progress" means build
      // output, not just phase changes: the phases are coarse enough that a
      // cold pod/gradle build stays in one of them for hours.
      if (ph !== "ready") {
        if (stuckMinutes > 0 && now - p.lastProgressAt > stuckMinutes * 60_000) doomed.push({ id, reason: "stuck" });
        continue;
      }
      if (idleMinutes > 0 && now - p.lastActivityAt > idleMinutes * 60_000) doomed.push({ id, reason: "idle" });
    }
    for (const { id, reason } of doomed) {
      this.d.audit.record({ actor: "engine", tool: "auto_stop", args: { preview: id, reason }, result: "ok" });
      await this.stopPreview(id).catch(() => {});
    }
    await this.reassertAndroidReverse();
    // Teardown keeps the checkout (it is the next build's warm cache), so this
    // sweep is the only thing that ever gives that disk back on a server that
    // isn't restarted. It only touches checkouts idle past the grace window.
    await this.pruneDisk();
    return doomed.map((d) => d.id);
  }

  /**
   * Re-take `tcp:8081` on every live Android device. Setting it once at launch
   * is not enough: `expo start` in any unrelated project on this machine
   * re-points 8081 on EVERY attached device, so a dev server started after a
   * preview is up silently takes over its bundle — the app keeps running, it
   * just becomes someone else's app. Cheap (one adb call per device) and
   * idempotent, so the janitor can simply re-assert every pass.
   */
  private async reassertAndroidReverse(): Promise<void> {
    for (const p of this.previews.values()) {
      if (p.record.phase !== "ready" || !usesMetroDeepLink(p.app.type)) continue;
      const port = this.d.metro.portForApp(p.app.id);
      if (!port) continue;
      for (const dev of p.devices.values()) {
        if (dev.record.platform !== "android" || !dev.androidPort) continue;
        await this.reverseMetroPorts(serialForPort(dev.androidPort), port).catch(() => {});
      }
    }
  }

  /**
   * Both ports a dev client can ask for. The app's own port is the one the
   * served manifest advertises, so the client dials `127.0.0.1:<port>` on the
   * DEVICE and finds nothing unless it is forwarded — the symptom is a dev
   * client stuck on "Unable to load script" while Metro is demonstrably healthy
   * on the host. 8081 is the debug build's compiled-in fallback, and pointing it
   * here too is what stops another project's `expo start` from owning it.
   */
  private async reverseMetroPorts(serial: string, metroPort: number): Promise<void> {
    if (metroPort !== METRO_PORT) await this.android().reversePort(serial, metroPort, metroPort);
    await this.android().reversePort(serial, METRO_PORT, metroPort);
  }

  /**
   * Give back the disk that teardown deliberately keeps: checkouts that are
   * neither live nor recently used, and the DerivedData trees of the checkouts
   * that just went away.
   *
   * Both halves run together, in this order, on purpose. A DerivedData tree is
   * only reclaimable once its project path is gone, so pruning it before the
   * checkout would find nothing to do; and running the pair only at boot (as it
   * used to) meant a LaunchAgent server up for a month never reclaimed a byte —
   * the 22 GB of abandoned DerivedData that `derivedData.ts` exists for would
   * simply accumulate until someone restarted the process.
   */
  private async pruneDisk(): Promise<{ worktrees: string[]; derived: string[] }> {
    const liveKeys = new Set<string>();
    for (const p of this.previews.values()) {
      if (p.record.source === "git" && p.spec) liveKeys.add(worktreeKey(p.app.id, p.spec));
    }
    // Checkout dirs of everything still running: a build in flight can have its
    // workspace missing for a moment (ns prepare / expo prebuild regenerate
    // `platforms/ios` in place), which otherwise reads as an orphan. Collected
    // AFTER the worktree pass, not before: that pass can wait on a checkout
    // lock, and a preview started while it waited would be missing from a
    // snapshot taken earlier — with its DerivedData deleted under the build.
    const worktrees = (await this.d.worktrees.pruneWorktrees?.(liveKeys).catch(() => [])) ?? [];
    const livePaths = new Set<string>();
    for (const p of this.previews.values()) {
      for (const dir of [p.sourceDir, p.record.worktreePath, p.app.path]) if (dir) livePaths.add(dir);
    }
    const derived = await pruneDerivedData({ livePaths: [...livePaths] }).catch(() => [] as string[]);
    return { worktrees, derived };
  }

  /**
   * Run `sweepIdle` on a timer. The handle is unref'd, so it never holds the
   * process open.
   *
   * Ticks never overlap: the sweep reclaims disk now (a `plutil` per DerivedData
   * tree, then multi-GB deletes) and can also wait on a checkout lock, so it is
   * no longer guaranteed to finish inside one interval. Two passes over the same
   * directories would spawn the work twice and race their own deletes.
   */
  startJanitor(everyMs = 60_000): void {
    if (this.janitor) return;
    let sweeping = false;
    this.janitor = setInterval(() => {
      if (sweeping) return;
      sweeping = true;
      void this.sweepIdle()
        .catch(() => {})
        .finally(() => {
          sweeping = false;
        });
    }, everyMs);
    this.janitor.unref?.();
  }

  stopJanitor(): void {
    if (this.janitor) clearInterval(this.janitor);
    this.janitor = undefined;
  }

  // --- stop ------------------------------------------------------------------

  /**
   * Devices currently occupying the machine — counted from what is actually
   * booted, not from what was requested. A `failed` preview's devices count
   * while they still hold a handle (they stay booted for the Rebuild grace
   * window); a preview that failed during clone or build never booted anything
   * and must not consume capacity. Teardowns in flight count too: they are
   * asynchronous, and dropping them from the tally let a new preview start on
   * top of simulators that were still shutting down.
   */
  private devicesInUse(): number {
    let n = this.tearingDown;
    for (const p of this.previews.values()) {
      if (p.record.phase === "stopped") continue;
      for (const dev of p.devices) {
        const booted = Boolean(dev.record.udid ?? dev.record.serial ?? dev.record.webPort);
        // A device still working toward ready has a slot reserved for it.
        if (booted || (dev.record.phase !== "failed" && p.record.phase !== "failed")) n++;
      }
    }
    return n;
  }

  /**
   * Release every device of a preview: detach the stream, then shut down and
   * delete the simulator/AVD deckhand created for it. Idempotent — the handles
   * are cleared, so a second call (stop after an idle sweep) is a no-op.
   */
  private async teardownDevices(p: LivePreview, onReleased?: () => void): Promise<void> {
    for (const dev of p.devices) {
      const stream = p.attached.get(dev.record.deviceId);
      if (stream) await stream.detach().catch(() => {});
      p.attached.delete(dev.record.deviceId);
      if (dev.record.platform === "web") {
        if (dev.record.webPort) this.webPorts.delete(dev.record.webPort);
        dev.record.webPort = undefined;
        onReleased?.();
        continue; // no simulator/emulator to tear down; the dev process is stopped by the caller
      }
      // A pooled device is released, not destroyed: the next preview of the same
      // shape boots it again instead of paying for a create (and, on Android, a
      // fresh ~2 GB AVD image) every single time.
      const pooled = dev.poolName != null;
      if (dev.record.platform === "android") {
        if (dev.record.serial) {
          await this.android().shutdown(dev.record.serial).catch(() => {});
          this.androidPorts.delete(portForSerial(dev.record.serial));
        }
        // Reserved before the boot, so it must be freed even when no serial ever
        // came back (boot timeout, emulator crash).
        if (dev.androidPort != null) this.androidPorts.delete(dev.androidPort);
        if (dev.record.udid && !pooled) await this.android().deleteAvd(dev.record.udid).catch(() => {}); // udid holds the AVD name
      } else if (dev.record.udid) {
        await this.d.simctl.shutdown(dev.record.udid).catch(() => {});
        if (!pooled) await this.d.simctl.delete(dev.record.udid).catch(() => {});
      }
      if (dev.poolName) {
        this.leased.delete(dev.poolName);
        dev.poolName = undefined;
      }
      dev.record.udid = undefined;
      dev.record.serial = undefined;
      dev.androidPort = undefined;
      onReleased?.();
    }
    await this.trimPool();
  }

  /**
   * Keep the pool bounded. Idle pooled devices cost disk (an AVD image is
   * ~2 GB), so the pool never holds more devices than the machine is allowed to
   * run at once — `maxTotalDevices` across both platforms, leased ones
   * included. iOS is trimmed first: an erased simulator is cheap to recreate,
   * an AVD image is not.
   */
  private async trimPool(): Promise<void> {
    if (!this.pooling()) return;
    // Both lists are best-effort: a machine with no Xcode or no Android SDK
    // simply has no pool of that kind, and trimming must not fail teardown.
    const sims = (await safeList<SimDevice>(() => this.d.simctl.listDevices())).filter((d) =>
      d.name.startsWith(POOL_SIM_PREFIX),
    );
    const avds = (await safeList<string>(() => this.android().listAvds())).filter((n) => n.startsWith(POOL_AVD_PREFIX));
    // Leased devices belong to a live preview and are never trimmed; they still
    // occupy the budget, so a busy machine keeps no idle spares at all.
    let budget = this.d.config.limits.maxTotalDevices - this.leased.size;
    const keepAvds = Math.max(0, Math.min(budget, avds.filter((n) => !this.leased.has(n)).length));
    budget -= keepAvds;
    let simsKept = 0;
    for (const sim of sims) {
      if (this.leased.has(sim.name)) continue;
      if (simsKept < budget) {
        simsKept++;
        continue;
      }
      await this.d.simctl.delete(sim.udid).catch(() => {});
      this.poolTenants.delete(sim.name);
    }
    let avdsKept = 0;
    for (const avd of avds) {
      if (this.leased.has(avd)) continue;
      if (avdsKept < keepAvds) {
        avdsKept++;
        continue;
      }
      await this.android().deleteAvd(avd).catch(() => {});
      this.poolTenants.delete(avd);
    }
  }

  async stopPreview(previewId: string): Promise<boolean> {
    const p = this.previews.get(previewId);
    if (!p) return false;
    // A compare session owns its reference previews — tear them down too,
    // unless another live compare session is still pairing against one.
    const refPreviewIds = (p.compare?.references ?? []).map((r) => r.previewId).filter((id): id is string => !!id);
    p.record.phase = "stopping";
    this.persist();
    for (const dev of p.devices) dev.abort.abort();

    // Local previews: kill the livesync process(es). The source dir is the
    // developer's own working copy — it is NEVER touched on teardown.
    if (p.record.source === "local") {
      for (const platform of new Set(p.devices.map((d) => d.record.platform))) {
        this.d.devProcs?.stop(devKey(p.app.id, platform));
      }
    }

    await this.teardownDevices(p);
    if (p.record.source !== "local") {
      await this.d.worktrees.removeWorktree(p.app, previewId).catch(() => {});
    }

    p.record.phase = "stopped";
    p.record.updatedAt = this.iso();
    this.persist();
    this.previews.delete(previewId);
    this.stopMetroIfUnused(p.app.id);
    this.d.audit.record({ actor: "engine", tool: "stop_preview", args: { preview: previewId }, result: "ok" });

    // Cascade: stop each reference preview once no other live compare needs it.
    // Re-checked per id inside the loop because an earlier iteration may itself
    // have cascaded into a later one.
    for (const refPreviewId of refPreviewIds) {
      if (!this.previews.has(refPreviewId)) continue;
      const stillUsed = [...this.previews.values()].some((o) =>
        (o.compare?.references ?? []).some((r) => r.previewId === refPreviewId),
      );
      if (!stillUsed) await this.stopPreview(refPreviewId).catch(() => {});
    }
    return true;
  }

  /** Snapshot of all live previews (for list/limits). */
  list(): PreviewStatus[] {
    return [...this.previews.keys()].map((id) => this.getStatus(id, { touch: false })!).filter(Boolean);
  }
}

function safeReadJson(file: string): { expo?: { slug?: string }; slug?: string } | null {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** List helper that swallows both a missing tool (sync throw) and a failed call. */
async function safeList<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch {
    return [];
  }
}
