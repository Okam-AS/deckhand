import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "./paths.ts";

// ---------------------------------------------------------------------------
// Domain phase types (shared across engine, MCP tools, viewer status).
// ---------------------------------------------------------------------------

export const PREVIEW_PHASES = ["pending", "running", "ready", "stopping", "stopped", "failed"] as const;
export type PreviewPhase = (typeof PREVIEW_PHASES)[number];

export const DEVICE_PHASES = [
  "pending",
  "preparing",
  "building",
  "booting",
  "installing-app",
  "launching",
  "ready",
  "failed",
] as const;
export type DevicePhase = (typeof DEVICE_PHASES)[number];

// "web" is the pseudo-platform for a frontend web preview: no simulator, one
// long-lived dev-server process reverse-proxied through the share URL.
export type Platform = "ios" | "android" | "web";

export interface PersistedDevice {
  deviceId: string; // stable id within the preview, e.g. "ios-0"
  platform: Platform;
  label: string; // human label, e.g. "iPhone 16 Pro · iOS 26"
  udid?: string; // simulator UDID once created
  serial?: string; // android adb serial (P2)
  runtime?: string; // e.g. "iOS 26.0"
  model?: string; // e.g. "iPhone 16 Pro"
  phase: DevicePhase;
  detail?: string; // short human status for the current phase
  // The build sub-step ("Compiling react-native-svg"), under the phase headline.
  // Churns per log line, so it is only ever written out incidentally, by the
  // next persist() of the whole record — nothing schedules a write for it.
  step?: string;
  error?: string;
  helperPort?: number; // serve-sim helper port (loopback)
  webPort?: number; // web only: the dev server's loopback port
}

/** Where a preview's code comes from: a git ref checkout, or a local dir built in place. */
export type PreviewSource = "git" | "local";

export interface PersistedPreview {
  previewId: string;
  shareId: string;
  appId: string;
  ref: string; // resolved ref description (branch or "pr/<n>"), or "local"
  source: PreviewSource;
  phase: PreviewPhase;
  devices: PersistedDevice[];
  createdAt: string; // ISO
  updatedAt: string; // ISO
  worktreePath?: string;
  passwordProtected: boolean;
  /**
   * True for a compare/migration reference pane: a preview booted under a
   * synthetic app id that is deliberately NOT in apps.yaml, so it has no owner
   * to scope against. Authorization denies by default when an app can't be
   * resolved, so a reference must say so explicitly rather than being inferred
   * from a failed lookup (which let any token drive any orphaned preview).
   */
  reference?: boolean;
  /** web only: the detected framework ("vite" | "nuxt" | "next" | "static"). Vite hosts
   *  path-based; the others host at the root of a per-share subdomain. */
  webFramework?: string;
}

/** A share PIN's scrypt hash + the digit length (so the viewer's pad shows the right dots). */
export interface PinRecord {
  salt: string;
  hash: string;
  length: number;
}

export interface PersistedState {
  version: 1;
  previews: PersistedPreview[];
  /**
   * Stable per-app share ids: the same app keeps the same viewer URL across
   * preview restarts and server restarts, so a bookmarked link never rots.
   */
  shareIds: Record<string, string>;
  /**
   * Per-app share PINs (scrypt-hashed). Persisted like shareIds so a bookmarked
   * protected URL stays protected across preview teardown and server restart.
   */
  pins: Record<string, PinRecord>;
}

const EMPTY: PersistedState = { version: 1, previews: [], shareIds: {}, pins: {} };

/**
 * Atomic JSON persistence for the set of previews, so a restart can reconcile
 * (see `staleOnBoot`). The engine owns the live in-memory previews and calls
 * `persist()` on every state transition; reads happen once at boot.
 */
export class StateStore {
  constructor(private readonly file: string = paths.state()) {}

  /**
   * Read the persisted state. An unreadable file is never quietly treated as an empty one.
   *
   * Every failure used to collapse to EMPTY — a missing file, a permissions error, a truncated
   * write, a hand edit (AGENTS.md tells agents to READ this file, so hand edits happen). The
   * server then came up looking healthy and the first `persist()` overwrote it, destroying
   * every stable share id and every scrypt PIN hash on the machine, with no log line, no audit
   * entry and no error. Bookmarked links rot and every protected share silently becomes public
   * on its next mint. Silent, total, and indistinguishable from a first boot.
   *
   * So the three cases are now told apart:
   *   missing        the only legitimate empty — a first boot
   *   unreadable     THROW. A permissions or IO fault is an operator problem, and a server
   *                  that cannot read this file must not start and overwrite it.
   *   unparseable    quarantine the file, then start empty. The data is preserved on disk and
   *                  named in the log, so it can be recovered by hand.
   */
  load(): PersistedState {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY);
      throw new Error(
        `cannot read ${this.file} (${(e as Error).message}). Refusing to start: continuing would ` +
          `overwrite it and destroy every share id and PIN hash it holds. Fix the permissions, or ` +
          `move the file aside deliberately.`,
      );
    }
    let parsed: Partial<PersistedState> | null = null;
    try {
      parsed = JSON.parse(text) as Partial<PersistedState>;
    } catch {
      parsed = null;
    }
    if (parsed && parsed.version === 1 && Array.isArray(parsed.previews)) {
      return { version: 1, previews: parsed.previews, shareIds: parsed.shareIds ?? {}, pins: parsed.pins ?? {} };
    }
    return this.quarantine(text.length);
  }

  /**
   * Move an unusable state file aside and start clean.
   *
   * Renamed rather than deleted, and named in the log: whatever is in there is the only copy of
   * every share id and PIN hash, and "it did not parse" is not a reason to be the one who
   * destroys it. If even the rename fails we throw, for the same reason as an unreadable file.
   */
  private quarantine(bytes: number): PersistedState {
    const aside = `${this.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      renameSync(this.file, aside);
    } catch (e) {
      throw new Error(
        `${this.file} is not valid deckhand state and could not be moved aside (${(e as Error).message}). ` +
          `Refusing to start rather than overwrite it.`,
      );
    }
    console.error(
      `deckhand: ${this.file} was not valid state (${bytes} bytes) — moved to ${aside} and starting empty. ` +
        `It holds every stable share id and PIN hash; recover them from that file if you need them.`,
    );
    return structuredClone(EMPTY);
  }

  /** Atomically overwrite the state file (temp file + rename). */
  persist(
    previews: PersistedPreview[],
    shareIds: Record<string, string> = {},
    pins: Record<string, PinRecord> = {},
  ): void {
    const state: PersistedState = { version: 1, previews, shareIds, pins };
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    // 0600: this file holds every share's PIN hash. A 4-6 digit keyspace at
    // scrypt N=16384 cracks offline in well under a second, so world-readable
    // means every PIN on the machine is readable by any local user.
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

/**
 * On restart, any preview that was live is now orphaned: its serve-sim helpers
 * and (booted) simulators did not survive the process exit cleanly, so the
 * previews must be reconciled (torn down / recreated), never trusted as-is.
 * Phase 1 marks them for teardown; Phase 4 adds richer reconciliation.
 */
export function staleOnBoot(state: PersistedState): PersistedPreview[] {
  return state.previews.filter((p) => p.phase !== "stopped" && p.phase !== "failed");
}
