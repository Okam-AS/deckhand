// ---------------------------------------------------------------------------
// Reading an accessibility tree without caring which backend produced it.
//
// Two shapes reach this code: SimDeck's `/accessibility-tree` response, whose
// nodes carry AX-prefixed keys, and the compact `describe` action snapshot,
// which uses plain ones. Callers should not have to know which answered, so
// everything here accepts both.
// ---------------------------------------------------------------------------

interface Node {
  AXLabel?: unknown;
  AXValue?: unknown;
  AXUniqueId?: unknown;
  label?: unknown;
  value?: unknown;
  id?: unknown;
  children?: unknown;
}

function roots(tree: unknown): unknown {
  if (!tree || typeof tree !== "object") return tree;
  const t = tree as { roots?: unknown; snapshot?: { roots?: unknown } };
  return t.roots ?? t.snapshot?.roots ?? tree;
}

/**
 * Walk into every array-valued property, not just `children`.
 *
 * A reader that knows one child key is one rename away from silently reporting an empty
 * screen — and "empty" is precisely the answer that sends an agent down the wrong path.
 * Collection is keyed on the label/id fields, so visiting extra arrays costs nothing.
 */
function descend(node: object, walk: (n: unknown) => void): void {
  for (const v of Object.values(node)) if (Array.isArray(v) || (v && typeof v === "object")) walk(v);
}

/** Every human-readable string in a tree, in document order, deduplicated. */
export function treeLabels(tree: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    const n = node as Node;
    for (const v of [n.AXLabel, n.label, n.AXValue, n.value]) {
      if (typeof v === "string" && v.trim() && !seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
    descend(node, walk);
  };
  walk(roots(tree));
  return out;
}

/** Every stable selector id in a tree — the things `tapElement {id}` can hit. */
export function treeIds(tree: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    const n = node as Node;
    for (const v of [n.AXUniqueId, n.id]) {
      if (typeof v === "string" && v.trim() && !seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
    descend(node, walk);
  };
  walk(roots(tree));
  return out;
}

/** How many of these to hand back before the list stops being a hint and starts being a dump. */
const SAMPLE = 12;

/**
 * What to tell an agent whose selector did not match.
 *
 * A timeout says only "not found", which is the same answer for two situations that
 * call for opposite next moves: the element has not rendered YET (wait, or drive
 * further), or it is on screen but absent from the tree (stop selecting, screenshot).
 * Real case: `waitFor {text:"Design system"}` failed after 9.5s on a screen showing
 * six rows including "Design system" — that screen's rows are simply not in the
 * accessibility tree, so no selector would ever have matched and no amount of waiting
 * would have helped.
 *
 * Naming what IS in the tree settles it in one line: if the agent can see its target
 * on screen and this list does not contain it, the tree is the unreliable part.
 */
export function selectorMissHint(tree: unknown): string {
  const labels = treeLabels(tree);
  const ids = treeIds(tree);
  if (labels.length === 0 && ids.length === 0) {
    return "Nothing is readable in the accessibility tree for this screen — iOS degrades the capture on complex screens (maps especially). Selectors cannot work here: take a screenshot and read it.";
  }
  const shown = labels.slice(0, SAMPLE).map((l) => JSON.stringify(l.length > 40 ? `${l.slice(0, 40)}…` : l));
  const more = labels.length > SAMPLE ? ` (+${labels.length - SAMPLE} more)` : "";
  return (
    `The tree currently holds ${labels.length} readable label(s) and ${ids.length} id(s): ${shown.join(", ")}${more}. ` +
    "If what you are looking for is visible on screen but not in that list, this screen does not expose it — verify with a screenshot instead of waiting, because no selector will ever match it."
  );
}
