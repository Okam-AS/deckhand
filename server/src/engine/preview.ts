import { randomBytes, createHash } from "node:crypto";
import { existsSync } from "node:fs";
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
import { Simctl, selectSimulator, supportedBy, deviceLabel, type SimDevice } from "../devices/ios.ts";
import { AndroidManager, AVD_PREFIX, selectSystemImage, portForSerial, serialForPort } from "../devices/android.ts";
import { resolveAndroidEnv } from "../devices/toolEnv.ts";
import { AndroidPhones, InstallConflictError, classifyInstallFailure, isEmulatorSerial, usabilityBlocker, type RegisteredApp } from "../devices/androidPhone.ts";
import { loadPhoneHolds, type PhoneHolds } from "../devices/phoneHolds.ts";
import { Iphones } from "../devices/iphones.ts";
import { IphoneAppError, executableFromAppUrl, type IphoneApps } from "../devices/iphoneApps.ts";
import type { IphoneSyslog, SyslogLine } from "../devices/iphoneSyslog.ts";
import { IPHONE_MARKER_ENV } from "../devices/iproxy.ts";
import { WdaStartError } from "../devices/wdaRunner.ts";
import { Reaper, POOL_SIM_PREFIX, POOL_AVD_PREFIX } from "./reaper.ts";
import { METRO_MARKER_ENV } from "./metro.ts";
import { DEV_MARKER_ENV } from "./devProcess.ts";
import { BUILD_MARKER_ENV } from "./procs.ts";
import { MetroManager } from "./metro.ts";
import { buildPlan, usesMetroDeepLink, nativescriptDevRun, webDevRun, webRootDevRun, GENERAL_IDLE_MS, METRO_PORT } from "./recipes.ts";
import { runStep as defaultRunStep, buildPids, type RunResult } from "./procs.ts";
import type { CommandStep } from "./recipes.ts";
import {
  detectBundleIdFromDir,
  detectFromRepo,
  detectWebFrameworkFromDir,
  webHostingMode,
  expoSlug,
  expoDevClientUrl,
  resolveExpoConfigFromDir,
  type WebFramework,
} from "./detect.ts";
import { loadSecretsEnv } from "../secrets.ts";
import { readMigrationLedger } from "./migrationLedger.ts";
import { DevProcessManager } from "./devProcess.ts";
import type { AttachedStream, StreamingBackend } from "../streaming/backend.ts";
import { LIVE_DEVICE_ID, type LiveShareRegistry } from "../share/liveShares.ts";
import { SimDeckControl, type ControlBackend, type SimDeckTarget, type DescribeOptions, type UiAction } from "../testing/control.ts";
import { AdbControl } from "../testing/adbControl.ts";
import { IphoneControl } from "../testing/iphoneControl.ts";
import { ScreenBook } from "../testing/screen.ts";
import { createHash as hashOf } from "node:crypto";
import { createReadStream } from "node:fs";
import { easProjectIdFromDir } from "./detect.ts";
import { EasError, devClientUpdateUrl } from "../eas/client.ts";
import { easProfileKey, type EasPreviews, type EasSelection, type EasTarget, type PreparedBuild } from "../eas/source.ts";
import { vetIpa } from "../eas/artifact.ts";
import {
  EnvironmentError,
  androidExtras,
  combineReports,
  iosLaunchArgs,
  markerSeen,
  resolveEnvironment,
  type EnvironmentReport,
  type EnvironmentSource,
  type ResolvedEnvironment,
} from "./environment.ts";

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
/**
 * How many times to throw the streaming helper away and re-attach before
 * declaring a device dead. A helper that comes up but never produces a frame is
 * usually the HELPER — a cold sim under load, a recorder that lost its grip, a
 * daemon adopted from a previous process — and a fresh one normally works. One
 * attempt made a transient failure permanent for the life of the preview.
 */
const FIRST_FRAME_ATTEMPTS = 3;
/** How long after launch the app log is watched for an environment's marker. */
const ENV_MARKER_WAIT_MS = 90_000;

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = hashOf("sha256");
    createReadStream(path)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}
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
 * Longest caption `buildStepDetail` will emit. A budget picked against a phone-sized
 * frame, NOT a measured limit and NOT a precondition: nothing in `viewer/` reads this
 * number or holds a width to it, so a longer caption would wrap rather than break
 * anything, and no test can fail on the two sides disagreeing. Whether 40 is still right
 * is a question for whoever is looking at the overlay.
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
  /** Aborted because the phone went away, not because anyone stopped it: a restart gets a fresh controller. */
  lost?: boolean;
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
  /** The Android package the build resolved; the only one deckhand touches on a phone. */
  appPackage?: string;
  /** Epoch ms the app was last launched, where the `app` log starts. */
  launchedAt?: number;
  /** A phone's clock minus the Mac's, measured at boot (`logcat -T` filters on the phone's). */
  clockOffsetMs?: number | null;
  /** Device ports deckhand pointed at this Mac with `adb reverse`; removed again at teardown. */
  reversed?: Set<number>;
  /** `freshApp` has been applied to this device (a restart does not wipe the app again). */
  freshApplied?: boolean;
  /** How the environment reached the app at its last launch, and whether its log proved it. */
  env?: { source: EnvironmentSource; verified: boolean; note?: string };
  /** What a dev-client EAS build was told to load, or why it shows the dev launcher. */
  devClient?: string;
  /** A physical iPhone's syslog, started before each launch; the `app` log reads it. */
  syslog?: IphoneSyslog;
  /** The app's process name on an iPhone (its CFBundleExecutable), which its syslog lines carry. */
  appProcess?: string;
}

interface LivePreview {
  record: PersistedPreview;
  app: App;
  spec?: RefSpec; // git source only; kept for restart_preview re-fetches
  devices: LiveDevice[];
  /**
   * The index the next device id gets. Only ever goes up, so a retired id is never
   * handed out again — `devices.length` was not that, because `removeDevices` shrinks
   * it. In memory only: no preview survives a restart (`reapOrphans` drops every
   * non-`stopped` one and persists), so there is nothing to carry across.
   * → `preview.test.ts` "never re-mints a retired device id, on any platform".
   */
  nextDeviceIndex: number;
  /** Consumed by the first build: a restart rebuilds without wiping the app again. */
  freshApp?: FreshApp;
  /** The app environment, or null when the app declares none (then it is unknown, never invented). */
  environment: ResolvedEnvironment | null;
  /** eas source: which build, and each artifact kind's fetched-and-vetted build, memoised per preview run. */
  eas?: EasSelection;
  easPrepared?: Map<EasTarget, Promise<PreparedBuild>>;
  prep?: Promise<string>; // memoized source dir (shared across devices)
  sourceDir?: string;
  attached: Map<string, AttachedStream>;
  /** Ephemeral: the agent's current end-to-end test run, surfaced to the viewer. */
  testRun?: TestRun;
  /** Set once the agent has been reminded to open a test run; cleared when it opens one. */
  testRunNudged?: boolean;
  /** The most recent waitFor/assert on this preview, and whether it held. */
  lastVerification?: { ok: boolean; action: string; selector?: string };
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
  /** A phone plugged into this Mac: an adb serial, or an iPhone's UDID. Never booted, never counted against maxTotalDevices. */
  serial?: string;
}

/** What `start_preview` may ask for on a phone before it is installed and launched. */
export type FreshApp = "data" | "reinstall";

/**
 * One live device record. Extracted so a cold start and a later add produce IDENTICAL
 * devices — the add path grew from a copy of this, and a copy is where the two quietly
 * drift into "why does the added one have no label".
 *
 * `index` is the preview's monotonic device counter and NOT a position — it is what
 * deviceId is built from, and it must stay unique for the life of the preview: ids are how
 * the viewer addresses a stream, so reusing one after a device is removed would point a
 * pane at the wrong device.
 * → `preview.test.ts` "never re-mints a retired device id, on any platform"
 *
 * `position` is 1-based and separate for exactly that reason. A counter that skips retired
 * ids reads as nonsense in a caption — a two-device preview captioned "android device 3".
 * It is a placeholder only: `bootIos`/`bootAndroid` overwrite the label with the real model
 * the moment boot starts; what a user actually reads it for is a device still pending, or one
 * whose boot failed before it was named.
 *
 * It is baked into the label once and never revisited, so it does NOT track a later removal:
 * remove one of three same-platform devices and the next add is captioned with a number a
 * survivor already carries. Two captions, never two ids — and only on devices that are both
 * still unnamed, which is why it is left as it is rather than renumbering labels the boot
 * path has already replaced with a real model.
 * → `preview.test.ts` "labels a device by its place in the preview, not by the id counter"
 */
export function newLiveDevice(dev: DeviceRequest, index: number, position: number): LiveDevice {
  return {
    record: {
      deviceId: `${dev.platform}-${index}`,
      platform: dev.platform,
      label:
        dev.platform === "web"
          ? "Web app"
          : dev.serial
            ? `phone ${dev.serial}`
            : dev.model && dev.runtime
              ? `${dev.model} · ${dev.runtime}`
              : `${dev.platform} device ${position}`,
      runtime: dev.runtime,
      model: dev.model,
      ...(dev.serial ? { serial: dev.serial, physical: true as const } : {}),
      phase: "pending",
    },
    logs: { build: [], metro: [], app: [], stream: [] },
    abort: new AbortController(),
  };
}

/** One phone in `list_devices`: targetable now, or the one thing stopping it and how to clear it. */
export type PhoneListing =
  | { id: string; platform: "android" | "ios"; model?: string; os?: string; targetable: true }
  | { id: string; platform: "android" | "ios"; model?: string; os?: string; targetable: false; blocker: string; fix: string };

export interface PhysicalListing {
  phones: PhoneListing[];
  /** Set when adb could not be asked, so an empty list is not mistaken for "no phones". */
  unavailable?: string;
  /** Set when devicectl could not be asked: the iPhones are unknown, not absent. */
  iphonesUnavailable?: string;
}

/** An iPhone UDID: 25 characters (`00008120-…`) on current phones, 40 hex on older ones. */
const UDID_RE = /^(?:[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}|[0-9A-Fa-f]{40})$/;

/** devicectl reports a UDID in upper case; every claim and hold compares in that form, or one phone takes two tenants. */
function canonicalPhone<D extends DeviceRequest>(d: D): D {
  return d.platform === "ios" && d.serial && UDID_RE.test(d.serial) ? { ...d, serial: d.serial.toUpperCase() } : d;
}

/** discoverIphones writes each blocker as "what: how to clear it". */
function splitBlocker(text: string): { blocker: string; fix: string } {
  const i = text.indexOf(": ");
  return i < 0 ? { blocker: text, fix: "" } : { blocker: text.slice(0, i), fix: text.slice(i + 2) };
}

/** A syslog line as the `app` log shows it. */
function syslogText(l: SyslogLine): string {
  return `${l.at.toISOString()} ${l.process}${l.subsystem ? `(${l.subsystem})` : ""}[${l.pid}] ${l.level} ${l.message}`;
}

export interface StartPreviewRequest {
  app: App;
  source: PreviewSource;
  /** Required for git-source previews; unused for local. */
  spec?: RefSpec;
  devices: DeviceRequest[];
  access: "public" | "password";
  /**
   * Mark this as a compare/migration pane: booted under a synthetic app id that is
   * deliberately not in apps.yaml (see `PersistedPreview.reference`). A pane is NOT
   * public — it takes the page's access, and `isReference` records what calling it
   * public cost.
   */
  reference?: boolean;
  /** Start the registered app fresh on Android devices: wipe its data, or uninstall it first. */
  freshApp?: FreshApp;
  /** eas source: a build id (or unique prefix), or a profile whose newest finished build is taken. */
  eas?: EasSelection;
  /** An environment the app declares; omitted, its default. Ignored by nothing: an unknown name throws. */
  environment?: string;
}

export interface StartPreviewResult {
  previewId: string;
  shareId: string;
  url: string;
  source: PreviewSource;
  /** True when an equivalent preview was already live and was returned as-is. */
  alreadyRunning: boolean;
  /** The environment the preview runs against; null when the app declares none. */
  environment: { name: string; explicit: boolean } | null;
  /**
   * Platforms the request asked for that the returned preview does not have.
   * Present only when they differ — a silent mismatch is a confidently wrong answer.
   */
  notAdded?: Platform[];
  /** What to do about `notAdded`, written for the agent to relay. */
  nextStep?: string;
  devices: { deviceId: string; label: string; phase: string }[];
}

export interface PreviewStatus {
  previewId: string;
  phase: PreviewPhase;
  ready: boolean;
  url: string | null;
  source: PreviewSource;
  /** Which backend the app talks to; `name: null` when the app declares no environments. */
  environment: EnvironmentReport | null;
  devices: {
    deviceId: string;
    label: string;
    phase: string;
    detail?: string;
    error?: string;
    logTail?: string;
    environment?: EnvironmentReport;
    devClient?: string;
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
  /** Phones plugged in by cable (adb). */
  phones?: AndroidPhones;
  /** describe/ui on a phone, which SimDeck cannot address. */
  phoneControl?: ControlBackend;
  /** Who holds which phone (`deckhand phone hold`); read on every claim. */
  phoneHolds?: () => PhoneHolds;
  /** Physical iPhones: discovery, the WDA runner each phone keeps, app handles and syslog. */
  iphones?: Iphones;
  /** describe/ui/screenshot on a physical iPhone, over its WDA. */
  iphoneControl?: IphoneControl;
  /** Builds EAS already made (start_preview's `eas` source). Absent: that source is refused. */
  eas?: EasPreviews;
  runStep?: (step: CommandStep, opts?: { onLog?: (l: string, s: "stdout" | "stderr") => void; signal?: AbortSignal }) => Promise<RunResult>;
  secretsEnv?: (appId: string) => Record<string, string>;
  now?: () => number;
  genPreviewId?: () => string;
  genShareId?: () => string;
  liveShares?: LiveShareRegistry;
}

export class PreviewError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
    /** A structured code for the MCP error; `preview_error` when absent. */
    public readonly code?: string,
  ) {
    super(message);
    this.name = "PreviewError";
  }
}

/** A build step that exited non-zero, carrying only the lines that step printed. */
class BuildStepFailed extends PreviewError {
  constructor(
    message: string,
    readonly output: readonly string[],
  ) {
    super(message);
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

/** The ref an eas preview is shown and reused under. */
function easRef(sel: EasSelection | undefined, env: ResolvedEnvironment | null): string {
  if (sel?.buildId) return `eas build ${sel.buildId.slice(0, 8)}`;
  if (sel?.profile) return `eas profile ${sel.profile}`;
  return `eas ${env ? `${env.name} profile` : "build"}`;
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
  /**
   * AVDs whose emulator did not confirm it had exited (`shutdown` returned false).
   * Nothing here may be deleted from disk: the AVD name is the only handle
   * `pkill -f "avd <name>"` has on a live QEMU, and `avdmanager delete` takes it
   * out of `listAvds()` for good. The lease is gone by then, so "leased" cannot
   * carry this — a released-but-still-running AVD is exactly what `trimPool`
   * would otherwise pick as the cheapest thing to reclaim.
   * → `preview.test.ts` "keeps trimPool off it once the lease is released", and
   * "declines the delete" for each of the three paths that reach a `deleteAvd`.
   */
  private readonly unstoppedAvds = new Set<string>();
  /** Devices whose teardown is still in flight (they hold real resources until it finishes). */
  private tearingDown = 0;
  /** A forgotten preview's teardown of a phone, still stopping its app there: the next tenant's boot waits for it. */
  private releasingPhones = new Map<string, Promise<void>>();

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

  private phones(): AndroidPhones {
    if (!this.d.phones) this.d.phones = new AndroidPhones();
    return this.d.phones;
  }

  private phoneControl(): ControlBackend {
    if (!this.d.phoneControl) this.d.phoneControl = new AdbControl({ appOf: (serial) => this.registeredAppOn(serial) });
    return this.d.phoneControl;
  }

  private iphones(): Iphones {
    if (!this.d.iphones) this.d.iphones = new Iphones();
    return this.d.iphones;
  }

  private iphoneControl(): IphoneControl {
    if (!this.d.iphoneControl) this.d.iphoneControl = new IphoneControl({ clientFor: (udid) => this.iphones().client(udid) });
    return this.d.iphoneControl;
  }

  /** The registered app's guarded handle on a physical iPhone; no other bundle id gets through it. */
  private iphoneApps(dev: LiveDevice): IphoneApps {
    if (!dev.appPackage || !dev.record.serial) throw new PreviewError("the app's iOS bundle id is not resolved yet");
    return this.whileWanted(dev, this.iphones().apps(dev.record.serial, dev.appPackage), ["install", "uninstall", "launch"]);
  }

  /** The handle with each change to the phone refused once the preview no longer wants the device; stopping the app stays open to teardown. */
  private whileWanted<T extends object, K extends keyof T>(dev: LiveDevice, handle: T, changes: K[]): T {
    const guarded = Object.create(handle) as T;
    for (const k of changes) {
      const real = handle[k] as unknown as (...a: unknown[]) => Promise<unknown>;
      (guarded as Record<K, unknown>)[k] = async (...a: unknown[]) => {
        this.stillWanted(dev);
        return real.apply(handle, a);
      };
    }
    return guarded;
  }

  private isIphone(dev: LiveDevice): boolean {
    return dev.record.physical === true && dev.record.platform === "ios";
  }

  private holds(): PhoneHolds {
    return (this.d.phoneHolds ?? loadPhoneHolds)();
  }

  /** The live preview holding a phone, or null. Every non-stopped preview counts, a failed one included. */
  private phoneTenant(serial: string): { p: LivePreview; dev: LiveDevice } | null {
    for (const p of this.previews.values()) {
      if (p.record.phase === "stopped") continue;
      for (const dev of p.devices) if (dev.record.physical && dev.record.serial === serial) return { p, dev };
    }
    return null;
  }

  /** Serials of the phones this app's live previews hold. */
  livePhonesForApp(appId: string): string[] {
    const out = new Set<string>();
    for (const p of this.previews.values()) {
      if (p.record.appId !== appId || p.record.phase === "stopped") continue;
      for (const dev of p.devices) if (dev.record.physical && dev.record.serial) out.add(dev.record.serial);
    }
    return [...out];
  }

  /** Why this phone cannot be handed to a new preview, as the structured `device_busy` error; null when it can. */
  private phoneBusy(serial: string, holds: PhoneHolds): PreviewError | null {
    const hold = holds[serial] ?? (UDID_RE.test(serial) ? Object.entries(holds).find(([k]) => k.toUpperCase() === serial)?.[1] : undefined);
    if (hold) {
      return new PreviewError(
        `phone ${serial} is held by ${hold.who} (since ${hold.since})`,
        `it is off the market until they release it: \`deckhand phone release ${serial}\` on the deckhand Mac`,
        "device_busy",
      );
    }
    const t = this.phoneTenant(serial);
    if (!t) return null;
    return new PreviewError(
      `phone ${serial} is in use by preview ${t.p.record.previewId} (app "${t.p.record.appId}", share ${this.viewerUrl(t.p.record.shareId)})`,
      `a phone runs one preview at a time — free it with stop_preview {previewId: "${t.p.record.previewId}"}, or stop_device on its ${t.dev.record.deviceId}`,
      "device_busy",
    );
  }

  /** The registered app on a phone some live preview drives, once its package is known. */
  private registeredAppOn(serial: string): RegisteredApp | null {
    const t = this.phoneTenant(serial);
    return t?.dev.appPackage ? this.phones().registeredApp(serial, t.dev.appPackage) : null;
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

  liveShareRevoked(shareId: string): boolean {
    return this.d.liveShares?.wasRevoked(shareId) ?? false;
  }

  /** Look up a live preview by its shareId (used by the share proxy). */
  findByShareId(
    shareId: string,
  ): { previewId: string; viewOnly?: true; devices: { deviceId: string; platform: Platform; stream?: AttachedStream }[] } | null {
    const live = this.d.liveShares?.find(shareId);
    if (live) return { previewId: `live-${shareId}`, viewOnly: true, devices: [{ deviceId: LIVE_DEVICE_ID, platform: "ios", stream: live.stream }] };
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

  /**
   * One honest line for a preview that has no devices yet.
   *
   * Prefers the newest build output over a phase name: "building" sits still for minutes on a
   * cold pod or gradle build, and a caption that never changes is indistinguishable from a
   * hang — which is exactly what the blank page felt like.
   */
  private preparingDetail(p: LivePreview): string {
    const tail = [...p.devices.flatMap((d) => d.logs.build)].slice(-1)[0];
    const step = tail ? buildStepDetail(tail) : null;
    if (step) return step;
    return p.record.phase === "pending"
      ? "Starting — fetching the branch."
      : "Preparing — fetching the branch and running the shared build.";
  }

  /** Sanitized public state for the viewer (no udids, no logs). */
  shareState(shareId: string): {
    ready: boolean;
    ref: string;
    repo: string;
    source: PreviewSource;
    /** Local previews can be rebuilt from the viewer's refresh button. */
    canRestart: boolean;
    /**
     * What the preview is doing RIGHT NOW, when it has no devices to say it for itself.
     *
     * A cold start spends its first minute on the worktree and the shared build, before
     * `simctl create` has produced anything — so `devices` is empty and the viewer had
     * nothing at all to render. Someone who has just typed a PIN sat looking at a blank page
     * for a minute with no sign the build had even begun.
     */
    detail?: string;
    devices: { deviceId: string; platform: Platform; label: string; phase: string; detail?: string; step?: string; physical?: true }[];
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
      devices: { deviceId: string; platform: Platform; label: string; phase: string; detail?: string; step?: string; physical?: true }[];
    }[];
    /** Migration target only: the agent-maintained parity ledger, if the file exists. */
    ledger?: { screens: { name: string; status: string; note?: string }[] };
    viewOnly?: true;
  } | null {
    const live = this.d.liveShares?.find(shareId);
    if (live) {
      const devices = [{ deviceId: LIVE_DEVICE_ID, platform: "ios" as const, label: live.label, phase: "ready" }];
      return {
        ready: true,
        ref: "live",
        repo: live.label,
        source: "local",
        canRestart: false,
        devices,
        panes: [{ shareId, repo: live.label, ref: "live", self: true, devices }],
        viewOnly: true,
      };
    }
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
        ...(d.record.physical ? { physical: true as const } : {}),
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
            // Same rule the migratesFrom branch has always had, and the compare
            // branch never did: only advertise a pane this page can actually
            // unlock. Access is inherited at boot, so the two normally match —
            // until `set_pin --remove` makes the page public while the pane
            // keeps its PIN. The pane then mounted and had its WS refused once a
            // second forever, with no pad, because the pad only ever renders for
            // the page's own shareId.
            if (!this.partnerIsReachable(p.record.shareId, r.shareId)) continue;
            refPanes.push({
              shareId: r.shareId,
              repo: r.repo,
              // The LIVE record, not the snapshot taken when the pane was booted.
              // A local pane's ref starts as "local" and is replaced by its real
              // branch a moment later, so the snapshot would show "local" forever
              // — and a restarted pane's ref can move under it too.
              ref: live.record.ref || r.ref,
              devices: sanitizeDevices(live),
            });
          }
          if (p.compare.items.length) {
            ledger = { screens: p.compare.items.map((i) => ({ name: i.name, status: i.verdict, note: i.note })) };
          }
        } else if (p.app.migratesFrom) {
          const src = this.livePreviewForApp(p.app.migratesFrom);
          // A migration pairs two REGISTERED apps, each with its own PIN, set
          // independently. An `alongside` pane cannot drift that way — it is a
          // synthetic app whose id is keyed by the page's access class and whose
          // PIN is written from the page's at boot (`bootReference`,
          // mcp/tools.ts), so it is NOT public and NOT free to mint toward.
          // A migration source is a real app, so the pane is only mountable when
          // this page can actually unlock it: the unlock propagates from a
          // proven PIN on this share,
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
          ...(p.devices.length === 0 ? { detail: this.preparingDetail(p) } : {}),
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
   * FORWARD ONLY, and that direction is a security property rather than an
   * omission: a page mints for the panes it renders, and a pane never mints for
   * the page holding it. Panes are keyed by CONTENT, so two pages naming the
   * same source share one pane — the note in the body says what the reverse
   * direction cost. → `preview.test.ts` "mints a page's panes, and never the
   * other way round".
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
            // Mirrors shareState exactly: never mint for a pane we did not
            // advertise, and never advertise one we cannot mint for.
            if (this.liveByShareId(r.shareId) && this.partnerIsReachable(shareId, r.shareId)) out.add(r.shareId);
          }
        }
        // FORWARD ONLY. There used to be a reverse direction here — unlocking a
        // pane also unlocked the page holding it — justified by "a pane belongs
        // to one page". That stopped being true when panes were keyed by
        // CONTENT: two pages naming the same source share one pane, so the
        // reverse mint handed a holder of page B's PIN a valid cookie for page
        // A, and disclosed A's shareId in the cookie's Path. Different apps,
        // different owners, no PIN ever proven for A.
        //
        // Nothing is lost by dropping it. A pane's shareId is never given to a
        // user — it appears only inside the page's own state, which already
        // requires the page's cookie to read — and anyone who does open a pane
        // URL directly holds that pane's PIN anyway, so the pad works. The
        // forward direction alone covers every pane the page actually renders.
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

  /**
   * Drop the stable share id and PIN of an app that is no longer registered.
   *
   * Both are keyed by app id and were written on first preview but never removed, so
   * state.json accumulated an entry per app that ever existed — including the scrypt hash of
   * a PIN for a share nobody can reach any more. Neither is reachable without the app, so
   * keeping them buys nothing and keeps a credential hash on disk indefinitely.
   *
   * Called when apps.yaml loses an app, which covers `remove_app` and a hand edit alike.
   * Re-registering the same id mints a fresh share id — deliberate: the old link was
   * unregistered, and silently reviving it would resurrect access somebody removed.
   */
  forgetApp(appId: string): void {
    const hadShare = appId in this.stableShareIds;
    const hadPin = appId in this.pins;
    if (!hadShare && !hadPin) return;
    delete this.stableShareIds[appId];
    delete this.pins[appId];
    this.persist();
    this.d.audit.record({
      actor: "engine",
      tool: "forget_app",
      args: { app: appId, shareId: hadShare, pin: hadPin },
      result: "ok",
    });
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
   * Every LIVE pane this page shows, and whether its access is the page's to set.
   *
   * `synthetic` is an `alongside` pane: it runs under a content-keyed app id that
   * is deliberately not in apps.yaml, so no tool call names it and the page that
   * booted it is the only thing that can change its access. A migration-source
   * pane is the opposite — it IS a registered app's own preview, with its own
   * link and its own operator-set PIN, which a page must not rewrite.
   *
   * Mirrors `shareState`'s two pairing sources exactly (compare session wins,
   * else `migratesFrom`): a pane this omits but shareState renders is one a
   * page's PIN silently fails to reach.
   * → `server.test.ts` "set_pin on a public page locks the panes whose shareIds it already disclosed"
   */
  panesOf(previewId: string): { appId: string; shareId: string; synthetic: boolean }[] {
    const p = this.previews.get(previewId);
    if (!p) return [];
    const entry = (live: LivePreview) => ({
      appId: live.record.appId,
      shareId: live.record.shareId,
      synthetic: live.record.reference === true,
    });
    if (p.compare) {
      const out = [];
      for (const r of p.compare.references) {
        const live = this.liveByShareId(r.shareId);
        if (live) out.push(entry(live));
      }
      return out;
    }
    if (p.app.migratesFrom) {
      const src = this.livePreviewForApp(p.app.migratesFrom);
      if (src) return [entry(src)];
    }
    return [];
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

  /**
   * Whether the app has a web preview that could still be SERVED.
   *
   * Keyed on the attached stream rather than the phase, because those are not the same
   * question and the difference was an auth hole: the proxy's web upstream resolver requires
   * an attached stream and never looks at the phase, so a `failed` preview whose dev server
   * was still running remained fully reachable — while this guard skipped it and let
   * `set_pin remove:true` make it public. Phase is what we REPORT; the attached stream is
   * what is actually reachable, and a guard must be keyed on the latter.
   *
   * `stopped` still short-circuits: teardownDevices detaches every stream, so there is
   * nothing to serve and nothing to protect.
   */
  private hasLiveWebPreview(appId: string): boolean {
    for (const p of this.previews.values()) {
      if (p.record.appId !== appId || p.record.phase === "stopped") continue;
      if (p.devices.some((d) => d.record.platform === "web" && p.attached.has(d.record.deviceId))) return true;
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
    req = { ...req, devices: req.devices.map(canonicalPhone) };
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
    let environment: ResolvedEnvironment | null;
    try {
      environment = resolveEnvironment(req.app, req.environment);
    } catch (e) {
      if (e instanceof EnvironmentError) throw new PreviewError(e.message, e.hint, e.code);
      throw e;
    }
    if (environment && req.app.type === "web") {
      throw new PreviewError(`web app "${req.app.id}" declares environments, which only mobile previews can apply`, "remove environments from this web app in apps.yaml; a web preview runs its dev server as configured", "bad_request");
    }
    if (req.source === "eas") this.checkEasRequest(req);
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
    const existing = this.findReusable(req, environment?.name ?? null);
    if (existing) {
      // Asking for a platform this preview does not have is a DIFFERENT request, and it used
      // to come back as `alreadyRunning` with the extra device silently dropped. Now it is
      // satisfied: the missing devices are added to the live preview and the running ones are
      // left alone. If adding fails (capacity, a web preview) the reason is reported rather
      // than swallowed — the caller still gets its link, with the failure attached.
      const specs = this.missingDevices(existing, req);
      const missing = [...new Set(specs.map((d) => d.platform))];
      if (missing.length) {
        try {
          this.addDevices(existing.record.previewId, specs);
          return this.resultFor(existing, true);
        } catch (e) {
          // The hint is the actionable half — dropping it leaves a reason with no way out.
          const why =
            e instanceof PreviewError && e.hint ? `${e.message} (${e.hint})` : e instanceof Error ? e.message : String(e);
          return this.resultFor(existing, true, missing, why);
        }
      }
      return this.resultFor(existing, true);
    }

    if (req.devices.length > this.d.config.limits.maxDevicesPerPreview) {
      throw new PreviewError(
        `too many devices (${req.devices.length} > ${this.d.config.limits.maxDevicesPerPreview})`,
        "request fewer devices or raise limits.maxDevicesPerPreview",
      );
    }
    this.checkPhoneRequests(req.devices, req.source);
    // Devices still being released for THIS app are already spoken for by this
    // request — don't make it queue behind its own teardown. Only what is still
    // held is discounted; releases that already completed are out of the tally
    // anyway, and discounting them twice would over-admit.
    const totalActive = Math.max(0, this.devicesInUse() - stillReleasing());
    // A phone costs the Mac no CPU or RAM, which is all this cap protects.
    const booting = req.devices.filter((d) => !d.serial).length;
    if (booting && totalActive + booting > this.d.config.limits.maxTotalDevices) {
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
    const devices: LiveDevice[] = req.devices.map((dev, i) => newLiveDevice(dev, i, i + 1));

    const record: PersistedPreview = {
      previewId,
      shareId,
      appId: req.app.id,
      ref: req.source === "local" ? "local" : req.source === "eas" ? easRef(req.eas, environment) : refDescription(req.spec!),
      source: req.source,
      ...(environment ? { environment: environment.name } : {}),
      ...(req.source === "eas" ? { eas: { ...req.eas } } : {}),
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
      nextDeviceIndex: devices.length,
      ...(req.freshApp ? { freshApp: req.freshApp } : {}),
      environment,
      ...(req.source === "eas" ? { eas: { ...req.eas } } : {}),
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

    // A local preview's ref starts as the literal "local" because start_preview
    // is synchronous and reading the branch is not. Fill in the real branch as
    // soon as git answers: "local" names the SOURCE MODE, not what is on screen,
    // and two panes both reading "local" say nothing about which branch each one
    // is. The viewer polls, so it picks this up within a poll. Read-only —
    // deckhand never writes to a borrowed checkout (PLAN §11 item 4).
    if (req.source === "local" && req.app.path) {
      // Wrapped: this is a cosmetic lookup, and nothing cosmetic may be able to
      // fail start_preview. (It did — a WorktreeManager without the method threw
      // synchronously, past the .catch() that only covers a rejected promise.)
      void (async () => this.d.worktrees.localBranch?.(req.app.path!))()
        .then((branch) => {
          if (!branch || record.ref !== "local") return;
          record.ref = branch;
          this.persist();
        })
        .catch(() => {
          /* a detached or non-git checkout keeps "local", which is still true */
        });
    }

    // Kick off orchestration; do not await (start_preview returns immediately).
    record.phase = "running";
    void this.orchestratePreview(preview).catch(() => {
      /* per-device errors are captured onto the device records */
    });

    return this.resultFor(preview, false);
  }

  /**
   * Add devices to a LIVE preview, without touching the ones already running.
   *
   * This was refused outright, and the advice was "stop_preview, then start again with the
   * full list" — which reboots working simulators and pays for their build a second time,
   * for the crime of wanting one more device.
   *
   * Nothing structural was in the way. `orchestrateGroup` is already self-contained per
   * group: it boots that group's devices, awaits the source, and builds. Devices in other
   * groups are never referenced. And `prepareSource` is memoised on `p.prep`, so a second
   * call on a live preview returns the directory the first one resolved rather than
   * re-checking out anything.
   *
   * So each new device is orchestrated as its own group. That is deliberate rather than
   * clever: a device joining a platform that is already live pays for its own build instead
   * of reusing the neighbour's artifact. Slower, and correct — locating and copying a built
   * product means reasoning about whether that artifact is still the one on the running
   * device, which is exactly the kind of assumption that turns into "why is this build
   * stale". The cost is a build; the alternative was a reboot of everything.
   *
   * Capacity is re-checked here, not inherited from the original request: the machine's
   * budget is shared, and a preview that was admitted an hour ago says nothing about now.
   *
   * Synchronous, like `startPreview`, and for the same reason: the caller gets its link back
   * immediately and polls for readiness. Booting and building happen behind it.
   */
  addDevices(previewId: string, specs: DeviceRequest[]): LiveDevice[] {
    specs = specs.map(canonicalPhone);
    const p = this.active(previewId);
    if (!p) throw new PreviewError(`no active preview "${previewId}"`);
    if (p.devices.some((d) => d.record.platform === "web") || specs.some((sp) => sp.platform === "web")) {
      throw new PreviewError("a web preview has no devices to add", "start a device preview instead");
    }
    if (p.devices.length + specs.length > this.d.config.limits.maxDevicesPerPreview) {
      throw new PreviewError(
        `too many devices (${p.devices.length + specs.length} > ${this.d.config.limits.maxDevicesPerPreview})`,
        "stop a device or raise limits.maxDevicesPerPreview",
      );
    }
    if (p.record.source === "local") {
      const platforms = [...p.devices, ...specs].map((d) => ("record" in d ? d.record.platform : d.platform));
      if (new Set(platforms).size < platforms.length) {
        throw new PreviewError(
          "local previews run one device per platform",
          "the livesync process targets a single device; stop_device the one this preview has on that platform first",
        );
      }
    }
    const booting = specs.filter((sp) => !sp.serial).length;
    if (booting && this.devicesInUse() + booting > this.d.config.limits.maxTotalDevices) {
      throw new PreviewError(
        `device capacity reached (${this.devicesInUse()}/${this.d.config.limits.maxTotalDevices} in use)`,
        "stop another preview or raise limits.maxTotalDevices",
      );
    }
    this.checkPhoneRequests(specs, p.record.source);

    // A per-preview counter, NOT `p.devices.length`: `removeDevices` (the `stop_device` tool)
    // shrinks the list, so the length handed a retired index straight back. Called through
    // startPreview that was merely confusing — the id carries the platform and
    // `missingDevices()` filters by it, so nothing live collided — but this method is
    // public, and a caller that does not filter gave two LIVE devices one id. A device id is
    // how a viewer pane addresses a stream, so that is one pane showing another's video.
    const start = p.nextDeviceIndex;
    // The caption gets the position instead (see newLiveDevice): `p.devices` has not been
    // pushed to yet, so its length is the count of devices already on the preview.
    const added = specs.map((spec, i) => newLiveDevice(spec, start + i, p.devices.length + i + 1));
    p.nextDeviceIndex = start + specs.length;
    p.devices.push(...added);
    // `p.record.devices` is a separate array (startPreview built it with `.map()`), and it
    // is the one that reaches state.json. Pushing to `p.devices` alone left `persist()`
    // writing the pre-add list — invisible through `getStatus`, which reads `p.devices`,
    // and wrong for anything reading the file. `removeDevices` re-syncs the same way.
    p.record.devices = p.devices.map((d) => d.record);
    this.persist();
    this.markActive(p);

    // Each on its own, so one device failing to boot cannot fail the others — and so a
    // caller gets its link back immediately, exactly as a cold start does.
    for (const dev of added) {
      void this.orchestrateGroup(p, [dev]).catch(() => {
        /* per-device errors land on the device record via failDevice */
      });
    }
    return added;
  }

  /**
   * Remove devices from a live preview, leaving the rest running.
   *
   * The mirror of `addDevices`, and it was missing for the same reason: getting from
   * two devices back to one meant stopping the whole preview and rebuilding the device
   * you wanted to keep. Adding was fixed first; this is the other half of the same gap.
   *
   * Refuses to remove the last device. A preview with no devices is not a smaller
   * preview, it is a stopped one wearing a running preview's URL — and the caller that
   * wanted that has `stop_preview`, which also frees the worktree and the share.
   */
  async removeDevices(previewId: string, deviceIds: string[]): Promise<string[]> {
    const p = this.active(previewId);
    if (!p) throw new PreviewError(`no active preview "${previewId}"`);
    const doomed = p.devices.filter((d) => deviceIds.includes(d.record.deviceId));
    const unknown = deviceIds.filter((id) => !p.devices.some((d) => d.record.deviceId === id));
    if (unknown.length) {
      throw new PreviewError(
        `no such device on this preview: ${unknown.join(", ")}`,
        `it has ${p.devices.map((d) => d.record.deviceId).join(", ")}`,
      );
    }
    if (doomed.length === p.devices.length) {
      throw new PreviewError(
        "that would remove every device",
        "call stop_preview instead — it also releases the worktree and the share",
      );
    }

    for (const dev of doomed) {
      dev.lost = false;
      dev.abort.abort();
    }

    // The livesync process is keyed by app+PLATFORM, not by device — so removing a
    // device only ends it if that platform is leaving with it. Unconditional here ONLY
    // because startPreview and addDevices enforce one device per platform on local previews, which is
    // the only source that has a livesync process at all: a removed device is always the
    // last of its platform. If that rule is ever relaxed, this must check for a surviving
    // sibling first, or it kills livesync for a device nobody asked to touch. Written as
    // a note rather than a guard, because with the rule in force no input can tell the
    // two apart, and a branch no test can reach is not protection.
    if (p.record.source === "local") {
      for (const platform of new Set(doomed.map((d) => d.record.platform))) {
        this.d.devProcs?.stop(devKey(p.app.id, platform));
      }
    }

    await this.teardownDevices(p, undefined, doomed);
    p.devices = p.devices.filter((d) => !doomed.includes(d));
    p.record.devices = p.devices.map((d) => d.record);
    this.recomputePreviewPhase(p);
    this.persist();
    this.markActive(p);
    return doomed.map((d) => d.record.deviceId);
  }

  /**
   * Platforms the caller asked for that this live preview does not have.
   *
   * `findReusable` matches on app + source + ref and IGNORES the device list, which is right
   * for the daily loop — asking again for what is already running should return it, not mint a
   * second simulator. But it made a genuinely different request look satisfied: asking for
   * iOS + Android while an iOS preview was live returned `alreadyRunning: true` and silently
   * dropped Android. The caller saw success and no Android, and the only way anyone found to
   * get it was `stop_preview` + start again — which reboots the iOS simulators that were
   * working and pays for their build a second time.
   *
   * An empty result and a satisfied request must not look the same (CONSTITUTION §3).
   */
  private missingDevices(p: LivePreview, req: StartPreviewRequest): DeviceRequest[] {
    const live = new Set(p.devices.filter((d) => !d.record.physical).map((d) => d.record.platform));
    const phones = new Set(p.devices.flatMap((d) => (d.record.physical && d.record.serial ? [d.record.serial] : [])));
    const wanted = new Set<Platform>();
    return req.devices.filter((d) => {
      // A phone is its own device: an emulator already on the preview does not stand in for it.
      if (d.serial) return !phones.has(d.serial);
      if (live.has(d.platform) || wanted.has(d.platform)) return false;
      wanted.add(d.platform);
      return true;
    });
  }

  /**
   * Phones asked for are hardware this Mac can hand over: Android, not an emulator, asked for once,
   * and neither held nor in another live preview. Read synchronously with the claim that follows,
   * so two start_previews cannot both take one phone.
   */
  private checkPhoneRequests(devices: DeviceRequest[], source: PreviewSource): void {
    const phones = devices.filter((d) => d.serial);
    if (!phones.length) return;
    const holds = this.holds();
    const seen = new Set<string>();
    for (const d of phones) {
      const serial = d.serial!;
      if (d.platform === "ios") {
        if (!UDID_RE.test(serial)) throw new PreviewError(`"${serial}" is not an iPhone UDID`, "pass the id list_devices reports under physical", "bad_request");
        if (source !== "eas") {
          throw new PreviewError(
            `a physical iPhone runs only an EAS internal-distribution build, and this preview would ${source === "local" ? "build the local checkout" : "build from git"}`,
            "this Mac holds no Apple signing credentials, so deckhand cannot build or sign an app for a phone. Pass eas: {} (the newest build of the profile the environment maps for ios), eas: {profile: \"<an internal device profile>\"} or eas: {buildId: \"<id>\"} — a build whose profile lists this phone (register it with `eas device:create`, then rebuild). Or preview on an iOS simulator.",
            "iphone_needs_eas",
          );
        }
      } else if (d.platform === "android") {
        if (!/^[A-Za-z0-9._:-]{1,64}$/.test(serial)) throw new PreviewError(`"${serial}" is not an adb serial`, "pass the id list_devices reports under physical", "bad_request");
        if (isEmulatorSerial(serial)) throw new PreviewError(`${serial} is an emulator, not a phone`, "ask for an emulator by platform and runtime instead", "bad_request");
      } else {
        throw new PreviewError(`a ${d.platform} preview has no phone`, "drop the phone id", "bad_request");
      }
      if (seen.has(serial)) throw new PreviewError(`phone ${serial} was asked for twice`, "list each phone once", "bad_request");
      seen.add(serial);
      const busy = this.phoneBusy(serial, holds);
      if (busy) throw busy;
    }
  }

  private resultFor(p: LivePreview, alreadyRunning: boolean, missing: Platform[] = [], why?: string): StartPreviewResult {
    this.markActive(p); // an idempotent start_preview is someone using it
    return {
      previewId: p.record.previewId,
      shareId: p.record.shareId,
      url: this.previewUrl(p),
      source: p.record.source,
      alreadyRunning,
      environment: p.environment ? { name: p.environment.name, explicit: p.environment.explicit } : null,
      devices: p.devices.map((d) => ({ deviceId: d.record.deviceId, label: d.record.label, phase: d.record.phase })),
      ...(missing.length
        ? {
            notAdded: missing,
            nextStep:
              `${missing.join(" + ")} could NOT be added to this running preview: ${why ?? "unknown reason"}. ` +
              `The devices already running are untouched. Free capacity (stop_preview on another preview) and ask again, ` +
              `or stop this one and start it with the full device list.`,
          }
        : {}),
    };
  }

  /** An equivalent live preview: same app, source and environment, and the same ref or EAS build choice. */
  private findReusable(req: StartPreviewRequest, environment: string | null): LivePreview | null {
    for (const p of this.previews.values()) {
      const ph = p.record.phase;
      if (ph === "stopped" || ph === "failed" || ph === "stopping") continue;
      if (p.record.appId !== req.app.id || p.record.source !== req.source) continue;
      if ((p.record.environment ?? null) !== environment) continue;
      if (req.source === "git" && p.record.ref !== refDescription(req.spec!)) continue;
      if (req.source === "eas" && (p.record.eas?.buildId !== req.eas?.buildId || p.record.eas?.profile !== req.eas?.profile)) continue;
      return p;
    }
    return null;
  }

  /** The EAS project an app's builds come from: registered, else read from a local checkout's app config. */
  private easProjectFor(app: App): string | null {
    return app.easProjectId ?? (app.path ? easProjectIdFromDir(app.path) : null);
  }

  private checkEasRequest(req: StartPreviewRequest): void {
    if (!this.d.eas) throw new PreviewError("this deckhand cannot preview EAS builds", "it was started without the EAS source", "eas_unavailable");
    if (req.app.type === "web") throw new PreviewError("a web app has no EAS builds", "omit eas", "bad_request");
    if (req.eas?.buildId && req.eas.profile) throw new PreviewError("pass eas.buildId or eas.profile, not both", "a build id already names one build", "bad_request");
    if (!this.easProjectFor(req.app)) {
      throw new PreviewError(
        `app "${req.app.id}" has no EAS project id`,
        `register it on the deckhand machine: \`deckhand app add\` with --eas-project <uuid> (or add easProjectId to the app in apps.yaml); it is extra.eas.projectId in the app config`,
        "no_eas_project",
      );
    }
    const ready = this.d.eas.ready();
    if (!ready.ok) throw new PreviewError(ready.message, ready.hint, "eas_token_missing");
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
   * Stop the app's Metro once nothing is using it any more.
   *
   * Teardown killed the dev processes but never Metro, so every finished Expo
   * preview left one listening for the rest of the server's life and `freePort`
   * simply moved to the next port — the 8081-8099 range emptied out over a few
   * app switches and previews started failing with "no free Metro port".
   * App-scoped, and no narrower: `stopApp` reaps every server this app has (one
   * per checkout and env), and the guard above is what stops it running while
   * another preview of the SAME app is still live.
   */
  private stopMetroIfUnused(appId: string): void {
    for (const other of this.previews.values()) if (other.app.id === appId) return;
    void this.d.metro.stopApp(appId).catch(() => {});
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
  private releaseInBackground(p: LivePreview): () => number {
    const phones = p.devices.filter((d) => d.record.physical);
    let resolve!: () => void;
    const releasing = new Promise<void>((r) => (resolve = r));
    for (const dev of phones) if (dev.record.serial) this.releasingPhones.set(dev.record.serial, releasing);
    const phonesReleased = (): void => {
      for (const dev of phones) if (dev.record.serial && this.releasingPhones.get(dev.record.serial) === releasing) this.releasingPhones.delete(dev.record.serial);
      resolve();
    };
    let held = p.devices.filter((d) => !d.record.physical).length;
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
            // Owner-guarded: this teardown runs asynchronously, and the key is per
            // app+platform, so a newer preview may already own it.
            this.d.devProcs?.stop(devKey(p.app.id, platform), p.record.previewId);
          }
        }
        await this.teardownDevices(p, undefined, phones).finally(phonesReleased);
        await this.teardownDevices(p, releaseOne, p.devices.filter((d) => !d.record.physical));
        this.stopMetroIfUnused(p.app.id);
        if (p.record.source === "git") {
          await this.d.worktrees.removeWorktree(p.app, p.record.previewId).catch(() => {});
        }
      } finally {
        // Whatever teardownDevices didn't reach (it threw part-way through).
        while (held > 0) releaseOne();
        phonesReleased();
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
    return (dev.record.platform === "android" || dev.record.physical ? dev.record.serial : dev.record.udid) ?? "";
  }

  /** A borrowed phone outlives its preview, so every step that touches one first asks whether the preview still wants it. */
  private stillWanted(dev: LiveDevice): void {
    if (dev.abort.signal.aborted) throw new PreviewError("preview was stopped while its device was starting");
  }

  private async bootDevice(p: LivePreview, dev: LiveDevice): Promise<string> {
    if (dev.record.physical && dev.record.serial) await this.releasingPhones.get(dev.record.serial);
    if (dev.record.physical) this.stillWanted(dev);
    if (this.isIphone(dev)) return this.bootIphone(p, dev);
    return dev.record.platform === "android" ? this.bootAndroid(p, dev) : this.bootIos(p, dev);
  }

  private async bootIos(p: LivePreview, dev: LiveDevice): Promise<string> {
    const runtimes = await this.d.simctl.listRuntimes();
    const deviceTypes = await this.d.simctl.listDeviceTypes();
    const { runtime, deviceType } = selectSimulator(runtimes, deviceTypes, { runtime: dev.record.runtime, model: dev.record.model });
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

  /**
   * A phone is not booted: it is waited for. Awake and unlocked is the person's to give; the only
   * thing deckhand sends is one wake key. Its clock offset is measured here because the `app` log
   * filters on the phone's clock, which can be wrong by years.
   */
  private async bootPhone(p: LivePreview, dev: LiveDevice): Promise<string> {
    const serial = dev.record.serial!;
    const phones = this.phones();
    this.setPhase(p, dev, "booting", "waiting for the phone to be awake and unlocked");
    const info = await phones.waitUsable(serial, 120_000, dev.abort.signal, (b) => {
      dev.record.detail = `phone is ${b.blocker} — ${b.fix}`;
    });
    const name = [info.manufacturer, info.model].filter(Boolean).join(" ") || serial;
    dev.record.model = info.model;
    dev.record.runtime = info.os;
    dev.record.label = `${name}${info.os ? ` · ${info.os}` : ""} (phone)`;
    dev.clockOffsetMs = await phones.clockOffsetMs(serial).catch(() => null);
    if (dev.clockOffsetMs != null && Math.abs(dev.clockOffsetMs) > 60_000) {
      this.appendLog(dev, "build", `deckhand: this phone's clock is ${Math.round(dev.clockOffsetMs / 1000)}s off the Mac's; the app log corrects for it (the clock is never changed)`);
    }
    return serial;
  }

  /**
   * An iPhone is not booted either. It must be listed paired, cabled and unblocked, and its WDA —
   * owned by the server, kept across previews — must answer before the app is touched: a phone
   * deckhand cannot see or drive gets no install. A locked phone is waited for, like Android's.
   */
  private async bootIphone(p: LivePreview, dev: LiveDevice): Promise<string> {
    const udid = dev.record.serial!;
    const iphones = this.iphones();
    this.setPhase(p, dev, "booting", "checking the iPhone is cabled and unlocked");
    const deadline = this.d.now!() + 120_000;
    for (;;) {
      const phone = (await iphones.list()).find((x) => x.udid.toLowerCase() === udid.toLowerCase());
      if (!phone) throw new PreviewError(`iPhone ${udid} is not cabled to this Mac (devicectl does not list it as paired)`, "plug it in by cable, unlock it and tap Trust", "no_phone");
      const blockers = phone.blockers.filter((b) => !b.startsWith("WDA could not start") && !b.startsWith("WDA stopped"));
      const waitable = blockers.length > 0 && blockers.every((b) => b.startsWith("locked"));
      if (!blockers.length) {
        dev.record.model = phone.model ?? undefined;
        dev.record.runtime = phone.osVersion ? `iOS ${phone.osVersion}` : undefined;
        dev.record.label = `${phone.model ?? phone.name}${phone.osVersion ? ` · iOS ${phone.osVersion}` : ""} (phone)`;
        break;
      }
      const first = splitBlocker(blockers[0]!);
      if (!waitable || this.d.now!() >= deadline || dev.abort.signal.aborted) throw new PreviewError(`iPhone ${udid}: ${first.blocker}`, first.fix, "phone_blocked");
      dev.record.detail = `phone is ${first.blocker} — ${first.fix}`;
      await new Promise((r) => setTimeout(r, 3_000).unref());
    }
    this.setPhase(p, dev, "booting", "starting WebDriverAgent on the phone (a cold start takes about 30 s)");
    try {
      await iphones.client(udid);
    } catch (e) {
      if (e instanceof WdaStartError) throw new PreviewError(`WebDriverAgent could not start on iPhone ${udid}: ${e.message}`, e.hint ?? "read the WDA log named above", "wda_unavailable");
      throw e;
    }
    return udid;
  }

  private async bootAndroid(p: LivePreview, dev: LiveDevice): Promise<string> {
    if (dev.record.physical) return this.bootPhone(p, dev);
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
      // Do NOT claim tenancy yet. The wipe is a `-wipe-data` flag on the boot
      // below, so at this point it has not happened — and bootEmulator can throw
      // or time out (240s). Recording the new tenant here meant the retry
      // computed wipeData=false and handed this app an AVD still holding the
      // PREVIOUS tenant's data: its app storage, accounts and cookies, across
      // owner scopes, silently. iOS gets this right by erasing first and
      // recording after; the comment there even claims Android was already
      // correct, which is what made this easy to miss. Claimed after the boot
      // returns instead — see below.
    } else {
      avdName = `${AVD_PREFIX}${p.record.previewId}_${dev.record.deviceId}`.replace(/[^A-Za-z0-9_]/g, "_");
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
    // QEMU exists from here on: `bootEmulator` spawns the emulator detached BEFORE its
    // first await and only waits afterwards, while `record.serial` appears seconds to
    // minutes later. In between, a stop/remove aborts this boot and tears the device
    // down in the same call with nothing awaiting it — and teardown, finding no serial,
    // has no shutdown to ask and so no answer to record. Say the answer now, in the only
    // direction that is safe to be wrong in: nothing has confirmed this emulator is
    // gone, so its AVD name — the sole handle `pkill -f "avd <name>"` and the reaper
    // have on the process — is not deletable by teardownDevices or trimPool. This one
    // piece of bookkeeping precedes its effect deliberately (the rest of the file
    // records after): it is a claim that a process may exist, and the spawn is what it
    // is guarding against. Every path below settles it — clean shutdown clears it.
    this.noteStopped(avdName, false);
    try {
      serial = await android.bootEmulator(avdName, port, undefined, { wipeData, signal: dev.abort.signal });
      // The wipe has now actually run, so the AVD really does belong to this app.
      // A boot that threw leaves the old tenant recorded, so the next attempt
      // wipes again — the safe direction to be wrong in.
      if (avdName.startsWith(POOL_AVD_PREFIX)) this.poolTenants.set(avdName, p.app.id);
    } catch (err) {
      // bootEmulator launches QEMU detached and only *waits* here, so a throw —
      // abort or timeout — leaves an emulator running that nothing can address:
      // record.serial was never set, so teardown can't reach it either. Kill it
      // by the port we know before that port goes back in the pool, or the next
      // preview allocates 5554, collides, and streams the abandoned device.
      // Whether it died is NOT settled here — the claim made before the spawn already
      // says an emulator may exist under this name, and that claim is what stops
      // teardown and trimPool deleting the AVD of a process we may have failed to kill.
      //
      // The answer is deliberately thrown away HERE, unlike everywhere else this file
      // calls shutdown. `shutdown` returns `true` as soon as `adb get-state` fails, and
      // a boot that threw is in that state BY CONSTRUCTION: `adb wait-for-device` is the
      // step that would have made adb know this serial, and it is exactly the step that
      // did not finish. So `true` here means "adb never heard of it", not "the process
      // died" — spending it would clear the claim on evidence that does not exist, and
      // delete the sole handle (`pkill -f "avd <name>"`) on a live QEMU. The image is
      // reclaimed by the reaper's kill-then-delete at the next boot instead.
      await android.shutdown(serialForPort(port)).catch(() => {});
      this.androidPorts.delete(port);
      dev.androidPort = undefined;
      throw err;
    }
    dev.record.serial = serial;
    await this.abandonIfAborted(dev, async () => {
      // Same rule as teardownDevices: an emulator that has not confirmed it is gone keeps
      // its AVD. An aborted start_preview is the likeliest place to hit it — the emulator
      // finished booting milliseconds ago and is asked to die immediately.
      const stoppedCleanly = await android.shutdown(serial).catch(() => false);
      this.noteStopped(avdName, stoppedCleanly);
      if (!dev.poolName && stoppedCleanly) await android.deleteAvd(avdName).catch(() => {});
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
    const value = app.bundleId ?? (worktreePath ? detectBundleIdFromDir(worktreePath, app.type, platform === "android" ? "android" : "ios") : null);
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

  private platformGroups(p: LivePreview): Map<string, LiveDevice[]> {
    const groups = new Map<string, LiveDevice[]>();
    for (const dev of p.devices) {
      // A phone builds on its own: copying an emulator's APK onto someone's phone is an install
      // conflict waiting to happen, and the phone's build tool sees the phone's ABI.
      const key = dev.record.physical ? `phone:${dev.record.serial}` : dev.record.platform;
      const g = groups.get(key) ?? [];
      g.push(dev);
      groups.set(key, g);
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
    // A failed WEB device must stop serving, not just stop being reported as ready.
    //
    // attachWebAndReady inserts the stream into `p.attached` BEFORE it waits for the dev
    // server to answer, so a readiness timeout left a live dev server with an attached
    // stream and the preview in phase `failed`. The share proxy's web upstream resolver
    // only requires an attached stream — it never looks at the phase — so the dev server
    // stayed fully reachable. Combined with the PIN guard below, which skipped `failed`
    // previews, `set_pin remove:true` then made a still-serving web preview PUBLIC, which
    // is the exact state startPreview refuses to create.
    if (dev.record.platform === "web") {
      this.d.devProcs?.stop(devKey(p.app.id, "web"));
      const stream = p.attached.get(dev.record.deviceId);
      p.attached.delete(dev.record.deviceId);
      void stream?.detach().catch(() => {});
    }
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
    if (p.record.source === "eas") {
      await this.easGroup(p, group, (dev) => this.bootDevice(p, dev));
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
    // Expo's dev-client launch deep-links into Metro, which needs the app's slug.
    // Resolved once per build (launch() runs per device, so resolving there spawned
    // `expo config` N times for an N-device preview) — and only after the build,
    // since evaluating a dynamic app.config.* needs the project's own installed
    // Expo CLI, which doesn't exist in a fresh worktree until deps are installed.
    let slug: string | null = null;

    try {
      appEnv = this.appEnv(p.app);
      bundleId = this.resolveBundleId(p.app, sourceDir, platform);
      if (platform === "android") for (const dev of group) dev.appPackage = bundleId;
      builderHandle = await handleOf(0);
      await this.applyDevicePreferences(platform, builderHandle);

      // Mark the whole group building (non-builders wait on the shared build).
      for (const dev of group) {
        this.setPhase(p, dev, "building", dev === builder ? "building the app" : "building the app (shared)");
      }
      await this.freshBeforeInstall(p, builder, builderHandle);
      try {
        await this.runBuildPlan(p, builder, platform, builderHandle, sourceDir, appEnv, local);
      } catch (e) {
        if (!(e instanceof BuildStepFailed) || !(await this.resolveInstallConflict(p, builder, builderHandle, sourceDir, e.output))) throw e;
      }
      // Android only: its dev-client deep link carries the slug; iOS launches with --initialUrl.
      if (platform === "android" && usesMetroDeepLink(p.app.type)) slug = await this.resolveExpoSlug(sourceDir, appEnv);

      if (local && p.app.type === "nativescript") {
        if (Object.keys(this.launchArgs(p)).length) {
          throw new PreviewError(
            `environment "${p.environment!.name}" needs launch arguments, and a NativeScript livesync preview launches the app itself without them`,
            "preview this app from git (ref) instead, or from an EAS build",
            "environment_unsupported",
          );
        }
        // Livesync builds, installs, launches, then keeps watching for saves.
        this.setPhase(p, builder, "building", "first livesync build");
        this.startDevProcess(p, builder, platform, builderHandle, sourceDir, appEnv);
        this.setPhase(p, builder, "installing-app", "waiting for the app to install");
        await this.verifyInstalled(platform, builderHandle, bundleId, DEV_INSTALL_TIMEOUT_MS, () =>
          this.devProcessDead(p.app.id, platform),
        );
        await this.silenceDevOverlays(platform, builderHandle, bundleId);
      } else {
        this.setPhase(p, builder, "installing-app", "verifying install");
        await this.verifyInstalled(platform, builderHandle, bundleId);
        await this.silenceDevOverlays(platform, builderHandle, bundleId);
        await this.freshAfterInstall(p, builder, builderHandle);
        this.setPhase(p, builder, "launching", "launching app");
        await this.launch(p, builder, builderHandle, bundleId, sourceDir, appEnv, slug);
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
          await this.applyDevicePreferences(platform, handle);
          this.setPhase(p, dev, "installing-app", "installing");
          await this.freshBeforeInstall(p, dev, handle);
          await this.installProduct(platform, handle, appPath);
          await this.verifyInstalled(platform, handle, bundleId);
          await this.silenceDevOverlays(platform, handle, bundleId);
          await this.freshAfterInstall(p, dev, handle);
          this.setPhase(p, dev, "launching", "launching app");
          await this.launch(p, dev, handle, bundleId, sourceDir, appEnv, slug);
          await this.attachAndReady(p, dev, platform, handle);
        } catch (e) {
          this.failDevice(p, dev, e);
        }
      }),
    );
  }

  // --- eas source (a build EAS already made: no checkout, no build) ------------------

  private easTarget(dev: LiveDevice): EasTarget {
    if (dev.record.platform === "android") return "android";
    return dev.record.physical ? "ios-device" : "ios-simulator";
  }

  /** Resolve, download and vet one artifact kind once per preview run; every device of that kind shares it. */
  private easPrepare(p: LivePreview, target: EasTarget, bundleId: string, log: (line: string) => void): Promise<PreparedBuild> {
    p.easPrepared ??= new Map();
    let prep = p.easPrepared.get(target);
    if (!prep) {
      const eas = this.d.eas!;
      const projectId = this.easProjectFor(p.app)!;
      const profileFor = p.environment?.env.easProfile?.[easProfileKey(target)];
      prep = (async () => {
        const build = await eas.resolve(projectId, target, { buildId: p.eas?.buildId, profile: p.eas?.buildId ? undefined : (p.eas?.profile ?? profileFor) });
        return eas.prepare(projectId, target, build, bundleId, log);
      })();
      p.easPrepared.set(target, prep);
      prep.catch(() => p.easPrepared?.delete(target));
    }
    return prep;
  }

  /**
   * An eas group: the artifact is fetched and vetted before a phone is touched (an emulator or
   * simulator boots meanwhile — those are deckhand's own), then each device gets the same
   * install → verify → launch → attach as a built one, with no checkout and no build.
   */
  private async easGroup(p: LivePreview, group: LiveDevice[], boot: (dev: LiveDevice) => Promise<string>): Promise<void> {
    const platform = group[0]!.record.platform;
    const target = this.easTarget(group[0]!);
    let bundleId: string;
    try {
      bundleId = this.resolveBundleId(p.app, p.app.path ?? "", platform);
    } catch (e) {
      for (const dev of group) this.failDevice(p, dev, e);
      return;
    }
    for (const dev of group) {
      if (platform === "android" || dev.record.physical) dev.appPackage = bundleId;
      this.setPhase(p, dev, "preparing", "fetching the EAS build");
    }
    const prepP = this.easPrepare(p, target, bundleId, (line) => {
      for (const dev of group) this.appendLog(dev, "build", `[eas] ${line}`);
      this.noteProgress(p);
    });
    await Promise.all(
      group.map(async (dev) => {
        try {
          // The .ipa's profile must list this very phone before the phone is touched.
          const handleP = dev.record.physical
            ? prepP.then((prep) => {
                if (prep.ipa) vetIpa(prep.ipa, bundleId, dev.record.serial!, prep.build.id);
                return boot(dev);
              })
            : boot(dev);
          const [prep, handle] = await Promise.all([prepP, handleP]);
          await this.easInstallAndLaunch(p, dev, handle, prep);
        } catch (e) {
          this.failDevice(p, dev, e instanceof EasError ? new PreviewError(`${e.message}${e.hint ? `. ${e.hint}` : ""}`, e.hint, e.code) : e);
        }
      }),
    );
  }

  private async easInstallAndLaunch(p: LivePreview, dev: LiveDevice, handle: string, prep: PreparedBuild): Promise<void> {
    const platform = dev.record.platform;
    this.stillWanted(dev);
    this.setPhase(p, dev, "installing-app", `installing EAS build ${prep.build.id.slice(0, 8)}`);
    if (this.isIphone(dev)) {
      await this.installEasIpa(p, dev, prep);
    } else {
      await this.freshBeforeInstall(p, dev, handle);
      if (platform === "android") await this.installEasApk(p, dev, handle, prep);
      else await this.installProduct(platform, handle, prep.installPath);
      await this.verifyInstalled(platform, handle, prep.bundleId);
      await this.silenceDevOverlays(platform, handle, prep.bundleId);
      await this.freshAfterInstall(p, dev, handle);
    }
    this.stillWanted(dev);
    this.setPhase(p, dev, "launching", "launching app");
    await this.launchEas(p, dev, handle, prep);
    this.stillWanted(dev);
    await this.attachAndReady(p, dev, platform, handle);
  }

  /**
   * Skip the install when the phone already has this very artifact: same version, then the same
   * bytes (an e2e APK can declare one versionCode for every build). A signature or downgrade
   * conflict replaces the registered app, and the log says what went.
   */
  private async installEasApk(p: LivePreview, dev: LiveDevice, serial: string, prep: PreparedBuild): Promise<void> {
    const app = this.registeredApp(dev, serial);
    const before = await app.installed(app.pkg);
    if (before && before.versionCode === prep.versionCode && before.versionName === prep.versionName) {
      const [theirs, ours] = await Promise.all([app.installedApkSha256(app.pkg), sha256File(prep.installPath)]);
      if (theirs && theirs === ours) {
        this.appendLog(dev, "build", `deckhand: ${app.pkg} ${prep.versionName ?? "?"} (${prep.versionCode ?? "?"}) from EAS build ${prep.build.id} is already installed — not reinstalling`);
        return;
      }
    }
    this.appendLog(dev, "build", `deckhand: installing ${app.pkg} ${prep.versionName ?? "?"} (${prep.versionCode ?? "?"}) from EAS build ${prep.build.id}${before ? ` over ${before.versionName ?? "?"} (${before.versionCode ?? "?"})` : ""}`);
    try {
      await app.install(app.pkg, prep.installPath);
    } catch (e) {
      if (!(e instanceof InstallConflictError)) throw e;
      this.appendLog(
        dev,
        "build",
        `deckhand: ${e.message} — uninstalling ${app.pkg} ${before?.versionName ?? "?"} (versionCode ${before?.versionCode ?? "?"}, installer ${before?.installer ?? "?"}, first installed ${before?.firstInstallTime ?? "?"}) and installing EAS build ${prep.build.id}. No other app on the device is touched.`,
      );
      this.setPhase(p, dev, "installing-app", `reinstalling ${app.pkg} (${e.kind === "signature" ? "signed with another key" : "newer version on the device"})`);
      await app.uninstall(app.pkg);
      await app.install(app.pkg, prep.installPath);
      this.d.audit.record({ actor: "engine", tool: "phone_reinstall", args: { preview: p.record.previewId, device: dev.record.deviceId, package: app.pkg, reason: e.kind, build: prep.build.id }, result: "ok" });
    }
  }

  /**
   * The .ipa onto the iPhone, through the registered app's handle only. A signer/team/version
   * conflict uninstalls the registered app — the operator allows that for the app under test — and
   * installs again; the log says what went. iOS has no clear-data, so either freshApp is a reinstall.
   */
  private async installEasIpa(p: LivePreview, dev: LiveDevice, prep: PreparedBuild): Promise<void> {
    const apps = this.iphoneApps(dev);
    const before = await apps.installedApp();
    const describeApp = (a: typeof before) => (a ? `${a.version ?? "?"} (${a.bundleVersion ?? "?"})` : "none");
    if (p.freshApp && !dev.freshApplied) {
      if (before) {
        this.appendLog(dev, "build", `deckhand: freshApp=${p.freshApp} — uninstalling ${apps.bundleId} ${describeApp(before)} before installing (iOS cannot clear an app's data in place)`);
        await apps.uninstall(apps.bundleId);
      }
      // Recorded after the uninstall: one that threw is tried again by a restart.
      dev.freshApplied = true;
    }
    this.appendLog(dev, "build", `deckhand: installing ${apps.bundleId} ${prep.versionName ?? "?"} (${prep.versionCode ?? "?"}) from EAS build ${prep.build.id}; on the phone now: ${describeApp(before)}`);
    try {
      await apps.install(prep.installPath);
    } catch (e) {
      if (!(e instanceof IphoneAppError) || e.code !== "install_conflict") throw this.iphoneAppError(e);
      this.appendLog(dev, "build", `deckhand: ${e.message.slice(0, 300)} — uninstalling ${apps.bundleId} ${describeApp(before)} and installing EAS build ${prep.build.id}. No other app on the phone is touched.`);
      this.setPhase(p, dev, "installing-app", `reinstalling ${apps.bundleId} (signed differently or newer on the phone)`);
      await apps.uninstall(apps.bundleId);
      await apps.install(prep.installPath).catch((e2: unknown) => {
        throw this.iphoneAppError(e2);
      });
      this.d.audit.record({ actor: "engine", tool: "phone_reinstall", args: { preview: p.record.previewId, device: dev.record.deviceId, package: apps.bundleId, reason: "install_conflict", build: prep.build.id }, result: "ok" });
    }
    const after = await apps.installedApp();
    if (!after) throw new PreviewError(`app ${apps.bundleId} did not appear installed on the iPhone`, "read the build log (logs source=build)");
    dev.appProcess = executableFromAppUrl(after.url) ?? undefined;
  }

  private iphoneAppError(e: unknown): unknown {
    return e instanceof IphoneAppError ? new PreviewError(e.message, e.hint, e.code === "not_provisioned" ? "eas_not_provisioned" : e.code === "foreign_bundle" ? "eas_wrong_app" : "iphone_install_failed") : e;
  }

  /** Launch with the environment's arguments; a dev-client build is pointed at its channel's newest update. */
  private async launchEas(p: LivePreview, dev: LiveDevice, handle: string, prep: PreparedBuild): Promise<void> {
    const args = this.launchArgs(p);
    const hasArgs = Object.keys(args).length > 0;
    const mapped = p.environment?.env.easProfile?.[easProfileKey(prep.target)];
    const note = p.environment && mapped && prep.build.buildProfile !== mapped ? `the build is EAS profile "${prep.build.buildProfile ?? "?"}", not "${mapped}", the profile environment "${p.environment.name}" maps` : undefined;
    dev.env = { source: hasArgs ? "launch-args" : mapped && prep.build.buildProfile === mapped ? "eas-profile" : "build-default", verified: false, ...(note ? { note } : {}) };
    const link = prep.build.developmentClient ? await this.devClientLink(prep) : null;
    dev.devClient = link?.note;
    if (link?.note) this.appendLog(dev, "build", `deckhand: ${link.note}`);
    dev.launchedAt = this.d.now!();
    if (dev.record.platform === "android") {
      const app = this.registeredApp(dev, handle);
      if (link?.url) {
        await app.forceStop(app.pkg);
        await app.openUrl(app.pkg, link.url, androidExtras(args));
      } else {
        await app.launch(app.pkg, androidExtras(args));
      }
      return;
    }
    if (this.isIphone(dev)) {
      await this.launchIphone(dev, args, link?.url ?? undefined);
      return;
    }
    const launchArgs = iosLaunchArgs(args);
    await this.d.simctl.launch(handle, prep.bundleId, { args: launchArgs, terminateRunning: launchArgs.length > 0 });
    if (link?.url) await this.d.simctl.openUrl(handle, link.url);
  }

  /**
   * Syslog first — it only streams, it cannot read the past — then a fresh launch of the registered
   * app with the environment's `-KEY value` arguments and, for a dev client, the update link as its
   * payload (a payload goes to this app, where an openUrl could reach another).
   */
  private async launchIphone(dev: LiveDevice, args: Record<string, string>, payloadUrl: string | undefined): Promise<void> {
    const apps = this.iphoneApps(dev);
    dev.syslog?.stop();
    dev.syslog = this.iphones().syslog(dev.record.serial!, dev.appProcess);
    dev.syslog.start();
    dev.launchedAt = this.d.now!();
    try {
      this.stillWanted(dev);
      await apps.launch(apps.bundleId, { args, ...(payloadUrl ? { payloadUrl } : {}) });
      this.stillWanted(dev);
    } catch (e) {
      dev.syslog?.stop();
      dev.syslog = undefined;
      throw this.iphoneAppError(e);
    }
  }

  /** The newest update on the build's own channel, as a dev-client link — or why there is none. */
  private async devClientLink(prep: PreparedBuild): Promise<{ url: string | null; note: string }> {
    const b = prep.build;
    const launcher = "it opens the Expo dev launcher instead of the app — deckhand's packaging, not an app bug";
    if (!b.updateChannel) return { url: null, note: `dev launcher: this dev-client build has no EAS Update channel, so ${launcher}. Preview a build with a channel, or a non-dev-client profile.` };
    const eas = this.d.eas!;
    const update = await eas.latestUpdate(prep.projectId, b);
    if (!update) return { url: null, note: `dev launcher: no EAS Update for runtime ${b.runtime?.version ?? "?"} on channel "${b.updateChannel.name}", so ${launcher}. Publish one with eas update.` };
    const scheme = prep.schemes.find((x) => x.startsWith("exp+")) ?? `exp+${await eas.projectSlug(prep.projectId)}`;
    return {
      url: devClientUpdateUrl(scheme, prep.projectId, update.group),
      note: `dev client: loading EAS Update ${update.group} (branch ${update.branchName}, ${update.createdAt}) from channel "${b.updateChannel.name}"`,
    };
  }

  // --- environment ------------------------------------------------------------------

  private envReport(p: LivePreview, dev: LiveDevice): EnvironmentReport {
    if (!p.environment) return { name: null, source: "unknown", verified: false, note: "this app declares no environments, so which backend it talks to is unknown" };
    const marker = p.environment.env.logMarker;
    const planned: EnvironmentSource = Object.keys(this.launchArgs(p)).length ? "launch-args" : p.record.source === "eas" && p.environment.env.easProfile ? "eas-profile" : "build-default";
    const notes = [dev.env?.note, marker && dev.record.platform === "ios" && !dev.record.physical ? "an iOS simulator's app log is not captured, so the marker cannot be checked there" : undefined].filter(Boolean);
    return {
      name: p.environment.name,
      source: dev.env?.source ?? planned,
      verified: marker ? (dev.env?.verified ?? false) : "no-marker",
      ...(notes.length ? { note: notes.join("; ") } : {}),
    };
  }

  /** Watch the app log for the environment's marker for a while after launch (Android, and a physical iPhone's syslog). */
  private watchEnvironment(p: LivePreview, dev: LiveDevice): void {
    const marker = p.environment?.env.logMarker;
    if (!marker || !this.hasAppLog(dev) || !dev.env || dev.env.verified) return;
    const until = this.d.now!() + ENV_MARKER_WAIT_MS;
    void (async () => {
      while (this.d.now!() < until && dev.record.phase === "ready" && !dev.abort.signal.aborted) {
        if (await this.checkMarker(p, dev).catch(() => false)) return;
        await new Promise((r) => setTimeout(r, 3_000).unref());
      }
    })().catch(() => {});
  }

  private async checkMarker(p: LivePreview, dev: LiveDevice, lines?: readonly string[]): Promise<boolean> {
    const marker = p.environment?.env.logMarker;
    if (!marker || !dev.env) return false;
    if (dev.env.verified) return true;
    const seen = markerSeen(marker, lines ?? (await this.appLogLines(p, dev)).lines);
    if (seen) {
      dev.env.verified = true;
      this.appendLog(dev, "build", `deckhand: environment "${p.environment!.name}" verified — the app log matched ${marker}`);
    }
    return seen;
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
      owner: p.record.previewId,
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
    return `livesync process ${this.devProcs().exitReason(key)}`;
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
      owner: p.record.previewId,
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

  /** The guarded handle on this device's registered app; never another package. */
  private registeredApp(dev: LiveDevice, serial: string): RegisteredApp {
    if (!dev.appPackage) throw new PreviewError("the app's Android package is not resolved yet");
    return this.whileWanted(dev, this.phones().registeredApp(serial, dev.appPackage), ["install", "uninstall", "clearData", "launch", "openUrl"]);
  }

  /** `freshApp: "reinstall"`: the registered app goes before the build installs it again. Android only. */
  private async freshBeforeInstall(p: LivePreview, dev: LiveDevice, serial: string): Promise<void> {
    if (p.freshApp !== "reinstall" || dev.freshApplied || dev.record.platform !== "android") return;
    const app = this.registeredApp(dev, serial);
    const before = await app.installed(app.pkg);
    if (before) {
      this.appendLog(dev, "build", `deckhand: freshApp=reinstall — uninstalling ${app.pkg} ${before.versionName ?? "?"} (${before.versionCode ?? "?"}) before installing this build`);
      await app.uninstall(app.pkg);
    }
    // Recorded after the uninstall: one that threw is tried again by a restart.
    dev.freshApplied = true;
  }

  /** `freshApp: "data"`: the installed app's data and signed-in session are cleared before launch. Android only. */
  private async freshAfterInstall(p: LivePreview, dev: LiveDevice, serial: string): Promise<void> {
    if (p.freshApp !== "data" || dev.freshApplied || dev.record.platform !== "android") return;
    const app = this.registeredApp(dev, serial);
    this.appendLog(dev, "build", `deckhand: freshApp=data — clearing ${app.pkg}'s data before launch`);
    await app.clearData(app.pkg);
    // Recorded after the clear: a clear that threw is tried again by a restart, not skipped.
    dev.freshApplied = true;
  }

  /**
   * A phone already holding the registered app signed with another key, or at a higher version,
   * refuses the build's install. That app — and only that app — is uninstalled and this build
   * installed, and the log says what was removed. Anything else stays a failed build.
   * Returns whether it resolved the failure.
   */
  private async resolveInstallConflict(p: LivePreview, dev: LiveDevice, serial: string, sourceDir: string, stepOutput: readonly string[]): Promise<boolean> {
    if (!dev.record.physical || !dev.appPackage) return false;
    const conflict = classifyInstallFailure(stepOutput.join("\n"));
    if (!(conflict instanceof InstallConflictError)) return false;
    const apk = await this.android().findApk(sourceDir);
    if (!apk) return false;
    const app = this.registeredApp(dev, serial);
    const before = await app.installed(app.pkg);
    this.appendLog(
      dev,
      "build",
      `deckhand: ${conflict.message} — uninstalling ${app.pkg} ${before?.versionName ?? "?"} (versionCode ${before?.versionCode ?? "?"}, installer ${before?.installer ?? "?"}, first installed ${before?.firstInstallTime ?? "?"}) and installing this build. No other app on the phone is touched.`,
    );
    this.setPhase(p, dev, "installing-app", `reinstalling ${app.pkg} (${conflict.kind === "signature" ? "signed with another key" : "newer version on the phone"})`);
    await app.uninstall(app.pkg);
    await app.install(app.pkg, apk);
    this.d.audit.record({ actor: "engine", tool: "phone_reinstall", args: { preview: p.record.previewId, device: dev.record.deviceId, package: app.pkg, reason: conflict.kind }, result: "ok" });
    return true;
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
      const output: string[] = [];
      const res = await this.d.runStep!(step, {
        signal: dev.abort.signal,
        onLog: (line) => {
          if (output.push(line) > LOG_CAP) output.shift();
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
        throw new BuildStepFailed(
          `build step "${step.name}" failed${res.timedOut ? " (idle timeout)" : ""}${res.aborted ? " (aborted)" : ""}` +
            (cause ? ` — ${cause}` : ""),
          output,
        );
      }
    }
  }

  /**
   * Write Expo's launch-overlay preferences off, wherever the app just landed.
   *
   * There are three install paths (builder + dev process, builder + plain install, and the
   * copy to the group's other devices) and the first version of this patched exactly one of
   * them — the one an Expo preview does NOT take. It shipped green, and the overlays were
   * still there on the next fresh simulator. Hence one helper, called from all three, right
   * after the app is verified installed: that is the moment its preference domain exists.
   *
   * Best-effort by design; see Simctl.silenceDevOverlays for what is written and why a
   * permission alert is deliberately not on the list.
   */
  private async silenceDevOverlays(platform: Platform, handle: string, bundleId: string): Promise<void> {
    if (platform !== "ios") return;
    await this.d.simctl.silenceDevOverlays(handle, bundleId).catch(() => {});
  }

  // Before the build, not beside the overlays: local livesync launches the app itself, and the app reads this at launch.
  private async applyDevicePreferences(platform: Platform, handle: string): Promise<void> {
    if (platform === "ios" && this.d.config.ios?.reduceTransparency) await this.d.simctl.reduceTransparency(handle).catch(() => {});
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
        this.watchEnvironment(p, dev);
        return;
      }
      this.streamLog(dev, `kept helper at ${kept.origin}${kept.helperBasePath} is not answering — re-attaching`);
      p.attached.delete(dev.record.deviceId);
      await kept.detach().catch(() => {});
    }
    const ref = platform === "android" ? { platform, udid: handle, serial: handle } : { platform, udid: handle, ...(dev.record.physical ? { physical: true } : {}) };
    // Retry a SILENT first frame with a fresh helper. A helper that comes up and
    // then produces nothing is recoverable by discarding it and asking again —
    // which is what the viewer already does on its side, and what the server did
    // not do at all. One bad attempt used to leave the pane reading "This device
    // didn't start" for the life of the preview, curable only by restart_preview.
    for (let attempt = 1; attempt <= FIRST_FRAME_ATTEMPTS; attempt++) {
      const t0 = this.d.now!();
      let stream: AttachedStream;
      try {
        stream = await this.d.streaming.attach(ref);
      } catch (e) {
        // An attach that THROWS is a different failure (no helper binary, no
        // adb) and retrying only reproduces it — surface it now.
        this.streamLog(dev, `attach FAILED after ${this.d.now!() - t0}ms: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }
      this.streamLog(dev, `attached in ${this.d.now!() - t0}ms → ${stream.origin}${stream.helperBasePath}`);
      p.attached.set(dev.record.deviceId, stream);
      const t1 = this.d.now!();
      const framed = await stream.waitForFirstFrame();
      this.streamLog(
        dev,
        `first frame ${framed ? "ok" : "NOT SEEN"} after ${this.d.now!() - t1}ms (attempt ${attempt}/${FIRST_FRAME_ATTEMPTS})`,
      );
      if (framed) {
        this.setPhase(p, dev, "ready", undefined);
        this.watchEnvironment(p, dev);
        return;
      }
      // Discard the helper before retrying: `attach` is idempotent per device,
      // so without this the next attempt is handed the same silent one back.
      p.attached.delete(dev.record.deviceId);
      await stream.detach().catch(() => {});
      if (dev.abort.signal.aborted) return;
    }
    throw new PreviewError(
      `stream attached but produced no first frame (${FIRST_FRAME_ATTEMPTS} attempts)`,
      "read the device's `stream` log (logs tool, source=stream) — it records the helper URL and every probe",
    );
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

  /**
   * The Expo slug that the dev-client deep link is built from. Resolved through
   * app.config.* when the project has one (see resolveExpoConfigFromDir), with the
   * evaluation failure surfaced as the error's hint — otherwise a broken
   * app.config.js reads as a bare "could not resolve the slug".
   */
  private async resolveExpoSlug(sourceDir: string, appEnv: Record<string, string>): Promise<string> {
    const { config, error } = await resolveExpoConfigFromDir(sourceDir, appEnv);
    const slug = expoSlug(config);
    if (slug) return slug;
    throw new PreviewError(
      "could not resolve the Expo slug from app.json or app.config.*",
      error
        ? `\`expo config --json\` failed in ${sourceDir}: ${error}`
        : `add a slug to app.json, or make sure \`expo config --json\` runs in ${sourceDir}`,
    );
  }

  private async launch(
    p: LivePreview,
    dev: LiveDevice,
    handle: string,
    bundleId: string,
    worktreePath: string,
    appEnv: Record<string, string>,
    /** Pre-resolved Expo slug (once per build); required for metro-deep-link apps on Android. */
    slug: string | null,
  ): Promise<void> {
    if (dev.record.physical) this.stillWanted(dev);
    const args = this.launchArgs(p);
    const hasArgs = Object.keys(args).length > 0;
    dev.env = { source: hasArgs ? "launch-args" : "build-default", verified: false };
    if (dev.record.platform === "android") {
      dev.launchedAt = this.d.now!();
      if (usesMetroDeepLink(p.app.type)) {
        if (!slug) throw new PreviewError("could not resolve the Expo slug from app.json or app.config.*");
        const metro = await this.d.metro.ensure(p.app.id, worktreePath, appEnv);
        await this.reverseMetroPorts(dev, handle, metro.port);
        if (dev.record.physical || hasArgs) {
          // Addressed to the registered app, so no other dev client on the phone can answer the link.
          const app = this.registeredApp(dev, handle);
          await app.forceStop(app.pkg);
          await app.openUrl(app.pkg, expoDevClientUrl(slug, `http://localhost:${metro.port}`), androidExtras(args));
          return;
        }
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
      if (hasArgs) {
        const app = this.registeredApp(dev, handle);
        await app.launch(app.pkg, androidExtras(args));
        return;
      }
      // The build already launched the builder; (re)launch is idempotent and
      // covers install-many devices.
      await this.android().launch(handle, bundleId);
      return;
    }
    if (usesMetroDeepLink(p.app.type)) {
      const metro = await this.d.metro.ensure(p.app.id, worktreePath, appEnv);
      // A cold start told its server by launch argument, not a deep link. expo-dev-launcher reads
      // `--initialUrl <url>` from its process arguments and loads that bundle (on a simulator it skips
      // the local-network gate). A deep link instead (a) makes iOS 27 ask "Open in «App»?" — a
      // system alert that sat over the app until someone tapped it — and (b) lands in a process
      // `expo run:ios` already started on its own LAN-IP URL, whose failed first load and dev menu
      // stayed on screen. Restarting the process reads the dev-menu preferences written just
      // before (silenceDevOverlays) and leaves nothing of that first load behind.
      await this.d.simctl.launch(handle, bundleId, { terminateRunning: true, args: [...iosLaunchArgs(args), "--initialUrl", metro.manifestUrl] });
    } else {
      await this.d.simctl.launch(handle, bundleId, { args: iosLaunchArgs(args), terminateRunning: hasArgs });
    }
  }

  /** The launch arguments of the preview's environment; none when it declares none. */
  private launchArgs(p: LivePreview): Record<string, string> {
    return p.environment?.env.launchArgs ?? {};
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
    // A verdict is a claim about a build, and this replaces the build.
    this.clearTestRun(previewId);
    for (const dev of p.devices) {
      if (!dev.lost) continue;
      dev.lost = false;
      dev.abort = new AbortController();
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
    if (p.record.source === "eas") {
      // A profile's newest build is looked up again: a restart is how a new EAS build reaches the device.
      p.easPrepared = new Map();
      await Promise.all(
        [...this.platformGroups(p).values()].map((group) => {
          for (const dev of group) {
            dev.record.error = undefined;
            dev.record.phase = "pending";
            dev.env = undefined;
          }
          return this.easGroup(p, group, async (dev) => {
            const h = this.handle(dev);
            if (!h) throw new PreviewError("device was never booted", "stop this preview and start a new one to boot fresh devices");
            return h;
          });
        }),
      );
      return;
    }
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
          dev.record.phase = "pending";
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
      environment: p.record.devices.some((d) => d.platform === "web") ? null : combineReports(p.devices.map((dv) => this.envReport(p, dv))),
      devices: p.devices.map((dv) => ({
        deviceId: dv.record.deviceId,
        label: dv.record.label,
        phase: dv.record.phase,
        detail: dv.record.detail,
        step: dv.record.step,
        error: dv.record.error,
        logTail: dv.record.phase === "failed" ? dv.logs.build.slice(-20).join("\n") : undefined,
        ...(dv.record.platform === "web" ? {} : { environment: this.envReport(p, dv) }),
        ...(dv.devClient ? { devClient: dv.devClient } : {}),
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

  /**
   * The `app` log on an Android device: logcat since the app was launched, filtered to its pids and
   * to the system's crash lines about it, in the Mac's clock, headed by whether the process is
   * running now. Facts only — whether the run passed is the caller's call.
   */
  async appLog(previewId: string, deviceId: string | undefined, tailLines = 200): Promise<string | null> {
    const p = this.active(previewId);
    if (!p) return null;
    const dev = deviceId ? p.devices.find((d) => d.record.deviceId === deviceId) : p.devices[0];
    if (!dev) return null;
    if (!this.hasAppLog(dev)) {
      throw new PreviewError("the `app` log is captured on Android devices and physical iPhones only", "on an iOS simulator read source `build` or `stream`");
    }
    if (this.isIphone(dev)) return this.iphoneAppLog(p, dev, tailLines);
    const { lines, pids, pkg } = await this.appLogLines(p, dev);
    await this.checkMarker(p, dev, lines).catch(() => false);
    const fact = pids.length ? `process ${pkg}: running (pid ${pids.join(", ")})` : `process ${pkg}: NOT running`;
    return [fact, ...lines.slice(-tailLines)].join("\n");
  }

  private hasAppLog(dev: LiveDevice): boolean {
    return dev.record.platform === "android" || this.isIphone(dev);
  }

  /** The app's own syslog lines and the crash reporter's about it, headed by whether it runs and any crash markers. */
  private async iphoneAppLog(p: LivePreview, dev: LiveDevice, tailLines: number): Promise<string> {
    const { lines } = await this.appLogLines(p, dev);
    await this.checkMarker(p, dev, lines).catch(() => false);
    const apps = this.iphoneApps(dev);
    const running = await apps.isRunning().catch(() => null);
    const crashes = dev.syslog?.crashes(apps.bundleId) ?? [];
    const head = [
      `process ${apps.bundleId} (${dev.appProcess ?? "?"}): ${running === null ? "unknown (devicectl did not answer)" : running ? "running" : "NOT running"}`,
      ...(crashes.length ? [`crash markers: ${crashes.length} — last: ${syslogText(crashes.at(-1)!)}`] : []),
      ...(dev.syslog?.ended ? [`syslog: ${dev.syslog.ended}`] : []),
    ];
    return [...head, ...lines.slice(-tailLines)].join("\n");
  }

  private async appLogLines(p: LivePreview, dev: LiveDevice): Promise<{ lines: string[]; pids: number[]; pkg: string }> {
    if (this.isIphone(dev)) {
      if (!dev.syslog || !dev.appPackage) throw new PreviewError("the app has not been launched on this iPhone yet, so it has no log", "wait for preview_status to report the device ready");
      const lines = dev.appProcess ? dev.syslog.lines({ process: dev.appProcess }) : [];
      return { lines: lines.map(syslogText), pids: [...new Set(lines.map((l) => l.pid))], pkg: dev.appPackage };
    }
    const serial = dev.record.serial;
    if (!serial || !dev.appPackage) throw new PreviewError("the app is not on this device yet, so it has no log", "wait for preview_status to report the device ready");
    const offset = (await this.phones().clockOffsetMs(serial).catch(() => null)) ?? dev.clockOffsetMs ?? 0;
    const app = this.phones().registeredApp(serial, dev.appPackage);
    const { lines, pids } = await app.log(app.pkg, dev.launchedAt ?? Date.parse(p.record.createdAt), offset);
    return { lines, pids, pkg: app.pkg };
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
   * Whether a preview is a pane booted alongside a page — deliberately not backed
   * by an app in apps.yaml, which is the only case where "no app found" is
   * legitimate rather than a reason to deny.
   *
   * A pane is NOT public. It takes the page's access, and its synthetic app id is
   * keyed by access class so a public page and a protected one never land on the
   * same pane. This said "deliberately public" until 2026-08-08, and that sentence
   * is what made `set_pin { previewId: <pane>, remove: true }` look harmless — it
   * published a protected page's pane, reproduced and fixed the same day. If you
   * are reading this to decide whether a pane needs guarding: it does.
   * → `server.test.ts` "refuses to set or remove a PIN on a pane"
   */
  isReference(previewId: string): boolean {
    return this.previews.get(previewId)?.record.reference === true;
  }

  /** Whether some preview of this app is live right now (a reference pane about to be reused). */
  hasLivePreviewForApp(appId: string): boolean {
    return this.livePreviewForApp(appId) !== null;
  }

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

  /**
   * The most recent FAILED preview of an app, while it is still in memory.
   *
   * A build that fails is kept for `limits.failedGraceMinutes` precisely so it can be
   * read and rebuilt — its phase, its device error and its build log are all still
   * there, and the viewer shows them. But every tool that addresses a preview by APP
   * id goes through `livePreviewForApp`, which skips `failed`, so the MCP surface
   * answered `no_preview` — "no running preview … call start_preview to boot one" —
   * about a preview that had just failed and was holding the reason why.
   *
   * The cost, measured 2026-08-28: five previews of one app failed in `install-deps`,
   * and the `logs` call that would have named the cause was REFUSED as `no_preview`
   * each time, while the viewer displayed the npm error plainly. The agent read the
   * refusal as "it never started", started another, and the cycle repeated for half
   * an hour. A preview that DIED and one that was never started are not the same
   * fact and must not share an answer.
   *
   * Deliberately NOT folded into `livePreviewForApp`: that one decides whether an app
   * is live for pane REUSE (`hasLivePreviewForApp`) and whether a checkout may be
   * deleted (`remove_app`), and a failed preview is correctly "not live" for both.
   * This is a lookup for READING and REBUILDING, and only `resolvePreviewId` uses it.
   */
  failedPreviewIdForApp(appId: string): string | null {
    let best: LivePreview | null = null;
    for (const p of this.previews.values()) {
      if (p.record.appId !== appId || p.record.phase !== "failed") continue;
      if (!best || p.record.createdAt > best.record.createdAt) best = p;
    }
    return best?.record.previewId ?? null;
  }

  /**
   * Live reference panes built from the same source as `app`, and the page each
   * one is shown on.
   *
   * A pane runs under a SYNTHETIC app id keyed by CONTENT (`app:<id>`,
   * `repo:<r>@<ref>`, …), never by the app it came from — so `previewIdForApp`
   * structurally cannot find one. An agent that put the old app on the page with
   * `alongside`, then asked "is that app running?", was told no while its pane
   * was on screen; the documented next step was `start_preview`, which booted a
   * SECOND set of simulators on a second share link. The duplicate then looked
   * right to drive and was invisible in the viewer, because the page streams the
   * pane. Answering the question truthfully is what stops that.
   *
   * Matched on the build source rather than the synthetic id, so it covers every
   * `alongside` kind: `{app}` and `{worktree}` panes carry the path, `{repo,ref}`
   * panes carry the repo.
   */
  referencePanesFor(app: App): { previewId: string; shareId: string; ref: string; onPreviewId: string | null }[] {
    const panes: { previewId: string; shareId: string; ref: string; onPreviewId: string | null }[] = [];
    for (const p of this.previews.values()) {
      const ph = p.record.phase;
      if (p.record.reference !== true || ph === "stopped" || ph === "failed" || ph === "stopping") continue;
      const sameSource = app.path ? p.app.path === app.path : Boolean(app.repo) && p.app.repo === app.repo;
      if (!sameSource) continue;
      panes.push({
        previewId: p.record.previewId,
        shareId: p.record.shareId,
        ref: p.record.ref,
        onPreviewId: this.pageShowingPane(p.record.previewId),
      });
    }
    return panes;
  }

  /** The working preview whose compare session shows this pane, if any. */
  pageShowingPane(paneId: string): string | null {
    for (const p of this.previews.values()) {
      if (p.record.phase === "stopped") continue;
      if (p.compare?.references.some((r) => r.previewId === paneId)) return p.record.previewId;
    }
    return null;
  }

  /** The live (non-terminal) preview carrying a given shareId, if any. */
  private liveByShareId(shareId: string): LivePreview | null {
    for (const p of this.previews.values()) {
      const ph = p.record.phase;
      if (p.record.shareId === shareId && ph !== "stopped" && ph !== "failed") return p;
    }
    return null;
  }

  /**
   * Enumerate available iOS runtimes/models, Android API levels, current capacity, and the
   * phones cabled to this Mac with what blocks each.
   */
  async listDevices(): Promise<{
    ios: { runtimes: { version: string; name: string; models?: string[] }[]; models: string[] };
    android: { apiLevels: number[] };
    physical: PhysicalListing;
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
        runtimes: runtimes
          .filter((r) => r.isAvailable)
          .map((r) => ({
            version: r.version,
            name: r.name,
            ...(r.supportedDeviceTypes ? { models: supportedBy(r, deviceTypes).map((d) => d.name) } : {}),
          })),
        models: deviceTypes.map((d) => d.name),
      },
      android: { apiLevels },
      physical: await this.listPhones(),
      capacity: { inUse, max: this.d.config.limits.maxTotalDevices },
    };
  }

  /**
   * The phones plugged into this Mac that a preview could take: each is either targetable now, or
   * names its one blocker and the action that clears it. A failed adb is said, not shown as "none".
   */
  async listPhones(): Promise<PhysicalListing> {
    let phones;
    let holds: PhoneHolds;
    const iphonesP = this.listIphones();
    try {
      phones = await this.phones().list();
      holds = this.holds();
    } catch (e) {
      const ios = await iphonesP;
      return { phones: ios.phones, unavailable: `could not list phones: ${e instanceof Error ? e.message : String(e)}`, ...(ios.unavailable ? { iphonesUnavailable: ios.unavailable } : {}) };
    }
    const ios = await iphonesP;
    return {
      phones: [
        ...phones.map((info): PhoneListing => {
          const base = { id: info.id, platform: "android" as const, ...(info.model ? { model: [info.manufacturer, info.model].filter(Boolean).join(" ") } : {}), ...(info.os ? { os: info.os } : {}) };
          const blocked = usabilityBlocker(info) ?? this.phoneBusyBlocker(info.id, holds);
          return blocked ? { ...base, targetable: false, ...blocked } : { ...base, targetable: true };
        }),
        ...ios.phones,
      ],
      ...(ios.unavailable ? { iphonesUnavailable: ios.unavailable } : {}),
    };
  }

  /** Cabled iPhones with discovery's blockers (and a failed WDA start), then holds and tenancy. */
  private async listIphones(): Promise<{ phones: PhoneListing[]; unavailable?: string }> {
    try {
      const found = await this.iphones().list();
      const holds = this.holds();
      return {
        phones: found.map((ph): PhoneListing => {
          const base = { id: ph.udid, platform: "ios" as const, ...(ph.model ? { model: ph.model } : {}), ...(ph.osVersion ? { os: `iOS ${ph.osVersion}` } : {}) };
          const blocked = ph.blockers.length ? splitBlocker(ph.blockers[0]!) : this.phoneBusyBlocker(ph.udid, holds);
          if (blocked && ph.blockers.length > 1) blocked.fix = `${blocked.fix}; then also: ${ph.blockers.slice(1).join("; ")}`;
          return blocked ? { ...base, targetable: false, ...blocked } : { ...base, targetable: true };
        }),
      };
    } catch (e) {
      return { phones: [], unavailable: `could not list iPhones: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  private phoneBusyBlocker(serial: string, holds: PhoneHolds): { blocker: string; fix: string } | null {
    const e = this.phoneBusy(serial, holds);
    return e ? { blocker: e.message, fix: e.hint ?? "" } : null;
  }

  /**
   * Turn `{physical: true}` into a serial: the phone this app's live preview already has, else the
   * first targetable phone. A named serial is checked by startPreview itself.
   */
  async resolvePhoneRequests(app: App, devices: (DeviceRequest & { physical?: boolean })[]): Promise<DeviceRequest[]> {
    if (!devices.some((d) => d.physical && !d.serial)) return devices.map(({ physical: _p, ...d }) => d);
    const mine = new Set<string>();
    for (const p of this.previews.values()) {
      if (p.record.appId !== app.id || p.record.phase === "stopped" || p.record.phase === "failed") continue;
      for (const d of p.devices) if (d.record.physical && d.record.serial) mine.add(d.record.serial);
    }
    const listing = await this.listPhones();
    const taken = new Set(devices.flatMap((d) => (d.serial ? [d.serial] : [])));
    const out: DeviceRequest[] = [];
    for (const { physical, ...d } of devices) {
      if (!physical || d.serial) {
        out.push(d);
        continue;
      }
      const ios = d.platform === "ios";
      const unavailable = ios ? listing.iphonesUnavailable : listing.unavailable;
      if (unavailable) throw new PreviewError(unavailable, ios ? "check that `xcrun devicectl list devices` works on the deckhand Mac" : "check that `adb devices` works on the deckhand Mac", "no_phone");
      const same = listing.phones.filter((ph) => ph.platform === (ios ? "ios" : "android"));
      const ids = new Set(same.map((ph) => ph.id));
      const pick = [...mine].find((s) => ids.has(s) && !taken.has(s)) ?? same.find((ph) => ph.targetable && !taken.has(ph.id))?.id;
      if (!pick) {
        const why = same.length
          ? same.map((ph) => `${ph.id}${ph.model ? ` (${ph.model})` : ""}: ${ph.targetable ? "taken by this request" : `${ph.blocker} — ${ph.fix}`}`).join("; ")
          : ios
            ? "no iPhone is cabled to this Mac (devicectl lists none paired)"
            : "no phone is plugged into this Mac (adb lists none)";
        throw new PreviewError(`no free ${ios ? "iPhone" : "Android phone"}: ${why}`, `fix the blocker named above, or ask for ${ios ? "a simulator" : "an emulator"} instead`, "no_phone");
      }
      taken.add(pick);
      out.push({ ...d, platform: ios ? "ios" : "android", serial: pick });
    }
    return out;
  }

  /**
   * Ask adb, not the bookkeeping: a phone that left adb (unplugged, revoked, offline) ends its
   * device with an error instead of a `ready` that no longer drives anything.
   */
  async checkPhones(): Promise<string[]> {
    const lost: string[] = [];
    for (const p of this.previews.values()) {
      if (p.record.phase === "stopped" || p.record.phase === "stopping") continue;
      for (const dev of p.devices) {
        if (!dev.record.physical || !dev.record.serial || dev.record.phase === "failed") continue;
        if (this.isIphone(dev)) {
          const cabled = await this.iphones().connected(dev.record.serial).catch(() => null);
          if (cabled !== false) continue;
          this.losePhone(p, dev, `iPhone ${dev.record.serial} is no longer cabled to this Mac (unplugged, or it stopped trusting it)`);
          lost.push(dev.record.deviceId);
          continue;
        }
        const state = await this.phones().adbState(dev.record.serial).catch(() => null);
        if (state === null || state === "device") continue;
        lost.push(dev.record.deviceId);
        this.losePhone(p, dev, `phone ${dev.record.serial} left adb (${state === "missing" ? "unplugged, or USB debugging revoked" : `adb says "${state}"`})`);
      }
    }
    return lost;
  }

  private losePhone(p: LivePreview, dev: LiveDevice, error: string): void {
    dev.abort.abort();
    dev.lost = true;
    const stream = p.attached.get(dev.record.deviceId);
    p.attached.delete(dev.record.deviceId);
    void stream?.detach().catch(() => {});
    dev.syslog?.stop();
    dev.record.error = error;
    dev.record.phase = "failed";
    dev.record.detail = this.failureDetail(dev.record.error);
    this.touch(p);
    this.d.audit.record({ actor: "engine", tool: "device_failed", args: { preview: p.record.previewId, device: dev.record.deviceId }, result: "error", error: dev.record.error });
  }

  /**
   * Inspect a repo at its default branch to detect app type + bundle id, without
   * a checkout. Used by add_app before registering. Propagates credential/ref
   * errors so the caller can turn them into onboarding steps.
   */
  async inspectAppRepo(app: App, spec: RefSpec): Promise<{ type: AppType | null; bundleId: string | null; easProjectId: string | null }> {
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
    if (this.isIphone(dev)) return this.iphoneControl().screenshot({ platform: "ios", udid: dev.record.serial!, ...(dev.appPackage ? { bundleId: dev.appPackage } : {}) });
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
      // A phone is driven over adb by its serial: SimDeck resolves only an AVD name.
      if (dev.record.physical) return { platform: "android", udid: dev.record.serial! };
      // record.udid holds the AVD name for Android; SimDeck resolves the adb serial from it.
      if (!dev.record.udid) throw new PreviewError(`device ${deviceId} has no emulator yet`);
      return { platform: "android", udid: `android:${dev.record.udid}` };
    }
    if (dev.record.physical) return { platform: "ios", udid: dev.record.serial! };
    if (!dev.record.udid) throw new PreviewError(`device ${deviceId} has no simulator yet`);
    return { platform: "ios", udid: dev.record.udid };
  }

  /** The device's UI language, or null when it cannot be read — a hint, never a reason to fail. */
  async uiLanguage(previewId: string, deviceId: string): Promise<string | null> {
    const dev = this.active(previewId)?.devices.find((d) => d.record.deviceId === deviceId);
    try {
      if (dev?.record.platform === "android" && dev.record.serial) return await this.android().uiLanguage(dev.record.serial);
      if (dev?.record.platform === "ios" && dev.record.udid) return await this.d.simctl.uiLanguage(dev.record.udid);
    } catch {
      return null;
    }
    return null;
  }

  /**
   * SimDeck for simulators and emulators; adb for an Android phone and WDA for an iPhone, which
   * SimDeck cannot address. The iPhone backend is handed the registered bundle id: it refuses
   * every touch while anything else is in front.
   */
  private controlFor(previewId: string, deviceId: string): ControlBackend {
    const dev = this.active(previewId)?.devices.find((d) => d.record.deviceId === deviceId);
    if (dev && this.isIphone(dev)) {
      const ctl = this.iphoneControl();
      const bundleId = dev.appPackage;
      const t = (target: SimDeckTarget) => ({ platform: "ios" as const, udid: target.udid, ...(bundleId ? { bundleId } : {}) });
      return { describe: (target, opts) => ctl.describe(t(target), opts), action: (target, a) => ctl.action(t(target), a) };
    }
    return dev?.record.physical ? this.phoneControl() : this.simdeckControl();
  }

  /** The live device driving this iPhone, for the viewer's stream input. */
  private iphoneTenant(udid: string): { p: LivePreview; dev: LiveDevice } | null {
    const t = this.phoneTenant(udid);
    return t && this.isIphone(t.dev) ? t : null;
  }

  /** One viewer gesture or key on an iPhone's stream, as a `ui` action on the preview holding it. */
  async iphoneStreamAction(udid: string, action: UiAction): Promise<unknown> {
    const t = this.iphoneTenant(udid);
    if (!t) throw new PreviewError(`no live preview drives iPhone ${udid}`);
    this.markActive(t.p);
    return this.ui(t.p.record.previewId, t.dev.record.deviceId, action);
  }

  /** The `describe` tree of an iPhone's preview, as text, for its stream helper. */
  async iphoneStreamDescribe(udid: string): Promise<string> {
    const t = this.iphoneTenant(udid);
    if (!t) throw new PreviewError(`no live preview drives iPhone ${udid}`);
    return JSON.stringify(await this.describe(t.p.record.previewId, t.dev.record.deviceId, { interactiveOnly: true }));
  }

  /** Accessibility tree for a device — the agent's "eyes". */
  describe(previewId: string, deviceId: string, opts: DescribeOptions = {}): Promise<unknown> {
    const target = this.simdeckTarget(previewId, deviceId);
    return this.controlFor(previewId, deviceId).describe(target, opts);
  }

  /** What a dev-client EAS build on this device was told to load, or why it shows the dev launcher. */
  devClientNote(previewId: string, deviceId: string): string | null {
    return this.previews.get(previewId)?.devices.find((d) => d.record.deviceId === deviceId)?.devClient ?? null;
  }

  /** Drive one UI action on a device — the agent's "hands". */
  ui(previewId: string, deviceId: string, action: UiAction): Promise<unknown> {
    const target = this.simdeckTarget(previewId, deviceId);
    return this.controlFor(previewId, deviceId).action(target, action);
  }

  /** Where the app's own files are for this preview: the worktree once prepared, else the registered path. */
  sourceDirOf(previewId: string): string | undefined {
    const p = this.active(previewId);
    return p ? (p.sourceDir ?? p.app.path) : undefined;
  }

  /** Whether the `app` log source is captured for this device (Android, physical iPhone). */
  capturesAppLog(previewId: string, deviceId: string | undefined): boolean {
    const p = this.previews.get(previewId);
    const dev = deviceId ? p?.devices.find((d) => d.record.deviceId === deviceId) : p?.devices[0];
    return dev ? this.hasAppLog(dev) : false;
  }

  /** A device's platform without resolving a control target; null when there is no such device. */
  platformOfDevice(previewId: string, deviceId: string | undefined): Platform | null {
    const p = this.previews.get(previewId);
    const dev = deviceId ? p?.devices.find((d) => d.record.deviceId === deviceId) : p?.devices[0];
    return dev?.record.platform ?? null;
  }

  platformOf(previewId: string, deviceId: string): "ios" | "android" {
    return this.simdeckTarget(previewId, deviceId).platform;
  }

  /** The refs and last-shown screen of one device, kept for as long as the device is. */
  screenBook(previewId: string, deviceId: string): ScreenBook {
    const key = `${previewId}/${deviceId}/${this.simdeckTarget(previewId, deviceId).udid}`;
    const book = this.screenBooks.get(key) ?? new ScreenBook();
    this.screenBooks.delete(key);
    this.screenBooks.set(key, book);
    if (this.screenBooks.size > 32) this.screenBooks.delete(this.screenBooks.keys().next().value!);
    return book;
  }

  private readonly screenBooks = new Map<string, ScreenBook>();

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
   * Remember how the last verifier went, so a step marked `passed` right after a failed
   * one can be questioned. Recorded per preview rather than per device: the agent reports
   * one step for what it just did, whichever device it drove.
   */
  noteVerification(previewId: string, ok: boolean, action: string, selector?: string): void {
    const p = this.previews.get(previewId);
    if (!p) return;
    p.lastVerification = { ok, action, ...(selector ? { selector } : {}) };
  }

  /** The failed verifier still standing, or null once something has verified since. */
  failedVerification(previewId: string): { action: string; selector?: string } | null {
    const v = this.previews.get(previewId)?.lastVerification;
    return v && !v.ok ? { action: v.action, ...(v.selector ? { selector: v.selector } : {}) } : null;
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
   * A finished run otherwise lingers until the next run or a rebuild — which is right while it
   * is the record of what just happened, and wrong once it is stale or was recorded badly. There
   * was no way to take it back: `startTestRun` only replaces one run with another, so the only
   * escape was to leave a misleading verdict on screen.
   */
  clearTestRun(previewId: string): boolean {
    const p = this.previews.get(previewId);
    if (!p?.testRun) return false;
    p.testRun = undefined;
    p.testRunNudged = false;
    p.lastVerification = undefined;
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
    // Evidence belongs to the run it was gathered in. Carrying a failed verifier across
    // would block the next run's first honest pass for something that happened before it
    // existed — a guard that fires on the wrong run teaches agents to route around it.
    p.lastVerification = undefined;
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
    // Preserve the verdicts already recorded. `start_preview` is idempotent and
    // is the documented way for an agent to re-answer "what's the link?" — so
    // re-calling it mid-session used to reset every item to `pending` and throw
    // away an afternoon of judgements, silently. Seeding the same name twice is
    // not a request to forget what you decided about it.
    const prior = new Map((p.compare?.items ?? []).map((i) => [i.name, i]));
    const merged = uniq.map((name) => prior.get(name) ?? { name, verdict: "pending" as const });
    // Anything recorded earlier but not named again stays: the list is additive
    // by design (setCompareItem appends unknown names) and there is no removal
    // API, so dropping them could only ever lose work.
    for (const item of prior.values()) if (!uniq.includes(item.name)) merged.push(item);
    // Panes this page is dropping. `start_preview` is idempotent and documented
    // as the way to re-answer "what's the link?", so re-calling it with a
    // different `alongside` is expected — and the old panes then held a
    // simulator, a Metro port and a worktree with no previewId ever returned to
    // the agent and no path for `stop_preview` to reach them. Only the idle
    // sweep would eventually collect them, an hour later.
    const kept = new Set(refs.map((r) => r.shareId));
    const dropped = (p.compare?.references ?? []).filter((r) => !kept.has(r.shareId));

    p.compare = { references: refs, items: merged };

    for (const r of dropped) {
      if (!r.previewId || !this.previews.has(r.previewId)) continue;
      // Shared panes are the point of content-keying: another page may be
      // showing this one right now.
      const stillUsed = [...this.previews.values()].some((o) =>
        (o.compare?.references ?? []).some((x) => x.previewId === r.previewId),
      );
      if (!stillUsed) void this.stopPreview(r.previewId).catch(() => {});
    }
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
   * them.
   *
   * Called once per boot, but AFTER the HTTP port is bound (see `server.ts`) —
   * the bind is what proves we are the only server, so a second `deckhand
   * serve` dies on EADDRINUSE before it can delete this one's devices. Every
   * sweep below therefore has to spare what is live RIGHT NOW: a `start_preview`
   * can land in the seconds between the bind and here.
   */
  async reapOrphans(): Promise<{ sims: number; avds: number; previews: number }> {
    // The only definition of "stale on boot" in the repo, and `failed` is deliberately
    // inside it: a failed preview still holds a booted simulator and a worktree, and
    // counting it as using zero devices was one of the two original resource leaks
    // (PLAN, "Device lifecycle"). → `preview.test.ts` "reaps a FAILED preview at boot".
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
        // Device reap FIRST, and with no await before it: `liveDeviceHandles()`
        // is what spares a device being created right now, and every await
        // between reading it and acting on it widens that window. (Putting the
        // Metro reap ahead of it did exactly that, and the in-flight test caught
        // it.) Metro and devices are independent, so order costs nothing here.
        // Lazily, not by value: `reap` awaits a shutdown and a delete per orphan, and the boot
        // sweep runs AFTER the port is bound on purpose — so a `start_preview` can create a
        // device between the read and the kill. Passing the reader lets it re-check at each
        // destructive call instead of diffing against a set from before the awaits.
        const devices = await reaper.reap(() => this.liveDeviceHandles());
        // Metro AND the livesync runners: both are spawned detached and tracked
        // only in memory, so both were reparented to launchd on every restart.
        // The livesync leak was the worse of the two by far — 36 orphans at 418%
        // CPU, which starved the Android emulators (CPU-bound QEMU) while iOS
        // (native) stayed fine.
        // Spare what we already own. This sweep runs AFTER the port is bound, so
        // a start_preview that landed in the meantime has children carrying the
        // same marker — and killing those leaves the preview `ready` with a dead
        // bundler. The device reap guards the identical window with
        // liveDeviceHandles(); this one has to guard it too. Read as late as
        // possible, for the same reason.
        for (const [tool, marker, keep] of [
          ["reap_metro", METRO_MARKER_ENV, () => this.d.metro?.livePids() ?? []],
          ["reap_dev_run", DEV_MARKER_ENV, () => this.d.devProcs?.livePids() ?? []],
          // NOT an empty keep-set. "Build steps are awaited, so nothing is owned across a
          // boot" is true of a boot and false of this sweep: it runs AFTER the port is bound
          // (deliberately — that is what makes a second `deckhand serve` die on EADDRINUSE
          // before deleting the running server's devices), so an agent's start_preview can
          // land in the seconds between, and its brand-new xcodebuild/gradle carries the same
          // marker. Same window liveDeviceHandles() guards for devices and livePids() for
          // Metro; builds were the one resource with nothing to spare them.
          ["reap_build", BUILD_MARKER_ENV, () => buildPids()],
          // iPhone helpers: WDA runners and iproxy forwards (kept per phone by the server) and each
          // device's idevicesyslog. Spared: what this server already runs.
          ["reap_iphone", IPHONE_MARKER_ENV, () => [...(this.d.iphones?.livePids() ?? []), ...this.iphoneSyslogPids()]],
        ] as const) {
          const killed = await reaper.reapOrphansByMarker(marker, keep()).catch(() => [] as number[]);
          if (killed.length) this.d.audit.record({ actor: "engine", tool, args: { killed: killed.length }, result: "ok" });
        }
        // Streaming helpers. serve-sim daemonizes ITSELF (`--detach`), so our source never
        // passes a detached spawn option for it and it carries no env marker — the sweep above cannot
        // see it, and neither can the guardrail that enforces markers. It needs its own
        // call, and until this line existed it had none: StreamingRouter.reapOrphans() was
        // written, tested, and never reached from boot, so the 2h48m orphan that motivated
        // it (see serveSim.ts) would have survived every restart. Spare what is live, for
        // the same reason the device reap does — and by every identifier a BACKEND
        // keys on, which is not the set the Reaper uses: serve-sim's helper map is
        // keyed by simulator UDID, AndroidAdbBackend's by adb serial, and its
        // recorder sweep reads the AVD name too (that is what answers for an
        // emulator still booting, before a serial exists). `names` is the fourth
        // thing liveDeviceHandles returns and is left out deliberately: it is the
        // simulator/AVD *device* name, which only the Reaper matches on — no
        // backend has ever seen it. A backend that keys on one has to be added here.
        const live = this.liveDeviceHandles();
        await this.d.streaming.reapOrphans(new Set([...live.udids, ...live.avds, ...live.serials])).catch(() => {});
        return devices;
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
   *
   * ONE device has up to three identifiers, and each consumer of this knows
   * only its own:
   *   - `udids`  — simulator UDID. The Reaper matches `simctl list` on it, and
   *                ServeSimBackend keys its helper map on it.
   *   - `avds`   — AVD name. The Reaper matches `avdmanager list` on it, and it
   *                is what `adb emu avd name` reports.
   *   - `serials`— adb serial (`emulator-5554`). AndroidAdbBackend keys its
   *                helper map on THIS and on nothing else.
   * A backend handed only the two the Reaper needs cannot spare anything: the
   * boot sweep passed `udids ∪ avds` to `reapOrphans`, and `keep.has(serial)`
   * in AndroidAdbBackend was therefore false for every live Android device, so
   * the sweep stopped the helper of a `start_preview` that landed after the
   * port was bound. Anything that fans a keep-set across backends must carry
   * all three.
   */
  private iphoneSyslogPids(): number[] {
    return [...this.previews.values()].flatMap((p) => p.devices.flatMap((d) => d.syslog?.livePids() ?? []));
  }

  private liveDeviceHandles(): { udids: string[]; avds: string[]; serials: string[]; names: string[] } {
    const udids: string[] = [];
    const avds: string[] = [];
    const serials: string[] = [];
    // Pool leases cover the pooled config; `deviceName` covers both, including
    // the non-pooled `deckhand-<previewId>-<n>` names that no lease ever holds.
    const names = new Set<string>(this.leased);
    for (const p of this.previews.values()) {
      for (const dev of p.devices) {
        if (dev.deviceName) names.add(dev.deviceName);
        if (dev.record.serial) serials.push(dev.record.serial);
        if (!dev.record.udid) continue;
        // record.udid holds the AVD name on Android, the simulator UDID on iOS.
        (dev.record.platform === "android" ? avds : udids).push(dev.record.udid);
      }
    }
    return { udids, avds, serials, names: [...names] };
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
    const stopped: string[] = [];
    for (const { id, reason } of doomed) {
      // Re-check immediately before tearing this one down. `doomed` is decided for the whole
      // set before the first await, and each stopPreview takes seconds — shutting down and
      // deleting simulators — so by the time the loop reaches the second entry, someone may
      // have opened the viewer on it or an agent may have called screenshot/describe/ui,
      // both of which reset lastActivityAt. Tearing it down then is the worst outcome this
      // sweep has: a preview somebody is actively watching disappears under them, and
      // recovery costs a full rebuild.
      const p = this.previews.get(id);
      if (!p) continue;
      if (reason === "idle" && this.d.now!() - p.lastActivityAt <= idleMinutes * 60_000) {
        this.d.audit.record({ actor: "engine", tool: "auto_stop_skipped", args: { preview: id, reason: "reactivated" }, result: "ok" });
        continue;
      }
      this.d.audit.record({ actor: "engine", tool: "auto_stop", args: { preview: id, reason }, result: "ok" });
      await this.stopPreview(id).catch(() => {});
      stopped.push(id);
    }
    await this.checkPhones().catch(() => []);
    await this.reassertAndroidReverse();
    // Teardown keeps the checkout (it is the next build's warm cache), so this
    // sweep is the only thing that ever gives that disk back on a server that
    // isn't restarted. It only touches checkouts idle past the grace window.
    await this.pruneDisk();
    return stopped;
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
      const port = this.d.metro.portForApp(p.app.id, p.sourceDir ?? p.record.worktreePath);
      if (!port) continue;
      for (const dev of p.devices.values()) {
        // Keyed on the serial the device has, emulator or phone — not on a console port only an emulator has.
        if (dev.record.platform !== "android" || dev.record.phase === "failed") continue;
        const serial = dev.record.serial ?? (dev.androidPort ? serialForPort(dev.androidPort) : undefined);
        if (serial) await this.reverseMetroPorts(dev, serial, port).catch(() => {});
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
  private async reverseMetroPorts(dev: LiveDevice, serial: string, metroPort: number): Promise<void> {
    const reversed = (dev.reversed ??= new Set());
    if (metroPort !== METRO_PORT) {
      reversed.add(metroPort);
      await this.android().reversePort(serial, metroPort, metroPort);
    }
    reversed.add(METRO_PORT);
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
        if (dev.record.physical) continue;
        const booted = Boolean(dev.record.udid ?? dev.record.serial ?? dev.record.webPort);
        // A device still working toward ready has a slot reserved for it.
        if (booted || (dev.record.phase !== "failed" && p.record.phase !== "failed")) n++;
      }
    }
    return n;
  }

  /**
   * Release a preview's devices: detach the stream, then shut down and delete the
   * simulator/AVD deckhand created for it. Idempotent — the handles are cleared, so a
   * second call (a stop after an idle sweep) is a no-op.
   *
   * `only` picks a subset; the default is all of them, which is what stopPreview
   * wants, and `removeDevices` passes a subset. Parameterised rather than
   * copied — every simulator/emulator/pool release in this method is a place a second
   * version would drift, and a leaked pool lease or an un-freed adb port is invisible
   * until the machine runs out of them.
   */
  private async teardownDevices(p: LivePreview, onReleased?: () => void, only?: LiveDevice[]): Promise<void> {
    for (const dev of only ?? p.devices) {
      const stream = p.attached.get(dev.record.deviceId);
      if (stream) await stream.detach().catch(() => {});
      p.attached.delete(dev.record.deviceId);
      if (dev.record.platform === "web") {
        if (dev.record.webPort) this.webPorts.delete(dev.record.webPort);
        dev.record.webPort = undefined;
        onReleased?.();
        continue; // no simulator/emulator to tear down; the dev process is stopped by the caller
      }
      if (dev.record.physical) {
        // Borrowed hardware: stop driving it. The app is stopped and deckhand's own reverse
        // rules go; the phone is never shut down, wiped or reaped, and is not in the capacity tally.
        await this.releasePhone(dev);
        continue;
      }
      // A pooled device is released, not destroyed: the next preview of the same
      // shape boots it again instead of paying for a create (and, on Android, a
      // fresh ~2 GB AVD image) every single time.
      const pooled = dev.poolName != null;
      if (dev.record.platform === "android") {
        // `shutdown` answers whether the device actually went away. Deleting the AVD takes its
        // NAME out of `listAvds()`, and that name is the only thing `pkill -f "avd <name>"` in
        // the reaper has to go on. Delete after a failed shutdown and a live QEMU is left with
        // no collector — the 418%-CPU class.
        if (dev.record.serial) {
          const stoppedCleanly = await this.android().shutdown(dev.record.serial).catch(() => false);
          if (dev.record.udid) this.noteStopped(dev.record.udid, stoppedCleanly);
          this.androidPorts.delete(portForSerial(dev.record.serial));
        }
        // Reserved before the boot, so it must be freed even when no serial ever
        // came back (boot timeout, emulator crash).
        if (dev.androidPort != null) this.androidPorts.delete(dev.androidPort);
        // The SET decides, not the local answer: a boot that threw has no serial to shut down
        // here, and what it knew about its half-started emulator was recorded there. Asking
        // "did I just stop it" instead would read a device nobody could stop as stopped.
        // Recorded before the lease is released below — from that moment this set is the only
        // thing standing between a live QEMU and `trimPool`'s delete.
        if (dev.record.udid && !pooled && !this.unstoppedAvds.has(dev.record.udid)) {
          await this.android().deleteAvd(dev.record.udid).catch(() => {}); // udid holds the AVD name
        }
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

  private async releasePhone(dev: LiveDevice): Promise<void> {
    const serial = dev.record.serial;
    if (this.isIphone(dev)) {
      // The registered app is stopped and this device's syslog ends; WDA and its forward stay up,
      // owned by the server for the next preview on this phone.
      if (serial && dev.appPackage) await this.iphoneApps(dev).terminate(dev.appPackage).catch(() => false);
      dev.syslog?.stop();
      dev.syslog = undefined;
      return;
    }
    if (serial) {
      if (dev.appPackage) {
        const app = this.phones().registeredApp(serial, dev.appPackage);
        await app.forceStop(app.pkg).catch(() => {});
      }
      for (const port of dev.reversed ?? []) await this.phones().removeReverse(serial, port);
    }
    dev.reversed = undefined;
    // The serial stays on the record (a phone has no handle to lose); the preview leaving the map frees it, and a
    // background release holds the next tenant's boot (releasingPhones) until this has returned.
  }

  /**
   * Record what `AndroidManager.shutdown` answered for the emulator running `avdName`.
   * Cleared on a clean stop so a pooled AVD that later shuts down properly becomes
   * trimmable again — a name that could never leave this set would pin an AVD image
   * (~2 GB) on disk for the life of the process.
   */
  private noteStopped(avdName: string, stoppedCleanly: boolean): void {
    if (stoppedCleanly) this.unstoppedAvds.delete(avdName);
    else this.unstoppedAvds.add(avdName);
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
      // `unstoppedAvds` is a second, weaker kind of lease: teardown released the pool
      // lease seconds ago and its emulator never confirmed it had exited, so this is a
      // name attached to a possibly-live QEMU. Deleting it hides that process from the
      // only sweep that can name it. It is not counted against `keepAvds` either — this
      // is not a spare being kept, it is a device that would not go away.
      if (this.leased.has(avd) || this.unstoppedAvds.has(avd)) continue;
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
    if (p.record.source === "git") {
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

/** List helper that swallows both a missing tool (sync throw) and a failed call. */
async function safeList<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch {
    return [];
  }
}
