import { repoName, type ShareDevice, type SharePane } from "./api.ts";

/**
 * The stage's layout, as data.
 *
 * The viewer used to have two screens — a grid of one app's devices, and a
 * two-column compare — that differed only in how they grouped the same frames.
 * Everything they disagreed about (grouping, how many devices are on screen,
 * which one each column shows) is decided here, as a pure function, so the
 * component below just renders the answer and there is exactly one stage.
 *
 * Pure on purpose: this is the only part of the merge with real branching, and
 * the viewer has no DOM test setup (and may not grow one — no new deps). Keeping
 * it DOM-free is what makes it testable at all.
 */

/** One device on screen. */
export interface StagePane {
  /**
   * Identity, stable across polls. Composite because two sources both call
   * their first device "ios-0": keyed on deviceId alone, React reuses the wrong
   * frame, the FLIP map reads a foreign rect, and — worst — input is routed to
   * the wrong device, which is a real touch on a real phone.
   */
  key: string;
  shareId: string;
  deviceId: string;
  device: ShareDevice;
}

/** One source (an app at a ref) and its devices. */
export interface StageGroup {
  key: string;
  shareId: string;
  repo: string;
  ref: string;
  /** Names the source in the mobile dock's grouped picker. */
  label: string;
  self: boolean;
  /** Every device of this source. All stay mounted; only `visible` ones decode. */
  panes: StagePane[];
  /** The device this group currently shows. */
  activeKey: string;
}

export interface Stage {
  groups: StageGroup[];
  /** Every pane, flat, in render order. */
  panes: StagePane[];
  /** Keys that are on screen right now. Everything else stays mounted, hidden. */
  visible: Set<string>;
  /** More than one source → grouped columns with headings. */
  multiSource: boolean;
}

/**
 * The narrowest a source's column can get and still be worth looking at. Below
 * this a phone renders too small to judge a screen by, which is the only reason
 * to have it on screen at all — so it is better to show one source properly and
 * switch between them.
 */
export const MIN_PANE_WIDTH = 340;

export interface StageOptions {
  isMobile: boolean;
  /**
   * Viewport width in CSS pixels. Sources sit side by side while they all fit at
   * MIN_PANE_WIDTH; below that the stage shows ONE, exactly as it does on a
   * phone. Omit and everything is assumed to fit.
   */
  viewportWidth?: number;
  /**
   * Explicit per-group device choice (group key → pane key), from the picker.
   * A stale entry (the device went away) is ignored rather than blanking the group.
   */
  choices?: Record<string, string>;
  /** Mobile shows exactly one device; this is the one. */
  focusKey?: string;
}

export function paneKey(shareId: string, deviceId: string): string {
  return `${shareId}:${deviceId}`;
}

/** Short name for a pane's picker row: "iPhone 16 Pro · iOS 26" → "iPhone 16 Pro". */
export function shortDeviceName(label: string): string {
  return label.split(" · ")[0] ?? label;
}

/**
 * The heading for an unlabelled source: just the repo's own name, not
 * `owner/name` — the line under it already reads "acme/app · main", and a
 * heading that repeats it wastes the one line a narrow column has.
 */
export function repoShortName(repo: string): string {
  const full = repoName(repo);
  return full.slice(full.lastIndexOf("/") + 1);
}

export function computeStage(sharePanes: SharePane[], opts: StageOptions): Stage {
  const groups: StageGroup[] = sharePanes
    .filter((p) => p.devices.length > 0)
    .map((p) => {
      const panes: StagePane[] = p.devices.map((d) => ({
        key: paneKey(p.shareId, d.deviceId),
        shareId: p.shareId,
        deviceId: d.deviceId,
        device: d,
      }));
      return {
        key: p.shareId,
        shareId: p.shareId,
        repo: p.repo,
        ref: p.ref,
        // No agent-supplied name: an invented label ("Old app", "the Expo port")
        // says less than the repo itself and drifts from it over time. Repo and
        // branch are shown in full behind each frame's (i) button; this is just
        // the short name the dock's picker groups by.
        label: repoShortName(p.repo) || p.shareId,
        meta: p.ref,
        self: p.self === true,
        panes,
        activeKey: pickActive(panes, opts.choices?.[p.shareId]),
      };
    });

  const all = groups.flatMap((g) => g.panes);
  const multiSource = groups.length > 1;

  // ONE rule, for every shape of page: show everything that fits at a usable
  // width, otherwise show one and let the picker switch.
  //
  // It used to count GROUPS, so a single source "fit" no matter how many devices
  // it had — and that page then needed its own controls (a Side-by-side/Focus
  // toggle and a switch per device) that the multi-source page did not. Two
  // layouts for the same question, and the one-repo case was the odd one out for
  // no reason a user could see. Counting what will actually be on screen makes
  // the difference disappear.
  const width = opts.viewportWidth ?? Infinity;
  // Several sources → one device each: the comparison is BETWEEN the sources, and
  // two apps times two platforms is four phones too small to judge anything by.
  const wanted = multiSource ? groups.length : all.length;
  const fits = wanted * MIN_PANE_WIDTH <= width;

  if (opts.isMobile || !fits) {
    const focused = opts.focusKey && all.some((p) => p.key === opts.focusKey) ? opts.focusKey : (groups[0]?.activeKey ?? "");
    return { groups, panes: all, visible: new Set(focused ? [focused] : []), multiSource };
  }
  if (multiSource) return { groups, panes: all, visible: new Set(groups.map((g) => g.activeKey)), multiSource };
  return { groups, panes: all, visible: new Set(all.map((p) => p.key)), multiSource };
}

/**
 * Which device a group shows: the explicit pick, else a healthy one, else the
 * first.
 *
 * Each column chooses INDEPENDENTLY. An earlier version had the other columns
 * follow whichever platform you last picked, on the theory that comparing
 * old-iOS against new-Android is rarely what you meant — but that spends a click
 * every time it guesses wrong, and guessing on the user's behalf about which two
 * things they want to hold up against each other is not the stage's business.
 *
 * Health matters because a group shows ONE device: picking positionally put a
 * "This device didn't start" frame on screen while a perfectly good one sat
 * hidden behind the picker, with nothing saying so. An explicit pick still wins
 * — asking to see the broken device is reasonable, and it is how you read the
 * error.
 */
function pickActive(panes: StagePane[], choice: string | undefined): string {
  if (choice && panes.some((p) => p.key === choice)) return choice;
  const healthy = panes.filter((p) => p.device.phase !== "failed");
  return (healthy.length ? healthy : panes)[0]?.key ?? "";
}

/**
 * Whether the viewer should still consider itself unlocked, given what the server just said.
 *
 * `unlocked` exists only to bridge the moment between a correct PIN and the refetched state
 * arriving — without it the content branch renders once with no devices. It was a ONE-WAY
 * latch, and the server can go back to locked: the unlock cookie has a 12h TTL, and an
 * operator can set a new PIN on a share somebody already has open.
 *
 * When that happened the pad never came back, because `locked && !unlocked` stayed false. The
 * locked state carries no panes and no devices, so the tab rendered the content branch with
 * nothing in it: a permanently blank screen, no error, no way back except a manual reload.
 *
 * The server's answer is the truth; the latch may only ever bridge forward from it.
 */
export function stillUnlocked(previouslyUnlocked: boolean, serverSaysLocked: boolean): boolean {
  return previouslyUnlocked && !serverSaysLocked;
}

/**
 * What the page should show while it has no usable state, and when to ask again.
 *
 * Both no-state paths used to be dead ends. `"gone"` (a 404 on /state) set a flag
 * and returned WITHOUT scheduling another poll, so the viewer never noticed the
 * share coming back — while the screen it showed said, in as many words, "this
 * same link will come right back". A promise the code made unobservable.
 *
 * `null` (any other failure) kept polling but left the page on "Loading preview…"
 * forever, which is what a user actually hit: a preview was swapped behind a
 * stable share URL, /state answered non-OK for a few seconds, and the spinner
 * never stopped or explained itself. Server-side the new preview was ready with a
 * first frame in 1.5s.
 *
 * So: never stop, and after a short streak say what is happening. A share that is
 * genuinely paused is polled calmly rather than not at all — the cost is one
 * request every few seconds against a promise the UI already makes.
 */
export type PollView = "loading" | "reconnecting" | "paused" | "state";

/** Consecutive failures before the spinner admits it is retrying rather than starting. */
export const RECONNECT_AFTER_FAILURES = 4;

export interface PollDecision {
  view: PollView;
  /** Always a number. There is no input for which the viewer stops asking. */
  delayMs: number;
}

export function pollDecision(
  result: "gone" | "error" | "state",
  opts: { consecutiveFailures: number; settled: boolean; hadStateBefore: boolean },
): PollDecision {
  if (result === "state") return { view: "state", delayMs: opts.settled ? 5000 : 1200 };
  if (result === "gone") return { view: "paused", delayMs: 5000 };
  // Back off once a failure looks persistent rather than hammering through a tunnel
  // that is already unhappy, but keep it well inside a human's patience.
  const persistent = opts.consecutiveFailures >= RECONNECT_AFTER_FAILURES;
  return {
    // "Loading" is only honest the first time. Once we have shown content, or have
    // failed repeatedly, the user is owed the word "reconnecting".
    view: persistent || opts.hadStateBefore ? "reconnecting" : "loading",
    delayMs: persistent ? 3000 : 1200,
  };
}

/**
 * What to show for a preview's source: the branch, and whether it is a working copy.
 *
 * The viewer used to render the literal "local working copy" for every local preview and
 * drop `ref` on the floor. The branch was never missing — deckhand looks it up when the
 * preview starts (`localBranch`), persists it, and ships it in the share state. A user
 * looking at the panel saw "local working copy" while the payload behind it said
 * "feature/review".
 *
 * Both facts matter and neither replaces the other. The branch answers "what am I looking
 * at"; "working copy" answers "is this the pushed ref, or this machine's uncommitted
 * state" — which is the difference between a preview you can share the meaning of and one
 * only this checkout can reproduce. So: show the branch, keep the qualifier.
 *
 * A checkout with no branch to report (detached HEAD, or not a git repo at all) keeps
 * `ref` as the sentinel "local", and there the old label is the whole truth.
 */
export function sourceLabel(source: string | undefined, refName: string | undefined): { key: string; value: string } {
  if (source !== "local") return { key: "Branch", value: refName || "—" };
  if (!refName || refName === "local") return { key: "Source", value: "local working copy" };
  return { key: "Branch", value: `${refName} · working copy` };
}
