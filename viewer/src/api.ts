export interface ShareDevice {
  deviceId: string;
  /** "ios" | "android" | "web" — "web" renders an iframe instead of a device canvas. */
  platform?: string;
  label: string;
  phase: string;
  detail?: string;
  /** The build sub-step ("Compiling react-native-svg") shown under the headline. */
  step?: string;
}

export type TestStepStatus = "pending" | "running" | "passed" | "failed";
export interface ShareTestStep {
  n: number;
  label: string;
  status: TestStepStatus;
  detail?: string;
}
/** The agent's live end-to-end test run, rendered as a calm spinner + step popover. */
export interface ShareTestRun {
  status: "running" | "passed" | "failed";
  title: string;
  steps: ShareTestStep[];
  summary?: string;
}

/**
 * One source on the page: an app at a ref, with its devices. A page is a LIST
 * of these — an ordinary preview has exactly one, a comparison has several.
 * Order is old → new (references first, this share's own last).
 */
export interface SharePane {
  /** Each pane streams from its OWN share path; one PIN unlocks them all. */
  shareId: string;
  repo: string;
  ref: string;
  /** True for the page's own share — the one `devices`/`canRestart` describe. */
  self?: true;
  devices: ShareDevice[];
}

/** One row of the migration parity ledger (agent-maintained, in the target repo). */
export interface ShareLedgerScreen {
  name: string;
  /** "not-started" | "in-progress" | "matches" | "differs" (open string — the server owns the enum). */
  status: string;
  note?: string;
}

export interface ShareState {
  ready: boolean;
  ref: string;
  repo: string;
  /** "local" = dev-mode preview of a working copy; "git" = a ref checkout. */
  source?: "git" | "local";
  /** Whether the rebuild button applies right now (local + settled). */
  canRestart?: boolean;
  /** True when the share is PIN-protected and not yet unlocked (state is then minimal). */
  locked?: boolean;
  /** Number of PIN digits (when locked) — drives the pad's dot count + auto-submit. */
  pinLength?: number;
  /** This share's own devices. Same as the `self` pane's — kept for the web branch. */
  devices: ShareDevice[];
  /** Present while the agent is running (or just finished) an end-to-end test. */
  testRun?: ShareTestRun;
  /**
   * Every source on this page, in display order. Always at least one, so the
   * stage renders a list and never asks "is this a comparison?".
   */
  panes: SharePane[];
  /** The parity checklist, when the agent is keeping one. */
  ledger?: { screens: ShareLedgerScreen[] };
}

/** "github.com/acme/store-app" → "acme/store-app" (host + .git stripped). */
export function repoName(repo: string): string {
  if (!repo) return "";
  return repo
    .replace(/^https?:\/\//, "")
    .replace(/^git@/, "")
    .replace(/\.git$/, "")
    .replace(/^[^/:]+[/:]/, ""); // drop the host segment
}

export function shareIdFromPath(): string | null {
  const m = /^\/s\/([^/]+)/.exec(location.pathname);
  return m ? decodeURIComponent(m[1]!) : null;
}

/** Result of a PIN attempt: unlocked, wrong (retry), or locked out for `lockedMs`. */
export type UnlockResult = { ok: true } | { ok: false; lockedMs: number };

/** Submit a PIN; on success the server sets the unlock cookie (sent automatically thereafter). */
export async function verifyPin(shareId: string, pin: string): Promise<UnlockResult> {
  try {
    const res = await fetch(`/s/${encodeURIComponent(shareId)}/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => ({}))) as { lockedMs?: number };
    return { ok: false, lockedMs: res.status === 429 ? (body.lockedMs ?? 30000) : 0 };
  } catch {
    return { ok: false, lockedMs: 0 };
  }
}

export async function fetchShareState(shareId: string): Promise<ShareState | "gone" | null> {
  try {
    const res = await fetch(`/s/${encodeURIComponent(shareId)}/state`, { headers: { accept: "application/json" } });
    if (res.status === 404) return "gone";
    if (!res.ok) return null;
    return (await res.json()) as ShareState;
  } catch {
    return null;
  }
}

export function deviceBase(shareId: string, deviceId: string): string {
  return `/s/${encodeURIComponent(shareId)}/dev/${encodeURIComponent(deviceId)}`;
}

export function deviceWsUrl(shareId: string, deviceId: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${deviceBase(shareId, deviceId)}/ws`;
}

/**
 * One word for the pill at the top of the frame — the same chip the streaming
 * states ("Connecting…") already use. It replaces the big centred headline: with
 * a live build sub-step underneath the spinner, a full sentence in the middle of
 * the frame was two competing status lines saying the same thing.
 */
export function phaseBadge(phase: string): string {
  switch (phase) {
    case "pending":
    case "preparing":
      return "Preparing…";
    case "booting":
      return "Booting…";
    case "building":
      return "Building…";
    case "installing-app":
      return "Installing…";
    case "launching":
      return "Launching…";
    default:
      return "Connecting…";
  }
}

/** Friendly, calm status text for a device phase. */
export function phaseLabel(phase: string, detail?: string): string {
  // "failed" keeps its headline even with a detail — the detail is the REASON,
  // rendered underneath, not a replacement. A bare error message where the
  // status line should be read as noise; "This device didn't start." + the
  // reason reads as an answer.
  if (phase === "failed") return "This device didn't start.";
  if (detail) return detail;
  switch (phase) {
    case "pending":
    case "preparing":
      return "Getting things ready…";
    case "booting":
      return "Waking the simulator…";
    case "building":
      return "Building the app…";
    case "installing-app":
      return "Installing…";
    case "launching":
      return "Almost there…";
    case "ready":
      return "Ready";
    case "failed":
      return "This device didn't start.";
    default:
      return "Working…";
  }
}
