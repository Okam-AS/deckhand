import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppType } from "../config.ts";

// ---------------------------------------------------------------------------
// App-type and bundle-id detection. Pure cores (take already-read data) so
// they're unit-testable; thin `*FromDir` wrappers do the filesystem reads.
// ---------------------------------------------------------------------------

export interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  nativescript?: unknown;
}

export interface TypeSignals {
  packageJson: PackageJson | null;
  hasNativescriptConfig: boolean;
  hasIosDir: boolean;
  hasAndroidDir: boolean;
}

function allDeps(pkg: PackageJson | null): Record<string, string> {
  return { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
}

/** Classify an app from filesystem signals. Order matters: NativeScript and Expo
 *  both sit on top of react-native, so check the more specific ones first; "web"
 *  is checked LAST so it can never steal a mobile project that also happens to
 *  pull in Vite for tooling. */
export function detectAppType(s: TypeSignals): AppType | null {
  const deps = allDeps(s.packageJson);
  if (s.hasNativescriptConfig || s.packageJson?.nativescript != null || "nativescript" in deps) {
    return "nativescript";
  }
  if ("expo" in deps) return "expo";
  if ("react-native" in deps || s.hasIosDir || s.hasAndroidDir) return "react-native";
  // Frontend web project: Vite (path-based), or Nuxt/Next (subdomain hosting).
  if (webFrameworkFromDeps(deps)) return "web";
  return null;
}

// --- web framework -----------------------------------------------------------

/**
 * Which web dev server a `web` app runs. `vite` hosts path-based
 * (`--base=/s/<id>/web/`); `nuxt`/`next` can't set their base at runtime without
 * editing the checkout, so they host at the root of a per-share subdomain (see
 * docs/web-wildcard-hosting-plan.md). `static` = a built `dist/` with no dev server.
 */
export type WebFramework = "vite" | "nuxt" | "next" | "static";

function webFrameworkFromDeps(deps: Record<string, string>): WebFramework | null {
  if ("nuxt" in deps || "nuxt-edge" in deps) return "nuxt";
  if ("next" in deps) return "next";
  if ("vite" in deps) return "vite";
  return null;
}

/** Detect the web framework from a package.json's deps, or null. */
export function detectWebFramework(pkg: PackageJson | null): WebFramework | null {
  return webFrameworkFromDeps(allDeps(pkg));
}

/** Detect the web framework from a local checkout dir, or null. */
export function detectWebFrameworkFromDir(dir: string): WebFramework | null {
  return detectWebFramework(readJsonSafe(join(dir, "package.json")) as PackageJson | null);
}

/** Whether a web app hosts path-based (Vite / undetected fallback) or via a subdomain (Nuxt/Next/static). */
export function webHostingMode(framework: WebFramework | null): "path" | "subdomain" {
  return framework === "vite" || framework == null ? "path" : "subdomain";
}

function readJsonSafe(file: string): unknown | null {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function detectAppTypeFromDir(dir: string): AppType | null {
  return detectAppType({
    packageJson: readJsonSafe(join(dir, "package.json")) as PackageJson | null,
    hasNativescriptConfig:
      existsSync(join(dir, "nativescript.config.ts")) || existsSync(join(dir, "nativescript.config.js")),
    hasIosDir: existsSync(join(dir, "ios")),
    hasAndroidDir: existsSync(join(dir, "android")),
  });
}

function parseJsonSafe(text: string | null): unknown | null {
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Detect app type + iOS bundle id from a repo at a ref, using only cheap object-DB
 * reads (WorktreeManager.inspect) — no working-tree checkout. Mirrors the
 * filesystem detectors but sources every signal from git. Returns nulls the
 * caller can turn into "pass type/bundleId explicitly" onboarding hints.
 */
export async function detectFromRepo(
  read: (path: string) => Promise<string | null>,
  hasEntry: (path: string) => Promise<boolean>,
): Promise<{ type: AppType | null; bundleId: string | null }> {
  const [pkgText, hasNsTs, hasNsJs, hasIosDir, hasAndroidDir] = await Promise.all([
    read("package.json"),
    hasEntry("nativescript.config.ts"),
    hasEntry("nativescript.config.js"),
    hasEntry("ios"),
    hasEntry("android"),
  ]);
  const type = detectAppType({
    packageJson: parseJsonSafe(pkgText) as PackageJson | null,
    hasNativescriptConfig: hasNsTs || hasNsJs,
    hasIosDir,
    hasAndroidDir,
  });

  let bundleId: string | null = null;
  if (type === "expo") {
    bundleId = expoBundleId(parseJsonSafe(await read("app.json")) as ExpoConfig | null, "ios");
  } else if (type === "nativescript") {
    const cfg = (await read("nativescript.config.ts")) ?? (await read("nativescript.config.js"));
    if (cfg) bundleId = /id:\s*['"]([^'"]+)['"]/.exec(cfg)?.[1] ?? null;
  }
  return { type, bundleId };
}

// --- bundle id -------------------------------------------------------------

interface ExpoConfig {
  expo?: { ios?: { bundleIdentifier?: string }; android?: { package?: string }; slug?: string };
  ios?: { bundleIdentifier?: string };
  android?: { package?: string };
  slug?: string;
}

/** iOS bundle id / Android package from an Expo app.json (either nested under `expo` or flat). */
export function expoBundleId(config: ExpoConfig | null, platform: "ios" | "android"): string | null {
  if (!config) return null;
  if (platform === "ios") return config.expo?.ios?.bundleIdentifier ?? config.ios?.bundleIdentifier ?? null;
  return config.expo?.android?.package ?? config.android?.package ?? null;
}

/** Expo project slug (used to build the dev-client deep link). */
export function expoSlug(config: ExpoConfig | null): string | null {
  return config?.expo?.slug ?? config?.slug ?? null;
}

interface NativeScriptConfig {
  id?: string;
}

export function nativescriptBundleId(config: NativeScriptConfig | null): string | null {
  return config?.id ?? null;
}

/** Read the iOS bundle id from a checked-out worktree, best-effort. Returns null if unknown. */
export function detectBundleIdFromDir(dir: string, type: AppType, platform: "ios" | "android" = "ios"): string | null {
  if (type === "expo") {
    const appJson = readJsonSafe(join(dir, "app.json")) as ExpoConfig | null;
    return expoBundleId(appJson, platform);
  }
  if (type === "nativescript") {
    // nativescript.config.* is TS/JS; a shallow regex read is good enough for the id.
    for (const name of ["nativescript.config.ts", "nativescript.config.js"]) {
      const p = join(dir, name);
      if (existsSync(p)) {
        const m = /id:\s*['"]([^'"]+)['"]/.exec(readFileSync(p, "utf8"));
        if (m) return m[1]!;
      }
    }
    return null;
  }
  // bare react-native: bundle id lives in Info.plist / build.gradle; deferred
  // (Phase 1 targets Expo). Return null so the caller can require an override.
  return null;
}

/** The Expo dev-client deep link that launches the app against a running Metro. */
export function expoDevClientUrl(slug: string, metroManifestUrl: string): string {
  const url = new URL("exp+" + slug + "://expo-development-client/");
  url.searchParams.set("url", metroManifestUrl);
  url.searchParams.set("disableOnboarding", "1");
  return url.toString();
}
