import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// Long-lived dev-process lifecycle for local previews (the NativeScript
// livesync runner). Mirrors MetroManager's shape: one process per key, spawned
// detached so the whole tree can be killed, output tailed into the device's
// build log. `restart` re-spawns with the remembered spec — that is what the
// restart_preview tool and the viewer's refresh button ultimately call.
// ---------------------------------------------------------------------------

export interface DevRunSpec {
  /** One process per app+platform: `${appId}:${platform}`. */
  key: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  onLog?: (line: string) => void;
}

interface RunningDev {
  spec: DevRunSpec;
  child: ChildProcess;
  exited: boolean;
  exitCode: number | null;
}

export type SpawnFn = typeof nodeSpawn;

/**
 * Env marker stamped on every livesync tree deckhand spawns, so a LATER
 * deckhand can recognise and collect its own.
 *
 * These are spawned detached and tracked only in an in-memory Map, so every
 * server restart reparented the whole tree to launchd and forgot it. Measured
 * on the machine today: 36 orphans burning 418% CPU with the load average at
 * 17.9 on an 18-core box. That starves the Android emulators specifically —
 * they are full-system ARM emulation under QEMU and CPU-bound, while iOS
 * simulators are native and nearly free — which is exactly the "Android lags,
 * iOS is fine" asymmetry, and it is nowhere near the streaming code.
 */
export const DEV_MARKER_ENV = "DECKHAND_DEV_RUN";

/** How long a SIGTERM gets before the group is killed outright. */
const KILL_ESCALATION_MS = 5_000;

export class DevProcessManager {
  private readonly procs = new Map<string, RunningDev>();
  constructor(private readonly spawnFn: SpawnFn = nodeSpawn) {}

  /** Start (replacing any previous) dev process for a key. */
  start(spec: DevRunSpec): void {
    this.stop(spec.key);
    const child = this.spawnFn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env, [DEV_MARKER_ENV]: "1" },
      detached: true,
    });
    const rec: RunningDev = { spec, child, exited: false, exitCode: null };
    const wire = (stream: NodeJS.ReadableStream | null) => {
      if (!stream || !spec.onLog) return;
      createInterface({ input: stream }).on("line", (l) => spec.onLog!(l));
    };
    wire(child.stdout);
    wire(child.stderr);
    child.on("error", (err) => {
      rec.exited = true;
      rec.exitCode = 127;
      spec.onLog?.(`spawn error: ${err.message}`);
    });
    child.on("close", (code) => {
      rec.exited = true;
      rec.exitCode = code;
    });
    this.procs.set(spec.key, rec);
  }

  isAlive(key: string): boolean {
    const rec = this.procs.get(key);
    return Boolean(rec && !rec.exited);
  }

  exitCode(key: string): number | null {
    return this.procs.get(key)?.exitCode ?? null;
  }

  /** Kill and re-spawn with the remembered spec. False when the key is unknown. */
  restart(key: string): boolean {
    const rec = this.procs.get(key);
    if (!rec) return false;
    this.start(rec.spec);
    return true;
  }

  /** Kill the process tree for a key (no-op when unknown/already gone). */
  stop(key: string): void {
    const rec = this.procs.get(key);
    this.procs.delete(key);
    if (!rec || rec.exited || !rec.child.pid) return;
    const pid = rec.child.pid;
    const signal = (sig: NodeJS.Signals) => {
      try {
        process.kill(-pid, sig);
      } catch {
        try {
          rec.child.kill(sig);
        } catch {
          // already gone
        }
      }
    };
    signal("SIGTERM");
    // SIGTERM was sent and never followed up, so a livesync runner that ignores
    // it — which is how 36 of them survived, the oldest for nearly five hours —
    // simply stayed. Escalate, and don't hold the process open waiting.
    const t = setTimeout(() => {
      if (rec.exited) return;
      signal("SIGKILL");
    }, KILL_ESCALATION_MS);
    t.unref?.();
  }

  stopAll(): void {
    for (const key of [...this.procs.keys()]) this.stop(key);
  }
}
