/** A Choice question accepts at most this many options (TypeSafe API). */
export const MAX_OPTIONS = 255;

/** The only actions a candidate can carry. `openUrl`, free text and raw coordinates are not in it. */
export type NavigateAction =
  | { type: "tap"; x: number; y: number }
  | { type: "back" }
  | { type: "gesture"; preset: "scroll-up" | "scroll-down" };

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One on-screen element, backend-neutral. `value` stays on this machine. */
export interface ScreenElement {
  ref: string;
  role: string;
  label?: string;
  value?: string;
  id?: string;
  frame?: Rect;
  interactive: boolean;
  textInput: boolean;
  secure: boolean;
  heading: boolean;
  checked: boolean;
}

export interface Screen {
  elements: ScreenElement[];
  /** The whole screen, in the tree's units; every tap is normalised against it. */
  viewport: Rect | null;
  /** What the decider reads: minimised and masked. */
  lines: string[];
  /** Identity of the screen for loop detection (local only). */
  signature: string;
}

export type ActionKind = "done" | "stuck" | "back" | "scroll" | "tap" | "reveal" | "fill";

export interface Candidate {
  key: string;
  kind: ActionKind;
  actions: NavigateAction[];
  /** Name of a caller-supplied value to type after `actions`; resolved by the loop, never sent to the model. */
  typeKey?: string;
  /** Trace text; never carries a caller-supplied text VALUE. */
  summary: string;
  /** The tapped element's frame, screen-normalised: what must not move between reading and acting. */
  target?: Rect;
}

const INTERACTIVE_ROLE =
  /^(button|link|cell|textfield|securetextfield|searchfield|textarea|switch|toggle|togglebutton|tab|tabbutton|menuitem|checkbox|checkbutton|radiobutton|segmentedcontrol|picker|slider|stepper|incrementor|popupbutton|combobox|edittext|autocompletetextview|spinner|imagebutton|compoundbutton|seekbar)$/i;
const TEXT_INPUT_ROLE = /^(textfield|securetextfield|searchfield|textarea|edittext|autocompletetextview)$/i;
const SECURE_ROLE = /^securetextfield$/i;
const HEADING_ROLE = /^(heading|header)$/i;
/** Android has no heading role, and iOS headers are often plain text: a short text counts as a title inside a header, toolbar or app bar. */
const TITLE_SCOPE_ID = /toolbar|action_bar|app_bar|collapsing|header|title/i;
/** iOS groups carry the toolbar's own name ("Toolbar"); an Android CollapsingToolbarLayout carries the screen's title. */
const NOT_A_TITLE_ROLE = /^(group|toolbar|application|window)$/i;
const ROW_ROLE = /^(statictext|genericelement)$/i;
/** Android lists take the click themselves, so uiautomator reports their rows as not clickable. */
const LIST_ROLE = /^(listview|recyclerview|gridview|expandablelistview)$/i;
const CONTAINER_ROLE = /layout|view$|container|group|^element$/i;
const LABEL_MAX = 60;
const ID_MAX = 40;
const TITLE_MAX = 40;

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
// Six or more digits, allowing the separators people write them with: phone, national id, card, account.
const LONG_NUMBER = /\+?\d(?:[\s.\-/]?\d){5,}/g;
// Serials, order and account ids: eight or more letters and digits with at least two of each.
const CODE = /\b(?=(?:[A-Za-z]*\d){2})(?=(?:\d*[A-Za-z]){2})[A-Za-z\d]{8,}\b/g;

/** Mask what reads like personal data before it can leave the machine. */
export function mask(s: string): string {
  return s.replace(EMAIL, "[email]").replace(LONG_NUMBER, "[number]").replace(CODE, "[code]");
}

function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function roots(tree: unknown): unknown {
  if (!tree || typeof tree !== "object") return tree;
  const t = tree as { roots?: unknown; snapshot?: { roots?: unknown } };
  return t.roots ?? t.snapshot?.roots ?? tree;
}

function frameOf(n: Record<string, unknown>): Rect | undefined {
  const f = (n.frameInScreen ?? n.frame) as Partial<Rect> | undefined;
  if (!f || typeof f !== "object") return undefined;
  const { x, y, width, height } = f;
  if ([x, y, width, height].every((v) => typeof v === "number" && Number.isFinite(v))) return { x: x!, y: y!, width: width!, height: height! };
  return undefined;
}

function roleOf(n: Record<string, unknown>): string {
  const raw = str(n.type) ?? str(n.role) ?? str(n.AXRole) ?? str(n.className) ?? "Element";
  const bare = raw.replace(/^AX/, "").replace(/^android\.widget\./, "");
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}

function shortId(id: string): string {
  return id.replace(/^[\w.]+:id\//, "");
}

interface Raw {
  node: Record<string, unknown>;
  role: string;
  frame?: Rect;
  interactive: boolean;
  textInput: boolean;
  secure: boolean;
  ownText?: string;
  value?: string;
  id?: string;
  insideInteractive: boolean;
  titleScope: boolean;
  children: Raw[];
}

/** Flatten either tree shape (compact snapshot or AX-keyed endpoint, iOS or Android) into elements, document order. */
export function readScreen(tree: unknown, shot?: { width: number; height: number } | null): Screen {
  const top: Raw[] = [];
  const build = (node: unknown, insideInteractive: boolean, titleScope: boolean, into: Raw[], listItem = false): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) build(n, insideInteractive, titleScope, into, listItem);
      return;
    }
    const n = node as Record<string, unknown>;
    if (n.hidden === true || n.isHidden === true) return;
    const role = roleOf(n);
    const secure = n.password === true || SECURE_ROLE.test(role);
    const textInput = secure || TEXT_INPUT_ROLE.test(role) || /edittext/i.test(str(n.className) ?? "");
    const interactive = textInput || (listItem && !insideInteractive) || n.clickable === true || n.checkable === true || INTERACTIVE_ROLE.test(role);
    const value = str(n.value) ?? str(n.AXValue) ?? (textInput ? str(n.text) : undefined);
    const labelSources = textInput
      ? [n.placeholder, n.hint, n.hintText, n.contentDescription, n.AXLabel, n.label]
      : [n.label, n.AXLabel, n.text, n.contentDescription, n.title];
    let ownText: string | undefined;
    for (const s of labelSources) {
      const v = str(s);
      if (v && !(textInput && v === value)) {
        ownText = v;
        break;
      }
    }
    const id = str(n.id) ?? str(n.AXUniqueId) ?? str(n.AXIdentifier) ?? str(n.resourceId) ?? str(n.androidResourceId);
    const inTitle = titleScope || (!!id && TITLE_SCOPE_ID.test(shortId(id)));
    const raw: Raw = { node: n, role, frame: frameOf(n), interactive, textInput, secure, ownText, value, id, insideInteractive, titleScope: inTitle, children: [] };
    into.push(raw);
    const kids = n.children;
    if (kids && typeof kids === "object") build(kids, insideInteractive || interactive, inTitle, raw.children, LIST_ROLE.test(role) && !anyClickable(kids));
  };
  build(roots(tree), false, false, top);

  const viewport = findViewport(top, shot ?? null);
  const elements: ScreenElement[] = [];
  const visit = (r: Raw): void => {
    let label = r.ownText;
    const row = !r.interactive && isListRow(r, viewport);
    const interactive = r.interactive || row;
    if (r.interactive && !r.textInput && !label) label = descendantText(r);
    const heading = !interactive && !r.insideInteractive && !!label && isHeading(r, label);
    if (interactive || heading || (!r.insideInteractive && (label || r.id))) {
      elements.push({
        ref: `e${elements.length + 1}`,
        role: row ? "Row" : r.interactive && CONTAINER_ROLE.test(r.role) ? "Item" : r.role,
        ...(label ? { label } : {}),
        ...(r.value ? { value: r.value } : {}),
        ...(r.id ? { id: r.id } : {}),
        ...(r.frame ? { frame: r.frame } : {}),
        interactive,
        textInput: r.textInput,
        secure: r.secure,
        heading,
        checked: r.node.checked === true || r.node.selected === true,
      });
    }
    for (const c of r.children) visit(c);
  };
  for (const r of top) visit(r);

  const headings = new Set<string>();
  const lines = elements
    .filter((e) => !e.heading || (headings.has(e.label!) ? false : (headings.add(e.label!), true)))
    .map(line)
    .filter((l): l is string => l !== null);
  const signature = elements.map((e) => `${e.role}|${e.label ?? ""}|${e.id ?? ""}|${e.value ?? ""}|${e.checked ? 1 : 0}`).join("\n");
  return { elements, viewport, lines, signature };
}

/**
 * The whole screen in the tree's units, from the origin — taps are screen-normalised. The roots do
 * not say it: Android Clock's starts at y=136 and a permission dialog's root is the dialog alone.
 * The screenshot does, in pixels; iOS frames are points, so it is divided by the integer scale.
 */
function findViewport(top: Raw[], shot: { width: number; height: number } | null): Rect | null {
  let width = 0;
  let height = 0;
  for (const r of top) {
    if (!r.frame || r.frame.width <= 0 || r.frame.height <= 0) continue;
    width = Math.max(width, r.frame.x + r.frame.width);
    height = Math.max(height, r.frame.y + r.frame.height);
  }
  if (width <= 0 || height <= 0) return null;
  if (!shot || shot.width < width * 0.9) return { x: 0, y: 0, width, height };
  const scale = Math.max(1, Math.round(shot.width / width));
  return { x: 0, y: 0, width: shot.width / scale, height: shot.height / scale };
}

/** Width and height from a PNG's IHDR, or null for anything that is not a PNG. */
export function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** A list whose rows report no click of their own takes the click itself (a ListView popup); one with clickable rows does not. */
function anyClickable(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(anyClickable);
  const n = node as Record<string, unknown>;
  return n.clickable === true || anyClickable(n.children);
}

function descendantText(r: Raw): string | undefined {
  const out: string[] = [];
  const walk = (c: Raw): void => {
    if (out.length >= 2) return;
    if (c.ownText && !c.interactive) out.push(c.ownText);
    for (const k of c.children) walk(k);
  };
  for (const c of r.children) walk(c);
  return out.length ? out.join(", ") : undefined;
}

/** SwiftUI lists expose a tappable row as static text: full width, row height, a short label. */
function isListRow(r: Raw, viewport: Rect | null): boolean {
  if (!ROW_ROLE.test(r.role) || r.insideInteractive || r.titleScope || !r.frame || !viewport || !r.ownText || r.ownText.length > LABEL_MAX) return false;
  const h = r.frame.height / viewport.height;
  return r.frame.width >= viewport.width * 0.85 && h >= 0.045 && h <= 0.15;
}

function isHeading(r: Raw, label: string): boolean {
  if (label.length > TITLE_MAX) return false;
  return HEADING_ROLE.test(r.role) || r.node.heading === true || (r.titleScope && !NOT_A_TITLE_ROLE.test(r.role));
}

/** What the decider may read about one element: role, a masked label, a masked id. Never a value. */
function describeElement(e: ScreenElement): string {
  const parts = [e.role];
  if (e.label && !e.secure) parts.push(JSON.stringify(clip(mask(e.label), LABEL_MAX)));
  if (e.id) parts.push(`#${clip(mask(shortId(e.id)), ID_MAX)}`);
  return parts.join(" ");
}

function line(e: ScreenElement): string | null {
  if (e.heading) return `${e.ref} ${e.role} ${JSON.stringify(clip(mask(e.label!), TITLE_MAX))}`;
  if (!e.interactive) return null;
  return `${e.ref} ${describeElement(e)}${e.textInput ? " (text field)" : ""}`;
}

function center(e: ScreenElement, vp: Rect): { x: number; y: number } | null {
  if (!e.frame || e.frame.width <= 0 || e.frame.height <= 0) return null;
  const x = (e.frame.x + e.frame.width / 2 - vp.x) / vp.width;
  const y = (e.frame.y + e.frame.height / 2 - vp.y) / vp.height;
  return { x: round(x), y: round(y) };
}

function round(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}

/** Clear of the status bar and the home indicator: a tap at y≈0.03 on iOS scrolls the list to the top instead. */
function onScreen(p: { x: number; y: number }): boolean {
  return p.x > 0.01 && p.x < 0.99 && p.y > 0.07 && p.y < 0.97;
}

export interface CandidateSet {
  candidates: Candidate[];
  /** Tappable elements dropped because the option cap was reached. */
  dropped: number;
}

/**
 * The closed action set for one screen. A tap lands on the centre of an element's own frame as the
 * tree reported it; `textKeys` are the NAMES of values the caller supplied, and the values themselves
 * never reach the model.
 */
export function candidatesFor(screen: Screen, textKeys: string[]): CandidateSet {
  const fixed: Candidate[] = [
    { key: "done: the goal is already achieved on this screen", kind: "done", actions: [], summary: "done" },
    { key: "stuck: no listed action moves toward the goal", kind: "stuck", actions: [], summary: "stuck" },
    { key: "back: return to the previous screen", kind: "back", actions: [{ type: "back" }], summary: "back" },
    { key: "scroll down: the target is not listed, reveal more of this screen below", kind: "scroll", actions: [{ type: "gesture", preset: "scroll-down" }], summary: "scroll down" },
    { key: "scroll up: reveal content above", kind: "scroll", actions: [{ type: "gesture", preset: "scroll-up" }], summary: "scroll up" },
  ];
  const fills: Candidate[] = [];
  const taps: Candidate[] = [];
  const vp = screen.viewport;
  const seen = new Set<string>();
  for (const e of screen.elements) {
    if (!e.interactive) continue;
    const name = describeElement(e);
    const p = vp ? center(e, vp) : null;
    if (p && onScreen(p)) {
      const at: NavigateAction = { type: "tap", x: p.x, y: p.y };
      const target = { x: (e.frame!.x - vp!.x) / vp!.width, y: (e.frame!.y - vp!.y) / vp!.height, width: e.frame!.width / vp!.width, height: e.frame!.height / vp!.height };
      const dedupe = `${p.x},${p.y}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      if (e.textInput) {
        for (const k of textKeys) {
          fills.push({ key: `type the "${k}" value into ${e.ref} ${name}`, kind: "fill", actions: [at], typeKey: k, summary: `typed "${k}" into ${name}`, target });
        }
      }
      taps.push({ key: `tap ${e.ref} ${name}`, kind: "tap", actions: [at], summary: `tapped ${name}`, target });
    } else if (p) {
      const preset = p.y >= 0.5 ? "scroll-down" : "scroll-up";
      taps.push({ key: `scroll to ${e.ref} ${name}`, kind: "reveal", actions: [{ type: "gesture", preset }], summary: `scrolled toward ${name}` });
    }
  }
  const room = MAX_OPTIONS - fixed.length;
  const variable = [...fills, ...taps];
  const kept = variable.slice(0, room);
  return { candidates: [...fixed, ...kept], dropped: variable.length - kept.length };
}
