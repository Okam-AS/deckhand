import { appEnvironments, LAUNCH_ARG_KEY_RE, LAUNCH_ARG_VALUE_RE, type App, type AppEnvironment } from "../config.ts";

// ---------------------------------------------------------------------------
// Which backend a preview's app runs against. An app that declares
// environments always runs one of them — its default unless the caller named
// another — and never silently a different one. An app that declares none has
// an unknown environment, and nothing here invents one.
// ---------------------------------------------------------------------------

export interface ResolvedEnvironment {
  name: string;
  env: AppEnvironment;
  /** False when the app's default was taken because the caller named none. */
  explicit: boolean;
}

/** How the environment reached the app on one device. */
export type EnvironmentSource = "eas-profile" | "launch-args" | "build-default";

export interface EnvironmentReport {
  name: string | null;
  source: EnvironmentSource | "unknown";
  /** True once the app log matched the environment's marker; "no-marker" when it declares none. */
  verified: boolean | "no-marker";
  note?: string;
}

export class EnvironmentError extends Error {
  constructor(
    message: string,
    readonly hint: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "EnvironmentError";
  }
}

export function resolveEnvironment(app: App, requested?: string): ResolvedEnvironment | null {
  const envs = appEnvironments(app);
  if (!envs) {
    if (requested) {
      throw new EnvironmentError(
        `app "${app.id}" declares no environments, so "${requested}" cannot be chosen`,
        "omit environment (the app then runs whatever its build defaults to), or declare environments for the app in apps.yaml on the deckhand machine",
        "no_environments",
      );
    }
    return null;
  }
  const name = requested ?? envs.default;
  const env = envs.byName.get(name);
  if (!env) {
    throw new EnvironmentError(
      `app "${app.id}" has no environment "${name}"`,
      `its environments are ${[...envs.byName.keys()].join(", ")} (default ${envs.default}); omit environment for the default`,
      "unknown_environment",
    );
  }
  return { name, env, explicit: requested !== undefined };
}

/** Re-checked at use: these strings reach a device-side shell line on Android. */
export function assertLaunchArgs(args: Record<string, string>): Record<string, string> {
  for (const [k, v] of Object.entries(args)) {
    if (!LAUNCH_ARG_KEY_RE.test(k) || !LAUNCH_ARG_VALUE_RE.test(v)) throw new EnvironmentError(`refusing launch argument ${JSON.stringify(k)}`, "launch argument keys and values are letters, digits and _ . : / @ + -", "bad_launch_args");
  }
  return args;
}

/** `am start` string extras: `-e KEY value …`. */
export function androidExtras(args: Record<string, string>): string[] {
  return Object.entries(assertLaunchArgs(args)).flatMap(([k, v]) => ["-e", k, v]);
}

/**
 * iOS process arguments, `-KEY value …` — the argument domain NSUserDefaults reads, and the form
 * both `simctl launch` and `devicectl device process launch` pass through after the bundle id.
 */
export function iosLaunchArgs(args: Record<string, string>): string[] {
  return Object.entries(assertLaunchArgs(args)).flatMap(([k, v]) => [`-${k}`, v]);
}

export function markerSeen(marker: string | undefined, lines: readonly string[]): boolean {
  if (!marker) return false;
  const re = new RegExp(marker);
  return lines.some((l) => re.test(l));
}

/** The weakest claim across a preview's devices: verified only when every device is. */
export function combineReports(reports: EnvironmentReport[]): EnvironmentReport | null {
  if (!reports.length) return null;
  const [first] = reports;
  const same = <K extends keyof EnvironmentReport>(k: K) => reports.every((r) => r[k] === first![k]);
  const verified: EnvironmentReport["verified"] = reports.every((r) => r.verified === "no-marker") ? "no-marker" : reports.every((r) => r.verified === true) ? true : false;
  const notes = [...new Set(reports.flatMap((r) => (r.note ? [r.note] : [])))];
  return {
    name: first!.name,
    source: same("source") ? first!.source : "build-default",
    verified,
    ...(notes.length ? { note: notes.join(" ") } : {}),
  };
}
