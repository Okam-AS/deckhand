import { SimDeckDaemon, type SimDeckDaemonOptions } from "./simdeck.ts";

// ---------------------------------------------------------------------------
// SimDeck control-only REST client. Backs deckhand's `describe` (accessibility
// tree) and `ui` (tap/type/…) MCP tools by driving SimDeck's REST surface on a
// device deckhand already booted. See simdeck.ts for the two hard rules (REST
// only; same-origin auth, no token). Every request carries a matching `Origin`
// so the loopback POST is accepted without a token — and this client never
// touches the input WebSocket / webrtc / refresh endpoints.
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

/** An element selector — prefer id/text/label (the positional @e# refs are unstable across snapshots). */
export interface Selector {
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
  | { type: "waitFor"; selector: Selector; timeoutMs?: number }
  | { type: "assert"; selector: Selector }
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
const KEY_USAGE: Record<string, number> = {
  return: 40, enter: 40, escape: 41, backspace: 42, tab: 43, space: 44,
  delete: 76, right: 79, left: 80, down: 81, up: 82,
};
// HID usage for 'v' + left-GUI (Cmd) modifier bit — used to paste non-US text on iOS.
const V_USAGE = 25;
const CMD_MOD = 0x08;

export interface SimDeckControlOptions extends SimDeckDaemonOptions {
  daemon?: SimDeckDaemon;
}

export class SimDeckControl {
  private readonly daemon: SimDeckDaemon;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SimDeckControlOptions = {}) {
    this.daemon = opts.daemon ?? new SimDeckDaemon(opts);
    this.fetchImpl = opts.fetchImpl ?? fetch;
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
   * changes nothing, verified against the daemon. So a caller that asks for `source` or
   * `maxDepth` still gets the endpoint, because those are real levers: `source` picks the
   * framework inspector over the native-AX fallback, which is the difference between a
   * usable tree and 150 unlabelled nodes on a map-heavy screen. `interactiveOnly` alone
   * does NOT force the endpoint — the action is strictly better on that axis.
   */
  async describe(target: SimDeckTarget, opts: DescribeOptions = {}): Promise<unknown> {
    const origin = await this.daemon.ensureRunning();
    if (opts.source == null && opts.maxDepth == null) {
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
    const origin = await this.daemon.ensureRunning();

    // iOS HID typing is ASCII-only; route non-US text (æøå, …) through the
    // pasteboard + Cmd-V paste instead of failing on an unsupported character.
    if (action.type === "type" && target.platform === "ios" && /[^\x00-\x7F]/.test(action.text)) {
      await this.pasteboard(origin, target, action.text);
      return this.post(origin, target, { action: "key", keyCode: V_USAGE, modifiers: CMD_MOD });
    }
    return this.post(origin, target, this.toStep(action));
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
      case "waitFor":
        return { action: "waitFor", selector: a.selector, ...(a.timeoutMs != null ? { timeoutMs: a.timeoutMs } : {}) };
      case "assert":
        return { action: "assert", selector: a.selector };
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
