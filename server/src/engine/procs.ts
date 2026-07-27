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

/** Run a single build step to completion, killing the tree on idle-timeout or abort. */
export function runStep(step: CommandStep, opts: RunOptions = {}): Promise<RunResult> {
  const idleMs = opts.idleTimeoutMs ?? step.idleTimeoutMs;
  const killGraceMs = opts.killGraceMs ?? 5_000;
  const env = { ...process.env, ...step.env };

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
