import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pidAlive } from "./lock.ts";

export type FingerprintRunner = (dir: string, env: Record<string, string>) => Promise<string | null>;

/**
 * `fingerprint fingerprint:generate` from the project's own @expo/fingerprint; null when it is not
 * there or fails. There is deliberately no weaker fallback: a key that misses a native input hands a
 * stale binary to a changed app, so no fingerprint means no cache.
 */
export const expoFingerprint: FingerprintRunner = (dir, env) =>
  new Promise((resolve) => {
    execFile(
      "npx",
      ["--no-install", "fingerprint", "fingerprint:generate", "--platform", "ios"],
      { cwd: dir, env: { ...process.env, ...env }, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          const hash = (JSON.parse(String(stdout)) as { hash?: unknown }).hash;
          resolve(typeof hash === "string" && hash ? hash : null);
        } catch {
          resolve(null);
        }
      },
    );
  });

export const xcodeVersion = (): Promise<string> =>
  new Promise((resolve) =>
    execFile("xcodebuild", ["-version"], { timeout: 30_000 }, (err, out) => resolve(err ? "unknown" : String(out).trim().replace(/\s+/g, " "))),
  );

export interface CacheKeyInput {
  appId: string;
  bundleId: string;
  fingerprint: string;
  xcode: string;
  runtime: string;
}

export function buildCacheKey(input: CacheKeyInput): string {
  return createHash("sha256")
    .update(JSON.stringify(["ios-simulator", input.appId, input.bundleId, input.fingerprint, input.xcode, input.runtime]))
    .digest("hex")
    .slice(0, 32);
}

export const MAX_CACHED_BUILDS = 6;

export interface CacheHit {
  app: string;
  /** Call once the app is installed; until then the prune leaves the entry alone. */
  done: () => void;
}

export class BuildCache {
  constructor(
    private readonly dir: string,
    private readonly max = MAX_CACHED_BUILDS,
  ) {}

  lookup(key: string): CacheHit | null {
    const entry = join(this.dir, key);
    if (!existsSync(entry)) return null;
    // Marked in use before it is read, so a prune in another run cannot remove it between the two.
    const mark = join(this.dir, `.inuse-${key}-${process.pid}-${randomBytes(4).toString("hex")}`);
    writeFileSync(mark, "");
    const app = existsSync(entry) ? readdirSync(entry).find((f) => f.endsWith(".app")) : undefined;
    if (!app) {
      rmSync(mark, { force: true });
      return null;
    }
    const now = new Date();
    utimesSync(entry, now, now);
    return { app: join(entry, app), done: () => rmSync(mark, { force: true }) };
  }

  /** A copy lands under a private name and is renamed into place; if another run stored the key first, theirs stands. */
  store(key: string, appPath: string, meta: Record<string, unknown>): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = join(this.dir, `.tmp-${key}-${process.pid}-${randomBytes(4).toString("hex")}`);
    mkdirSync(tmp);
    try {
      cpSync(appPath, join(tmp, basename(appPath)), { recursive: true, verbatimSymlinks: true });
      writeFileSync(join(tmp, "meta.json"), JSON.stringify({ ...meta, storedAt: new Date().toISOString() }, null, 2));
      try {
        renameSync(tmp, join(this.dir, key));
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOTEMPTY" && code !== "EEXIST") throw e;
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    this.prune(key);
  }

  private inUse(): Set<string> {
    const keys = new Set<string>();
    for (const f of readdirSync(this.dir)) {
      const m = /^\.inuse-(.+)-(\d+)-[0-9a-f]{8}$/.exec(f);
      if (!m) continue;
      if (pidAlive(Number(m[2]))) keys.add(m[1]!);
      else rmSync(join(this.dir, f), { force: true });
    }
    return keys;
  }

  private prune(keep: string): void {
    const busy = this.inUse();
    const entries = readdirSync(this.dir)
      .filter((f) => !f.startsWith(".") && f !== keep)
      .map((f) => ({ f, t: statSync(join(this.dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of entries.slice(Math.max(0, this.max - 1))) {
      if (!busy.has(f)) rmSync(join(this.dir, f), { recursive: true, force: true });
    }
  }
}
