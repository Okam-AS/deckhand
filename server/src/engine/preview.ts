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
import { WorktreeManager, type RefSpec, refDescription } from "./worktree.ts";
import { Simctl, selectRuntime, selectDeviceType, deviceLabel, type SimDevice } from "../devices/ios.ts";
import { AndroidManager, selectSystemImage, portForSerial } from "../devices/android.ts";
import { Reaper, POOL_SIM_PREFIX, POOL_AVD_PREFIX } from "./reaper.ts";
import { MetroManager } from "./metro.ts";
import { buildPlan, usesMetroDeepLink, nativescriptDevRun, webDevRun, webRootDevRun, GENERAL_IDLE_MS } from "./recipes.ts";
import { runStep as defaultRunStep, type RunResult } from "./procs.ts";
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

interface LiveDevice {
  record: PersistedDevice;
  logs: Record<LogSource, string[]>;
  abort: AbortController;
  /** Pool slot held by this device (see leaseName) — released, not deleted, on teardown. */
  poolName?: string;
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
  /** Ephemeral: pairing + parity checklist for a compare session, surfaced to the viewer. */
  compare?: CompareSession;
  /** Epoch ms of the last viewer/agent touch — the idle sweep's clock. */
  lastActivityAt: number;
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
export type CompareVerdict = "pending" | "doing" | "matches" | "adjusted" | "regression";
export interface CompareItem {
  name: string;
  verdict: CompareVerdict;
  note?: string;
}
export interface CompareReference {
  shareId: string;
  repo: string;
  ref: string;
}
export interface CompareSession {
  reference: CompareReference;
  /** Engine-internal: the booted reference preview, torn down with the working one. */
  referencePreviewId?: string;
  items: CompareItem[];
}
export interface CompareCounts {
  pending: number;
  doing: number;
  matches: number;
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

/** One dev process per app+platform. */
function devKey(appId: string, platform: Platform): string {
  return `${appId}:${platform}`;
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

  private allocAndroidPort(): number {
    for (let p = 5554; p <= 5680; p += 2) {
      if (!this.androidPorts.has(p)) {
        this.androidPorts.add(p);
        return p;
      }
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
    devices: { deviceId: string; platform: Platform; label: string; phase: string; detail?: string }[];
    /** The agent's live test run (calm spinner + step popover in the viewer), if any. */
    testRun?: {
      status: TestRunStatus;
      title: string;
      steps: { n: number; label: string; status: TestStepStatus; detail?: string }[];
      summary?: string;
    };
    /**
     * Migration target only: the live SOURCE preview to show alongside, so the
     * viewer can render old vs new side by side. Present only when this app has a
     * `migratesFrom` whose source preview is currently live.
     */
    pairedWith?: {
      shareId: string;
      repo: string;
      ref: string;
      devices: { deviceId: string; platform: Platform; label: string; phase: string; detail?: string }[];
    };
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
      }));
    for (const p of this.previews.values()) {
      if (p.record.shareId === shareId) {
        this.markActive(p); // the viewer polls this — it is the idle clock's heartbeat
        // Pair the working preview with its reference and surface the checklist.
        // A live compare session (explicit reference + in-memory items) wins; else
        // fall back to the legacy migration path (migratesFrom + repo-file ledger).
        // Both are gated so an ordinary preview does zero extra work.
        let pairedWith;
        let ledger;
        if (p.compare) {
          const ref = this.liveByShareId(p.compare.reference.shareId);
          if (ref) {
            pairedWith = {
              shareId: p.compare.reference.shareId,
              repo: p.compare.reference.repo,
              ref: p.compare.reference.ref,
              devices: sanitizeDevices(ref),
            };
          }
          if (p.compare.items.length) {
            ledger = { screens: p.compare.items.map((i) => ({ name: i.name, status: i.verdict, note: i.note })) };
          }
        } else if (p.app.migratesFrom) {
          const src = this.livePreviewForApp(p.app.migratesFrom);
          if (src) {
            pairedWith = {
              shareId: src.record.shareId,
              repo: src.app.repo ?? src.app.id,
              ref: src.record.ref,
              devices: sanitizeDevices(src),
            };
          }
          const led = readMigrationLedger(p.sourceDir ?? p.app.path);
          if (led) ledger = led;
        }
        return {
          ready: p.record.phase === "ready",
          ref: p.record.ref,
          repo: p.app.repo ?? p.app.id,
          source: p.record.source,
          canRestart: p.record.source === "local" && (p.record.phase === "ready" || p.record.phase === "failed"),
          devices: sanitizeDevices(p),
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
          ...(pairedWith ? { pairedWith } : {}),
          ...(ledger ? { ledger } : {}),
        };
      }
    }
    return null;
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
    if (pin == null) {
      delete this.pins[appId];
    } else {
      const { salt, hash } = hashPassword(pin);
      this.pins[appId] = { salt, hash, length: pin.length };
    }
    for (const p of this.previews.values()) {
      if (p.record.appId === appId) p.record.passwordProtected = pin != null;
    }
    this.persist();
    this.d.audit.record({ actor: "engine", tool: "set_pin", args: { app: appId, protected: pin != null }, result: "ok" });
  }

  /** Whether the share behind `shareId` requires a PIN, and its digit length (for the pad). */
  pinInfoForShare(shareId: string): { required: boolean; length: number } {
    const appId = this.appIdForShare(shareId);
    const rec = appId ? this.pins[appId] : undefined;
    return rec ? { required: true, length: rec.length } : { required: false, length: 0 };
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
    this.recomputePreviewPhase(p);
    this.persist();
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
    this.reapTerminalForApp(req.app.id);
    const existing = this.findReusable(req);
    if (existing) return this.resultFor(existing, true);

    if (req.devices.length > this.d.config.limits.maxDevicesPerPreview) {
      throw new PreviewError(
        `too many devices (${req.devices.length} > ${this.d.config.limits.maxDevicesPerPreview})`,
        "request fewer devices or raise limits.maxDevicesPerPreview",
      );
    }
    const totalActive = this.devicesInUse();
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
      ...(webFramework ? { webFramework } : {}),
    };
    const preview: LivePreview = {
      record,
      app: req.app,
      spec: req.spec,
      devices,
      attached: new Map(),
      lastActivityAt: this.d.now!(),
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
   */
  private reapTerminalForApp(appId: string): void {
    for (const [id, p] of this.previews) {
      if (p.record.appId === appId && (p.record.phase === "failed" || p.record.phase === "stopped")) {
        this.previews.delete(id);
        if (p.record.phase === "failed") this.releaseInBackground(p);
      }
    }
  }

  /**
   * Release everything a forgotten preview still holds — dev processes, devices,
   * worktree — without blocking the caller (startPreview is synchronous). The
   * device count is held in `tearingDown` for the duration so a preview starting
   * right now can't claim capacity that is still occupied.
   */
  private releaseInBackground(p: LivePreview): void {
    this.tearingDown += p.devices.length;
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
        await this.teardownDevices(p);
        if (p.record.source !== "local") {
          await this.d.worktrees.removeWorktree(p.app, p.record.previewId).catch(() => {});
        }
      } finally {
        this.tearingDown -= p.devices.length;
      }
    })().catch(() => {});
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
    this.touch(p);
  }

  private appEnv(app: App): Record<string, string> {
    return { ...app.env, ...this.d.secretsEnv!(app.id) };
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
      const existing = (await safeList<SimDevice>(() => this.d.simctl.listDevices())).find((d) => d.name === name);
      if (existing) {
        udid = existing.udid;
        // Unknown predecessor (a restart lost the tenant map) ⇒ factory reset.
        if (this.poolTenants.get(name) !== p.app.id) await this.d.simctl.erase(udid).catch(() => {});
      } else {
        udid = await this.d.simctl.create(name, deviceType.identifier, runtime.identifier);
      }
      this.poolTenants.set(name, p.app.id);
    } else {
      udid = await this.d.simctl.create(
        `deckhand-${p.record.previewId}-${dev.record.deviceId}`,
        deviceType.identifier,
        runtime.identifier,
      );
    }
    dev.record.udid = udid;
    this.setPhase(p, dev, "booting", "booting simulator");
    await this.d.simctl.bootAndWait(udid);
    return udid;
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
      const exists = (await safeList<string>(() => android.listAvds())).includes(avdName);
      wipeData = this.poolTenants.get(avdName) !== p.app.id;
      if (!exists) await android.createAvd(avdName, image, profile);
      this.poolTenants.set(avdName, p.app.id);
    } else {
      avdName = `deckhand_${p.record.previewId}_${dev.record.deviceId}`.replace(/[^A-Za-z0-9_]/g, "_");
      await android.createAvd(avdName, image, profile);
    }
    dev.record.udid = avdName; // remember the AVD name for teardown
    dev.record.model = profile;
    dev.record.runtime = `Android ${image.api}`;
    dev.record.label = `${profile} · Android ${image.api}`;
    const port = this.allocAndroidPort();
    this.setPhase(p, dev, "booting", "booting emulator");
    const serial = await android.bootEmulator(avdName, port, undefined, { wipeData });
    dev.record.serial = serial;
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
    if (app.bundleId) return app.bundleId;
    // Only reached for iOS/Android builds; web has no bundle id.
    const detected = detectBundleIdFromDir(worktreePath, app.type, platform === "android" ? "android" : "ios");
    if (!detected) {
      throw new PreviewError(
        `could not determine the ${platform} ${platform === "android" ? "package" : "bundle id"} for ${app.id}`,
        `set bundleId for app "${app.id}" (deckhand app ...) or ensure the config declares it`,
      );
    }
    return detected;
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

  private failDevice(p: LivePreview, dev: LiveDevice, e: unknown): void {
    if (dev.record.phase === "ready" || dev.record.phase === "failed") return;
    dev.record.error = e instanceof Error ? e.message : String(e);
    this.setPhase(p, dev, "failed", undefined);
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
    // Expo's dev-client launch deep-links into Metro, which needs the app's slug.
    // Resolved once per build (launch() runs per device, so resolving there spawned
    // `expo config` N times for an N-device preview) — and only after the build,
    // since evaluating a dynamic app.config.* needs the project's own installed
    // Expo CLI, which doesn't exist in a fresh worktree until deps are installed.
    let slug: string | null = null;

    try {
      appEnv = this.appEnv(p.app);
      bundleId = this.resolveBundleId(p.app, sourceDir, platform);
      builderHandle = await handleOf(0);

      // Mark the whole group building (non-builders wait on the shared build).
      for (const dev of group) {
        this.setPhase(p, dev, "building", dev === builder ? "building the app" : "building the app (shared)");
      }
      await this.runBuildPlan(p, builder, platform, builderHandle, sourceDir, appEnv, local);
      if (platform === "ios" && usesMetroDeepLink(p.app.type)) slug = await this.resolveExpoSlug(sourceDir, appEnv);

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
          this.setPhase(p, dev, "installing-app", "installing");
          await this.installProduct(platform, handle, appPath);
          await this.verifyInstalled(platform, handle, bundleId);
          this.setPhase(p, dev, "launching", "launching app");
          await this.launch(p, dev, handle, bundleId, sourceDir, appEnv, slug);
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
      env: appEnv,
      onLog: (line) => this.appendLog(dev, "build", `[livesync] ${line}`),
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
      onLog: (line) => this.appendLog(dev, "build", `[web] ${line}`),
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
    const plan = buildPlan({ type: p.app.type, platform, udid, worktreePath, appEnv, local });
    for (const step of plan) {
      const res = await this.d.runStep!(step, {
        signal: dev.abort.signal,
        onLog: (line) => this.appendLog(dev, "build", `[${step.name}] ${line}`),
      });
      if (res.code !== 0 && !step.optional) {
        throw new PreviewError(
          `build step "${step.name}" failed${res.timedOut ? " (idle timeout)" : ""}${res.aborted ? " (aborted)" : ""}`,
        );
      }
    }
  }

  private async attachAndReady(p: LivePreview, dev: LiveDevice, platform: Platform, handle: string): Promise<void> {
    // A restarted preview keeps its stream: it captures the device's screen,
    // which survives app reinstalls — no reason to detach and reattach.
    if (p.attached.has(dev.record.deviceId)) {
      this.setPhase(p, dev, "ready", undefined);
      return;
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
    /** Pre-resolved Expo slug (once per build); required for metro-deep-link apps. */
    slug: string | null,
  ): Promise<void> {
    if (dev.record.platform === "android") {
      // The build already launched the builder; (re)launch is idempotent and
      // covers install-many devices.
      await this.android().launch(handle, bundleId);
      return;
    }
    if (usesMetroDeepLink(p.app.type)) {
      if (!slug) throw new PreviewError("could not resolve the Expo slug from app.json or app.config.*");
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
    const c: CompareCounts = { pending: 0, doing: 0, matches: 0, adjusted: 0, regression: 0 };
    for (const i of items) c[i.verdict]++;
    return c;
  }

  /** Link a working preview to a reference preview + seed the item checklist (replacing any prior). */
  startCompare(previewId: string, reference: CompareReference, items: string[] = [], referencePreviewId?: string): CompareCounts {
    const p = this.active(previewId);
    if (!p) throw new PreviewError(`no active preview "${previewId}"`);
    const seen = new Set<string>();
    const uniq = items.map((s) => s.trim()).filter((s) => s.length > 0 && !seen.has(s) && (seen.add(s), true));
    p.compare = { reference, referencePreviewId, items: uniq.map((name) => ({ name, verdict: "pending" as const })) };
    return PreviewEngine.countCompare(p.compare.items);
  }

  /** Set one item's verdict (by exact name; appends if new). Returns the new counts. */
  setCompareItem(previewId: string, patch: { item: string; verdict: CompareVerdict; note?: string }): CompareCounts {
    const c = this.active(previewId)?.compare;
    if (!c) throw new PreviewError(`no compare session for preview "${previewId}"`, "call compare_start first");
    let item = c.items.find((x) => x.name === patch.item);
    if (!item) {
      item = { name: patch.item, verdict: patch.verdict };
      c.items.push(item);
    }
    item.verdict = patch.verdict;
    if (patch.note != null) item.note = patch.note || undefined;
    return PreviewEngine.countCompare(c.items);
  }

  /** The current compare session (reference + items + counts), or null. */
  compareStatus(previewId: string): { reference: CompareReference; items: CompareItem[]; counts: CompareCounts } | null {
    const c = this.active(previewId)?.compare;
    if (!c) return null;
    return { reference: c.reference, items: c.items, counts: PreviewEngine.countCompare(c.items) };
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
    // The in-memory map is empty at boot, so every deckhand-named device on the
    // machine is an orphan: sweep them all, keeping nothing.
    // Guard the construction too: `new AndroidManager()` resolves tool env and
    // can throw, and that must never cost us the stale-preview cleanup below.
    const report = await (async () => {
      try {
        const reaper = this.d.reaper ?? new Reaper({ simctl: this.d.simctl, android: this.android() });
        return await reaper.reap();
      } catch {
        return { sims: [], avds: [], keptPooled: [] };
      }
    })();
    if (stale.length) this.persist(); // drops the stale previews, keeps shareIds + pins
    if (stale.length || report.sims.length || report.avds.length) {
      this.d.audit.record({
        actor: "engine",
        tool: "reap_orphans",
        args: { previews: stale.length, sims: report.sims.length, avds: report.avds.length },
        result: "ok",
      });
    }
    return { sims: report.sims.length, avds: report.avds.length, previews: stale.length };
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
      // holds its devices until something collects it.
      if (ph !== "ready") {
        if (stuckMinutes > 0 && sinceProgress > stuckMinutes * 60_000) doomed.push({ id, reason: "stuck" });
        continue;
      }
      if (idleMinutes > 0 && now - p.lastActivityAt > idleMinutes * 60_000) doomed.push({ id, reason: "idle" });
    }
    for (const { id, reason } of doomed) {
      this.d.audit.record({ actor: "engine", tool: "auto_stop", args: { preview: id, reason }, result: "ok" });
      await this.stopPreview(id).catch(() => {});
    }
    return doomed.map((d) => d.id);
  }

  /** Run `sweepIdle` on a timer. The handle is unref'd, so it never holds the process open. */
  startJanitor(everyMs = 60_000): void {
    if (this.janitor) return;
    this.janitor = setInterval(() => void this.sweepIdle().catch(() => {}), everyMs);
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
  private async teardownDevices(p: LivePreview): Promise<void> {
    for (const dev of p.devices) {
      const stream = p.attached.get(dev.record.deviceId);
      if (stream) await stream.detach().catch(() => {});
      p.attached.delete(dev.record.deviceId);
      if (dev.record.platform === "web") {
        if (dev.record.webPort) this.webPorts.delete(dev.record.webPort);
        dev.record.webPort = undefined;
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
    // A compare session owns a dedicated reference preview — tear it down too,
    // unless another live compare session is still pairing against it.
    const refPreviewId = p.compare?.referencePreviewId;
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
    this.d.audit.record({ actor: "engine", tool: "stop_preview", args: { preview: previewId }, result: "ok" });

    // Cascade: stop the paired reference preview once no other live compare needs it.
    if (refPreviewId && this.previews.has(refPreviewId)) {
      const stillUsed = [...this.previews.values()].some((o) => o.compare?.referencePreviewId === refPreviewId);
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
