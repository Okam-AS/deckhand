import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { paths, resolveUnderHome } from "./paths.ts";

// ---------------------------------------------------------------------------
// Schemas (PLAN.md §5). Zod validates on load so a malformed config fails
// loudly at startup with a path-qualified message, never mid-preview.
// ---------------------------------------------------------------------------

const portRange = z
  .tuple([z.number().int().min(1024).max(65535), z.number().int().min(1024).max(65535)])
  .refine(([lo, hi]) => lo <= hi, "helperPortRange must be [low, high] with low <= high");

export const configSchema = z.object({
  hostname: z.string().min(1),
  // Optional host on which to serve subdomain-web previews (Nuxt/Next/static) — a
  // domain the INSTALLER controls, whose TLS cert covers it (a first-level host
  // under your zone works on Cloudflare's free plan; a wildcard needs ACM).
  // Nothing here is deckhand-specific; each install sets its own. One subdomain-web
  // preview is served at a time on this host. Omit to keep subdomain-web loopback-only.
  webHost: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).default(4300),
  streaming: z
    .object({
      serveSim: z
        .object({
          version: z.string().min(1),
          codec: z.enum(["auto", "mjpeg"]).default("auto"),
          helperPortRange: portRange.default([3100, 3199]),
        })
        .strict(),
    })
    .strict(),
  // Either auth mode may be present (or neither, when a PAT is pasted later via
  // the one-time setup URL — PLAN §6). The App suits multi-org installs; a
  // fine-grained PAT is the low-setup path agent-led onboarding walks users to.
  githubApp: z
    .object({
      appId: z.number().int().positive(),
      privateKeyPath: z.string().min(1),
    })
    .strict()
    .optional(),
  githubPat: z
    .object({ path: z.string().min(1).default("github-pat") })
    .strict()
    .optional(),
  // Fall back to the deckhand user's `gh` CLI session when neither a PAT nor a
  // GitHub App is configured — makes a dev-Mac install (deckhand on the machine
  // you code on) work with zero credential setup. Tradeoff in PLAN §11.4: a gh
  // session token usually carries write scopes, so on ambient credentials the
  // read-only guarantee is behavioral, not capability-bounded.
  githubAmbient: z.boolean().default(true),
  allowPublicRepos: z.boolean().default(false),
  // HMAC key for signing share unlock cookies (PIN gate). Omit and deckhand
  // auto-generates + persists one under ~/.deckhand/share-secret on first boot.
  shareSecret: z.string().min(1).optional(),
  // Agent-driven testing backend (PLAN §8, describe/ui). deckhand drives SimDeck
  // control-only (REST /action + /accessibility-tree) on the same booted device;
  // it keeps serve-sim/adb-screencap for the human video. Loopback only. Omit and
  // the fields below default; the daemon is contacted lazily on the first
  // describe/ui, so a non-testing install pays nothing.
  simdeck: z
    .object({
      bin: z.string().min(1).default("simdeck"),
      port: z.number().int().min(1).max(65535).default(4310),
      // Best-effort start the local SimDeck service if it isn't already up. On
      // failure, describe/ui return an actionable "install/start SimDeck" error.
      autostart: z.boolean().default(true),
    })
    .strict()
    .optional(),
  limits: z
    .object({
      maxDevicesPerPreview: z.number().int().positive().default(4),
      maxTotalDevices: z.number().int().positive().default(6),
      // Auto-teardown. A preview nobody is watching still costs a booted
      // simulator (~1.5 GB) and, on Android, a QEMU process burning a core —
      // and previews were only ever stopped by an explicit stop_preview, so
      // they piled up. 0 disables either sweep.
      /** Stop a ready/running preview after this many minutes with no viewer traffic. */
      idleMinutes: z.number().int().nonnegative().default(45),
      /** Tear down a failed preview's devices after this many minutes (a Rebuild grace window). */
      failedGraceMinutes: z.number().int().nonnegative().default(15),
      /**
       * Give up on a preview that has made no progress at all for this long. A
       * build that is still moving updates its phase and never trips this; a
       * wedged one (a dev server that never binds, a hung emulator) would
       * otherwise hold its devices forever, since it is neither ready nor failed.
       */
      stuckMinutes: z.number().int().nonnegative().default(90),
      /**
       * Reuse simulators/AVDs across previews (named by device shape, kept on
       * disk between runs) instead of creating and deleting one per preview.
       * Set false to go back to a throwaway device per preview.
       */
      reuseDevices: z.boolean().default(true),
      disk: z
        .object({
          watch: z.number().positive().default(50),
          pressure: z.number().positive().default(35),
          critical: z.number().positive().default(20),
        })
        .strict()
        .default({ watch: 50, pressure: 35, critical: 20 }),
    })
    .strict()
    .default({
      maxDevicesPerPreview: 4,
      maxTotalDevices: 6,
      idleMinutes: 45,
      failedGraceMinutes: 15,
      stuckMinutes: 90,
      reuseDevices: true,
      disk: { watch: 50, pressure: 35, critical: 20 },
    }),
});

export type Config = z.infer<typeof configSchema>;

// "web" is a frontend web project (a Vite dev server). Unlike the mobile types
// it has no device/simulator: the preview IS the dev server, reverse-proxied
// through the share URL. It is local-only (see the refine below).
export const appTypeSchema = z.enum(["expo", "react-native", "nativescript", "web"]);
export type AppType = z.infer<typeof appTypeSchema>;

export const appSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "app id must be kebab-case (a-z, 0-9, -)"),
    repo: z.string().min(1).optional(),
    /** Local source dir on this machine (dev mode): previews build in place, no worktree. */
    path: z.string().min(1).startsWith("/", "path must be absolute").optional(),
    type: appTypeSchema,
    defaultBranch: z.string().min(1).default("main"),
    allowForkPRs: z.boolean().default(false),
    bundleId: z.string().min(1).optional(),
    /** web only: the npm script that starts the dev server (default "dev"). */
    devScript: z.string().min(1).optional(),
    // Migration lineage: this app is the TARGET of a migration from another
    // registered app (the source/oracle). Purely descriptive — it lets the viewer
    // show the two apps side by side and read the target's parity ledger. The
    // referenced id must exist (checked across the whole apps file, see appsSchema).
    migratesFrom: z.string().min(1).optional(),
    env: z.record(z.string(), z.string()).default({}),
  })
  .strict()
  .refine((a) => a.repo || a.path, { message: "an app needs a repo, a local path, or both" })
  .refine((a) => a.type !== "web" || Boolean(a.path), {
    message: "a web app needs a local path — web previews are local dev servers, not git builds",
  });

export type App = z.infer<typeof appSchema>;

export const appsSchema = z
  .object({ apps: z.array(appSchema).default([]) })
  // Cross-app checks that a single appSchema can't do: a `migratesFrom` must name
  // another registered app (and never itself), so the pairing always resolves.
  .superRefine((file, ctx) => {
    const ids = new Set(file.apps.map((a) => a.id));
    file.apps.forEach((a, i) => {
      if (a.migratesFrom == null) return;
      if (a.migratesFrom === a.id) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["apps", i, "migratesFrom"], message: "an app can't migrate from itself" });
      } else if (!ids.has(a.migratesFrom)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["apps", i, "migratesFrom"],
          message: `migratesFrom "${a.migratesFrom}" is not a registered app id`,
        });
      }
    });
  });
export type AppsFile = z.infer<typeof appsSchema>;

export const roleSchema = z.enum(["admin", "member"]);
export type Role = z.infer<typeof roleSchema>;

export const tokenSchema = z
  .object({
    name: z.string().min(1),
    role: roleSchema,
    owners: z.array(z.string().min(1)).optional(),
    token: z.string().regex(/^[0-9a-f]{64}$/, "token must be 64 lowercase hex chars"),
  })
  .strict();

export type TokenEntry = z.infer<typeof tokenSchema>;

export const tokensSchema = z.object({ tokens: z.array(tokenSchema).default([]) });
export type TokensFile = z.infer<typeof tokensSchema>;

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

/** Thrown when a config file is missing or invalid, with an actionable message. */
export class ConfigError extends Error {
  constructor(
    public readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = "ConfigError";
  }
}

function readYaml(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new ConfigError(file, "not found — run `deckhand init` on the mini");
    }
    throw new ConfigError(file, err.message);
  }
  try {
    return parseYaml(text);
  } catch (e) {
    throw new ConfigError(file, `invalid YAML: ${(e as Error).message}`);
  }
}

function parseWith<S extends z.ZodTypeAny>(schema: S, file: string, raw: unknown): z.output<S> {
  const result = schema.safeParse(raw ?? {});
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first && first.path.length ? first.path.join(".") : "(root)";
    throw new ConfigError(file, `${where}: ${first?.message ?? "invalid"}`);
  }
  return result.data;
}

export function loadConfig(file = paths.config()): Config {
  return parseWith(configSchema, file, readYaml(file));
}

export function loadApps(file = paths.apps()): App[] {
  return parseWith(appsSchema, file, readYaml(file)).apps;
}

export function loadTokens(file = paths.tokens()): TokenEntry[] {
  return parseWith(tokensSchema, file, readYaml(file)).tokens;
}

/** The absolute path to the GitHub App private key, or null if the App isn't configured. */
export function githubPrivateKeyPath(config: Config): string | null {
  return config.githubApp ? resolveUnderHome(config.githubApp.privateKeyPath) : null;
}

/**
 * The absolute path to the fine-grained PAT file. Defaults to `github-pat`
 * under the home dir even when `githubPat` is absent from config, so the
 * one-time setup URL (PLAN §6) can drop a PAT there and have it take effect
 * without a config edit.
 */
export function githubPatPath(config: Config): string {
  return resolveUnderHome(config.githubPat?.path ?? "github-pat");
}

/**
 * The repo owner (org/user) and name from an app's `repo` string. Handles
 * `github.com/owner/name`, `https://github.com/owner/name(.git)`,
 * `git@github.com:owner/name(.git)`, and bare `owner/name`.
 */
export function parseRepo(repo: string): { host: string; owner: string; name: string } {
  let s = repo.trim().replace(/\.git$/, "");
  s = s.replace(/^https?:\/\//, "").replace(/^git@/, "");
  // Normalize the scp-style colon separator to a slash: host:owner/name.
  s = s.replace(":", "/");
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new ConfigError("apps.yaml", `repo "${repo}" must be owner/name or host/owner/name`);
  }
  const name = parts[parts.length - 1]!;
  const owner = parts[parts.length - 2]!;
  const host = parts.length >= 3 ? parts[0]! : "github.com";
  return { host, owner, name };
}

/** The repo owner (org/user) portion of an app's `repo` string, e.g. `ainfrastructure`. */
export function repoOwner(repo: string): string {
  return parseRepo(repo).owner;
}

/**
 * The HMAC key for signing share unlock cookies. Prefers `config.shareSecret`;
 * otherwise reads (or, on first boot, generates + persists 0600) a random key at
 * `~/.deckhand/share-secret`, so unlock cookies survive restarts without a config edit.
 */
export function resolveShareSecret(config: Config): string {
  if (config.shareSecret) return config.shareSecret;
  const file = paths.shareSecret();
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    // not yet created
  }
  const secret = randomBytes(32).toString("hex");
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, secret + "\n", { mode: 0o600 });
  } catch {
    // if we can't persist, use the in-memory secret (cookies won't survive restart)
  }
  return secret;
}

/**
 * The base URL a human should open (viewer, setup page). In a real install that's
 * the public tunnel host over https; on a loopback hostname (local dev/testing
 * with no tunnel) it's the actual http loopback address so links are reachable.
 */
export function publicBaseUrl(config: Config): string {
  const h = config.hostname;
  if (!h || h === "localhost" || h === "::1" || /^127\./.test(h)) return `http://127.0.0.1:${config.port}`;
  return `https://${h}`;
}
