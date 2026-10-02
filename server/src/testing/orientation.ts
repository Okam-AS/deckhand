import type { Selector } from "./control.ts";

// ---------------------------------------------------------------------------
// A turned iOS simulator. SimDeck injects every touch in the device's unrotated (portrait)
// screen, while the accessibility tree reports an app's frames in the turned UI, and SimDeck's
// selector taps send the UI point unrotated. So on a turned device deckhand places every touch
// itself: it finds the element, maps the point with `toNative`, and sends a plain tap.
//
// `quarterTurns` is the turn from the UI to the space touches are injected in, and it is read
// from that space, never from a screenshot: measured once on an iPad, the raw screenshot faced the
// other way from the touch space. The tree cannot tell 1 from 3 (or 0 from 2): the root frame is
// the same both ways. SimDeck's `accessibility-point` hit-tests in the touch space's points and
// answers with the element's frame in the UI, which can.
// ---------------------------------------------------------------------------

export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Node = Record<string, unknown>;

/** Map a normalized point in the turned UI to the device's unrotated screen. */
export function toNative(u: number, v: number, quarterTurns: number): { x: number; y: number } {
  switch (((quarterTurns % 4) + 4) % 4) {
    case 1:
      return { x: 1 - v, y: u };
    case 2:
      return { x: 1 - u, y: 1 - v };
    case 3:
      return { x: v, y: 1 - u };
    default:
      return { x: u, y: v };
  }
}

/** SimDeck's gesture presets as normalized swipes (`normalized_gesture_coordinates`, default delta). */
const PRESETS: Record<string, [number, number, number, number]> = {
  "scroll-up": [0.5, 0.275, 0.5, 0.725],
  "scroll-down": [0.5, 0.725, 0.5, 0.275],
  "scroll-left": [0.275, 0.5, 0.725, 0.5],
  "scroll-right": [0.725, 0.5, 0.275, 0.5],
};
export const PRESET_DURATION_MS = 500;

export function presetSwipe(preset: string): [number, number, number, number] {
  const p = PRESETS[preset];
  if (!p) throw new Error(`unknown gesture preset "${preset}"`);
  return p;
}

export function frameOf(n: unknown): Frame | null {
  if (!n || typeof n !== "object") return null;
  const f = ((n as Node).frame ?? (n as Node).frameInScreen) as Partial<Frame> | undefined;
  if (!f || typeof f.x !== "number" || typeof f.y !== "number" || typeof f.width !== "number" || typeof f.height !== "number") return null;
  return f as Frame;
}

export function rootsOf(tree: unknown): Node[] {
  const t = tree as { roots?: unknown; snapshot?: { roots?: unknown } } | null;
  const r = t?.roots ?? t?.snapshot?.roots;
  return Array.isArray(r) ? (r.filter((n) => n && typeof n === "object") as Node[]) : [];
}

function children(n: Node): Node[] {
  return Array.isArray(n.children) ? (n.children.filter((c) => c && typeof c === "object") as Node[]) : [];
}

/**
 * On a turned device SpringBoard's own elements (the «Open in …?» prompt a dev build shows) are
 * reported in the unrotated screen's points, under a root that carries no label, though the root's
 * own frame is the turned screen's; an app's elements are reported in its turned UI.
 */
export function isNativeRoot(root: Node): boolean {
  const label = root.label ?? root.AXLabel;
  return typeof label !== "string" || label.trim() === "" || label === "SpringBoard";
}

/** The screen in the UI's points: the largest root frame. */
export function uiBounds(tree: unknown): Frame | null {
  let best: Frame | null = null;
  for (const r of rootsOf(tree)) {
    const f = frameOf(r);
    if (f && f.width > 0 && f.height > 0 && (!best || f.width * f.height > best.width * best.height)) best = f;
  }
  return best;
}

/** The turns a tree's shape allows: a landscape root is 1 or 3, a portrait one 0 or 2. */
export function candidateTurns(bounds: Frame): [number, number] {
  return bounds.width > bounds.height ? [1, 3] : [0, 2];
}

/**
 * Elements to hit-test with: small, and away from the centre, where the two candidate turns map
 * to the same point. Farthest from the centre first.
 */
export function probeNodes(tree: unknown, bounds: Frame, max = 3): Frame[] {
  const out: { f: Frame; d: number }[] = [];
  const area = bounds.width * bounds.height;
  const walk = (n: Node, root: boolean) => {
    const f = frameOf(n);
    if (!root && f && f.width >= 4 && f.height >= 4 && f.width * f.height <= area * 0.1) {
      const cx = (f.x + f.width / 2 - bounds.x) / bounds.width;
      const cy = (f.y + f.height / 2 - bounds.y) / bounds.height;
      const d = Math.hypot(cx - 0.5, cy - 0.5);
      if (cx > 0.02 && cx < 0.98 && cy > 0.02 && cy < 0.98 && d > 0.15) out.push({ f, d });
    }
    for (const c of children(n)) walk(c, false);
  };
  // SpringBoard's elements are in the unrotated screen's points, so they are no evidence about the UI.
  for (const r of rootsOf(tree)) if (!isNativeRoot(r)) walk(r, true);
  out.sort((a, b) => b.d - a.d);
  const picked: Frame[] = [];
  for (const { f } of out) {
    if (picked.some((p) => Math.abs(p.x - f.x) < 1 && Math.abs(p.y - f.y) < 1)) continue;
    picked.push(f);
    if (picked.length >= max) break;
  }
  return picked;
}

/** The point, in unrotated screen points, where `f`'s centre is under `quarterTurns`. */
export function nativeProbePoint(f: Frame, bounds: Frame, quarterTurns: number): { x: number; y: number } {
  const u = (f.x + f.width / 2 - bounds.x) / bounds.width;
  const v = (f.y + f.height / 2 - bounds.y) / bounds.height;
  const p = toNative(u, v, quarterTurns);
  const nativeW = Math.min(bounds.width, bounds.height);
  const nativeH = Math.max(bounds.width, bounds.height);
  return { x: p.x * nativeW, y: p.y * nativeH };
}

/**
 * Did a hit-test land on `want`. The two candidate turns differ by half a turn, so the wrong one
 * hits whatever is at `want`'s centre mirrored through the screen's centre: a hit holding the
 * centre and not its mirror can only come from the right one. A hit holding both proves nothing,
 * and neither does a screen-sized container (SimDeck answers a miss with one, in either axes).
 */
export function hitMatches(hit: Frame | null, want: Frame, bounds: Frame): boolean {
  if (!hit) return false;
  const cx = want.x + want.width / 2;
  const cy = want.y + want.height / 2;
  const mx = 2 * bounds.x + bounds.width - cx;
  const my = 2 * bounds.y + bounds.height - cy;
  const holds = (x: number, y: number) => x >= hit.x - 0.5 && x <= hit.x + hit.width + 0.5 && y >= hit.y - 0.5 && y <= hit.y + hit.height + 0.5;
  return holds(cx, cy) && !holds(mx, my) && hit.width * hit.height <= bounds.width * bounds.height * 0.25;
}

// --- SimDeck's selector semantics, for the taps deckhand places itself ---------------------
// Ported from SimDeck 0.2.0 `accessibility_query.rs` (`element_matches_selector`,
// `tap_point_from_snapshot`, `tap_candidate_rank`), so a turned device picks the element an
// upright one would.

const ID_KEYS = ["AXIdentifier", "AXUniqueId", "inspectorId", "id", "identifier"];
const LABEL_KEYS = ["AXLabel", "label", "title", "text", "name"];
const VALUE_KEYS = ["AXValue", "value"];

function fieldsMatch(n: Node, want: string, regex: boolean, keys: string[]): boolean {
  let re: RegExp | null = null;
  if (regex) {
    try {
      re = new RegExp(want);
    } catch {
      re = null;
    }
  }
  return keys.some((k) => {
    const v = n[k];
    if (typeof v !== "string") return false;
    return re ? re.test(v) : v === want;
  });
}

export function matchesSelector(n: Node, s: Selector): boolean {
  const regex = !!s.regex;
  return (
    (s.id == null || fieldsMatch(n, s.id, regex, ID_KEYS)) &&
    (s.text == null || fieldsMatch(n, s.text, regex, LABEL_KEYS)) &&
    (s.label == null || fieldsMatch(n, s.label, regex, LABEL_KEYS)) &&
    (s.value == null || fieldsMatch(n, s.value, regex, VALUE_KEYS))
  );
}

function roleRank(n: Node): number {
  const role = String(n.role ?? n.type ?? "").toLowerCase();
  if (["button", "cell", "checkbox", "link", "switch", "toggle", "slider", "textfield"].some((r) => role.includes(r))) return 2;
  return role ? 1 : 0;
}

function rank(n: Node, w: number, h: number): [number, number, number] {
  const r = roleRank(n);
  const f = frameOf(n);
  if (!f || f.width <= 0 || f.height <= 0) return [r, 0, 0];
  const { x, y, width, height } = f;
  const cx = x + width / 2;
  const cy = y + height / 2;
  const fully = x >= 0 && y >= 0 && x + width <= w && y + height <= h;
  const centre = cx >= 0 && cy >= 0 && cx <= w && cy <= h;
  const meets = x < w && y < h && x + width > 0 && y + height > 0;
  const vis = fully ? 3 : centre && x >= 0 && y >= 0 ? 2 : meets ? 1 : 0;
  const vw = Math.min(x + width, w) - Math.max(x, 0);
  const vh = Math.min(y + height, h) - Math.max(y, 0);
  return [r, vis, vw > 0 && vh > 0 ? Math.round(vw * vh) : 0];
}

function greater(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

/**
 * The element SimDeck's selector tap would pick, as a normalized point on the screen its root is in: the
 * `index`-th match in document order across roots, else the best-ranked match of the first root
 * that has one. Null when nothing matches.
 */
export function selectorTarget(tree: unknown, s: Selector): { u: number; v: number; native: boolean } | null {
  let seen = 0;
  for (const root of rootsOf(tree)) {
    const rf = frameOf(root);
    if (!rf || rf.width <= 0 || rf.height <= 0) continue;
    // A native root's elements are in the portrait screen's points while the root reports the turned frame.
    const native = isNativeRoot(root) && rf.width > rf.height;
    const w = native ? rf.height : rf.width;
    const h = native ? rf.width : rf.height;
    const matches: Node[] = [];
    const walk = (n: Node) => {
      if (matchesSelector(n, s)) matches.push(n);
      for (const c of children(n)) walk(c);
    };
    walk(root);
    let node: Node | undefined;
    if (s.index != null) {
      if (s.index < seen + matches.length) node = matches[s.index - seen];
      seen += matches.length;
    } else {
      let best: [number, number, number] | null = null;
      for (const m of matches) {
        const r = rank(m, w, h);
        if (!best || greater(r, best)) {
          best = r;
          node = m;
        }
      }
    }
    if (!node) continue;
    const f = frameOf(node);
    if (!f) return null;
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    return { u: clamp((f.x + f.width / 2) / w), v: clamp((f.y + f.height / 2) / h), native };
  }
  return null;
}
