import { execFile } from "node:child_process";
import { VERIFY_MARKER_ENV } from "../engine/reaper.ts";
import { buildPids } from "../engine/procs.ts";
import { pidAlive } from "./lock.ts";

/** Pids in `ps -E` output stamped by a verify run whose own process is gone. */
export function verifyOrphansIn(psOut: string, alive: (pid: number) => boolean = pidAlive): number[] {
  const re = new RegExp(`\\b${VERIFY_MARKER_ENV}=(\\d+)\\b`);
  const out: number[] = [];
  for (const line of psOut.split("\n")) {
    const owner = re.exec(line);
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (!owner || !Number.isInteger(pid) || pid <= 0) continue;
    const ownerPid = Number(owner[1]);
    if (ownerPid !== process.pid && !alive(ownerPid)) out.push(pid);
  }
  return out;
}

function kill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}

/** Metro and build trees a crashed or killed verify left behind. */
export function reapVerifyOrphans(): Promise<number[]> {
  return new Promise((resolve) => {
    execFile("ps", ["-E", "-ax", "-o", "pid=,command="], { maxBuffer: 16 * 1024 * 1024 }, (_e, stdout) => {
      const pids = verifyOrphansIn(String(stdout ?? ""));
      for (const pid of pids) kill(pid, "SIGKILL");
      resolve(pids);
    });
  });
}

/** Every build step this process started is its own process group; take each down whole. */
export function killBuildGroups(signal: NodeJS.Signals = "SIGKILL"): void {
  for (const pid of buildPids()) kill(-pid, signal);
}
