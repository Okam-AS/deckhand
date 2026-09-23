import type { Selector } from "../testing/control.ts";

export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Match {
  node: Record<string, unknown>;
  frame: Frame;
  /** The coordinate space the frame is in: the rotated UI, or the device's unrotated screen. */
  space: "ui" | "native";
  viewport: { width: number; height: number };
}

/**
 * Map a normalized point in the rotated UI to the device's unrotated screen, where SimDeck injects
 * touches. `quarterTurns` is how far the device was turned counter-clockwise, the same count that
 * rotates a screenshot upright.
 */
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

function str(n: Record<string, unknown>, ...keys: string[]): string[] {
  return keys.map((k) => n[k]).filter((v): v is string => typeof v === "string");
}

function matches(n: Record<string, unknown>, s: Selector): boolean {
  const test = (candidates: string[], want: string | undefined) => {
    if (want == null) return true;
    if (s.regex) {
      const re = new RegExp(want);
      return candidates.some((c) => re.test(c));
    }
    return candidates.includes(want);
  };
  return (
    test(str(n, "id", "AXUniqueId", "identifier"), s.id) &&
    test(str(n, "label", "AXLabel"), s.label) &&
    test(str(n, "value", "AXValue"), s.value) &&
    test(str(n, "label", "AXLabel", "value", "AXValue", "title", "AXTitle"), s.text)
  );
}

function frameOf(n: Record<string, unknown>): Frame | null {
  const f = n.frame as Partial<Frame> | undefined;
  if (!f || typeof f.x !== "number" || typeof f.y !== "number" || typeof f.width !== "number" || typeof f.height !== "number") return null;
  return f as Frame;
}

/**
 * Every node matching `s`, in document order. On a rotated device SpringBoard's own elements (the
 * «Open in …?» prompt among them) are reported in the unrotated screen's points, under a root that
 * carries no label, while an app's are reported in its rotated UI.
 */
export function findAll(tree: unknown, s: Selector): Match[] {
  const t = tree as { roots?: unknown; snapshot?: { roots?: unknown } } | null;
  const roots = (t?.roots ?? t?.snapshot?.roots ?? []) as Record<string, unknown>[];
  const out: Match[] = [];
  for (const root of Array.isArray(roots) ? roots : []) {
    const rf = frameOf(root);
    if (!rf) continue;
    const native = str(root, "label", "AXLabel").length === 0 || str(root, "label", "AXLabel")[0] === "SpringBoard";
    const long = Math.max(rf.width, rf.height);
    const short = Math.min(rf.width, rf.height);
    const viewport = native ? { width: short, height: long } : { width: rf.width, height: rf.height };
    const walk = (n: unknown) => {
      if (!n || typeof n !== "object") return;
      const node = n as Record<string, unknown>;
      const f = frameOf(node);
      if (node !== root && f && matches(node, s)) out.push({ node, frame: f, space: native ? "native" : "ui", viewport });
      for (const c of (node.children as unknown[] | undefined) ?? []) walk(c);
    };
    walk(root);
  }
  return out;
}

export function pick(all: Match[], s: Selector): Match | null {
  return all[s.index ?? 0] ?? null;
}

export function isVisible(m: Match): boolean {
  const cx = m.frame.x + m.frame.width / 2;
  const cy = m.frame.y + m.frame.height / 2;
  return m.frame.width > 0 && m.frame.height > 0 && cx >= 0 && cy >= 0 && cx <= m.viewport.width && cy <= m.viewport.height;
}

/** Where to touch a match, in SimDeck's normalized native coordinates. */
export function touchPoint(m: Match, quarterTurns: number): { x: number; y: number } {
  const u = (m.frame.x + m.frame.width / 2) / m.viewport.width;
  const v = (m.frame.y + m.frame.height / 2) / m.viewport.height;
  return m.space === "native" ? { x: u, y: v } : toNative(u, v, quarterTurns);
}
