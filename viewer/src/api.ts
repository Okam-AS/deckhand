export interface ShareDevice {
  deviceId: string;
  /** "ios" | "android" | "web" — "web" renders an iframe instead of a device canvas. */
  platform?: string;
  label: string;
  phase: string;
  detail?: string;
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

/** A migration source preview shown alongside the target (old vs new). */
export interface SharePaired {
  shareId: string;
  repo: string;
  ref: string;
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
  devices: ShareDevice[];
  /** Present while the agent is running (or just finished) an end-to-end test. */
  testRun?: ShareTestRun;
  /** Migration target only: the live source preview to render side by side. */
  pairedWith?: SharePaired;
  /** Migration target only: the parity checklist, when the ledger file exists. */
  ledger?: { screens: ShareLedgerScreen[] };
}

/** "github.com/Okam-AS/AdminApp" → "Okam-AS/AdminApp" (host + .git stripped). */
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

/** Friendly, calm status text for a device phase. */
export function phaseLabel(phase: string, detail?: string): string {
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
