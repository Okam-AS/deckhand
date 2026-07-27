import { execFile } from "node:child_process";
import type { Simctl, SimDevice } from "../devices/ios.ts";
import type { AndroidManager } from "../devices/android.ts";

// ---------------------------------------------------------------------------
// Orphan reaper. A deckhand process owns every simulator/AVD it names
// `deckhand-…` / `deckhand_…`, but it cannot tear them down if it exits
// abnormally (crash, SIGKILL, a `serve` restart). Those devices then linger
// forever: booted simulators, emulator QEMU processes pinned to a console port,
// and serve-sim helpers — several GB of RAM each, invisible to the next process
// because its in-memory preview map starts empty.
//
// So: on boot, sweep. Deckhand binds a single loopback port, so only one server
// runs at a time and *every* deckhand-named device found at startup is by
// definition an orphan. Devices in `keep` (a live preview's, when sweeping
// mid-run) are spared.
// ---------------------------------------------------------------------------

/** Simulator names deckhand creates: `deckhand-<previewId>-<deviceId>`. */
export const SIM_PREFIX = "deckhand-";
/** AVD names deckhand creates: `deckhand_<previewId>_<deviceId>` (avdmanager forbids "-"). */
export const AVD_PREFIX = "deckhand_";
/** Pooled devices are named by shape, not by preview — they outlive a preview on purpose. */
export const POOL_SIM_PREFIX = "deckhand-pool-";
export const POOL_AVD_PREFIX = "deckhand_pool_";

export function isPooled(name: string): boolean {
  return name.startsWith(POOL_SIM_PREFIX) || name.startsWith(POOL_AVD_PREFIX);
}

export function orphanSims(devices: SimDevice[], keep: ReadonlySet<string> = new Set()): SimDevice[] {
  return devices.filter((d) => d.name.startsWith(SIM_PREFIX) && !keep.has(d.udid));
}

export function orphanAvds(names: string[], keep: ReadonlySet<string> = new Set()): string[] {
  return names.filter((n) => n.startsWith(AVD_PREFIX) && !keep.has(n));
}

export interface ReapReport {
  sims: string[]; // udids deleted
  avds: string[]; // AVD names deleted
  /** Pooled devices left on disk (shut down + helpers killed) for the next preview to reuse. */
  keptPooled: string[];
}

/** Kill processes whose full command line matches `pattern` (best effort). */
export type Killer = (pattern: string) => Promise<void>;

const defaultKiller: Killer = (pattern) =>
  new Promise((resolve) => {
    // -f matches the full argv; a miss exits non-zero, which is fine.
    execFile("pkill", ["-f", pattern], () => resolve());
  });

export interface ReaperDeps {
  simctl: Simctl;
  android: AndroidManager;
  kill?: Killer;
  log?: (line: string) => void;
}

export class Reaper {
  private readonly kill: Killer;
  constructor(private readonly d: ReaperDeps) {
    this.kill = d.kill ?? defaultKiller;
  }

  /**
   * Shut down, unregister and delete every deckhand-owned simulator/AVD not in
   * `keep`, plus the helper processes bound to them. Never throws: a reap
   * failure must not stop the server from coming up.
   */
  async reap(keep: { udids?: Iterable<string>; avds?: Iterable<string> } = {}): Promise<ReapReport> {
    const keepUdids = new Set(keep.udids ?? []);
    const keepAvds = new Set(keep.avds ?? []);
    const report: ReapReport = { sims: [], avds: [], keptPooled: [] };

    const sims = orphanSims(await this.list(() => this.d.simctl.listDevices(), []), keepUdids);
    for (const sim of sims) {
      // The helper streams from the UDID; kill it before the device disappears.
      await this.kill(`serve-sim ${sim.udid}`).catch(() => {});
      await this.d.simctl.shutdown(sim.udid).catch(() => {});
      // Pooled devices are the point of the pool: keep them on disk, just make
      // sure nothing is still running against them. The engine wipes one whose
      // previous tenant it can't account for (exactly this case) on acquire.
      if (isPooled(sim.name)) {
        report.keptPooled.push(sim.name);
        continue;
      }
      await this.d.simctl.delete(sim.udid).catch(() => {});
      report.sims.push(sim.udid);
    }

    const avds = orphanAvds(await this.list(() => this.d.android.listAvds(), []), keepAvds);
    for (const avd of avds) {
      // `adb emu kill` needs a reachable console port; orphans often collide on
      // one (each process restarts port allocation at 5554), so kill the QEMU
      // process by its -avd argument instead — always exact, never ambiguous.
      // The pattern is anchored at the end (pkill -f matches a substring of the
      // full argv), or `avd deckhand_pool_x` would also kill the process running
      // `-avd deckhand_pool_x_2`. No leading "-": pkill would read it as a flag.
      await this.kill(`avd ${avd}([[:space:]]|$)`).catch(() => {});
      if (isPooled(avd)) {
        report.keptPooled.push(avd);
        continue;
      }
      await this.d.android.deleteAvd(avd).catch(() => {});
      report.avds.push(avd);
    }

    if (report.sims.length || report.avds.length || report.keptPooled.length) {
      this.d.log?.(
        `reaped ${report.sims.length} orphaned simulator(s), ${report.avds.length} orphaned AVD(s); ` +
          `${report.keptPooled.length} pooled device(s) kept`,
      );
    }
    return report;
  }

  private async list<T>(fn: () => Promise<T[]>, fallback: T[]): Promise<T[]> {
    try {
      return await fn();
    } catch {
      return fallback; // Xcode/Android SDK missing — nothing of ours to reap.
    }
  }
}
