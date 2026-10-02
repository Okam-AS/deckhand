import { execFile } from "node:child_process";
import { basename } from "node:path";
import { SimDeckDaemon, type SimDeckDaemonOptions } from "./simdeck.ts";
import {
  candidateTurns, frameOf, hitMatches, nativeProbePoint, presetSwipe, probeNodes, rootSpace, rootsOf, selectorTarget, toNative, uiBounds,
  PRESET_DURATION_MS, type SpaceOf,
} from "./orientation.ts";

// ---------------------------------------------------------------------------
// SimDeck control-only REST client. Backs deckhand's `describe` (accessibility
// tree) and `ui` (tap/type/…) MCP tools by driving SimDeck's REST surface on a
// device deckhand already booted. See simdeck.ts for the two hard rules (REST
// only; same-origin auth, no token). Deckhand holds no SimDeck token: the POSTs
// carry a matching `Origin` so loopback accepts them tokenless, and the GETs
// (accessibility-tree, screenshot.png) send no headers at all — a loopback GET
// needs neither. This client never touches the input WebSocket / webrtc /
// refresh endpoints. → control.test.ts "translates tap to a normalized /action
// POST with a same-origin Origin header" and "never touches the input WebSocket
// / webrtc / refresh endpoints".
// ---------------------------------------------------------------------------

/** A booted device addressed the way SimDeck expects: iOS UDID, or `android:<avd>`. */
export interface SimDeckTarget {
  platform: "ios" | "android";
  udid: string;
}

export interface DescribeOptions {
  /** auto | native-ax | nativescript | react-native | flutter | swiftui | uikit | android-uiautomator */
  source?: string;
  /** Prune to actionable elements (+ ancestors) — the default for agent loops. */
  interactiveOnly?: boolean;
  maxDepth?: number;
}

/** An element selector. `ref` is deckhand's own; SimDeck's positional @e# refs are unstable across snapshots and never used. */
export interface Selector {
  /** A ref from deckhand's own screen listing (`e12`); resolved by deckhand, never sent to SimDeck. */
  ref?: string;
  id?: string;
  text?: string;
  label?: string;
  value?: string;
  index?: number;
  regex?: boolean;
}

/** A single UI action. Coordinates are normalized 0..1 (top-left origin). */
export type UiAction =
  | { type: "tap"; x: number; y: number }
  | { type: "tapElement"; selector: Selector; waitTimeoutMs?: number }
  | { type: "type"; text: string }
  | { type: "key"; name: string }
  | { type: "button"; name: string }
  | { type: "home" }
  | { type: "swipe"; startX: number; startY: number; endX: number; endY: number; durationMs?: number }
  | { type: "gesture"; preset: "scroll-up" | "scroll-down" | "scroll-left" | "scroll-right" }
  | { type: "openUrl"; url: string }
  | { type: "back" }
  | { type: "dismissKeyboard" }
  | { type: "sleep"; ms: number }
  | { type: "scrollUntilVisible"; selector: Selector }
  | { type: "toggleAppearance" }
  | { type: "waitFor"; selector: Selector; timeoutMs?: number }
  | { type: "waitForNot"; selector: Selector; timeoutMs?: number }
  | { type: "assert"; selector: Selector }
  | { type: "assertNot"; selector: Selector }
  | { type: "query"; selector: Selector };

/** Thrown when a SimDeck action/inspection request fails (bad selector, element not found, …). */
export class SimDeckActionError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "SimDeckActionError";
  }
}

// Named-key → HID usage code (matches serve-sim/SimDeck HID usages, and deckhand's viewer input map).
/** The actions that place a touch, which a turned iOS device needs placed by deckhand. */
const TOUCHES = new Set<UiAction["type"]>(["tap", "tapElement", "swipe", "gesture", "back"]);

function unverified(result: unknown): unknown {
  return result && typeof result === "object" && !Array.isArray(result) ? { ...result, orientationUnverified: UNVERIFIED } : { result, orientationUnverified: UNVERIFIED };
}

/** A turn to place a touch with; landscape that could not be told apart refuses the touch. */
function known(turns: number | null): number {
  if (turns == null) {
    throw new SimDeckActionError(
      "this iOS device is turned to landscape and deckhand could not tell which way, so it will not place a touch that may land elsewhere",
      409,
    );
  }
  return turns;
}

const KEY_USAGE: Record<string, number> = {
  return: 40, enter: 40, escape: 41, backspace: 42, tab: 43, space: 44,
  delete: 76, right: 79, left: 80, down: 81, up: 82,
};
// HID usage for 'v' + left-GUI (Cmd) modifier bit — used to paste non-US text on iOS.
const V_USAGE = 25;
const CMD_MOD = 0x08;

export interface SimDeckControlOptions extends SimDeckDaemonOptions {
  daemon?: SimDeckDaemon;
  /** How long one request may take beyond the wait the action itself asks for. */
  requestTimeoutMs?: number;
  /** The name of the process with this pid (a simulator's processes are host processes), or null. */
  processNameImpl?: (pid: number) => Promise<string | null>;
}

function defaultProcessName(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "comm=", "-p", String(pid)], { timeout: 3000 }, (err, stdout) => {
      const name = err ? "" : String(stdout).trim();
      resolve(name ? basename(name) : null);
    });
  });
}

/** Said beside a touch placed as if upright on a device whose way up could not be read. */
const UNVERIFIED =
  "deckhand could not read which way up this iOS device is and placed the touch as if upright; if it is upside down, the touch landed mirrored. Check the returned screen.";

/** The wait an action asks SimDeck for, which its request must be allowed on top of the base timeout. */
function askedWaitMs(init: RequestInit | undefined): number {
  if (typeof init?.body !== "string") return 0;
  try {
    const b = JSON.parse(init.body) as Record<string, unknown>;
    const n = (k: string) => (typeof b[k] === "number" && Number.isFinite(b[k]) ? (b[k] as number) : 0);
    return n("timeoutMs") + n("waitTimeoutMs") + n("ms") + n("durationMs") + (b.action === "scrollUntilVisible" ? 30_000 : 0);
  } catch {
    return 0;
  }
}

export class SimDeckControl {
  private readonly daemon: SimDeckDaemon;
  private readonly fetchImpl: typeof fetch;

  private readonly now: () => number;
  private readonly lastTurns = new Map<string, number>();
  private readonly processName: (pid: number) => Promise<string | null>;
  private readonly processNames = new Map<number, string | null>();

  constructor(opts: SimDeckControlOptions = {}) {
    this.daemon = opts.daemon ?? new SimDeckDaemon(opts);
    const base = opts.fetchImpl ?? fetch;
    const baseMs = opts.requestTimeoutMs ?? 30_000;
    // A request SimDeck never answers would hold the device's queue until the OS gave up (~5 min).
    this.fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const ms = baseMs + askedWaitMs(init);
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SimDeckActionError(`SimDeck did not answer within ${Math.round(ms / 1000)} s — the action may still have run on the device; read the screen before you retry it`, 504)), ms);
      });
      return Promise.race([base(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(ms) }), late]).finally(() => clearTimeout(timer));
    }) as typeof fetch;
    this.now = opts.now ?? (() => Date.now());
    this.processName = opts.processNameImpl ?? defaultProcessName;
  }

  /**
   * Accessibility tree for a device (token-efficient; independent of the video stream).
   *
   * Two backends answer this, and the cheap one is the default. SimDeck's `describe`
   * ACTION returns the same screen as the `/accessibility-tree` endpoint in a third of
   * the bytes — measured on one app screen: 10,157 bytes for 76 elements, against 29,918
   * for the same 76 from the full tree and 26,501 for 70 from `interactiveOnly`. It is
   * both smaller AND more complete: the ids and labels are a superset of what
   * `interactiveOnly` returned. The saving is pure encoding — no `AXFrame` strings
   * duplicating the `frame` object, no null-valued keys, no `pid`/`hidden`/`enabled`
   * noise on every node.
   *
   * The action takes no options — passing `source`, `interactiveOnly` or `maxDepth` to it
   * changes nothing, verified against the daemon. So a caller that asks for any of them gets
   * the endpoint, because all three are real levers: `source` picks the framework inspector
   * over the native-AX fallback, which is the difference between a usable tree and 150
   * unlabelled nodes on a map-heavy screen, and `interactiveOnly` is a different, much
   * faster iOS capture — measured on iOS 26.5 Settings at ~0.2s against ~1.2s for both the
   * action and the full tree, at the price of headings and static text.
   */
  async describe(target: SimDeckTarget, opts: DescribeOptions = {}): Promise<unknown> {
    const origin = await this.daemon.ensureRunning();
    if (opts.source == null && opts.maxDepth == null && !opts.interactiveOnly) {
      const compact = await this.describeCompact(origin, target);
      // Same degradation as below: iOS can hand back an empty capture. Fall through to
      // the endpoint rather than answering "nothing on screen", which is never true.
      if (!isEmptyTree(compact)) return compact;
    }
    const body = await this.fetchTree(origin, target, opts);
    // iOS "regular/interactive" AX capture can degrade to an EMPTY tree on some
    // screens (a private-AX serialization limit — the response carries
    // `roots: []` + a `fallbackReason`), while the raw recursive tree still
    // works. Fall back to raw so the agent always gets something actionable.
    // (Observed on iOS 26.5.)
    if (opts.interactiveOnly && isEmptyTree(body)) {
      return this.fetchTree(origin, target, { ...opts, interactiveOnly: false });
    }
    return body;
  }

  /**
   * The compact snapshot, unwrapped to the same `{roots}` shape the endpoint returns so
   * callers never have to know which backend answered. SimDeck nests it under `snapshot`
   * alongside its own `action`/`ok` echo, which is bookkeeping the agent has no use for.
   */
  private async describeCompact(origin: string, target: SimDeckTarget): Promise<unknown> {
    const res = await this.post(origin, target, { action: "describe" });
    const snapshot = (res as { snapshot?: unknown })?.snapshot;
    return snapshot ?? res;
  }

  private async fetchTree(origin: string, target: SimDeckTarget, opts: DescribeOptions): Promise<unknown> {
    const q = new URLSearchParams();
    q.set("source", opts.source ?? "auto");
    if (opts.interactiveOnly) q.set("interactiveOnly", "true");
    if (opts.maxDepth != null) q.set("maxDepth", String(opts.maxDepth));
    const url = `${origin}/api/simulators/${enc(target.udid)}/accessibility-tree?${q.toString()}`;
    // SimDeck's own API is unauthenticated and accepts ANY udid. Deckhand's
    // callers are scoped (simdeckTarget resolves previewId+deviceId to a device
    // of that preview), so nothing here widens it — but the daemon is not a
    // trust boundary. Anything that reaches loopback can drive every booted
    // device directly, bypassing this client entirely.
    const res = await this.fetchImpl(url);
    const body = await readJson(res);
    if (!res.ok) throw new SimDeckActionError(errText(body, `describe failed (${res.status})`), res.status);
    return body;
  }

  /** Perform one UI action on a device. Returns SimDeck's result (e.g. query matches, assert verdict). */
  async action(target: SimDeckTarget, action: UiAction): Promise<unknown> {
    if ("selector" in action && action.selector.ref != null) {
      throw new SimDeckActionError(`ref ${action.selector.ref} reached SimDeck unresolved`, 400);
    }
    const origin = await this.daemon.ensureRunning();

    // iOS HID typing is ASCII-only; route non-US text (æøå, …) through the
    // pasteboard + Cmd-V paste instead of failing on an unsupported character.
    if (action.type === "type" && target.platform === "ios" && /[^\x00-\x7F]/.test(action.text)) {
      await this.pasteboard(origin, target, action.text);
      return this.post(origin, target, { action: "key", keyCode: V_USAGE, modifiers: CMD_MOD });
    }
    if (target.platform === "ios" && TOUCHES.has(action.type)) {
      const tree = await this.touchTree(origin, target).catch(() => null);
      const bounds = tree == null ? null : uiBounds(tree);
      const turns = tree == null ? null : await this.quarterTurns(target, tree);
      if (turns === 0) return this.post(origin, target, this.toStep(action));
      // Unread, or portrait that cannot be told from upside down: placed as before, and said so.
      if (turns === null && (!bounds || bounds.width <= bounds.height)) return unverified(await this.post(origin, target, this.toStep(action)));
      return this.turnedAction(origin, target, action, turns, tree);
    }
    return this.post(origin, target, this.toStep(action));
  }

  /**
   * How far an iOS device is turned, in quarter turns (see orientation.ts), or null when no element
   * on screen can tell — never a guess, portrait included. A screen with no tree reads as upright.
   */
  async quarterTurns(target: SimDeckTarget, current?: unknown): Promise<number | null> {
    if (target.platform !== "ios") return 0;
    const origin = await this.daemon.ensureRunning();
    const tree = current ?? (await this.touchTree(origin, target));
    const bounds = uiBounds(tree);
    if (!bounds) return 0;
    const pair = candidateTurns(bounds);
    // Checked on every touch: the viewer's Rotate button turns the device under the agent. A wrong
    // guess is the slow hit-test (up to seconds, against ~10ms), so the last answer goes first.
    const last = this.lastTurns.get(target.udid);
    const order = last != null && pair.includes(last) ? [last, pair.find((t) => t !== last)!] : pair;
    const spaceOf = await this.spaces(tree);
    for (const probe of probeNodes(tree, bounds, spaceOf)) {
      for (const turns of order) {
        if (!hitMatches(await this.hit(origin, target, nativeProbePoint(probe, bounds, turns)), probe, bounds)) continue;
        this.lastTurns.set(target.udid, turns);
        return turns;
      }
    }
    return null;
  }

  /** Which points each root of `tree` is in, asking the OS which process owns it (orientation.ts rootSpace). */
  private async spaces(tree: unknown): Promise<SpaceOf> {
    const owners = new Map<unknown, string | null>();
    for (const root of rootsOf(tree)) {
      const pid = root.pid;
      if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) continue;
      if (!this.processNames.has(pid)) {
        if (this.processNames.size > 64) this.processNames.clear();
        this.processNames.set(pid, await this.processName(pid).catch(() => null));
      }
      owners.set(root, this.processNames.get(pid) ?? null);
    }
    return (root) => rootSpace(root, owners.get(root));
  }

  /** The screen a touch is placed on: the capture SimDeck's own selector tap reads. */
  private async touchTree(origin: string, target: SimDeckTarget): Promise<unknown> {
    const tree = await this.fetchTree(origin, target, { source: "auto", interactiveOnly: true });
    return isEmptyTree(tree) ? this.fetchTree(origin, target, { source: "auto" }) : tree;
  }

  /** The element under a point in the unrotated screen's points, with its frame in the UI; null when nothing is there. */
  private async hit(origin: string, target: SimDeckTarget, p: { x: number; y: number }): Promise<ReturnType<typeof frameOf>> {
    const q = new URLSearchParams({ x: p.x.toFixed(1), y: p.y.toFixed(1) });
    const res = await this.fetchImpl(`${origin}/api/simulators/${enc(target.udid)}/accessibility-point?${q.toString()}`);
    if (!res.ok) return null;
    return frameOf(rootsOf(await readJson(res))[0]);
  }

  /** A touch on a turned iOS device, placed by deckhand in the unrotated screen SimDeck injects into. */
  private async turnedAction(origin: string, target: SimDeckTarget, a: UiAction, turns: number | null, tree: unknown): Promise<unknown> {
    const swipe = (sx: number, sy: number, ex: number, ey: number, durationMs?: number) => {
      const s = toNative(sx, sy, known(turns));
      const e = toNative(ex, ey, known(turns));
      return this.post(origin, target, {
        action: "swipe", startX: s.x, startY: s.y, endX: e.x, endY: e.y, ...(durationMs != null ? { durationMs } : {}),
      });
    };
    switch (a.type) {
      case "tap": {
        const p = toNative(a.x, a.y, known(turns));
        return this.post(origin, target, { action: "tap", x: p.x, y: p.y, normalized: true });
      }
      case "swipe":
        return swipe(a.startX, a.startY, a.endX, a.endY, a.durationMs);
      case "gesture": {
        const [sx, sy, ex, ey] = presetSwipe(a.preset);
        await swipe(sx, sy, ex, ey, PRESET_DURATION_MS);
        return { action: "gesture", preset: a.preset };
      }
      case "tapElement":
        return this.turnedTapElement(origin, target, a.selector, a.waitTimeoutMs ?? 0, turns, tree);
      case "back": {
        for (const [selector, wait] of [[{ id: "BackButton" }, 2000], [{ label: "Back" }, 3000]] as const) {
          try {
            await this.turnedTapElement(origin, target, selector, wait, turns, tree);
            return { action: "back", method: "id" in selector ? "backButtonId" : "backLabel" };
          } catch (e) {
            if (!(e instanceof SimDeckActionError) || e.status !== 404) throw e;
          }
        }
        await swipe(0.02, 0.5, 0.85, 0.5, 350);
        return { action: "back", method: "edgeSwipe" };
      }
      default:
        return this.post(origin, target, this.toStep(a));
    }
  }

  /** SimDeck's selector tap, with the element found and the point placed here (orientation.ts). */
  private async turnedTapElement(
    origin: string, target: SimDeckTarget, selector: Selector, waitMs: number, turns: number | null, first: unknown,
  ): Promise<unknown> {
    const deadline = this.now() + waitMs;
    let tree = first;
    for (let last = false; ; ) {
      const found = selectorTarget(tree, selector, await this.spaces(tree));
      if (found) {
        if (found.space === "unknown") {
          throw new SimDeckActionError(
            "this iOS device is turned and deckhand cannot tell whether that element is SpringBoard's (unrotated points) or the app's, so it will not tap it",
            409,
          );
        }
        const p = found.space === "native" ? { x: found.u, y: found.v } : toNative(found.u, found.v, known(turns));
        await this.post(origin, target, { action: "tap", x: p.x, y: p.y, normalized: true });
        return { action: "tap" };
      }
      if (last) throw new SimDeckActionError("No accessibility element matched.", 404);
      // Like SimDeck: poll the interactive capture until the wait runs out, then read the full tree once.
      if (this.now() >= deadline) {
        last = true;
        tree = await this.fetchTree(origin, target, { source: "auto" });
      } else {
        await new Promise((r) => setTimeout(r, 150));
        tree = await this.touchTree(origin, target);
      }
    }
  }

  /** PNG screenshot via SimDeck (uses public `simctl io`; streaming-free). */
  async screenshot(target: SimDeckTarget): Promise<Buffer> {
    const origin = await this.daemon.ensureRunning();
    const res = await this.fetchImpl(`${origin}/api/simulators/${enc(target.udid)}/screenshot.png`);
    if (!res.ok) throw new SimDeckActionError(`screenshot failed (${res.status})`, res.status);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Translate a deckhand UiAction into SimDeck's `/action` payload (camelCase). */
  private toStep(a: UiAction): Record<string, unknown> {
    switch (a.type) {
      case "tap":
        return { action: "tap", x: a.x, y: a.y, normalized: true };
      case "tapElement":
        return { action: "tap", selector: a.selector, ...(a.waitTimeoutMs != null ? { waitTimeoutMs: a.waitTimeoutMs } : {}) };
      case "type":
        return { action: "type", text: a.text };
      case "key":
        return { action: "key", keyCode: keyUsage(a.name) };
      case "button":
        return { action: "button", button: a.name };
      case "home":
        return { action: "home" };
      case "swipe":
        return {
          action: "swipe",
          startX: a.startX, startY: a.startY, endX: a.endX, endY: a.endY,
          ...(a.durationMs != null ? { durationMs: a.durationMs } : {}),
        };
      case "gesture":
        return { action: "gesture", preset: a.preset };
      case "openUrl":
        return { action: "openUrl", url: a.url };
      case "back":
        return { action: "back" };
      case "dismissKeyboard":
        return { action: "dismissKeyboard" };
      case "sleep":
        // SimDeck reads `ms` and echoes it back as `durationMs`; sending `durationMs`
        // is accepted and silently slept for 0.
        return { action: "sleep", ms: a.ms };
      case "scrollUntilVisible":
        return { action: "scrollUntilVisible", selector: a.selector };
      case "toggleAppearance":
        return { action: "toggleAppearance" };
      case "waitFor":
        return { action: "waitFor", selector: a.selector, ...(a.timeoutMs != null ? { timeoutMs: a.timeoutMs } : {}) };
      case "waitForNot":
        return { action: "waitForNot", selector: a.selector, ...(a.timeoutMs != null ? { timeoutMs: a.timeoutMs } : {}) };
      case "assert":
        return { action: "assert", selector: a.selector };
      case "assertNot":
        return { action: "assertNot", selector: a.selector };
      case "query":
        return { action: "query", selector: a.selector };
    }
  }

  private async post(origin: string, target: SimDeckTarget, body: Record<string, unknown>): Promise<unknown> {
    const res = await this.fetchImpl(`${origin}/api/simulators/${enc(target.udid)}/action`, {
      method: "POST",
      // The same-origin `Origin` is what authorizes the loopback POST (no token).
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(body),
    });
    const json = await readJson(res);
    if (!res.ok) throw new SimDeckActionError(errText(json, `${String(body.action)} failed (${res.status})`), res.status);
    return json;
  }

  private async pasteboard(origin: string, target: SimDeckTarget, text: string): Promise<void> {
    const res = await this.fetchImpl(`${origin}/api/simulators/${enc(target.udid)}/pasteboard`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new SimDeckActionError(`pasteboard set failed (${res.status})`, res.status);
  }
}

function enc(udid: string): string {
  return encodeURIComponent(udid);
}

/** A SimDeck describe response that carries no usable nodes (degraded iOS AX capture). */
function isEmptyTree(body: unknown): boolean {
  if (!body || typeof body !== "object") return true;
  const roots = (body as { roots?: unknown }).roots;
  return Array.isArray(roots) && roots.length === 0;
}

function keyUsage(name: string): number {
  const usage = KEY_USAGE[name.toLowerCase()];
  if (usage == null) throw new SimDeckActionError(`unknown key "${name}" (try: enter, backspace, tab, escape, up/down/left/right)`, 400);
  return usage;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function errText(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const e = b.error ?? b.message;
    if (typeof e === "string" && e) return e;
    if (e && typeof e === "object") {
      const m = (e as Record<string, unknown>).message;
      if (typeof m === "string" && m) return m;
    }
  }
  return fallback;
}
