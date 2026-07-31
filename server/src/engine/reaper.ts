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
// runs at a time and every deckhand-named device it does NOT know about is an
// orphan. "Does not know about" is passed in as `keep` rather than assumed from
// an empty preview map: the boot reap runs after the port is bound (so that a
// second `serve` dies on EADDRINUSE before deleting the live server's devices),
// which means a start_preview can already be creating a simulator by the time
// the sweep runs.
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

export function orphanSims(
  devices: SimDevice[],
  keep: ReadonlySet<string> = new Set(),
  keepNames: ReadonlySet<string> = new Set(),
): SimDevice[] {
  return devices.filter((d) => d.name.startsWith(SIM_PREFIX) && !keep.has(d.udid) && !keepNames.has(d.name));
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

/** Pids of processes whose environment carries `marker`. Injected for tests. */
export type MarkedPidLister = (marker: string) => Promise<number[]>;

const defaultMarkedPids: MarkedPidLister = (marker) =>
  new Promise((resolve) => {
    // `ps -E` prints each process's environment after its argv, which is the
    // only place a Metro can be told apart from the developer's own `expo
    // start` — the command lines are identical.
    execFile("ps", ["-E", "-ax", "-o", "pid=,command="], { maxBuffer: 8 * 1024 * 1024 }, (_e, stdout) =>
      resolve(
        stdout
          .toString()
          .split("\n")
          .filter((l) => l.includes(`${marker}=1`))
          .map((l) => Number(l.trim().split(/\s+/)[0]))
          .filter((n) => Number.isInteger(n) && n > 0),
      ),
    );
  });

export interface ReaperDeps {
  simctl: Simctl;
  android: AndroidManager;
  kill?: Killer;
  /** Lists pids carrying an env marker (orphan Metro detection). */
  markedPids?: MarkedPidLister;
  killPid?: (pid: number) => void;
  log?: (line: string) => void;
}

export class Reaper {
  private readonly kill: Killer;
  private readonly markedPids: MarkedPidLister;
  private readonly killPid: (pid: number) => void;
  constructor(private readonly d: ReaperDeps) {
    this.kill = d.kill ?? defaultKiller;
    this.markedPids = d.markedPids ?? defaultMarkedPids;
    this.killPid = d.killPid ?? ((pid) => process.kill(pid));
  }

  /**
   * Kill processes left behind by a previous deckhand, identified by an env
   * marker it stamps on its own.
   *
   * Used for two things that are spawned `detached` and so outlive the server:
   * Metro (leaked one per restart until the 8081-8099 range was full) and the
   * NativeScript livesync runners (36 orphans at 418% CPU, measured — which
   * starved the CPU-bound Android emulators while native iOS stayed fine).
   *
   * Identified by the ENV marker, never by argv: the developer's own
   * `expo start` or `ns run` looks identical from the outside, and killing that
   * would be the emulator-hijack mistake in another costume.
   *
   * Called at boot only, before anything is owned, so every marked process
   * found is by definition an orphan. `keepPids` exists for callers that run it
   * later.
   */
  async reapOrphansByMarker(marker: string, keepPids: Iterable<number> = []): Promise<number[]> {
    const keep = new Set(keepPids);
    const pids = await this.markedPids(marker).catch(() => [] as number[]);
    const killed: number[] = [];
    for (const pid of pids) {
      if (keep.has(pid) || pid === process.pid) continue;
      try {
        this.killPid(pid);
        killed.push(pid);
      } catch {
        /* already gone, or not ours to signal */
      }
    }
    return killed;
  }

  /**
   * Shut down, unregister and delete every deckhand-owned simulator/AVD not in
   * `keep`, plus the helper processes bound to them. Never throws: a reap
   * failure must not stop the server from coming up.
   */
  async reap(keep: { udids?: Iterable<string>; avds?: Iterable<string>; names?: Iterable<string> } = {}): Promise<ReapReport> {
    const keepUdids = new Set(keep.udids ?? []);
    const keepAvds = new Set(keep.avds ?? []);
    // A device being created right now has no UDID yet, but its name is already
    // leased. Sparing by name closes the window between `simctl create` and the
    // engine recording what it got back.
    const keepNames = new Set(keep.names ?? []);
    const report: ReapReport = { sims: [], avds: [], keptPooled: [] };

    const sims = orphanSims(await this.list(() => this.d.simctl.listDevices(), []), keepUdids, keepNames);
    for (const sim of sims) {
      // The helper streams from the UDID; kill it before the device disappears.
      //
      // The pattern has to survive the helper's REAL argv, which is
      //   node .../node_modules/serve-sim/dist/serve-sim.js <udid> --port N --host 127.0.0.1
      // `serve-sim <udid>` never matched that — the ".js" sits between them — so
      // this reap had silently killed nothing since it was written, and every
      // detached helper survived every restart. That is what left orphans
      // holding ports across restarts. Anchor on the udid, which is unique and
      // cannot collide, and allow any suffix on the binary name. `[^/]*` keeps
      // the suffix from running across a path separator into an unrelated arg,
      // and the trailing class stops `AAA` from matching a longer `AAA-2`.
      await this.kill(`serve-sim[^/]*[[:space:]]${sim.udid}([[:space:]]|$)`).catch(() => {});
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

    const avds = orphanAvds(await this.list(() => this.d.android.listAvds(), []), new Set([...keepAvds, ...keepNames]));
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
