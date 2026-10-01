// ---------------------------------------------------------------------------
// The screen as an agent reads it: one line per element, each with a ref (`e12`) that stays the
// same for as long as that element is on screen, so a later screen can be sent as the lines that
// changed and an action can name its target by ref instead of by a selector that may miss.
// ---------------------------------------------------------------------------

export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenNode {
  role: string;
  label?: string;
  value?: string;
  id?: string;
  frame?: Frame;
  offscreen?: boolean;
}

interface RawNode {
  role?: unknown;
  AXRole?: unknown;
  type?: unknown;
  className?: unknown;
  label?: unknown;
  AXLabel?: unknown;
  text?: unknown;
  contentDescription?: unknown;
  title?: unknown;
  hint?: unknown;
  value?: unknown;
  AXValue?: unknown;
  id?: unknown;
  AXUniqueId?: unknown;
  AXIdentifier?: unknown;
  resourceId?: unknown;
  frame?: unknown;
  children?: unknown;
}

/** On Android a text field's `text` is what was typed, not its name. */
const TEXT_INPUT = /edittext|textfield|searchfield/i;

function str(...vs: unknown[]): string | undefined {
  for (const v of vs) if (typeof v === "string" && v.trim()) return v;
  return undefined;
}

function frameOf(v: unknown): Frame | undefined {
  if (!v || typeof v !== "object") return undefined;
  const f = v as Record<string, unknown>;
  const [x, y, width, height] = [f.x, f.y, f.width, f.height];
  if ([x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n))) {
    return { x: x as number, y: y as number, width: width as number, height: height as number };
  }
  return undefined;
}

function rootsOf(tree: unknown): unknown[] {
  if (Array.isArray(tree)) return tree;
  if (!tree || typeof tree !== "object") return [];
  const t = tree as { roots?: unknown; snapshot?: { roots?: unknown } };
  const r = t.roots ?? t.snapshot?.roots;
  return Array.isArray(r) ? r : [];
}

/** The bounds of the first root with a non-empty frame: what "on screen" is measured against. */
export function screenBounds(tree: unknown): Frame | undefined {
  for (const r of rootsOf(tree)) {
    const f = frameOf((r as RawNode)?.frame);
    if (f && f.width > 0 && f.height > 0) return f;
  }
  return undefined;
}

/**
 * Every element worth naming, in document order: anything with a label, a value or an id.
 * Pure layout containers carry none of the three and would only cost tokens.
 */
export function flattenTree(tree: unknown): ScreenNode[] {
  const bounds = screenBounds(tree);
  const out: ScreenNode[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    const raw = n as RawNode;
    const role = str(raw.role, raw.AXRole, raw.type, raw.className) ?? "Element";
    const input = TEXT_INPUT.test(role);
    const named = input ? str(raw.label, raw.AXLabel, raw.hint, raw.contentDescription) : str(raw.label, raw.AXLabel, raw.text, raw.contentDescription, raw.title);
    const value = str(raw.value, raw.AXValue, input ? raw.text : undefined);
    // SimDeck's compact Android tree copies an EditText's text into its label: typing would rename the field.
    const label = /edittext/i.test(role) && named === value ? undefined : named;
    const id = str(raw.id, raw.AXUniqueId, raw.AXIdentifier, raw.resourceId);
    if (label || value || id) {
      const frame = frameOf(raw.frame);
      const node: ScreenNode = { role };
      if (label) node.label = label;
      if (value && value !== label) node.value = value;
      if (id) node.id = id;
      if (frame) node.frame = frame;
      if (bounds && frame && isOffscreen(frame, bounds)) node.offscreen = true;
      out.push(node);
    }
    if (Array.isArray(raw.children)) walk(raw.children);
  };
  walk(rootsOf(tree));
  return out;
}

function isOffscreen(f: Frame, b: Frame): boolean {
  return f.x + f.width <= b.x || f.y + f.height <= b.y || f.x >= b.x + b.width || f.y >= b.y + b.height;
}

const clip = (s: string, n = 120): string => (s.length > n ? `${s.slice(0, n)}…` : s);

export function renderNode(ref: string, n: ScreenNode): string {
  let line = `${ref} ${n.role}`;
  if (n.label) line += ` ${JSON.stringify(clip(n.label))}`;
  if (n.id && n.id !== n.label) line += ` #${n.id}`;
  if (n.value) line += ` value=${JSON.stringify(clip(n.value, 60))}`;
  if (n.offscreen) line += " (offscreen)";
  return line;
}

/** `4:04`, `23:59:59`: a value that changes by itself every second or minute. */
const CLOCK = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g;

/**
 * Two captures of the same screen are equal under this; a transition, a list still loading, or a
 * value being typed is not. Frames are in it because an element sliding in keeps its label; clock
 * readings are not, or a screen with a running timer never holds still.
 */
export function shapeOf(tree: unknown): string {
  return flattenTree(tree)
    .map((n) => `${n.role}|${n.id ?? ""}|${n.label ?? ""}|${n.value ?? ""}|${frameKey(n.frame)}`.replace(CLOCK, "<time>"))
    .join("\n");
}

/** A diff past this many lines, or touching more than this share of the screen, goes out whole. */
const MAX_DIFF_LINES = 40;
const MAX_DIFF_SHARE = 0.5;
/** Refs remembered after they leave the screen, so an old ref can still be retried by its id or label. */
const MAX_REMEMBERED = 2000;

export interface Snapshot {
  revision: number;
  /** `shapeOf` the capture, so a later capture can be compared with it. */
  shape: string;
  bounds?: Frame;
  /** ref → node, in document order. */
  nodes: Map<string, ScreenNode>;
}

export type RefTarget =
  | { kind: "selector"; selector: { id?: string; label?: string } }
  | { kind: "point"; x: number; y: number };

export class RefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefError";
  }
}

/**
 * One device's screen memory: the latest snapshot, the lines the agent was last SHOWN (the base a
 * diff is taken against), and every ref ever minted, so a ref keeps naming one element across
 * snapshots while the element exists.
 */
export class ScreenBook {
  private counter = 0;
  private revision = 0;
  private latest: Snapshot | null = null;
  private shown: Map<string, string> | null = null;
  private readonly remembered = new Map<string, Remembered>();
  private readonly byKey = new Map<string, string>();
  private readonly groups = new Map<string, { where: string; refs: string[] }>();

  /**
   * Record a capture. An element seen before, on this screen or an earlier one, keeps its ref.
   * Elements that share role, id and label cannot be told apart once one of them moves or goes,
   * so a group of them keeps its refs only while every one of them is exactly where it was.
   */
  record(tree: unknown, opts: { keepGone?: boolean } = {}): Snapshot {
    const nodes = flattenTree(tree);
    const groups = new Map<string, ScreenNode[]>();
    for (const n of nodes) groups.set(keyOf(n), [...(groups.get(keyOf(n)) ?? []), n]);
    const refs = new Map<ScreenNode, string>();
    for (const [k, members] of groups) {
      if (members.length === 1) {
        const ref = this.byKey.get(k) ?? `e${++this.counter}`;
        this.byKey.set(k, ref);
        this.groups.delete(k);
        refs.set(members[0]!, ref);
        continue;
      }
      const where = members.map((n) => frameKey(n.frame)).join(";");
      const held = this.groups.get(k);
      let group = held?.where === where ? held.refs : undefined;
      if (!group) {
        this.byKey.delete(k);
        group = members.map(() => `e${++this.counter}`);
      }
      this.groups.set(k, { where, refs: group });
      members.forEach((n, i) => refs.set(n, group[i]!));
    }
    // A key gone from the screen gives up its ref: what shows up under it later may be another
    // element of the same name (the «Slett» of the next order), so it gets a ref of its own.
    // A capture taken mid-animation (before resolving a ref) may miss an element that is still there.
    if (!opts.keepGone) {
      for (const k of [...this.byKey.keys()]) if (!groups.has(k)) this.byKey.delete(k);
      for (const k of [...this.groups.keys()]) if (!groups.has(k)) this.groups.delete(k);
    }
    const next = new Map<string, ScreenNode>();
    for (const n of nodes) {
      const ref = refs.get(n)!;
      next.set(ref, n);
      this.remember(ref, n);
    }
    this.latest = { revision: ++this.revision, shape: shapeOf(tree), bounds: screenBounds(tree), nodes: next };
    return this.latest;
  }

  /** A ref this book has handed out, on screen or not. */
  knows(ref: string): boolean {
    return this.remembered.has(ref.replace(/^@/, ""));
  }

  get snapshot(): Snapshot | null {
    return this.latest;
  }

  /** The whole screen, and the new base for the next diff. */
  full(): string {
    const s = this.latest;
    if (!s) return "No screen captured yet.";
    this.shown = linesOf(s);
    return `Screen r${s.revision} (${s.nodes.size} elements; target one with {ref} — a ref names the same element for as long as it stays on screen):\n${[...this.shown.values()].join("\n")}`;
  }

  /** What changed since the agent was last shown the screen, or the whole screen when most of it did. */
  update(): string {
    const s = this.latest;
    if (!s) return "No screen captured yet.";
    const before = this.shown;
    if (!before) return this.full();
    const now = linesOf(s);
    const diff: string[] = [];
    for (const [ref, line] of now) {
      const was = before.get(ref);
      if (was === undefined) diff.push(`+ ${line}`);
      else if (was !== line) diff.push(`~ ${line} (was: ${was.slice(ref.length + 1)})`);
    }
    for (const [ref, line] of before) if (!now.has(ref)) diff.push(`- ${line}`);
    if (diff.length === 0) return `Screen r${s.revision}: nothing listed changed; every ref you hold is still valid.`;
    if (diff.length > MAX_DIFF_LINES || diff.length > MAX_DIFF_SHARE * Math.max(now.size, 1)) {
      return `The screen changed substantially. ${this.full()}`;
    }
    this.shown = now;
    return [
      `Screen r${s.revision} (${now.size} elements), changes since you last saw it — "+" appeared, "~" changed, "-" is GONE (do not target it); every other ref you hold is unchanged:`,
      ...diff,
    ].join("\n");
  }

  /**
   * How to hit a ref. A unique id or label is resolved by SimDeck at the moment of the tap, so it
   * survives a screen that moved since the snapshot; the element's own centre is the last resort,
   * and is only as current as `snapshot` — the caller decides whether that is current enough.
   */
  resolve(ref: string, opts: { preferPoint?: boolean } = {}): RefTarget {
    const r = ref.replace(/^@/, "");
    const s = this.latest;
    const node = s?.nodes.get(r);
    if (s && node) {
      const all = [...s.nodes.values()];
      if (opts.preferPoint && node.frame && s.bounds && !node.offscreen) return centre(node.frame, s.bounds);
      if (node.id && all.filter((n) => n.id === node.id).length === 1) return { kind: "selector", selector: { id: node.id } };
      if (node.label && all.filter((n) => n.label === node.label).length === 1) return { kind: "selector", selector: { label: node.label } };
      if (node.frame && s.bounds) {
        if (node.offscreen) throw new RefError(`${r} is off screen — scroll it into view first (scrollUntilVisible, or a gesture), then use the ref from the new screen`);
        return centre(node.frame, s.bounds);
      }
      throw new RefError(`${r} has no unique id or label, and no frame to tap`);
    }
    const old = this.remembered.get(r);
    if (!old) throw new RefError(`unknown ref ${r}`);
    // A ref is never retried by its name: whatever answers to that name now may be another element
    // (the «Slett» of the next order once this one is deleted), and SimDeck would tap it.
    const now = s ? [...s.nodes.entries()] : [];
    const holders = now.filter(([, n]) => (old.id && n.id === old.id) || (old.label && n.label === old.label)).map(([ref]) => ref);
    throw new RefError(`${r} is no longer on screen${holders.length ? `; its name is now on ${holders.join(", ")}, a different element` : ""} — target what you want by a ref from the current screen`);
  }

  private remember(ref: string, n: Remembered): void {
    this.remembered.delete(ref);
    this.remembered.set(ref, n);
    if (this.remembered.size <= MAX_REMEMBERED) return;
    const [oldRef, oldNode] = this.remembered.entries().next().value!;
    this.remembered.delete(oldRef);
    const k = keyOf(oldNode);
    if (this.byKey.get(k) === oldRef) this.byKey.delete(k);
    if (this.groups.get(k)?.refs.includes(oldRef)) this.groups.delete(k);
  }
}

type Remembered = ScreenNode;

/** iOS screens are portrait in hardware; a wider app root means the device is turned. */
export function isRotatedIos(platform: "ios" | "android", bounds: Frame | undefined): boolean {
  return platform === "ios" && !!bounds && bounds.width > bounds.height;
}

function centre(f: Frame, b: Frame): RefTarget {
  return { kind: "point", x: (f.x + f.width / 2 - b.x) / b.width, y: (f.y + f.height / 2 - b.y) / b.height };
}

function frameKey(f: Frame | undefined): string {
  return f ? `${Math.round(f.x)},${Math.round(f.y)},${Math.round(f.width)},${Math.round(f.height)}` : "";
}

function keyOf(n: ScreenNode): string {
  return `${n.role}\u0000${n.id ?? ""}\u0000${n.label ?? ""}`;
}

function linesOf(s: Snapshot): Map<string, string> {
  const m = new Map<string, string>();
  for (const [ref, n] of s.nodes) m.set(ref, renderNode(ref, n));
  return m;
}
