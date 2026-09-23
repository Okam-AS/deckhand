import type { UiAction } from "../testing/control.ts";

/** A Choice question accepts at most this many options (TypeSafe API). */
export const MAX_OPTIONS = 255;

/** One on-screen element, backend-neutral. */
export interface ScreenElement {
  ref: string;
  role: string;
  label?: string;
  value?: string;
  id?: string;
  interactive: boolean;
  textInput: boolean;
}

export interface Candidate {
  key: string;
  /** What the model reads for this option. */
  description: string;
  /** What code executes when it is chosen — empty for the two terminal options. */
  actions: UiAction[];
  /** Name of a caller-supplied value to type after `actions`; resolved by the loop, never sent to the model. */
  typeKey?: string;
  /** Trace text; never carries a caller-supplied text VALUE. */
  summary: string;
}

export interface Screen {
  elements: ScreenElement[];
  lines: string[];
  /** Identity of the screen for loop detection. */
  signature: string;
}

const INTERACTIVE_ROLE = /button|link|cell|field|switch|toggle|tab|menu|checkbox|radio|segment|picker|slider|stepper|searchfield|edittext/i;
const TEXT_INPUT_ROLE = /textfield|securetextfield|searchfield|textview|edittext|textarea/i;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function roots(tree: unknown): unknown {
  if (!tree || typeof tree !== "object") return tree;
  const t = tree as { roots?: unknown; snapshot?: { roots?: unknown } };
  return t.roots ?? t.snapshot?.roots ?? tree;
}

/** Flatten either tree shape (compact snapshot or AX-keyed endpoint) into elements, document order. */
export function readScreen(tree: unknown): Screen {
  const elements: ScreenElement[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    const n = node as Record<string, unknown>;
    const role = str(n.role) ?? str(n.type) ?? str(n.AXRole) ?? str(n.className) ?? "Element";
    const label = str(n.label) ?? str(n.AXLabel) ?? str(n.text) ?? str(n.contentDescription);
    const value = str(n.value) ?? str(n.AXValue);
    const id = str(n.id) ?? str(n.AXUniqueId) ?? str(n.resourceId);
    const textInput = TEXT_INPUT_ROLE.test(role);
    const interactive = textInput || INTERACTIVE_ROLE.test(role) || n.clickable === true;
    if (label || value || id) {
      elements.push({ ref: `e${elements.length + 1}`, role, label, value, id, interactive, textInput });
    }
    for (const v of Object.values(n)) if (v && typeof v === "object") walk(v);
  };
  walk(roots(tree));
  const lines = elements.map(line);
  return { elements, lines, signature: lines.join("\n") };
}

function line(e: ScreenElement): string {
  const parts = [`[${e.ref}]`, e.role];
  if (e.label) parts.push(JSON.stringify(e.label));
  if (e.value && e.value !== e.label) parts.push(`value=${JSON.stringify(e.value)}`);
  if (e.interactive) parts.push("(tappable)");
  return parts.join(" ");
}

/** A selector that tapElement can resolve: the stable id first, then the label. */
function selectorFor(e: ScreenElement): UiAction | null {
  if (e.id) return { type: "tapElement", selector: { id: e.id } };
  if (e.label) return { type: "tapElement", selector: { label: e.label } };
  return null;
}

function name(e: ScreenElement): string {
  return `${e.role} ${JSON.stringify(e.label ?? e.value ?? e.id)}`;
}

export interface CandidateSet {
  candidates: Candidate[];
  /** Tappable elements dropped because the option cap was reached. */
  dropped: number;
}

/**
 * The closed action set for one screen. `textKeys` are the NAMES of values the caller
 * supplied; the values themselves never reach the model.
 */
export function candidatesFor(screen: Screen, textKeys: string[]): CandidateSet {
  const fixed: Candidate[] = [
    { key: "done", description: "The goal is already achieved on the current screen — stop.", actions: [], summary: "done" },
    { key: "stuck", description: "No listed action moves toward the goal.", actions: [], summary: "stuck" },
    { key: "back", description: "Go back to the previous screen.", actions: [{ type: "back" }], summary: "back" },
    { key: "scroll_down", description: "Scroll down to reveal more of this screen.", actions: [{ type: "gesture", preset: "scroll-down" }], summary: "scroll down" },
    { key: "scroll_up", description: "Scroll up to reveal content above.", actions: [{ type: "gesture", preset: "scroll-up" }], summary: "scroll up" },
  ];
  const fills: Candidate[] = [];
  const taps: Candidate[] = [];
  const seen = new Set<string>();
  for (const e of screen.elements) {
    if (!e.interactive) continue;
    const tap = selectorFor(e);
    if (!tap) continue;
    const dedupe = JSON.stringify(tap);
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    if (e.textInput) {
      textKeys.forEach((k, i) => {
        fills.push({
          key: `fill_${e.ref}_${i}`,
          description: `Enter the "${k}" value into [${e.ref}] ${name(e)}.`,
          actions: [tap],
          typeKey: k,
          summary: `typed "${k}" into ${name(e)}`,
        });
      });
    }
    taps.push({ key: `tap_${e.ref}`, description: `Tap [${e.ref}] ${name(e)}.`, actions: [tap], summary: `tapped ${name(e)}` });
  }
  const room = MAX_OPTIONS - fixed.length;
  const variable = [...fills, ...taps];
  const kept = variable.slice(0, room);
  return { candidates: [...fixed, ...kept], dropped: variable.length - kept.length };
}
