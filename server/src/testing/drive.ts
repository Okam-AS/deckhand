import type { Selector, UiAction } from "./control.ts";
import { isRotatedIos, RefError, shapeOf, type ScreenBook } from "./screen.ts";

// ---------------------------------------------------------------------------
// Running `ui` actions so that one call is one step for the agent: resolve refs, act, wait for
// the screen to stop moving, and hand back what is on it now. A list of actions is the same
// loop with the look taken once, at the end.
// ---------------------------------------------------------------------------

export type ObserveMode = "auto" | "full" | "none";

export interface DriveDeps {
  platform: "ios" | "android";
  book: ScreenBook;
  act(action: UiAction): Promise<unknown>;
  /** A fresh capture of the screen — what the agent reads, and what settling compares. */
  observe(): Promise<unknown>;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

export interface DriveFailure {
  index: number;
  action: UiAction;
  message: string;
  error: unknown;
  /** Set when the failure was a selector or ref that matched nothing. */
  searched?: string;
}

export interface DriveResult {
  results: unknown[];
  failure?: DriveFailure;
  /** The rendered screen after the last action; absent when no look was taken. */
  screen?: string;
  /** The raw tree behind `screen`, for hints that read it. */
  tree?: unknown;
  /** Why no screen came back although one was asked for. */
  screenError?: string;
  settleMs: number;
}

/** Actions that can change what is on screen, and how long a screen that still looks as it did is given to start changing. */
const CHANGE_WAIT_MS: Partial<Record<UiAction["type"], number>> = {
  tap: 1000,
  tapElement: 1000,
  key: 1000,
  button: 1000,
  home: 1000,
  openUrl: 1500,
  back: 1000,
  dismissKeyboard: 600,
  toggleAppearance: 600,
  rotate: 1000,
  type: 300,
  swipe: 500,
  gesture: 500,
  scrollUntilVisible: 500,
};
/** A screen still moving after this long is read as it is. */
const SETTLE_MAX_MS = 5000;
/** Captures are ~0.8s on iOS; this only keeps an instant answer from becoming a busy loop. */
const CAPTURE_GAP_MS = 100;
/** uiautomator dumps take ~2s each, so Android is not polled. */
const ANDROID_SETTLE_MS = 700;
/** Between the steps of a list: the next step's own selector wait does the rest. */
const STEP_GAP_MS = 250;
/** Inside a list, a later step's element may still be rendering when its turn comes. */
const BATCH_TAP_WAIT_MS = 3000;

export function isMutating(a: UiAction): boolean {
  return CHANGE_WAIT_MS[a.type] !== undefined;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Capture until two captures in a row agree, and return the last. Until `changeWaitMs` has
 * passed, a screen that still looks like `before` does not count: a tap's push transition, or a
 * reply from the network, can start after the tap has returned.
 */
export async function settle(
  deps: Pick<DriveDeps, "observe" | "platform" | "sleep" | "now">,
  before: string | undefined,
  changeWaitMs: number,
): Promise<{ tree: unknown; ms: number }> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const start = now();
  if (deps.platform === "android") {
    await sleep(ANDROID_SETTLE_MS);
    return { tree: await deps.observe(), ms: now() - start };
  }
  let tree = await deps.observe();
  let shape = shapeOf(tree);
  for (;;) {
    await sleep(CAPTURE_GAP_MS);
    const next = await deps.observe();
    const nextShape = shapeOf(next);
    const elapsed = now() - start;
    if (nextShape === shape && (nextShape !== before || elapsed >= changeWaitMs)) return { tree: next, ms: elapsed };
    if (elapsed >= SETTLE_MAX_MS) return { tree: next, ms: elapsed };
    tree = next;
    shape = nextShape;
  }
}

function withSelector(a: UiAction, selector: Selector): UiAction {
  return { ...a, selector } as UiAction;
}

/**
 * Turn a `{ref}` selector into what SimDeck understands. A point is only taken from a capture made
 * after the last action — the viewer's own taps move the screen too, so an older one is re-read.
 */
async function resolveRefs(deps: DriveDeps, a: UiAction, freshAfter: number, moved: boolean): Promise<UiAction> {
  if (!("selector" in a) || !a.selector.ref) return a;
  const ref = a.selector.ref;
  // Decided: on Android a ref is tapped at its element's centre, never matched by name — how SimDeck's selectors match uiautomator fields is unverified.
  const opts = { preferPoint: deps.platform === "android" && a.type === "tapElement" };
  let target = deps.book.resolve(ref, opts);
  // After an earlier step of this call a name may no longer be unique, so any ref is re-read then.
  if ((target.kind === "point" || moved) && (deps.book.snapshot?.revision ?? 0) <= freshAfter) {
    deps.book.record(await deps.observe());
    target = deps.book.resolve(ref, opts);
  }
  if (target.kind === "point" && isRotatedIos(deps.platform, deps.book.snapshot?.bounds)) {
    throw new RefError(`${ref} has no unique id or label, and this iOS device is rotated: SimDeck touches the unrotated screen, so a tap at its centre would land elsewhere`);
  }
  if (target.kind === "point") {
    if (a.type !== "tapElement") throw new RefError(`${ref} can only be tapped: it has no unique id or label for ${a.type} to match`);
    return { type: "tap", x: target.x, y: target.y };
  }
  return withSelector(a, target.selector);
}

export async function drive(deps: DriveDeps, actions: UiAction[], observe: ObserveMode): Promise<DriveResult> {
  const results: unknown[] = [];
  const sleep = deps.sleep ?? defaultSleep;
  let failure: DriveFailure | undefined;
  let freshAfter = deps.book.snapshot?.revision ?? 0;
  let lastMove: UiAction | undefined;
  for (let i = 0; i < actions.length; i++) {
    let a = actions[i]!;
    try {
      a = await resolveRefs(deps, a, freshAfter, lastMove !== undefined);
      if (i > 0 && a.type === "tapElement" && a.waitTimeoutMs == null) a = { ...a, waitTimeoutMs: BATCH_TAP_WAIT_MS };
      results.push(await deps.act(a));
    } catch (e) {
      const orig = actions[i]!;
      const sel = "selector" in orig ? orig.selector : undefined;
      failure = {
        index: i,
        action: orig,
        message: e instanceof Error ? e.message : String(e),
        error: e,
        ...(sel ? { searched: sel.ref ?? sel.text ?? sel.label ?? sel.id } : {}),
      };
      break;
    }
    if (!isMutating(a)) continue;
    lastMove = a;
    freshAfter = deps.book.snapshot?.revision ?? 0;
    if (i < actions.length - 1) await sleep(STEP_GAP_MS);
  }
  if (observe === "none" && !(failure && lastMove)) return { results, failure, settleMs: 0 };
  // Nothing moved and the failure is thrown to the caller as is: a look would advance what it was shown.
  if (failure && !lastMove && !("selector" in failure.action)) return { results, failure, settleMs: 0 };
  // The action already happened: a look that fails must not turn it into a failure.
  let tree: unknown;
  let settleMs = 0;
  try {
    if (lastMove && !failure) {
      const s = await settle(deps, deps.book.snapshot?.shape, CHANGE_WAIT_MS[lastMove.type]!);
      tree = s.tree;
      settleMs = s.ms;
    } else {
      tree = await deps.observe();
    }
  } catch (e) {
    return { results, failure, settleMs, screenError: e instanceof Error ? e.message : String(e) };
  }
  deps.book.record(tree);
  const screen = observe === "full" ? deps.book.full() : deps.book.update();
  return { results, failure, screen, tree, settleMs };
}
