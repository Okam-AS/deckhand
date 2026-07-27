import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, delimiter } from "node:path";
import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Android toolchain env resolution (auto-mate-learnings.md §5). Fiddly on
// macOS: ANDROID_HOME and JAVA_HOME live in non-obvious places and a broken
// Homebrew java symlink must be rejected. Pure resolvers (given candidate
// probes) are testable; the default probes hit the filesystem.
// ---------------------------------------------------------------------------

export interface AndroidEnv {
  ANDROID_HOME: string;
  JAVA_HOME?: string;
  /** PATH with the SDK tool dirs prepended. */
  PATH: string;
}

/** Pick the first existing directory from candidates. */
export function firstExisting(candidates: string[], exists: (p: string) => boolean = existsSync): string | null {
  for (const c of candidates) if (c && exists(c)) return c;
  return null;
}

export function androidHomeCandidates(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  return [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, join(home, "Library", "Android", "sdk"), join(home, "Android", "Sdk")].filter(
    (x): x is string => !!x,
  );
}

/** Build the PATH additions for a given SDK root (platform-tools, emulator, cmdline-tools). */
export function sdkPathDirs(androidHome: string): string[] {
  return [
    join(androidHome, "platform-tools"),
    join(androidHome, "emulator"),
    join(androidHome, "cmdline-tools", "latest", "bin"),
    join(androidHome, "tools", "bin"),
  ];
}

function resolveJavaHome(exists: (p: string) => boolean = existsSync): string | undefined {
  if (process.env.JAVA_HOME && exists(process.env.JAVA_HOME)) return process.env.JAVA_HOME;
  // macOS: java_home locator. Prefer a modern LTS; reject a broken symlink.
  try {
    const out = execFileSync("/usr/libexec/java_home", ["-v", "21"], { encoding: "utf8" }).trim();
    if (out && exists(out)) return out;
  } catch {
    /* fall through */
  }
  try {
    const out = execFileSync("/usr/libexec/java_home", ["-v", "17"], { encoding: "utf8" }).trim();
    if (out && exists(out)) return out;
  } catch {
    /* fall through */
  }
  return undefined;
}

/** Resolve the full Android env, best-effort. Throws if no SDK root is found. */
export function resolveAndroidEnv(base: NodeJS.ProcessEnv = process.env): AndroidEnv {
  const androidHome = firstExisting(androidHomeCandidates(base));
  if (!androidHome) {
    throw new Error(
      "Android SDK not found — set ANDROID_HOME or install it under ~/Library/Android/sdk (Phase 4 `deckhand init` will guide this)",
    );
  }
  const javaHome = resolveJavaHome();
  const path = [...sdkPathDirs(androidHome), base.PATH ?? ""].filter(Boolean).join(delimiter);
  return { ANDROID_HOME: androidHome, ...(javaHome ? { JAVA_HOME: javaHome } : {}), PATH: path };
}

/** The env object to pass to spawned Android tool processes. */
export function androidProcessEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const a = resolveAndroidEnv(base);
  return { ...base, ANDROID_HOME: a.ANDROID_HOME, ANDROID_SDK_ROOT: a.ANDROID_HOME, ...(a.JAVA_HOME ? { JAVA_HOME: a.JAVA_HOME } : {}), PATH: a.PATH };
}
