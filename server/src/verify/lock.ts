import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

/** A lock directory with no owner file this old was left by a crash between mkdir and the write. */
const ORPHAN_MS = 30_000;

function ageMs(dir: string): number {
  try {
    return Date.now() - statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function owner(dir: string): { pid: number; token: string } | null {
  try {
    const [pid, token] = readFileSync(`${dir}/owner`, "utf8").trim().split(" ");
    return { pid: Number(pid), token: token ?? "" };
  } catch {
    return null;
  }
}

/**
 * A lock is a directory: `mkdir` is atomic, so exactly one creator wins. A dead holder's lock is
 * renamed aside before anyone may create a new one, so two processes that both saw it stale cannot
 * both take it: only one rename succeeds. Release removes the lock only while it still carries the
 * releaser's token.
 */
export function tryLock(dir: string): (() => void) | null {
  const token = randomBytes(8).toString("hex");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const held = owner(dir);
      if (held ? pidAlive(held.pid) : ageMs(dir) < ORPHAN_MS) return null;
      const aside = `${dir}.stale-${token}`;
      try {
        renameSync(dir, aside);
      } catch {
        return null;
      }
      if (owner(aside)?.token !== held?.token) {
        try {
          renameSync(aside, dir);
        } catch {
          // Someone created a new lock meanwhile; leave the displaced one aside rather than delete a live holder's record.
        }
        return null;
      }
      rmSync(aside, { recursive: true, force: true });
      continue;
    }
    writeFileSync(`${dir}/owner`, `${process.pid} ${token}`);
    return () => {
      if (owner(dir)?.token === token) rmSync(dir, { recursive: true, force: true });
    };
  }
  return null;
}

export async function waitForLock(
  dir: string,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => number = Date.now,
): Promise<(() => void) | null> {
  const deadline = now() + timeoutMs;
  for (;;) {
    const release = tryLock(dir);
    if (release || now() >= deadline) return release;
    await sleep(1000);
  }
}
