import type { Selector, UiAction } from "./control.ts";
import { RefError, shapeOf, type ScreenBook } from "./screen.ts";

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
  /** A cheap fresh capture, compared only with itself to tell when the screen is still. */
  probe(): Promise<unknown>;
  /** The full capture the agent reads. */
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
  settleMs: number;
}

/** Actions that can change what is on screen, and how long a still screen is given to start changing. */
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
const SETTLE_MAX_MS = 4000;
const PROBE_GAP_MS = 100;
/** uiautomator dumps take ~2s each, so Android is not polled. */
const ANDROID_SETTLE_MS = 700;
/** Inside a list, a later step's element may still be rendering when its turn comes. */
const BATCH_TAP_WAIT_MS = 3000;

export function isMutating(a: UiAction): boolean {
  return CHANGE_WAIT_MS[a.type] !== undefined;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Wait until two consecutive probes agree. Until `changeWaitMs` has passed, a screen still equal
 * to `before` does not count as settled: a tap's push transition can start after the tap returns.
 */
export async function settle(
  deps: Pick<DriveDeps, "probe" | "platform" | "sleep" | "now">,
  before: string | undefined,
  changeWaitMs: number,
): Promise<{ shape: string | undefined; ms: number }> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const start = now();
  if (deps.platform === "android") {
    await sleep(ANDROID_SETTLE_MS);
    return { shape: undefined, ms: now() - start };
  }
  let prev: string | undefined;
  for (;;) {
    const shape = shapeOf(await deps.probe());
    const elapsed = now() - start;
    if (prev !== undefined && shape === prev && (shape !== before || elapsed >= changeWaitMs)) return { shape, ms: elapsed };
    if (elapsed >= SETTLE_MAX_MS) return { shape, ms: elapsed };
    prev = shape;
    await sleep(PROBE_GAP_MS);
  }
}

function withSelector(a: UiAction, selector: Selector): UiAction {
  return { ...a, selector } as UiAction;
}

/** Turn a `{ref}` selector into what SimDeck understands, re-reading the screen once if the ref needs a fresh frame. */
async function resolveRefs(deps: DriveDeps, a: UiAction): Promise<UiAction> {
  if (!("selector" in a) || !a.selector.ref) return a;
  const ref = a.selector.ref;
  let target;
  try {
    target = deps.book.resolve(ref);
  } catch (e) {
    if (!(e instanceof RefError) || !deps.book.stale) throw e;
    deps.book.record(await deps.observe());
    target = deps.book.resolve(ref);
  }
  if (target.kind === "point") {
    if (a.type !== "tapElement") throw new RefError(`${ref} can only be tapped: it has no unique id or label for ${a.type} to match`);
    return { type: "tap", x: target.x, y: target.y };
  }
  return withSelector(a, target.selector);
}

export async function drive(deps: DriveDeps, actions: UiAction[], observe: ObserveMode): Promise<DriveResult> {
  const results: unknown[] = [];
  let failure: DriveFailure | undefined;
  let settleMs = 0;
  let before: string | undefined;
  const moves = actions.some(isMutating);
  if (moves && observe !== "none" && deps.platform === "ios") before = shapeOf(await deps.probe());
  for (let i = 0; i < actions.length; i++) {
    let a = actions[i]!;
    try {
      a = await resolveRefs(deps, a);
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
      if (!(e instanceof RefError)) deps.book.stale = true;
      break;
    }
    if (!isMutating(a)) continue;
    deps.book.stale = true;
    const last = i === actions.length - 1;
    if (last && observe === "none") break;
    const s = await settle(deps, before, CHANGE_WAIT_MS[a.type]!);
    settleMs += s.ms;
    before = s.shape;
  }
  if (observe === "none" && !(failure && moves)) return { results, failure, settleMs };
  const tree = await deps.observe();
  deps.book.record(tree);
  const screen = observe === "full" ? deps.book.full() : deps.book.update();
  return { results, failure, screen, tree, settleMs };
}
