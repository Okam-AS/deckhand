import { execFile } from "node:child_process";
import type { Simctl, SimDevice } from "../devices/ios.ts";
import { AVD_PREFIX, type AndroidManager } from "../devices/android.ts";

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

/** What a caller still owns and must not lose: udids, AVD names, and leased device names. */
export interface KeepHandles {
  udids?: Iterable<string>;
  avds?: Iterable<string>;
  names?: Iterable<string>;
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
   * Used for the things spawned `detached` that outlive the server: Metro
   * (leaked one per restart until the 8081-8099 range was full), the
   * NativeScript livesync runners (36 orphans at 418% CPU, measured — which
   * starved the CPU-bound Android emulators while native iOS stayed fine), and
   * build steps (xcodebuild/gradle reparented to launchd by a restart).
   *
   * Identified by the ENV marker, never by argv: the developer's own
   * `expo start` or `ns run` looks identical from the outside, and killing that
   * would be the emulator-hijack mistake in another costume.
   *
   * `keepPids` is NOT optional in practice, and deleting it at the call sites
   * kills live work. The one caller (`PreviewEngine.reapOrphans`) runs at boot
   * but AFTER the HTTP port is bound — deliberately, because the bind is what
   * proves only one server is running: a second `deckhand serve` has to die on
   * EADDRINUSE before it can delete the running server's devices. That ordering
   * leaves seconds in which an agent's `start_preview` lands, and its
   * brand-new Metro / livesync / xcodebuild carries the very marker this hunts
   * for. So a marked process is an orphan only once the caller's live pids are
   * excluded. → `preview.test.ts` "spares its own live processes when reaping
   * orphans by marker" (Metro and livesync; the build keep-set is not asserted
   * there).
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
   *
   * Pass `keep` as a FUNCTION. It is re-read immediately before each destructive
   * call, so a device leased while the sweep is running is spared; a plain object
   * is a snapshot and cannot spare anything that appears after this returns to
   * the event loop.
   */
  async reap(keep: KeepHandles | (() => KeepHandles) = {}): Promise<ReapReport> {
    // Read through the caller's thunk at every decision point, never once at
    // entry. This sweep runs AFTER the HTTP port is bound (see the header), and
    // it awaits a pkill, a shutdown and a delete per orphan — so a start_preview
    // that lands mid-sweep leases names a snapshot taken here can never hold,
    // and the AVD pass below reads its list after ALL of that. A by-value keep
    // set made that unfixable from the caller's side; a caller that still passes
    // a plain object gets exactly the old behaviour, which is the honest signal
    // that it has not closed the window. → the two "DURING the sweep" tests in
    // reaper.test.ts.
    const read = typeof keep === "function" ? keep : () => keep;
    // A device being created right now has no UDID yet, but its name is already
    // leased. Sparing by name closes the window between `simctl create` and the
    // engine recording what it got back.
    const sets = () => {
      const k = read();
      return { udids: new Set(k.udids ?? []), avds: new Set(k.avds ?? []), names: new Set(k.names ?? []) };
    };
    const report: ReapReport = { sims: [], avds: [], keptPooled: [] };

    const first = sets();
    const sims = orphanSims(await this.list(() => this.d.simctl.listDevices(), []), first.udids, first.names);
    for (const sim of sims) {
      const now = sets();
      if (now.udids.has(sim.udid) || now.names.has(sim.name)) continue;
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

    const afterSims = sets();
    const avds = orphanAvds(
      await this.list(() => this.d.android.listAvds(), []),
      new Set([...afterSims.avds, ...afterSims.names]),
    );
    for (const avd of avds) {
      const now = sets();
      if (now.avds.has(avd) || now.names.has(avd)) continue;
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
