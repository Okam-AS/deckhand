import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { CommandStep } from "./recipes.ts";

// ---------------------------------------------------------------------------
// Process spawning with a per-stage idle watchdog and process-group kill, so a
// silently-stalled build (SPM resolve, a hung installer) is reaped instead of
// hanging a preview forever. Every child is spawned detached (its own process
// group) so we can kill the whole tree, not just the top process.
// ---------------------------------------------------------------------------

export interface RunResult {
  code: number;
  timedOut: boolean;
  aborted: boolean;
}

export interface RunOptions {
  onLog?: (line: string, stream: "stdout" | "stderr") => void;
  signal?: AbortSignal;
  /** Override the step's idle timeout. */
  idleTimeoutMs?: number;
  /** Grace between SIGTERM and SIGKILL when killing the tree. */
  killGraceMs?: number;
}

function killTree(pid: number, signal: NodeJS.Signals): void {
  try {
    // Negative pid targets the whole process group (child was spawned detached).
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

/** Env marker on every build step, so a restart mid-build can collect the tree. */
export const BUILD_MARKER_ENV = "DECKHAND_BUILD";

/** Run a single build step to completion, killing the tree on idle-timeout or abort. */
/**
 * Pids of build steps this process is running right now.
 *
 * The boot orphan sweep hunts BUILD_MARKER_ENV with an empty keep-set, on the reasoning that
 * "build steps are awaited, so nothing is owned across a boot". That is true of a boot, and
 * false of the sweep, because the sweep runs AFTER the port is bound — deliberately, so a
 * second `deckhand serve` dies on EADDRINUSE before it deletes the running server's devices.
 * An agent's `start_preview` can therefore land in the seconds between, and its brand-new
 * xcodebuild/gradle carries the same marker. Metro and the livesync runners already spare
 * their own via livePids(); builds had no equivalent to spare.
 */
const liveBuildPids = new Set<number>();
export function buildPids(): number[] {
  return [...liveBuildPids];
}

export function runStep(step: CommandStep, opts: RunOptions = {}): Promise<RunResult> {
  const idleMs = opts.idleTimeoutMs ?? step.idleTimeoutMs;
  const killGraceMs = opts.killGraceMs ?? 5_000;
  // Marked like the other detached spawns: a build step is normally awaited and
  // killed on abort, but the abort only fires while the server is alive — a
  // restart mid-`xcodebuild`/`pod install` reparents the tree to launchd, where
  // nothing has ever collected it. Same marker family as Metro and livesync.
  const env = { ...process.env, ...step.env, [BUILD_MARKER_ENV]: "1" };

  const child =
    step.run.kind === "argv"
      ? spawn(step.run.command, step.run.args, { cwd: step.cwd, env, detached: true })
      : spawn("/bin/sh", ["-c", step.run.script], { cwd: step.cwd, env, detached: true });

  return new Promise<RunResult>((resolve) => {
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let idleTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const pid = child.pid;
    if (pid) liveBuildPids.add(pid);

    const hardKill = () => {
      if (pid) killTree(pid, "SIGKILL");
    };
    const softKillThenHard = () => {
      if (pid) killTree(pid, "SIGTERM");
      killTimer = setTimeout(hardKill, killGraceMs);
      killTimer.unref?.();
    };

    const resetIdle = () => {
      if (!idleMs) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        softKillThenHard();
      }, idleMs);
      idleTimer.unref?.();
    };

    const onAbort = () => {
      aborted = true;
      softKillThenHard();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const wireLines = (stream: NodeJS.ReadableStream | null, which: "stdout" | "stderr") => {
      if (!stream) return;
      const rl = createInterface({ input: stream });
      rl.on("line", (line) => {
        resetIdle();
        opts.onLog?.(line, which);
      });
    };
    wireLines(child.stdout, "stdout");
    wireLines(child.stderr, "stderr");
    resetIdle();

    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      // Both settle paths run cleanup, so this is the one place the pid is forgotten. A pid
      // left in the set would spare a DEAD build forever, and — worse — could spare an
      // unrelated process that later reuses the number.
      if (pid) liveBuildPids.delete(pid);
    };

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      opts.onLog?.(`spawn error: ${err.message}`, "stderr");
      resolve({ code: 127, timedOut, aborted });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code: code ?? (timedOut || aborted ? 124 : 1), timedOut, aborted });
    });
  });
}
