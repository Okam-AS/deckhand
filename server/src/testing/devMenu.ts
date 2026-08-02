// ---------------------------------------------------------------------------
// Detecting the Expo/React Native dev menu in an accessibility tree, and telling
// the agent how to get out of its way.
//
// Why this exists, from a real session: an agent tapped the app's "Alle filtre"
// button at the top right, got the dev menu instead, tried twice more, and
// reported the app as having "critical UI bugs — button ID mapping broken". The
// app was fine. Expo's floating **Tools button** sits in that corner in a dev
// build and swallows the tap before the app ever sees it.
//
// Static prose does not fix that: the agent had already been told to prefer
// `tapElement` over coordinates, and fell back to coordinates anyway the moment a
// selector missed. So the recovery rides the response that carries the evidence —
// it fires only when the dev menu is actually on screen, which is the one moment
// it is worth reading.
// ---------------------------------------------------------------------------

/**
 * Labels unique to the Expo dev menu. Deliberately specific: "Reload" and
 * "Go home" also appear there but are far too generic to key off, and a false
 * positive here tells the agent to go fiddle with a switch that does not exist.
 */
const DEV_MENU_MARKERS = [
  "Open React Native dev menu",
  "Toggle element inspector",
  "Toggle performance monitor",
  "Copy system info",
  "Source code explorer",
];

/** How many markers must be present. Two, so one stray label cannot trigger it. */
const MIN_MARKERS = 2;

/**
 * The way out, written as steps rather than description because the agent that
 * needs it is mid-loop and will act on the first line it reads.
 *
 * Every fact here was measured on the device, twice — and the second pass
 * corrected the first. The original text said the toggle has "NO accessibility
 * label", which was true of the verbose /accessibility-tree response this was
 * written against. The switch to the compact describe snapshot landed the same
 * day and changed it: the row now carries a sibling StaticText "Tools button".
 *
 * The CHECKBOX still has no label of its own, so `tapElement {text:"Tools
 * button"}` hits the text and not the switch. What works is to read the row's y
 * from that text and tap the checkbox beside it — measured at x≈0.67 with the
 * text at x≈0.28. Its value is "1" when on and "0" when off, which is also the
 * only way to tell whether the tap landed.
 *
 * Verified on iOS 26.5, Expo runtime 4.0.0.
 */
export const DEV_MENU_RECOVERY =
  'The Expo dev menu is on screen — it is NOT part of the app, and its floating "Tools button" sits over the top-right corner where app controls usually live, swallowing taps meant for them. ' +
  "If a tap there did something unexpected, that is why, and the app is probably fine. " +
  'Turn the button off so it stops intercepting: scroll DOWN inside the dev menu to the TOOLS section, to the row labelled "Tools button" just below "Fast refresh". ' +
  'The switch itself is an UNLABELLED checkbox, so `tapElement {text:"Tools button"}` hits the text, not the switch — read that row\'s y from the tree and tap the checkbox to its right (measured at x≈0.67, with the label at x≈0.28). ' +
  'Its value reads "1" when on and "0" when off, which is how you confirm the tap landed. ' +
  'Then close the menu with the "Close" button and retry the action that failed. ' +
  'A system permission alert sits ABOVE the dev menu and blocks it, so dismiss that first if one is up. ' +
  "Report any dev-build overlay you had to dismiss, but do not report it as an app bug.";

interface Node {
  AXLabel?: unknown;
  AXValue?: unknown;
  label?: unknown;
  value?: unknown;
  children?: unknown;
}

/** Every label-ish string in a tree, whichever of the two node shapes it uses. */
function labels(node: unknown, out: string[]): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) labels(n, out);
    return;
  }
  const n = node as Node;
  for (const v of [n.AXLabel, n.label, n.AXValue, n.value]) {
    if (typeof v === "string" && v) out.push(v);
  }
  labels(n.children, out);
}

/**
 * True when the tree shows the dev menu.
 *
 * Accepts either shape deckhand may hold: the `/accessibility-tree` response
 * (`roots`, AX-prefixed keys) or the compact `describe` action snapshot — the
 * caller should not have to know which backend answered.
 */
export function devMenuOpen(tree: unknown): boolean {
  if (!tree || typeof tree !== "object") return false;
  const t = tree as { roots?: unknown; snapshot?: { roots?: unknown } };
  const found: string[] = [];
  labels(t.roots ?? t.snapshot?.roots ?? tree, found);
  const hits = new Set(DEV_MENU_MARKERS.filter((m) => found.some((l) => l.includes(m))));
  return hits.size >= MIN_MARKERS;
}

/** `{ devMenu: … }` to spread into a tool result, or nothing. */
export function devMenuHint(tree: unknown): { devMenu?: string } {
  return devMenuOpen(tree) ? { devMenu: DEV_MENU_RECOVERY } : {};
}
