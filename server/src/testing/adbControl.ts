import { makeDefaultExec, type Exec } from "../devices/android.ts";
import { escapeInputText, NonAsciiTextError, type RegisteredApp } from "../devices/androidPhone.ts";
import { SimDeckActionError, type ControlBackend, type DescribeOptions, type Selector, type SimDeckTarget, type UiAction } from "./control.ts";
import { presetSwipe, PRESET_DURATION_MS } from "./orientation.ts";
import { phoneEdgeSwipeRefusal } from "./phoneEdges.ts";

// ---------------------------------------------------------------------------
// `describe` and `ui` for a physical Android phone, over adb. SimDeck addresses
// Android only as `android:<AVD name>` and answers a phone's serial with
// "Android emulator `<serial>` is not running", so a phone is driven here with
// `uiautomator dump`, `input` and `am`. The tree it returns is the shape
// screen.ts reads (role/label/value/id/frame), in pixels of the display `wm size`
// reports, so refs and the UiAction semantics are the same as on an emulator.
// ---------------------------------------------------------------------------

export interface UiNode {
  role: string;
  label?: string;
  hint?: string;
  value?: string;
  id?: string;
  package?: string;
  clickable?: boolean;
  frame: { x: number; y: number; width: number; height: number };
  children: UiNode[];
}

export interface UiTree {
  roots: UiNode[];
}

const TEXT_INPUT = /EditText|AutoCompleteTextView/;

function unescapeXml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attrsOf(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([\w-]+)="([^"]*)"/g)) out[m[1]!] = unescapeXml(m[2]!);
  return out;
}

function boundsOf(b: string | undefined): UiNode["frame"] {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(b ?? "");
  if (!m) return { x: 0, y: 0, width: 0, height: 0 };
  const [x1, y1, x2, y2] = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function nodeOf(a: Record<string, string>): UiNode {
  const role = (a.class ?? "").split(".").pop() || "Element";
  const text = a.text || undefined;
  const desc = a["content-desc"] || undefined;
  const input = TEXT_INPUT.test(role);
  return {
    role,
    ...(input ? { label: desc, hint: a.hint || undefined, value: text } : { label: text ?? desc }),
    ...(a["resource-id"] ? { id: a["resource-id"] } : {}),
    ...(a.package ? { package: a.package } : {}),
    ...(a.clickable === "true" ? { clickable: true } : {}),
    frame: boundsOf(a.bounds),
    children: [],
  };
}

/**
 * A uiautomator dump as one root the size of the display, so a ref's centre normalises to the
 * same 0..1 the screenshot and a `tap {x,y}` use.
 */
export function parseUiAutomatorTree(xml: string, screen: { w: number; h: number }): UiTree {
  const rotation = Number(/<hierarchy[^>]*rotation="(\d)"/.exec(xml)?.[1] ?? 0);
  const [w, h] = rotation % 2 ? [screen.h, screen.w] : [screen.w, screen.h];
  const root: UiNode = { role: "Screen", frame: { x: 0, y: 0, width: w, height: h }, children: [] };
  const stack: UiNode[] = [root];
  for (const m of xml.matchAll(/<(\/?)node\b([^>]*?)(\/?)>/g)) {
    if (m[1]) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node = nodeOf(attrsOf(m[2]!));
    stack[stack.length - 1]!.children.push(node);
    if (!m[3]) stack.push(node);
  }
  return { roots: [root] };
}

function* walk(nodes: UiNode[]): Generator<UiNode> {
  for (const n of nodes) {
    yield n;
    yield* walk(n.children);
  }
}

function matches(want: string | undefined, have: string | undefined, regex?: boolean): boolean {
  if (want == null) return true;
  if (have == null) return false;
  return regex ? new RegExp(want).test(have) : have === want;
}

/**
 * The elements a selector names. `text` matches a label for every verb except `query`, which also
 * matches what a field holds — the same split SimDeck has, so a flow behaves alike on both.
 */
export function findAll(tree: UiTree, sel: Selector, verb: UiAction["type"]): UiNode[] {
  const hits: UiNode[] = [];
  for (const n of walk(tree.roots)) {
    if (n.role === "Screen" || n.frame.width <= 0 || n.frame.height <= 0) continue;
    const idOk =
      sel.id == null || (n.id != null && (sel.regex ? new RegExp(sel.id).test(n.id) : n.id === sel.id || n.id.endsWith(`:id/${sel.id}`)));
    const labelOk = matches(sel.label, n.label, sel.regex);
    const textOk = sel.text == null || matches(sel.text, n.label, sel.regex) || (verb === "query" && (matches(sel.text, n.value, sel.regex) || matches(sel.text, n.hint, sel.regex)));
    const valueOk = matches(sel.value, n.value, sel.regex);
    if (idOk && labelOk && textOk && valueOk) hits.push(n);
  }
  return sel.index != null ? hits.slice(sel.index, sel.index + 1) : hits;
}

const KEYCODES: Record<string, number> = {
  enter: 66, return: 66, backspace: 67, tab: 61, escape: 111, space: 62, delete: 112,
  up: 19, down: 20, left: 21, right: 22,
};
/**
 * Buttons a phone may be pressed with. Power and volume change the phone's state, not the app's;
 * home and the app switcher leave the app, after which a tap lands on the launcher or another app.
 */
const BUTTONS: Record<string, number> = { back: 4, menu: 82 };
const LEAVES_APP = /^(home|app-?switch(er)?|recents?)$/i;
const TOUCHES = new Set<UiAction["type"]>(["tap", "tapElement", "type", "key", "swipe", "gesture", "scrollUntilVisible"]);
/** Read the tree first, which can wait out an animation, so focus is checked after it, right before the touch. */
const CHECKED_AT_THE_TOUCH = new Set<UiAction["type"]>(["tapElement", "scrollUntilVisible"]);
const LEAVES_APP_MESSAGE =
  "a physical phone is driven only inside the preview's app, so deckhand never presses home or the app switcher on it. Use `back`, or relaunch the app with restart_preview.";

/**
 * Windows outside the app's own package that are still the app's flow, because the app opened them
 * and the user returns from them: the runtime-permission prompt, Google sign-in and account
 * pickers, and a browser Custom Tab (where most web logins run).
 */
const PART_OF_APP_FLOW = /^(com\.(google\.)?android\.permissioncontroller|com\.google\.android\.gms|com\.android\.chrome|com\.sec\.android\.app\.sbrowser)$/;

/** What `dumpsys window displays` says has input focus: a package, or a bare system window such as NotificationShade. */
export function focusedWindow(dumpsys: string): { pkg: string } | { window: string } | null {
  const cur = /mCurrentFocus=Window\{\S+ u\d+ ([^}\s]+)\}/.exec(dumpsys)?.[1];
  if (!cur) return null; // mCurrentFocus=null: a transition; ask again
  const slash = cur.indexOf("/");
  if (slash > 0) return { pkg: cur.slice(0, slash) };
  // An app's popup menu or dropdown is a bare `PopupWindow:<hash>`, owned by the focused activity.
  if (/^PopupWindow:/.test(cur)) {
    const app = /mFocusedApp=ActivityRecord\{\S+ u\d+ ([^/\s]+)\//.exec(dumpsys)?.[1];
    if (app) return { pkg: app };
  }
  return { window: cur };
}

type Frame = UiNode["frame"];

/**
 * The visible navigation bar(s) in `dumpsys window displays`, in the rotated pixels `input tap` uses.
 * With three-button navigation its Home and Recents are a tap away while the app still has focus.
 */
export function navigationBars(dumpsys: string): Frame[] {
  const out: Frame[] = [];
  for (const m of dumpsys.matchAll(/type=(?:navigationBars|ITYPE_NAVIGATION_BAR) frame=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\] visible=true/g)) {
    const [x1, y1, x2, y2] = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
    out.push({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
  }
  return out;
}

function refuseOnNavigationBar(bars: Frame[], x: number, y: number): void {
  if (!bars.some((f) => x >= f.x && x < f.x + f.width && y >= f.y && y < f.y + f.height)) return;
  throw new SimDeckActionError(
    `(${x}, ${y}) is on the phone's navigation bar, whose Home and Recents leave the preview's app, so deckhand does not touch it on a phone. Aim at the app's content, or use \`back\`.`,
    422,
  );
}

const describeSelector = (s: Selector): string => JSON.stringify(Object.fromEntries(Object.entries(s).filter(([, v]) => v != null)));

export interface AdbControlOptions {
  exec?: Exec;
  /** The preview's registered app on a phone: `openUrl` goes to it and to nothing else. */
  appOf?: (serial: string) => RegisteredApp | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class AdbControl implements ControlBackend {
  private readonly exec: Exec;
  private readonly appOf: (serial: string) => RegisteredApp | null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly sizes = new Map<string, { w: number; h: number }>();

  constructor(opts: AdbControlOptions = {}) {
    this.exec = opts.exec ?? makeDefaultExec();
    this.appOf = opts.appOf ?? (() => null);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
  }

  private async adb(serial: string, args: string[], timeoutMs = 30_000) {
    return this.exec("adb", ["-s", serial, ...args], { timeoutMs });
  }

  private async shell(serial: string, args: string[]): Promise<string> {
    const res = await this.adb(serial, ["shell", ...args]);
    if (res.code !== 0) throw new SimDeckActionError(`adb shell ${args.slice(0, 2).join(" ")} failed: ${res.stderr.trim().slice(0, 160) || `exit ${res.code}`}`, 502);
    return res.stdout.toString();
  }

  /** The display in the pixels `input` taps in: the override size when the phone has one. */
  private async size(serial: string): Promise<{ w: number; h: number }> {
    const known = this.sizes.get(serial);
    if (known) return known;
    const out = await this.shell(serial, ["wm", "size"]);
    const m = /Override size:\s*(\d+)x(\d+)/.exec(out) ?? /(\d+)x(\d+)/.exec(out);
    if (!m) throw new SimDeckActionError(`could not read the screen size of ${serial} from \`wm size\`: ${out.trim().slice(0, 120)}`, 502);
    const size = { w: Number(m[1]), h: Number(m[2]) };
    this.sizes.set(serial, size);
    return size;
  }

  /**
   * One capture, or an actionable error — never an empty tree, which reads as "nothing on screen".
   * Dumped to stdout so nothing is left on the phone; uiautomator refuses while the window animates,
   * so it is asked again until the deadline.
   */
  async tree(serial: string, timeoutMs = 15_000): Promise<UiTree> {
    const size = await this.size(serial);
    const deadline = this.now() + timeoutMs;
    let last = "no attempt completed";
    for (let attempt = 1; ; attempt++) {
      const res = await this.adb(serial, ["exec-out", "uiautomator", "dump", "/dev/stdout"]);
      const out = res.stdout.toString();
      const end = out.indexOf("</hierarchy>");
      if (res.code === 0 && end >= 0) {
        const tree = parseUiAutomatorTree(out.slice(0, end + "</hierarchy>".length), size);
        if (tree.roots[0]!.children.length) return tree;
        last = "the dump held no elements";
      } else {
        last = `${out}${res.stderr}`.trim().slice(0, 160) || `uiautomator dump exited ${res.code}`;
      }
      if (this.now() >= deadline) throw new SimDeckActionError(`no accessibility tree from ${serial} after ${attempt} attempt(s): ${last}`, 503);
      await this.sleep(1000);
    }
  }

  async describe(target: SimDeckTarget, _opts: DescribeOptions = {}): Promise<unknown> {
    return this.tree(target.udid);
  }

  private async px(serial: string, x: number, y: number): Promise<[number, number]> {
    const { w, h } = await this.size(serial);
    return [Math.round(Math.min(Math.max(x, 0), 1) * (w - 1)), Math.round(Math.min(Math.max(y, 0), 1) * (h - 1))];
  }

  private async swipe(serial: string, sx: number, sy: number, ex: number, ey: number, ms: number): Promise<void> {
    const [a, b] = await this.px(serial, sx, sy);
    const [c, d] = await this.px(serial, ex, ey);
    await this.shell(serial, ["input", "swipe", String(a), String(b), String(c), String(d), String(Math.round(ms))]);
  }

  /** The preview's app (or a window it opened, PART_OF_APP_FLOW) must have input focus before deckhand touches the phone. */
  private async inApp(serial: string): Promise<Frame[]> {
    const app = this.appOf(serial);
    if (!app) throw new SimDeckActionError("deckhand drives a phone only inside the preview's app, and it is not installed yet — wait for preview_status ready", 409);
    let seen: ReturnType<typeof focusedWindow> = null;
    let dumpsys = "";
    for (let i = 0; i < 4 && !seen; i++) {
      if (i) await this.sleep(250);
      dumpsys = await this.shell(serial, ["dumpsys", "window", "displays"]);
      seen = focusedWindow(dumpsys);
    }
    if (seen && "pkg" in seen && (seen.pkg === app.pkg || PART_OF_APP_FLOW.test(seen.pkg))) return navigationBars(dumpsys);
    const what = !seen ? "no window with input focus (locked or asleep?)" : "pkg" in seen ? seen.pkg : `the system window ${seen.window}`;
    throw new SimDeckActionError(
      `the phone is showing ${what}, not the preview's app (${app.pkg}); deckhand never acts outside it. \`back\` closes a shade or dialog; otherwise relaunch the app with restart_preview, then retry.`,
      409,
    );
  }

  private async tapNode(serial: string, n: UiNode, bars: Frame[]): Promise<{ x: number; y: number }> {
    const x = Math.round(n.frame.x + n.frame.width / 2);
    const y = Math.round(n.frame.y + n.frame.height / 2);
    refuseOnNavigationBar(bars, x, y);
    await this.shell(serial, ["input", "tap", String(x), String(y)]);
    return { x, y };
  }

  /** Poll the tree until `ok` holds or the time runs out; the last tree is returned either way. */
  private async poll(serial: string, timeoutMs: number, ok: (t: UiTree) => boolean): Promise<{ tree: UiTree; held: boolean }> {
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const tree = await this.tree(serial);
      if (ok(tree)) return { tree, held: true };
      if (this.now() >= deadline) return { tree, held: false };
      await this.sleep(300);
    }
  }

  async action(target: SimDeckTarget, a: UiAction): Promise<unknown> {
    if ("selector" in a && a.selector.ref != null) throw new SimDeckActionError(`ref ${a.selector.ref} reached the adb backend unresolved`, 400);
    const serial = target.udid;
    const miss = (s: Selector) => new SimDeckActionError(`No accessibility element matched ${describeSelector(s)}.`, 404);
    if (a.type === "home" || (a.type === "button" && LEAVES_APP.test(a.name))) throw new SimDeckActionError(LEAVES_APP_MESSAGE, 422);
    if (a.type === "swipe") {
      const edge = phoneEdgeSwipeRefusal(a.startY, "android");
      if (edge) throw new SimDeckActionError(edge, 422);
    }
    // Everything that touches or types first checks what is in front, like the iPhone control.
    // `back` and dismissKeyboard are left out: back launches nothing, and it is how an agent
    // closes a shade or dialog it did not mean to open.
    const bars =
      (TOUCHES.has(a.type) || (a.type === "button" && a.name.toLowerCase() !== "back")) && !CHECKED_AT_THE_TOUCH.has(a.type) ? await this.inApp(serial) : [];
    switch (a.type) {
      case "tap": {
        const [x, y] = await this.px(serial, a.x, a.y);
        refuseOnNavigationBar(bars, x, y);
        await this.shell(serial, ["input", "tap", String(x), String(y)]);
        return { action: "tap", x, y };
      }
      case "tapElement": {
        const { tree, held } = await this.poll(serial, a.waitTimeoutMs ?? 0, (t) => findAll(t, a.selector, a.type).length > 0);
        if (!held) throw miss(a.selector);
        return { action: "tap", ...(await this.tapNode(serial, findAll(tree, a.selector, a.type)[0]!, await this.inApp(serial))) };
      }
      case "type": {
        let arg: string;
        try {
          arg = escapeInputText(a.text);
        } catch (e) {
          throw new SimDeckActionError((e as Error).message, e instanceof NonAsciiTextError ? 422 : 400);
        }
        await this.shell(serial, ["input", "text", arg]);
        return { action: "type", length: a.text.length };
      }
      case "key": {
        const code = KEYCODES[a.name.toLowerCase()];
        if (code == null) throw new SimDeckActionError(`unknown key "${a.name}" (try: enter, backspace, tab, escape, up/down/left/right)`, 400);
        await this.shell(serial, ["input", "keyevent", String(code)]);
        return { action: "key", key: a.name };
      }
      case "button": {
        const code = BUTTONS[a.name.toLowerCase()];
        if (code == null) {
          throw new SimDeckActionError(`button "${a.name}" is not pressed on a phone — power and volume change the phone, not the app (try: back, menu)`, 400);
        }
        await this.shell(serial, ["input", "keyevent", String(code)]);
        return { action: "button", button: a.name };
      }
      case "back":
        await this.shell(serial, ["input", "keyevent", "4"]);
        return { action: "back", method: "keyevent" };
      case "swipe":
        refuseOnNavigationBar(bars, ...(await this.px(serial, a.startX, a.startY)));
        await this.swipe(serial, a.startX, a.startY, a.endX, a.endY, a.durationMs ?? 300);
        return { action: "swipe" };
      case "gesture": {
        const [sx, sy, ex, ey] = presetSwipe(a.preset);
        await this.swipe(serial, sx, sy, ex, ey, PRESET_DURATION_MS);
        return { action: "gesture", preset: a.preset };
      }
      case "dismissKeyboard": {
        const ime = await this.shell(serial, ["dumpsys", "input_method"]);
        if (!/mInputShown=true/.test(ime)) return { action: "dismissKeyboard", shown: false };
        await this.shell(serial, ["input", "keyevent", "4"]);
        return { action: "dismissKeyboard", shown: true };
      }
      case "openUrl": {
        const app = this.appOf(serial);
        if (!app) throw new SimDeckActionError("this phone's app is not installed yet, so there is nothing to open the link in — wait for preview_status ready", 409);
        await app.openUrl(app.pkg, a.url);
        return { action: "openUrl", package: app.pkg };
      }
      case "sleep":
        await this.sleep(a.ms);
        return { action: "sleep", durationMs: a.ms };
      case "toggleAppearance":
        throw new SimDeckActionError("toggleAppearance switches the system dark mode, which is a setting on somebody's phone; deckhand never changes a phone's settings", 403);
      case "scrollUntilVisible": {
        for (let i = 0; i < 12; i++) {
          if (findAll(await this.tree(serial), a.selector, a.type).length) return { action: "scrollUntilVisible", scrolls: i };
          const [sx, sy, ex, ey] = presetSwipe("scroll-down");
          await this.inApp(serial);
          await this.swipe(serial, sx, sy, ex, ey, PRESET_DURATION_MS);
          await this.sleep(400);
        }
        throw miss(a.selector);
      }
      case "waitFor": {
        const { held } = await this.poll(serial, a.timeoutMs ?? 5000, (t) => findAll(t, a.selector, a.type).length > 0);
        if (!held) throw miss(a.selector);
        return { action: "waitFor", ok: true };
      }
      case "waitForNot": {
        const { held } = await this.poll(serial, a.timeoutMs ?? 5000, (t) => findAll(t, a.selector, a.type).length === 0);
        if (!held) throw new SimDeckActionError(`${describeSelector(a.selector)} is still on screen.`, 409);
        return { action: "waitForNot", ok: true };
      }
      case "assert": {
        if (!findAll(await this.tree(serial), a.selector, a.type).length) throw miss(a.selector);
        return { action: "assert", ok: true };
      }
      case "assertNot": {
        if (findAll(await this.tree(serial), a.selector, a.type).length) throw new SimDeckActionError(`${describeSelector(a.selector)} is on screen.`, 409);
        return { action: "assertNot", ok: true };
      }
      case "query": {
        const hits = findAll(await this.tree(serial), a.selector, a.type);
        return { action: "query", count: hits.length, matches: hits.slice(0, 20).map(({ children: _c, ...n }) => n) };
      }
    }
  }
}
