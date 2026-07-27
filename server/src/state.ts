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

  load(): PersistedState {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch {
      return structuredClone(EMPTY);
    }
    try {
      const parsed = JSON.parse(text) as Partial<PersistedState>;
      if (parsed && parsed.version === 1 && Array.isArray(parsed.previews)) {
        return { version: 1, previews: parsed.previews, shareIds: parsed.shareIds ?? {}, pins: parsed.pins ?? {} };
      }
      return structuredClone(EMPTY);
    } catch {
      return structuredClone(EMPTY);
    }
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
    writeFileSync(tmp, JSON.stringify(state, null, 2));
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
