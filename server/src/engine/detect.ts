import { execFile } from "node:child_process";
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

/** Dynamic Expo config filenames — evaluated by the Expo CLI, not statically readable. */
const EXPO_DYNAMIC_CONFIG_FILES = ["app.config.ts", "app.config.js", "app.config.cjs", "app.config.mjs"];

/** True if the project defines a dynamic Expo config (app.config.*) only the Expo CLI can resolve. */
function hasExpoDynamicConfig(dir: string): boolean {
  return EXPO_DYNAMIC_CONFIG_FILES.some((f) => existsSync(join(dir, f)));
}

export interface ExpoConfigResolution {
  config: ExpoConfig | null;
  /**
   * Why evaluation failed, when it did. The config may still be non-null (the
   * static read stood in), so this is a diagnostic to carry into the operator's
   * error, not a signal that resolution produced nothing.
   */
  error?: string;
}

/** Evaluator seam: `(dir, env) => resolution`. Injectable so the rules are testable without Expo. */
export type ExpoConfigEvaluator = (dir: string, env: Record<string, string>) => Promise<ExpoConfigResolution>;

/** First couple of non-empty lines of a tool's output, for a one-line error detail. */
function firstLines(text: string, max = 2): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.slice(0, max).join("; ").slice(0, 500);
}

/**
 * Evaluate a project's Expo config by shelling out to the Expo CLI (`expo config --json`),
 * which runs app.config.js/ts and merges app.json. Returns the resolved config (slug/ios/
 * android live at the top level of the CLI's output), or a null config plus the reason when
 * the CLI is unavailable or errors — a silent null leaves the operator with "could not
 * resolve the slug" and no cause. Prefers the project-local expo binary; falls back to
 * `npx --no-install expo`.
 */
export function evaluateExpoConfig(dir: string, env: Record<string, string> = {}): Promise<ExpoConfigResolution> {
  // Only ever the project's own Expo CLI. `npx --no-install expo` looks like a
  // harmless fallback but resolves a *globally* installed legacy expo-cli when the
  // project has none, and that answers with "legacy expo-cli does not support Node
  // +17" instead of the real config error — a misleading diagnostic is worse than a
  // clear absence. Modern Expo is always a project dependency.
  const localBin = join(dir, "node_modules", ".bin", "expo");
  if (!existsSync(localBin)) {
    return Promise.resolve({
      config: null,
      error: "no expo CLI in this project (node_modules/.bin/expo is missing — install dependencies first)",
    });
  }
  return new Promise((resolve) => {
    execFile(
      localBin,
      ["config", "--json"],
      // The same env the build steps and Metro get (procs.ts / metro.ts spread
      // process.env then appEnv). app.config.js routinely branches on APP_ENV or
      // API_BASE_URL, so evaluating under a different env can yield a different
      // config than the build actually produced.
      { cwd: dir, env: { ...process.env, ...env }, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
          return resolve({
            config: null,
            error: killed ? "`expo config --json` timed out after 60s" : firstLines(String(stderr) || err.message),
          });
        }
        const parsed = parseJsonSafe(stdout.toString()) as ExpoConfig | null;
        if (!parsed) return resolve({ config: null, error: "`expo config --json` did not return JSON" });
        resolve({ config: { slug: parsed.slug, ios: parsed.ios, android: parsed.android } });
      },
    );
  });
}

/**
 * Resolve a project's effective Expo config from a directory.
 *
 * With no dynamic `app.config.*`, static app.json is the whole truth and nothing is
 * spawned. When a dynamic config *does* exist it is always evaluated, even if app.json
 * looks complete: app.config.js receives app.json as its input and may override any
 * field, including the slug, so trusting a complete-looking app.json can hand back a
 * slug the project doesn't actually use. Evaluation costs one ~0.7s spawn and only
 * happens for projects that have a dynamic config at all.
 *
 * Falls back to the static read when evaluation fails, carrying the reason so the
 * caller can report it. `evaluate` is injectable for tests.
 */
export async function resolveExpoConfigFromDir(
  dir: string,
  env: Record<string, string> = {},
  evaluate: ExpoConfigEvaluator = evaluateExpoConfig,
): Promise<ExpoConfigResolution> {
  const staticCfg = readJsonSafe(join(dir, "app.json")) as ExpoConfig | null;
  if (!hasExpoDynamicConfig(dir)) return { config: staticCfg };
  const evaluated = await evaluate(dir, env);
  if (evaluated.config) return evaluated;
  return { config: staticCfg, error: evaluated.error };
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
