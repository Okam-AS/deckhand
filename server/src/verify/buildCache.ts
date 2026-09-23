import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface NativeFingerprint {
  hash: string;
  /** `expo` when @expo/fingerprint answered; `files` when the key fell back to hashing native inputs. */
  source: "expo" | "files";
}

export type FingerprintRunner = (dir: string, env: Record<string, string>) => Promise<string | null>;

/** `fingerprint fingerprint:generate` from the project's own @expo/fingerprint; null when it is not there or fails. */
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

const NATIVE_INPUTS = ["package.json", "app.json", "app.config.js", "app.config.cjs", "app.config.mjs", "app.config.ts", "eas.json", "Podfile.lock", "ios/Podfile.lock"];
const LOCKFILES = ["pnpm-lock.yaml", "yarn.lock", "package-lock.json", "bun.lock", "bun.lockb"];

/** Every native input a JS-only change leaves alone: the app's config files and the nearest lockfile up to the repo root. */
export function fileFingerprint(dir: string): string {
  const h = createHash("sha256");
  for (const f of NATIVE_INPUTS) {
    const p = join(dir, f);
    if (existsSync(p)) h.update(`${f}\0`).update(readFileSync(p)).update("\0");
  }
  for (let d = dir; ; d = dirname(d)) {
    const lock = LOCKFILES.find((f) => existsSync(join(d, f)));
    if (lock) {
      h.update(`lock:${lock}\0`).update(readFileSync(join(d, lock)));
      break;
    }
    if (existsSync(join(d, ".git")) || dirname(d) === d) break;
  }
  return h.digest("hex");
}

export async function nativeFingerprint(
  dir: string,
  env: Record<string, string>,
  runner: FingerprintRunner = expoFingerprint,
): Promise<NativeFingerprint> {
  const hash = await runner(dir, env);
  return hash ? { hash, source: "expo" } : { hash: fileFingerprint(dir), source: "files" };
}

/** Directory-safe cache key: the fingerprint plus everything else that makes a binary not interchangeable. */
export function buildCacheKey(input: { appId: string; bundleId: string; platform: "ios-simulator"; fingerprint: NativeFingerprint }): string {
  return createHash("sha256")
    .update(JSON.stringify([input.appId, input.bundleId, input.platform, input.fingerprint.source, input.fingerprint.hash]))
    .digest("hex")
    .slice(0, 32);
}

export const MAX_CACHED_BUILDS = 6;

export class BuildCache {
  constructor(
    private readonly dir: string,
    private readonly max = MAX_CACHED_BUILDS,
  ) {}

  /** The cached `.app` for a key, or null. A hit refreshes its age so the prune keeps it. */
  lookup(key: string): string | null {
    const entry = join(this.dir, key);
    const app = existsSync(entry) ? readdirSync(entry).find((f) => f.endsWith(".app")) : undefined;
    if (!app) return null;
    const now = new Date();
    utimesSync(entry, now, now);
    return join(entry, app);
  }

  /** Copy a built `.app` in under `key`, atomically: a half-copied bundle is never a hit. */
  store(key: string, appPath: string, meta: Record<string, unknown>): string {
    mkdirSync(this.dir, { recursive: true });
    const tmp = join(this.dir, `.tmp-${key}-${process.pid}`);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp);
    cpSync(appPath, join(tmp, basename(appPath)), { recursive: true, verbatimSymlinks: true });
    writeFileSync(join(tmp, "meta.json"), JSON.stringify({ ...meta, storedAt: new Date().toISOString() }, null, 2));
    const entry = join(this.dir, key);
    rmSync(entry, { recursive: true, force: true });
    renameSync(tmp, entry);
    this.prune(key);
    return join(entry, basename(appPath));
  }

  private prune(keep: string): void {
    const entries = readdirSync(this.dir)
      .filter((f) => !f.startsWith(".") && f !== keep)
      .map((f) => ({ f, t: statSync(join(this.dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of entries.slice(Math.max(0, this.max - 1))) rmSync(join(this.dir, f), { recursive: true, force: true });
  }
}
