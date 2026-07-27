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

export class DevProcessManager {
  private readonly procs = new Map<string, RunningDev>();
  constructor(private readonly spawnFn: SpawnFn = nodeSpawn) {}

  /** Start (replacing any previous) dev process for a key. */
  start(spec: DevRunSpec): void {
    this.stop(spec.key);
    const child = this.spawnFn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
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
    try {
      process.kill(-rec.child.pid, "SIGTERM");
    } catch {
      try {
        rec.child.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
  }

  stopAll(): void {
    for (const key of [...this.procs.keys()]) this.stop(key);
  }
}
