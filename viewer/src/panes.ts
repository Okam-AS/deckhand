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
  /** What to show as the column heading. */
  label: string;
  /** The secondary line under it: the branch, or "local" for a working copy. */
  meta: string;
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
  /**
   * The platform the user last picked. Groups without an explicit choice follow
   * it, so switching one column to Android switches the others too — comparing
   * old-iOS against new-Android is almost never what you meant, and doing it by
   * hand is two clicks for what feels like one. An explicit `choices` entry
   * still wins, which is how you break the link deliberately.
   */
  preferredPlatform?: string;
  /** Mobile shows exactly one device; this is the one. */
  focusKey?: string;
  /**
   * Devices the user has switched off. Only meaningful with a single source,
   * where every device is on screen by default — with several sources each one
   * already shows just one device, and `choices` is how you change which.
   * Never empties the stage: the last visible device can't be switched off.
   */
  hiddenKeys?: readonly string[];
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
        // Heading is the repo, subheading the branch. No agent-supplied name:
        // an invented label ("Old app", "the Expo port") says less than the two
        // facts that actually identify a source, and drifts from them over time.
        // The branch has to be here, not just the repo — two panes are often the
        // SAME repo at different refs, and then the repo alone names neither.
        label: repoShortName(p.repo) || p.shareId,
        meta: p.ref,
        self: p.self === true,
        panes,
        activeKey: pickActive(panes, opts.choices?.[p.shareId], opts.preferredPlatform),
      };
    });

  const all = groups.flatMap((g) => g.panes);
  const multiSource = groups.length > 1;

  // One device on screen when the columns cannot all be a usable width. A phone
  // is the extreme case of that, not a separate mode — and the picker switches
  // between sources, so nothing becomes unreachable, it just takes a click.
  const width = opts.viewportWidth ?? Infinity;
  const columnsFit = groups.length * MIN_PANE_WIDTH <= width;
  if (opts.isMobile || !columnsFit) {
    const focused = opts.focusKey && all.some((p) => p.key === opts.focusKey) ? opts.focusKey : (groups[0]?.activeKey ?? "");
    return { groups, panes: all, visible: new Set(focused ? [focused] : []), multiSource };
  }

  // Several sources → one device each, because the comparison is between the
  // sources: two apps times two platforms is four phones on screen, each too
  // small to judge anything by.
  if (multiSource) return { groups, panes: all, visible: new Set(groups.map((g) => g.activeKey)), multiSource };

  // One source → spend the screen on its devices, so an app's iOS and Android
  // sit side by side as they always have, minus any the user switched off.
  const off = new Set(opts.hiddenKeys ?? []);
  const visible = new Set(all.filter((p) => !off.has(p.key)).map((p) => p.key));
  // Never leave an empty stage — switching the last device off is a no-op.
  if (visible.size === 0 && all[0]) visible.add(all[0].key);
  return { groups, panes: all, visible, multiSource };
}

/**
 * Which device a group shows: the explicit pick, else a healthy device matching
 * the platform the user last chose elsewhere, else any healthy one, else the
 * first.
 *
 * Health matters because a group shows ONE device: picking positionally put a
 * "This device didn't start" frame on screen while a perfectly good one sat
 * hidden behind the picker, with nothing saying so. An explicit pick still wins
 * — asking to see the broken device is a reasonable thing to want, and it is how
 * you read the error.
 */
function pickActive(panes: StagePane[], choice: string | undefined, preferredPlatform: string | undefined): string {
  if (choice && panes.some((p) => p.key === choice)) return choice;
  const healthy = panes.filter((p) => p.device.phase !== "failed");
  const pool = healthy.length ? healthy : panes;
  if (preferredPlatform) {
    const match = pool.find((p) => p.device.platform === preferredPlatform);
    if (match) return match.key;
  }
  return pool[0]?.key ?? "";
}
