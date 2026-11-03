import { SimDeckActionError, type DescribeOptions, type Selector, type UiAction } from "./control.ts";
import { WdaClient, WdaError, keyText } from "./wdaClient.ts";
import { wdaSourceToTree, WdaSourceError, type PhoneTree } from "./wdaTree.ts";
import { flattenTree, shapeOf, type ScreenNode } from "./screen.ts";
import { presetSwipe, PRESET_DURATION_MS } from "./orientation.ts";

// ---------------------------------------------------------------------------
// `describe` and `ui` for a physical iPhone, over WebDriverAgent (wdaClient.ts). Same contract as
// SimDeckControl: the tree is the `{roots}` shape screen.ts reads, `tap`/`swipe` take 0..1 of the
// screen, selectors arrive already resolved from refs. Selectors are matched here, against the WDA
// tree, because WDA's own element queries are slow and match differently.
//
// A phone is borrowed hardware: every action that touches or types first checks that the
// preview's app is the one in front, and nothing here presses home, a hardware button, or a
// setting. What cannot be done faithfully is refused with a reason an agent can act on.
// ---------------------------------------------------------------------------

/** A phone addressed by UDID, with the bundle id of the preview's app — the only app it may drive. */
export interface IphoneTarget {
  platform: "ios";
  udid: string;
  bundleId?: string;
}

/** What the engine calls on a device's control backend; SimDeckControl has the same shape. */
export interface DeviceControl<T> {
  describe(target: T, opts?: DescribeOptions): Promise<unknown>;
  action(target: T, action: UiAction): Promise<unknown>;
  screenshot(target: T): Promise<Buffer>;
}

export class IphoneActionError extends SimDeckActionError {
  constructor(message: string, status: number) {
    super(message, status);
    this.name = "IphoneActionError";
  }
}

export interface IphoneControlOptions {
  /** A client for this phone's WDA, started and forwarded (devices/wdaRunner.ts `ensureRunning`). */
  clientFor(udid: string): Promise<WdaClient>;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

const DEFAULT_WAIT_MS = 5_000;
const POLL_MS = 300;
const SCROLL_TRIES = 10;
const BACK_LABEL = /\b(back|tilbake)\b/i;

const REFUSED: Partial<Record<UiAction["type"], string>> = {
  home: "a physical phone is driven only inside the preview's app, so deckhand never presses home on it. Use `back`, or relaunch the app with restart_preview.",
  button: "a physical phone is driven only inside the preview's app, so deckhand never presses its hardware buttons. Use `back`, or relaunch the app with restart_preview.",
  openUrl: "openUrl is not available on a physical iPhone: iOS may hand the URL to another app. Relaunch the preview's app with the deep link as its launch payload instead.",
  toggleAppearance: "toggleAppearance changes a setting on the phone, and deckhand never changes settings on borrowed hardware. Switch appearance on the phone yourself.",
};

export class IphoneControl implements DeviceControl<IphoneTarget> {
  private readonly clientFor: (udid: string) => Promise<WdaClient>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(opts: IphoneControlOptions) {
    this.clientFor = opts.clientFor;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
  }

  async describe(target: IphoneTarget, _opts: DescribeOptions = {}): Promise<PhoneTree> {
    return this.tree(await this.client(target));
  }

  async screenshot(target: IphoneTarget): Promise<Buffer> {
    const client = await this.client(target);
    return wrap(() => client.screenshot());
  }

  async action(target: IphoneTarget, a: UiAction): Promise<unknown> {
    if ("selector" in a && a.selector.ref != null) throw new IphoneActionError(`ref ${a.selector.ref} reached the iPhone control unresolved`, 400);
    const refused = REFUSED[a.type];
    if (refused) throw new IphoneActionError(refused, 422);
    const client = await this.client(target);
    switch (a.type) {
      case "sleep":
        await this.sleep(a.ms);
        return { action: "sleep", ms: a.ms };
      case "assert": {
        const hit = find(nodesOf(await this.tree(client)), a.selector);
        if (!hit) throw notFound(a.selector);
        return { action: "assert", ok: true, element: brief(hit) };
      }
      case "assertNot": {
        const hit = find(nodesOf(await this.tree(client)), a.selector);
        if (hit) throw new IphoneActionError(`an element matching ${JSON.stringify(a.selector)} is on screen: ${JSON.stringify(brief(hit))}`, 409);
        return { action: "assertNot", ok: true };
      }
      case "query": {
        const matches = matchAll(nodesOf(await this.tree(client)), a.selector);
        return { action: "query", count: matches.length, matches: matches.map(brief) };
      }
      case "waitFor": {
        const hit = await this.poll(client, a.timeoutMs ?? DEFAULT_WAIT_MS, (nodes) => find(nodes, a.selector));
        if (!hit) throw notFound(a.selector, a.timeoutMs ?? DEFAULT_WAIT_MS);
        return { action: "waitFor", ok: true, element: brief(hit) };
      }
      case "waitForNot": {
        const gone = await this.poll(client, a.timeoutMs ?? DEFAULT_WAIT_MS, (nodes) => (find(nodes, a.selector) ? null : true));
        if (!gone) throw new IphoneActionError(`an element matching ${JSON.stringify(a.selector)} was still on screen after ${a.timeoutMs ?? DEFAULT_WAIT_MS} ms`, 408);
        return { action: "waitForNot", ok: true };
      }
    }

    await this.inApp(client, target);
    switch (a.type) {
      case "tap": {
        const size = await wrap(() => client.windowSize());
        await wrap(() => client.tap(clamp(a.x) * size.width, clamp(a.y) * size.height));
        return { action: "tap" };
      }
      case "tapElement": {
        const hit = await this.poll(client, a.waitTimeoutMs ?? 0, (nodes) => find(nodes, a.selector));
        if (!hit) throw notFound(a.selector, a.waitTimeoutMs);
        if (hit.offscreen) throw new IphoneActionError(`${describeSel(a.selector)} is off screen — scroll it into view first (scrollUntilVisible, or a gesture)`, 409);
        await this.tapNode(client, hit);
        return { action: "tap", element: brief(hit) };
      }
      case "type":
        await wrap(() => client.keys(a.text), "focus the field first (tapElement on it), then type");
        return { action: "type" };
      case "key": {
        const text = keyText(a.name);
        if (text == null) throw new IphoneActionError(`key "${a.name}" cannot be typed on an iPhone's keyboard (try: enter, backspace, tab, space)`, 400);
        await wrap(() => client.keys(text), "focus a field first");
        return { action: "key", name: a.name };
      }
      case "swipe": {
        const size = await wrap(() => client.windowSize());
        await wrap(() => client.swipe(clamp(a.startX) * size.width, clamp(a.startY) * size.height, clamp(a.endX) * size.width, clamp(a.endY) * size.height, a.durationMs ?? 300));
        return { action: "swipe" };
      }
      case "gesture":
        await this.preset(client, a.preset);
        return { action: "gesture", preset: a.preset };
      case "back":
        return this.back(client);
      case "dismissKeyboard":
        await wrap(
          () => client.dismissKeyboard(),
          "this keyboard has no Done or Return key deckhand can press — tap outside the field, or send key {name: \"enter\"}",
        );
        return { action: "dismissKeyboard" };
      case "scrollUntilVisible":
        return this.scrollUntilVisible(client, a.selector);
    }
    throw new IphoneActionError(`${a.type} is not supported on a physical iPhone`, 422);
  }

  private async client(target: IphoneTarget): Promise<WdaClient> {
    if (target.platform !== "ios") throw new IphoneActionError("the iPhone control drives iOS devices only", 400);
    return this.clientFor(target.udid);
  }

  private async tree(client: WdaClient): Promise<PhoneTree> {
    const source = await wrap(() => client.source());
    let tree: PhoneTree;
    try {
      tree = wdaSourceToTree(source);
    } catch (e) {
      if (e instanceof WdaSourceError) throw new IphoneActionError(`WDA answered something that is not a screen: ${e.message}`, 502);
      throw e;
    }
    if (tree.roots.length === 1 && !tree.roots[0]!.children?.length) {
      throw new IphoneActionError("WDA read nothing on this iPhone's screen — it is probably locked or asleep. Unlock it (and set Auto-Lock to Never) and retry.", 503);
    }
    return tree;
  }

  /** The preview's app must be in front: a tap or a keystroke anywhere else is outside what deckhand may drive. */
  private async inApp(client: WdaClient, target: IphoneTarget): Promise<void> {
    if (!target.bundleId) {
      throw new IphoneActionError("deckhand drives a physical phone only inside the preview's app, and no app is registered for this device", 409);
    }
    const app = await wrap(() => client.activeAppInfo());
    if (app.bundleId !== target.bundleId) {
      throw new IphoneActionError(
        `the phone is showing ${app.bundleId ?? "something deckhand cannot name"}, not the preview's app (${target.bundleId}); deckhand never acts outside it. Relaunch the app with restart_preview, then retry.`,
        409,
      );
    }
  }

  private async poll<T>(client: WdaClient, waitMs: number, test: (nodes: ScreenNode[]) => T | null | undefined): Promise<T | null> {
    const deadline = this.now() + Math.max(0, waitMs);
    for (;;) {
      const hit = test(nodesOf(await this.tree(client)));
      if (hit) return hit;
      if (this.now() >= deadline) return null;
      await this.sleep(POLL_MS);
    }
  }

  private async tapNode(client: WdaClient, n: ScreenNode): Promise<void> {
    const f = n.frame;
    if (!f) throw new IphoneActionError(`${n.label ?? n.id ?? n.role} has no frame to tap`, 409);
    await wrap(() => client.tap(f.x + f.width / 2, f.y + f.height / 2));
  }

  private async preset(client: WdaClient, preset: string): Promise<void> {
    let p: [number, number, number, number];
    try {
      p = presetSwipe(preset);
    } catch (e) {
      throw new IphoneActionError((e as Error).message, 400);
    }
    const size = await wrap(() => client.windowSize());
    await wrap(() => client.swipe(p[0] * size.width, p[1] * size.height, p[2] * size.width, p[3] * size.height, PRESET_DURATION_MS));
  }

  /** iOS has no back key: the navigation bar's back button, else UINavigationController's edge swipe. */
  private async back(client: WdaClient): Promise<unknown> {
    const tree = await this.tree(client);
    const nodes = nodesOf(tree);
    const btn =
      nodes.find((n) => n.role === "Button" && n.id === "BackButton" && !n.offscreen) ??
      nodes.find((n) => n.role === "Button" && !n.offscreen && n.frame && n.frame.x < 40 && n.frame.y > 40 && n.frame.y < 140 && BACK_LABEL.test(`${n.label ?? ""} ${n.id ?? ""}`));
    if (btn) {
      await this.tapNode(client, btn);
      return { action: "back", method: "backButton", element: brief(btn) };
    }
    const size = await wrap(() => client.windowSize());
    await wrap(() => client.swipe(2, size.height / 2, size.width * 0.7, size.height / 2, 250));
    return {
      action: "back",
      method: "edgeSwipe",
      note: "This screen has no navigation-bar back button, so deckhand swiped in from the left edge. That does not close a modal sheet: if the screen did not change, it is a modal — look for its close or Done button, or swipe it down.",
    };
  }

  private async scrollUntilVisible(client: WdaClient, selector: Selector): Promise<unknown> {
    let before = "";
    for (let i = 0; i <= SCROLL_TRIES; i++) {
      const tree = await this.tree(client);
      const hit = find(nodesOf(tree), selector);
      if (hit && !hit.offscreen) return { action: "scrollUntilVisible", scrolls: i, element: brief(hit) };
      const shape = shapeOf(tree);
      if (i > 0 && shape === before) break;
      before = shape;
      if (i < SCROLL_TRIES) await this.preset(client, "scroll-down");
    }
    throw new IphoneActionError(`${describeSel(selector)} did not come into view after scrolling down to where the screen stopped moving`, 404);
  }
}

function nodesOf(tree: PhoneTree): ScreenNode[] {
  return flattenTree(tree);
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function test(want: string, got: string | undefined, regex: boolean | undefined): boolean {
  if (got === undefined) return false;
  if (!regex) return got === want;
  try {
    return new RegExp(want).test(got);
  } catch {
    throw new IphoneActionError(`invalid regex ${JSON.stringify(want)}`, 400);
  }
}

export function matchAll(nodes: ScreenNode[], s: Selector): ScreenNode[] {
  if (s.id == null && s.label == null && s.text == null && s.value == null) {
    throw new IphoneActionError("a selector needs an id, label, text or value", 400);
  }
  return nodes.filter(
    (n) =>
      (s.id == null || test(s.id, n.id, s.regex)) &&
      (s.label == null || test(s.label, n.label, s.regex)) &&
      (s.value == null || test(s.value, n.value, s.regex)) &&
      (s.text == null || test(s.text, n.label, s.regex) || test(s.text, n.value, s.regex)),
  );
}

function find(nodes: ScreenNode[], s: Selector): ScreenNode | undefined {
  return matchAll(nodes, s)[s.index ?? 0];
}

function brief(n: ScreenNode): Record<string, unknown> {
  return { role: n.role, ...(n.label ? { label: n.label } : {}), ...(n.id ? { id: n.id } : {}), ...(n.value ? { value: n.value } : {}), ...(n.offscreen ? { offscreen: true } : {}) };
}

function describeSel(s: Selector): string {
  const { regex: _r, index: _i, ...rest } = s;
  return `the element ${JSON.stringify(rest)}`;
}

function notFound(s: Selector, waitedMs?: number): IphoneActionError {
  return new IphoneActionError(`No accessibility element matched ${JSON.stringify(s)}${waitedMs ? ` within ${waitedMs} ms` : ""}.`, 404);
}

async function wrap<T>(fn: () => Promise<T>, hint?: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof WdaError) throw new IphoneActionError(hint ? `${e.message} — ${hint}` : e.message, e.status);
    throw e;
  }
}
