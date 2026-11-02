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

/** `/usr/libexec/java_home -F -v <major>`: without -F a version with no match silently
 * answers the default JDK (e.g. 26, which breaks AGP's jlink), so "-v 21" is not a check. */
export function locateJdk(major: string): string | undefined {
  try {
    return execFileSync("/usr/libexec/java_home", ["-F", "-v", major], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function resolveJavaHome(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
  locate: (major: string) => string | undefined = locateJdk,
): string | undefined {
  if (env.JAVA_HOME && exists(env.JAVA_HOME)) return env.JAVA_HOME;
  // macOS: java_home locator. Prefer a modern LTS; reject a broken symlink.
  for (const major of ["21", "17"]) {
    const out = locate(major);
    if (out && exists(out)) return out;
  }
  return undefined;
}

/** Resolve the full Android env, best-effort. Throws if no SDK root is found. */
export function resolveAndroidEnv(base: NodeJS.ProcessEnv = process.env): AndroidEnv {
  const androidHome = firstExisting(androidHomeCandidates(base));
  if (!androidHome) {
    throw new Error(
      "Android SDK not found — set ANDROID_HOME or install it under ~/Library/Android/sdk (`brew install --cask android-commandlinetools`; `deckhand doctor` names what is still missing)",
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
