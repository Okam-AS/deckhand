import { rmSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { App, AppType, Config } from "../config.ts";
import { appSchema, ConfigError, parseRepo, publicBaseUrl } from "../config.ts";
import type { Principal } from "../auth.ts";
import { canAccessApp, isAdmin, visibleApps } from "../auth.ts";
import type { PreviewEngine, CompareReference } from "../engine/preview.ts";
import { PreviewError } from "../engine/preview.ts";
import { parseRefSpec, refDescription, RefError } from "../engine/worktree.ts";
import { detectWebFrameworkFromDir, webHostingMode } from "../engine/detect.ts";
import { isValidPin } from "../share/shares.ts";
import { isAuthProblem } from "../github/credentials.ts";
import type { SetupStore } from "../setup/setupStore.ts";
import { paths } from "../paths.ts";
import type { AuditLog } from "../audit.ts";
import { summarizeArgs } from "../audit.ts";
import { SimDeckUnavailableError } from "../testing/simdeck.ts";
import { SimDeckActionError, type UiAction } from "../testing/control.ts";

// ---------------------------------------------------------------------------
// MCP tool registrations (PLAN §6). Bound per request to the authenticated
// principal so role + owner-scope are enforced server-side. Every tool returns
// a structured result — never a bare throw — so Claude can relay an actionable
// message. Every call is audited.
// ---------------------------------------------------------------------------

export interface ToolContext {
  engine: PreviewEngine;
  /** The live, shared apps array — add_app/remove_app mutate it in place. */
  apps: App[];
  config: Config;
  principal: Principal;
  audit: AuditLog;
  /** Persist the apps array to apps.yaml after a mutation (no-op in tests). */
  persistApps?: (apps: App[]) => void;
  /** Mints one-time setup URLs for credential onboarding. */
  setup?: SetupStore;
}

function ok(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...data }) }] };
}

function fail(code: string, message: string, hint?: string): CallToolResult {
  return failWith(code, message, hint ? { hint } : {});
}

/** Like `fail` but attaches extra structured fields (e.g. `setupUrl`) to the error. */
function failWith(code: string, message: string, extra: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code, message, ...extra } }) }],
    isError: true,
  };
}

/**
 * Where deckhand itself runs. Onboarding responses carry this so a co-located
 * agent (compare with your own `hostname`) can take the local-checkout shortcut
 * — register an existing working copy with the CLI — instead of walking the
 * GitHub credential flow (PLAN §6).
 */
function deckhandHost(): { hostname: string; user: string } {
  let user: string;
  try {
    user = userInfo().username;
  } catch {
    user = process.env.USER ?? "unknown";
  }
  return { hostname: hostname(), user };
}

/** The "local checkout is the default" onboarding step (PLAN §6). */
function localCheckoutHint(host: { hostname: string; user: string }, repo: string | null, appId: string | null): string {
  const what = repo ? `of ${repo}` : "of the project";
  return (
    `The DEFAULT is a local preview of a working checkout — no GitHub access needed, and edits livesync to the simulator. ` +
    `If you can run commands on the deckhand machine (host "${host.hostname}", user "${host.user}" — compare with \`hostname\`), ` +
    `find the checkout ${what} on it (the user's own working copy — the cwd if you're already in it, else ask where it is), ` +
    `verify it with \`git -C <dir> remote get-url origin\`, then register it with \`deckhand app add ${appId ?? "<id>"} --path <abs-dir>\`. ` +
    `When the user is working in a project and asks to preview it, this — not git — is what they mean.`
  );
}

function toFail(e: unknown): CallToolResult {
  if (e instanceof SimDeckUnavailableError) return fail("simdeck_unavailable", e.message, e.hint);
  if (e instanceof SimDeckActionError) return fail("ui_error", e.message);
  if (e instanceof PreviewError) return fail("preview_error", e.message, e.hint);
  if (e instanceof RefError) return fail("invalid_ref", e.message);
  return fail("internal_error", e instanceof Error ? e.message : String(e));
}

// Element selector for `ui`/`describe` — prefer id/text/label; the positional
// @e# refs SimDeck prints are unstable across snapshots.
const selectorSchema = z.object({
  id: z.string().optional(),
  text: z.string().optional(),
  label: z.string().optional(),
  value: z.string().optional(),
  index: z.number().int().nonnegative().optional(),
  regex: z.boolean().optional(),
});

// One UI action for the `ui` tool. Coordinates are normalized 0..1 (top-left origin).
const uiActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tap"), x: z.number(), y: z.number() }),
  z.object({ type: z.literal("tapElement"), selector: selectorSchema, waitTimeoutMs: z.number().int().positive().optional() }),
  z.object({ type: z.literal("type"), text: z.string() }),
  z.object({ type: z.literal("key"), name: z.string() }),
  z.object({ type: z.literal("button"), name: z.string() }),
  z.object({ type: z.literal("home") }),
  z.object({
    type: z.literal("swipe"),
    startX: z.number(), startY: z.number(), endX: z.number(), endY: z.number(),
    durationMs: z.number().int().positive().optional(),
  }),
  z.object({ type: z.literal("gesture"), preset: z.enum(["scroll-up", "scroll-down", "scroll-left", "scroll-right"]) }),
  z.object({ type: z.literal("openUrl"), url: z.string() }),
  z.object({ type: z.literal("waitFor"), selector: selectorSchema, timeoutMs: z.number().int().positive().optional() }),
  z.object({ type: z.literal("assert"), selector: selectorSchema }),
  z.object({ type: z.literal("query"), selector: selectorSchema }),
]);

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const { engine, apps, config, principal, audit } = ctx;
  const persistApps = ctx.persistApps ?? (() => {});

  const audited = (tool: string, args: unknown, run: () => CallToolResult | Promise<CallToolResult>) => {
    const record = (result: "ok" | "error", error?: string) =>
      audit.record({ actor: principal.name, tool, args: summarizeArgs(args), result, ...(error ? { error } : {}) });
    return Promise.resolve()
      .then(run)
      .then((r) => {
        record(r.isError ? "error" : "ok");
        return r;
      })
      .catch((e) => {
        record("error", e instanceof Error ? e.message : String(e));
        return toFail(e);
      });
  };

  /** Resolve an app the principal may access, or a failure result. */
  const resolveApp = (id: string): App | CallToolResult => {
    const app = apps.find((a) => a.id === id);
    if (!app) return fail("unknown_app", `no app named "${id}"`, "call list_apps to see available apps");
    if (!canAccessApp(principal, app)) {
      return fail("forbidden", `you don't have access to app "${id}"`, "this token is scoped to specific repo owners");
    }
    return app;
  };
  const isResult = (x: App | CallToolResult): x is CallToolResult => "content" in x;

  const previewOwnedByPrincipal = (previewId: string): CallToolResult | null => {
    const appId = engine.appIdFor(previewId);
    if (!appId) return fail("unknown_preview", `no active preview "${previewId}"`);
    const app = apps.find((a) => a.id === appId);
    if (app && !canAccessApp(principal, app)) return fail("forbidden", `you don't have access to preview "${previewId}"`);
    return null;
  };

  server.registerTool(
    "list_apps",
    {
      title: "List apps",
      description:
        "List the apps registered on this machine that you can preview. Apps come from a GitHub repo (git previews of a branch/PR), a local folder on this machine (dev-mode previews of the working copy, no pushing needed), or both.",
      inputSchema: {},
    },
    () =>
      audited("list_apps", {}, () => {
        const visible = visibleApps(principal, apps);
        return ok({
          apps: visible.map((a) => ({
            id: a.id,
            repo: a.repo ?? null,
            path: a.path ?? null,
            source: a.path ? (a.repo ? "github+local" : "local") : "github",
            type: a.type,
            defaultBranch: a.defaultBranch,
          })),
          // Empty-state onboarding (PLAN §6): tell the agent exactly what to ask
          // the user next. Relay `nextStep` to the user verbatim. Local checkout
          // beats every credential flow, so it is always the first suggestion.
          ...(visible.length === 0
            ? {
                onboarding: {
                  state: "no_apps",
                  host: deckhandHost(),
                  nextStep: isAdmin(principal)
                    ? `No apps are registered yet. ${localCheckoutHint(deckhandHost(), null, null)} ` +
                      "If there is NO local checkout on this machine, DON'T silently fall back to git — ask the user to choose: (a) give you the path to a local checkout (still local mode — preferred), or (b) preview from git, where deckhand fetches a pushed branch/PR from GitHub itself (the repo need not be on the machine, but it builds what's PUSHED, not local edits). A GitHub credential/PAT is NEVER needed for local mode — don't ask about connecting GitHub unless the user picks git; only then does add_app deal with read access (and only if no ambient credential already works). Explain that choice, then act: a path → `deckhand app add <id> --path <dir>`; git → call add_app with the repo. If a chosen git repo is private and no credential works, add_app returns a one-time setup link — relay it; never ask for the token in chat."
                    : "No apps are registered yet, and this token can only run previews, not add apps. Ask the user to have an admin register an app (an admin token can call add_app).",
                },
              }
            : {}),
        });
      }),
  );

  server.registerTool(
    "list_devices",
    {
      title: "List devices",
      description: "List available iOS simulator runtimes and models, plus current capacity.",
      inputSchema: {},
    },
    () => audited("list_devices", {}, async () => ok(await engine.listDevices())),
  );

  /** The daily-loop guidance attached to start/restart results (agent-led contract, PLAN §6). */
  const loopNextStep = (source: "git" | "local", url: string, ref?: string): string =>
    source === "local"
      ? `Give the user this link NOW: ${url} — it's already live (it shows build progress while the sim boots) and is stable for this app across restarts; relay it before any other work, don't wait for ready. Then poll preview_status for readiness. While the preview runs, file saves livesync to the simulator automatically, so after editing code there is nothing to call — just tell the user the change is on the sim. Only call restart_preview after native-level changes (new plugins, Podfile/gradle edits) or if the app looks stuck.`
      : `Give the user this link NOW: ${url} — it's already live (it shows build progress) and is stable for this app; relay it before any other work, don't wait for ready. Then poll preview_status for readiness. After pushing new commits to ${ref ?? "the branch"}, call restart_preview to rebuild the same simulators at the new tip — the link stays the same.`;

  /** Resolve a preview id from previewId or app args (status/restart accept either). */
  const resolvePreviewId = (args: { previewId?: string; app?: string }): string | CallToolResult => {
    if (args.previewId) return args.previewId;
    if (!args.app) return fail("bad_request", "pass previewId or app");
    const resolved = resolveApp(args.app);
    if (isResult(resolved)) return resolved;
    const id = engine.previewIdForApp(resolved.id);
    if (!id) {
      return fail(
        "no_preview",
        `no running preview for app "${args.app}"`,
        "call start_preview to boot one — the app keeps its stable viewer URL",
      );
    }
    return id;
  };

  server.registerTool(
    "start_preview",
    {
      title: "Start a preview",
      description:
        "Returns the live viewer link INSTANTLY — surface it to the user first, before any other work (it's live the moment the preview starts and shows build progress while devices boot); then poll preview_status for readiness. Starts a preview and returns its shareable viewer link — or, if an equivalent preview is already running, returns THAT one (idempotent: each app keeps a stable URL, so this is also the way to answer \"what's the link?\"). With ref/pr it builds that git ref; with neither, an app with a local path previews its local working copy (dev mode — file saves then livesync to the simulator automatically, no pushing needed), and a repo-only app builds its default branch. IMPORTANT: before every call you MUST ask the user whether to protect the link with a PIN or make it public, and pass that as `share` (this call fails until you do). If they choose a PIN, ask for a 4–6 digit code — never repeat that code back in chat.",
      inputSchema: {
        app: z.string().describe("app id from list_apps"),
        ref: z.string().optional().describe("branch name or commit SHA; omit for local dev mode or the default branch"),
        pr: z.number().int().positive().optional().describe("pull request number; omit if using ref"),
        devices: z
          .array(
            z.object({
              platform: z.enum(["ios", "android"]).default("ios"),
              runtime: z.string().optional().describe('e.g. "26" or "iOS 26"'),
              model: z.string().optional().describe('e.g. "iPhone 16 Pro"'),
            }),
          )
          .min(1)
          .optional()
          .describe("devices to boot (default: one iOS simulator)"),
        share: z
          .object({
            access: z.enum(["public", "pin"]).describe("REQUIRED — ask the user first: protect with a PIN, or public?"),
            pin: z.string().optional().describe("4–6 digit numeric PIN the user chose (required when access is 'pin')"),
          })
          .optional()
          .describe("access control — you must ask the user PIN-or-public before calling; omitting this fails the call"),
      },
    },
    (args) =>
      audited("start_preview", args, () => {
        const resolved = resolveApp(args.app);
        if (isResult(resolved)) return resolved;
        if (args.ref && args.pr) return fail("bad_request", "pass either ref or pr, not both");

        // Web apps are device-less local dev servers: no ref/pr, no simulator.
        const isWeb = resolved.type === "web";
        if (isWeb && (args.ref || args.pr)) {
          return fail(
            "web_local_only",
            `app "${resolved.id}" is a web app — it previews its local files, not a git ref`,
            "call start_preview again without ref/pr",
          );
        }
        if (isWeb && !resolved.path) {
          return fail(
            "no_local_path",
            `web app "${resolved.id}" has no local path configured`,
            `register it on this machine: deckhand app add ${resolved.id} --path <dir> --type web`,
          );
        }

        const devices = isWeb
          ? [{ platform: "web" as const }]
          : (args.devices ?? [{ platform: "ios" as const }]).map((d) => ({
              platform: d.platform ?? ("ios" as const),
              runtime: d.runtime,
              model: d.model,
            }));

        const wantsGit = Boolean(args.ref || args.pr);
        const source = isWeb || (!wantsGit && resolved.path) ? ("local" as const) : ("git" as const);
        let spec;
        if (source === "git") {
          if (!resolved.repo) {
            return fail(
              "local_only_app",
              `app "${resolved.id}" has no GitHub repo — it can only preview its local files`,
              "call start_preview again without ref/pr to preview the local working copy",
            );
          }
          spec = parseRefSpec({ ref: args.ref ?? (args.pr ? undefined : resolved.defaultBranch), pr: args.pr });
        }

        // Requirement: the agent must ask the user PIN-or-public before any link is made.
        if (!args.share) {
          return fail(
            "needs_access_choice",
            "Before creating a share link you must ask the user: protect it with a PIN, or make it public?",
            'Ask the user, then call again with share: { access: "pin", pin: "<4-6 digits>" } or share: { access: "public" }.',
          );
        }
        const access = args.share.access;
        if (access === "pin" && !isValidPin(args.share.pin ?? "")) {
          return fail(
            "needs_pin",
            "A PIN-protected share needs a 4–6 digit numeric PIN.",
            "Ask the user for a 4–6 digit code, then call again with share.pin set. Don't repeat the PIN in chat.",
          );
        }

        const result = engine.startPreview({
          app: resolved,
          source,
          spec,
          devices,
          access: access === "pin" ? "password" : "public",
        });
        // Apply the per-app PIN (also covers alreadyRunning: findReusable ignores access).
        engine.setAppPin(resolved.id, access === "pin" ? args.share.pin! : null);
        const protectionNote =
          access === "pin"
            ? " This link is PIN-protected: viewers must enter the PIN the user set (don't repeat the PIN in chat)."
            : " This link is public — anyone with the URL can open it.";
        // A subdomain-hosted web framework (Nuxt/Next/static) needs a configured
        // webHost to be publicly reachable; without one the URL is loopback-only.
        const webFw = isWeb && resolved.path ? detectWebFrameworkFromDir(resolved.path) : null;
        const webHostWarning =
          isWeb && webHostingMode(webFw) === "subdomain" && !config.webHost
            ? ` ⚠ This is a ${webFw} app, which serves at a subdomain root — but this machine has no webHost configured, so the link is loopback-only, not public. To share it, an admin sets webHost (+ a DNS route/ingress) on the deckhand machine (run \`deckhand doctor\` for status). Vite web apps don't need this.`
            : "";
        return ok({
          ...result,
          nextStep:
            (result.alreadyRunning
            ? `An equivalent preview is already running — same viewer link: ${result.url}. ` +
              (isWeb
                ? "Saving files hot-reloads the page automatically; call restart_preview only after dependency/config changes."
                : source === "local"
                  ? "File saves livesync to it automatically; call restart_preview only after native-level changes."
                  : "After pushing new commits, call restart_preview to rebuild it at the new tip.")
            : isWeb
              ? `Give the user this link NOW: ${result.url} (stable for this app) — relay it before any other work; then poll preview_status for readiness. It's a live web dev server — saving files hot-reloads the page automatically, so after editing there is nothing to call. Use restart_preview only after dependency/config changes (new packages, vite.config edits) or if the server looks stuck. Deckhand runs this working copy in place and only reads/runs it — never commit or push any local changes deckhand caused (dev-server caches, a stray lockfile); its git state is not yours to write.${webHostWarning}`
              : loopNextStep(source, result.url, args.ref ?? resolved.defaultBranch)) + protectionNote,
        });
      }),
  );

  /** Boot an app in its natural mode: local dev (livesync) when a working copy is registered, else git default-branch. */
  const bootWorkingApp = (app: App, devices: { platform: "ios" | "android"; runtime?: string; model?: string }[], access: "public" | "password") => {
    const source = app.path ? ("local" as const) : ("git" as const);
    const spec = source === "git" ? parseRefSpec({ ref: app.defaultBranch }) : undefined;
    return engine.startPreview({ app, source, spec, devices, access });
  };

  const shortHash = (s: string): string => "cmp-" + createHash("sha1").update(s).digest("hex").slice(0, 12);

  // Resolve a compare `against` into a booted, PUBLIC reference preview (so the paired
  // pane needs no cross-share unlock). Four kinds: another registered app, the working
  // app at another git ref, an arbitrary local worktree, or an arbitrary repo@ref.
  const bootReference = (
    workingApp: App,
    against: { app?: string; ref?: string; worktree?: string; repo?: string } | undefined,
    devices: { platform: "ios" | "android"; runtime?: string; model?: string }[],
  ): { reference: CompareReference; previewId: string } | CallToolResult => {
    const a = against ?? (workingApp.migratesFrom ? { app: workingApp.migratesFrom } : undefined);
    if (!a || (!a.app && !a.ref && !a.worktree && !a.repo)) {
      return fail(
        "needs_reference",
        "compare needs an `against` reference to build the working app against",
        "pass against: { app } | { ref } | { worktree } | { repo, ref } — or register the working app with migratesFrom for a default.",
      );
    }
    // The build config the reference boots from, plus a stable key identifying it.
    let base: App;
    let source: "local" | "git";
    let spec;
    let key: string;
    if (a.app) {
      const resolved = resolveApp(a.app);
      if (isResult(resolved)) return resolved;
      base = resolved;
      source = base.path ? "local" : "git";
      spec = source === "git" ? parseRefSpec({ ref: base.defaultBranch }) : undefined;
      key = `app:${resolved.id}`;
    } else if (a.worktree) {
      if (!a.worktree.startsWith("/")) return fail("bad_request", "against.worktree must be an absolute path");
      base = { ...workingApp, path: a.worktree, repo: undefined };
      source = "local";
      key = `worktree:${a.worktree}`;
    } else if (a.repo) {
      if (!a.ref) {
        return fail(
          "needs_ref",
          `against.repo "${a.repo}" needs a ref — that repo's default branch is unknown`,
          'pass against: { repo, ref } — e.g. ref: "main".',
        );
      }
      base = { ...workingApp, repo: a.repo, path: undefined };
      source = "git";
      spec = parseRefSpec({ ref: a.ref });
      key = `repo:${a.repo}@${a.ref}`;
    } else {
      // against.ref → the working app's build config at another git ref (needs a repo).
      if (!workingApp.repo) {
        return fail(
          "local_only_app",
          `app "${workingApp.id}" has no repo — an against.ref needs a git repo`,
          "use against: { worktree: <abs path> } to compare against another local checkout instead",
        );
      }
      base = workingApp;
      source = "git";
      spec = parseRefSpec({ ref: a.ref! });
      key = `ref:${workingApp.id}@${a.ref!}`;
    }
    if (base.type === "web") return fail("web_not_supported", "compare pairing is for mobile apps (iOS/Android), not web previews");
    // The reference ALWAYS boots under a synthetic, distinct app id. Sharing the
    // working app's id (a same-app against.ref, or against.app pointing at itself)
    // would collide on the per-app stable shareId (self-pairing) and per-app PIN,
    // and a public reference boot would wipe a registered app's persisted PIN. A
    // fresh id keyed by `key` stays stable across restarts (so compare is idempotent).
    const refApp: App = { ...base, id: shortHash(key), migratesFrom: undefined };
    const result = engine.startPreview({ app: refApp, source, spec, devices, access: "public" });
    engine.setAppPin(refApp.id, null);
    const ref = source === "local" ? "local" : refDescription(spec!);
    return { reference: { shareId: result.shareId, repo: base.repo ?? refApp.id, ref }, previewId: result.previewId };
  };

  server.registerTool(
    "compare_start",
    {
      title: "Start a compare",
      description:
        "Returns the live viewer URL instantly — surface it to the user FIRST, then do the work. Pairs the WORKING app against a reference (`against`) and shows them side by side (working vs reference), with an optional per-item parity checklist you maintain. `against` is one of: { app } another registered app · { ref } the same working app at another branch/PR/SHA · { worktree } another local checkout (absolute path) · { repo, ref } an arbitrary repo. Omit `against` to use the working app's registered migratesFrom. `items` seeds the checklist (call compare_set as you compare each; omit for a plain split screen). The checklist is LOCAL to this session (in-memory) — the project plan lives in your task tracker (e.g. Linear), not here. As with start_preview you MUST ask the user PIN-or-public for the working link first; the reference pane is public. Deckhand only runs and observes both apps.",
      inputSchema: {
        app: z.string().describe("the WORKING app id (the one you're building/comparing)"),
        against: z
          .object({
            app: z.string().optional().describe("another registered app id to compare against"),
            ref: z.string().optional().describe("a branch/PR/SHA of the WORKING app (or, with repo, of that repo)"),
            worktree: z.string().optional().describe("absolute path to another local checkout"),
            repo: z.string().optional().describe("an arbitrary repo (owner/name or url); pair with ref"),
          })
          .optional()
          .describe("what to compare the working app against; omit to use its registered migratesFrom"),
        items: z.array(z.string()).optional().describe("checklist item names to seed (flows/screens); update with compare_set"),
        devices: z
          .array(
            z.object({
              platform: z.enum(["ios", "android"]).default("ios"),
              runtime: z.string().optional().describe('e.g. "26" or "iOS 26"'),
              model: z.string().optional().describe('e.g. "iPhone 16 Pro"'),
            }),
          )
          .min(1)
          .optional()
          .describe("device types to boot for EACH pane (default: one iOS simulator each)"),
        share: z
          .object({
            access: z.enum(["public", "pin"]).describe("REQUIRED — ask the user first: protect the working link with a PIN, or public?"),
            pin: z.string().optional().describe("4–6 digit numeric PIN the user chose (required when access is 'pin')"),
          })
          .optional()
          .describe("access control for the working link — ask the user PIN-or-public before calling; omitting this fails the call"),
      },
    },
    (args) =>
      audited("compare_start", args, () => {
        const working = resolveApp(args.app);
        if (isResult(working)) return working;
        if (working.type === "web") return fail("web_not_supported", "compare pairing is for mobile apps (iOS/Android), not web previews");
        if (!args.share) {
          return fail(
            "needs_access_choice",
            "Before creating the compare link you must ask the user: protect the working link with a PIN, or make it public?",
            'Ask the user, then call again with share: { access: "pin", pin: "<4-6 digits>" } or share: { access: "public" }.',
          );
        }
        const access = args.share.access;
        if (access === "pin" && !isValidPin(args.share.pin ?? "")) {
          return fail("needs_pin", "A PIN-protected share needs a 4–6 digit numeric PIN.", "Ask the user for a 4–6 digit code, then call again with share.pin set. Don't repeat the PIN in chat.");
        }

        const devices = (args.devices ?? [{ platform: "ios" as const }]).map((d) => ({
          platform: d.platform ?? ("ios" as const),
          runtime: d.runtime,
          model: d.model,
        }));

        // Reference first (public oracle), then the working app with the chosen access.
        const refBoot = bootReference(working, args.against, devices);
        if ("content" in refBoot) return refBoot;
        const result = bootWorkingApp(working, devices, access === "pin" ? "password" : "public");
        engine.setAppPin(working.id, access === "pin" ? args.share.pin! : null);
        const counts = engine.startCompare(result.previewId, refBoot.reference, args.items ?? [], refBoot.previewId);

        const protectionNote =
          access === "pin"
            ? " The working link is PIN-protected (don't repeat the PIN in chat); the reference pane is public."
            : " The link is public — anyone with the URL can open it.";
        return ok({
          ...result,
          reference: refBoot.reference,
          counts,
          nextStep:
            `The viewer is already live at ${result.url} (it shows build progress while both panes boot) — give the user this link NOW, before any other work; do not wait for ready. ` +
            `It shows the working app and the reference side by side. Drive either pane with describe/ui/screenshot, compare each item yourself, and record the verdict with compare_set (matches / adjusted / regression). The checklist is local to this session — keep the project plan in your task tracker.` +
            protectionNote,
        });
      }),
  );

  server.registerTool(
    "compare_set",
    {
      title: "Set a compare verdict",
      description:
        "Record the parity verdict for one compare item after you've compared it in the viewer. verdict: matches (identical to the reference) · adjusted (deliberately different and fine — a redesign, not a bug) · regression (unwanted divergence to fix) · doing (in progress) · pending. An unknown item name is appended. Returns the updated counts. Call this as you finish each item. Pass previewId or the working app id.",
      inputSchema: {
        previewId: z.string().optional().describe("from compare_start; or pass app instead"),
        app: z.string().optional().describe("the working app id — targets its running compare"),
        item: z.string().describe("the item name (flow/screen)"),
        verdict: z.enum(["pending", "doing", "matches", "adjusted", "regression"]),
        note: z.string().optional().describe("optional short note, e.g. why it's adjusted"),
      },
    },
    (args) =>
      audited("compare_set", args, () => {
        const id = resolvePreviewId(args);
        if (typeof id !== "string") return id;
        const denied = previewOwnedByPrincipal(id);
        if (denied) return denied;
        const counts = engine.setCompareItem(id, { item: args.item, verdict: args.verdict, note: args.note });
        return ok({ counts });
      }),
  );

  server.registerTool(
    "compare_status",
    {
      title: "Get the compare checklist",
      description:
        "Return the current compare session — the reference, every item with its verdict/note, and the counts. Call this at the START of a compare session to pull the full checklist into context and see what's left. Pass previewId or the working app id.",
      inputSchema: {
        previewId: z.string().optional().describe("from compare_start; or pass app instead"),
        app: z.string().optional().describe("the working app id — targets its running compare"),
      },
    },
    (args) =>
      audited("compare_status", args, () => {
        const id = resolvePreviewId(args);
        if (typeof id !== "string") return id;
        const denied = previewOwnedByPrincipal(id);
        if (denied) return denied;
        const status = engine.compareStatus(id);
        if (!status) return fail("no_compare", "no compare session on this preview", "start one with compare_start");
        return ok(status);
      }),
  );

  server.registerTool(
    "restart_preview",
    {
      title: "Restart a preview",
      description:
        "Rebuild a running preview in place: same simulators, same viewer URL. Local (dev-mode) previews re-run the build against the current files — needed after native-level changes (new plugins, Podfile/gradle edits) or when the app is stuck; ordinary code edits livesync automatically and do NOT need this. Git previews fetch the ref's latest commit and rebuild — call it after pushing. Pass previewId, or just the app id.",
      inputSchema: {
        previewId: z.string().optional().describe("from start_preview; or pass app instead"),
        app: z.string().optional().describe("app id — restarts its running preview"),
      },
    },
    (args) =>
      audited("restart_preview", args, () => {
        const id = resolvePreviewId(args);
        if (typeof id !== "string") return id;
        const denied = previewOwnedByPrincipal(id);
        if (denied) return denied;
        const result = engine.restartPreview(id);
        return ok({
          ...result,
          nextStep: `Rebuilding on the same simulators. Poll preview_status until ready — the viewer link is unchanged: ${result.url}`,
        });
      }),
  );

  server.registerTool(
    "preview_status",
    {
      title: "Preview status",
      description:
        "Report per-device build/boot phases and the viewer URL once ready. Pass previewId, or just the app id to find its running preview (e.g. to answer \"what's the link to the sim?\").",
      inputSchema: {
        previewId: z.string().optional().describe("from start_preview; or pass app instead"),
        app: z.string().optional().describe("app id — reports on its running preview"),
      },
    },
    (args) =>
      audited("preview_status", args, () => {
        const id = resolvePreviewId(args);
        if (typeof id !== "string") return id;
        const denied = previewOwnedByPrincipal(id);
        if (denied) return denied;
        const status = engine.getStatus(id);
        if (!status) return fail("unknown_preview", `no active preview "${id}"`);
        return ok({
          status,
          ...(status.ready
            ? {
                testingHint:
                  "To test local changes: read the diff to pick flows, drive the app with `describe`+`ui`, and report progress with start_test_run/update_test_run/finish_test_run (shown live in the viewer). Then write the report in chat.",
              }
            : {}),
        });
      }),
  );

  server.registerTool(
    "stop_preview",
    {
      title: "Stop a preview",
      description:
        "Tear down a preview's simulators (and its git worktree; a local app's source folder is never touched). In the daily loop you normally leave the preview running so its URL stays live — stop only to free capacity or end a session for good.",
      inputSchema: { previewId: z.string() },
    },
    (args) =>
      audited("stop_preview", args, async () => {
        const denied = previewOwnedByPrincipal(args.previewId);
        if (denied) return denied;
        const stopped = await engine.stopPreview(args.previewId);
        return stopped ? ok({ stopped: true }) : fail("unknown_preview", `no active preview "${args.previewId}"`);
      }),
  );

  server.registerTool(
    "screenshot",
    {
      title: "Screenshot a device",
      description: "Capture a PNG screenshot of a device in a preview (so you can verify what's on screen).",
      inputSchema: { previewId: z.string(), deviceId: z.string() },
    },
    (args) =>
      audited("screenshot", args, async () => {
        const denied = previewOwnedByPrincipal(args.previewId);
        if (denied) return denied;
        const png = await engine.screenshot(args.previewId, args.deviceId);
        return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
      }),
  );

  server.registerTool(
    "describe",
    {
      title: "Describe the screen (accessibility tree)",
      description:
        "Read the on-screen UI as a structured accessibility tree — the agent's eyes for driving the app. Use interactiveOnly for a compact, actionable list, and drive actions by #id/text/label selectors (the positional @e# refs are unstable across snapshots). Pair with `ui` to act and `screenshot` to eyeball. In a test loop, describe once to understand a new screen — then verify with `ui` waitFor/assert, not repeated full dumps. Needs the SimDeck testing backend on the deckhand machine.",
      inputSchema: {
        previewId: z.string(),
        deviceId: z.string(),
        source: z
          .string()
          .optional()
          .describe("auto (default), native-ax, nativescript, react-native, flutter, uikit, android-uiautomator"),
        interactiveOnly: z.boolean().optional().describe("prune to tappable elements + ancestors (recommended in a loop)"),
        maxDepth: z.number().int().positive().optional(),
      },
    },
    (args) =>
      audited("describe", args, async () => {
        const denied = previewOwnedByPrincipal(args.previewId);
        if (denied) return denied;
        const tree = await engine.describe(args.previewId, args.deviceId, {
          source: args.source,
          interactiveOnly: args.interactiveOnly,
          maxDepth: args.maxDepth,
        });
        return ok({ describe: tree });
      }),
  );

  server.registerTool(
    "ui",
    {
      title: "Drive the device UI",
      description:
        "Perform ONE UI action to drive the app end-to-end: tap {x,y} (0..1 normalized), tapElement {selector}, type {text}, key {name: enter|backspace|tab|escape|up|down|left|right}, button {name}, home, swipe, gesture {preset: scroll-up|scroll-down|scroll-left|scroll-right}, openUrl {url}, and the verifiers waitFor/assert/query {selector}. Prefer tapElement + waitFor/assert over raw coordinates. Note: iOS can't HID-type non-US characters — non-ASCII text is pasted via the clipboard (focus the field first). Needs the SimDeck testing backend.",
      inputSchema: {
        previewId: z.string(),
        deviceId: z.string(),
        action: uiActionSchema,
      },
    },
    (args) =>
      audited("ui", args, async () => {
        const denied = previewOwnedByPrincipal(args.previewId);
        if (denied) return denied;
        const result = await engine.ui(args.previewId, args.deviceId, args.action as UiAction);
        return ok({ result });
      }),
  );

  server.registerTool(
    "logs",
    {
      title: "Read a device's logs",
      description:
        "Read deckhand's captured logs for a device in a preview — the fastest way to find out WHY a build failed, why a screen came up wrong, or why the viewer will not show a picture. `build` (default) carries the build/install step output plus the NativeScript livesync and web dev-server streams: compile errors, install failures, and dev-server crashes surface here. **`stream` is the one to read when the viewer is stuck on \"Connecting…\" or shows a black screen while the device says ready** — it traces the whole browser→helper path: helper attach + first-frame probes, every proxied stream request with its upstream status and byte count, WebSocket upgrade accepts/refusals with the exact reason, and what the viewer's own player reports (fallback to MJPEG, decode failure, giving up). Pair with `describe`/`screenshot` when the app is up but misbehaving. Pass previewId or app id; deviceId defaults to the first/only device. Returns the last `tailLines` lines (500 are retained per source).",
      inputSchema: {
        previewId: z.string().optional().describe("from start_preview; or pass app instead"),
        app: z.string().optional().describe("app id — reads its running preview"),
        deviceId: z.string().optional().describe("defaults to the first/only device in the preview"),
        source: z
          .enum(["build", "metro", "app", "stream"])
          .optional()
          .describe(
            "build (default): build/install + livesync + web dev-server output. stream: the browser→helper streaming trace — read this for a viewer that never shows a picture. metro/app runtime streams are reserved and not captured yet.",
          ),
        tailLines: z.number().int().positive().max(500).optional().describe("trailing lines to return (default 200)"),
      },
    },
    (args) =>
      audited("logs", args, () => {
        const id = resolvePreviewId(args);
        if (typeof id !== "string") return id;
        const denied = previewOwnedByPrincipal(id);
        if (denied) return denied;
        const source = args.source ?? "build";
        const log = engine.logs(id, args.deviceId, source, args.tailLines ?? 200);
        if (log === null) {
          return fail(
            "unknown_device",
            args.deviceId ? `no device "${args.deviceId}" in preview "${id}"` : `preview "${id}" has no devices`,
            "call preview_status to list the device ids",
          );
        }
        return ok({
          previewId: id,
          deviceId: args.deviceId ?? null,
          source,
          lines: log ? log.split("\n").length : 0,
          log,
          ...(log === "" ? { note: `No ${source} log captured yet for this device.` } : {}),
        });
      }),
  );

  server.registerTool(
    "set_pin",
    {
      title: "Set or remove a share PIN",
      description:
        "Protect a running preview's share link with a numeric PIN, change it, or remove it (make the link public again) — the viewer URL stays the same. Ask the user for a 4–6 digit PIN and NEVER repeat it back in chat. Pass previewId or app id. To remove protection, pass remove:true.",
      inputSchema: {
        previewId: z.string().optional().describe("from start_preview; or pass app instead"),
        app: z.string().optional().describe("app id — protects its running preview"),
        pin: z.string().optional().describe("4–6 digit numeric PIN to set/change (the user chooses it)"),
        remove: z.boolean().optional().describe("true to remove the PIN and make the link public"),
      },
    },
    (args) =>
      audited("set_pin", args, () => {
        const id = resolvePreviewId(args);
        if (typeof id !== "string") return id;
        const denied = previewOwnedByPrincipal(id);
        if (denied) return denied;
        const appId = engine.appIdFor(id);
        if (!appId) return fail("unknown_preview", `no active preview "${id}"`);
        if (args.remove) {
          engine.setAppPin(appId, null);
          return ok({ app: appId, protected: false, nextStep: "The link is now public — anyone with the URL can open it." });
        }
        if (!isValidPin(args.pin ?? "")) {
          return fail(
            "needs_pin",
            "Provide a 4–6 digit numeric PIN, or pass remove:true to make the link public.",
            "Ask the user for a 4–6 digit code; don't repeat it in chat.",
          );
        }
        engine.setAppPin(appId, args.pin!);
        return ok({
          app: appId,
          protected: true,
          nextStep: "The link is now PIN-protected — viewers must enter the PIN the user set. The URL is unchanged; don't repeat the PIN in chat.",
        });
      }),
  );

  // --- agent-driven test runs (surfaced live in the viewer, PLAN §8) ---------

  server.registerTool(
    "start_test_run",
    {
      title: "Start a test run",
      description:
        "Open an end-to-end test run on a preview so the viewer shows a live spinner + step popover. YOU are the brain: read the diff/changes to decide what to test, then drive the app with `describe` + `ui`, reporting each step here. Pass a short title and the planned step labels (you can add more later with update_test_run). Finish with finish_test_run and write the full report in chat yourself. Pass previewId or app id.",
      inputSchema: {
        previewId: z.string().optional().describe("from start_preview; or pass app instead"),
        app: z.string().optional().describe("app id — targets its running preview"),
        title: z.string().describe("short name for what's being tested, e.g. \"Login flow\""),
        steps: z.array(z.string()).optional().describe("planned step labels (shown pending; update as you go)"),
      },
    },
    (args) =>
      audited("start_test_run", args, () => {
        const id = resolvePreviewId(args);
        if (typeof id !== "string") return id;
        const denied = previewOwnedByPrincipal(id);
        if (denied) return denied;
        const { runId } = engine.startTestRun(id, args.title, args.steps ?? []);
        return ok({
          runId,
          nextStep:
            "Drive the app with `describe`/`ui`. Mark each step running→passed/failed with update_test_run, then finish_test_run + report in chat.",
        });
      }),
  );

  server.registerTool(
    "update_test_run",
    {
      title: "Update the test run",
      description:
        "Report progress on the current run so the viewer's step popover animates. Set a step running before you drive it, then passed/✓ or failed/✗ after you verify (with `ui` waitFor/assert). Reference a step by its number `n` or `label`; an unknown label appends a new step. Optionally set runStatus. Pass previewId or app id.",
      inputSchema: {
        previewId: z.string().optional(),
        app: z.string().optional(),
        step: z
          .object({
            n: z.number().int().positive().optional().describe("step number (1-based); or match by label"),
            label: z.string().optional(),
            status: z.enum(["pending", "running", "passed", "failed"]),
            detail: z.string().optional().describe("optional note (e.g. what failed)"),
          })
          .optional(),
        runStatus: z.enum(["running", "passed", "failed"]).optional(),
      },
    },
    (args) =>
      audited("update_test_run", args, () => {
        const id = resolvePreviewId(args);
        if (typeof id !== "string") return id;
        const denied = previewOwnedByPrincipal(id);
        if (denied) return denied;
        engine.updateTestRun(id, { step: args.step, runStatus: args.runStatus });
        return ok({ updated: true });
      }),
  );

  server.registerTool(
    "finish_test_run",
    {
      title: "Finish the test run",
      description:
        "Conclude the current run with a verdict (passed/failed) and a one-line summary — the viewer button settles to ✓/✗. Then write the full human-readable report in chat yourself (what you tested, what passed/failed, and any bug you found). Pass previewId or app id.",
      inputSchema: {
        previewId: z.string().optional(),
        app: z.string().optional(),
        status: z.enum(["passed", "failed"]),
        summary: z.string().optional().describe("one-line result shown in the viewer"),
      },
    },
    (args) =>
      audited("finish_test_run", args, () => {
        const id = resolvePreviewId(args);
        if (typeof id !== "string") return id;
        const denied = previewOwnedByPrincipal(id);
        if (denied) return denied;
        engine.finishTestRun(id, args.status, args.summary);
        return ok({ finished: true, nextStep: "Now post the full test report in chat for the user." });
      }),
  );

  // --- admin: app registration (the onboarding state machine, PLAN §6) -------

  const requireAdmin = (): CallToolResult | null =>
    isAdmin(principal) ? null : fail("forbidden", "this action requires an admin token", "ask an admin to register the app");

  /** Default a kebab-case app id from a repo name. */
  const defaultAppId = (name: string): string =>
    name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");

  server.registerTool(
    "add_app",
    {
      title: "Register an app",
      description:
        "Register a GitHub repo for GIT-MODE previews: deckhand fetches a pushed branch/PR from GitHub and builds it — the repo need NOT be checked out on the machine. This is NOT the default. Prefer a LOCAL preview when the project is on this machine: register it there with `deckhand app add <id> --path <dir>` (livesync, no push, no GitHub access) — that's done on the machine, not over MCP. Use add_app only when the user explicitly wants a pushed ref/PR, or the project isn't checked out locally. Detects the app type/bundle id from the repo. If the repo is private and deckhand has no credential, returns a one-time setup link for the user to grant read access — relay that link, never ask for the token in chat.",
      inputSchema: {
        repo: z.string().describe("owner/name, or a github.com URL"),
        id: z.string().optional().describe("app id (kebab-case); defaults from the repo name"),
        type: z
          .enum(["expo", "react-native", "nativescript"])
          .optional()
          .describe("override auto-detection if it can't tell"),
        branch: z.string().optional().describe("default branch to build (default: main)"),
        bundleId: z.string().optional().describe("iOS bundle id / Android package, if auto-detection can't find it"),
        migratesFrom: z
          .string()
          .optional()
          .describe("app id this is being migrated FROM (the source/oracle) — enables start_migration_preview and the side-by-side view"),
      },
    },
    (args) =>
      audited("add_app", args, async () => {
        const denied = requireAdmin();
        if (denied) return denied;

        let owner: string;
        let name: string;
        try {
          ({ owner, name } = parseRepo(args.repo));
        } catch (e) {
          return fail("bad_request", e instanceof ConfigError ? e.message : `invalid repo "${args.repo}"`);
        }
        const id = (args.id ?? defaultAppId(name)).trim();
        if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
          return fail("bad_request", `invalid app id "${id}"`, "ids are kebab-case: a-z, 0-9, -");
        }
        if (apps.some((a) => a.id === id)) {
          return fail("duplicate_app", `an app named "${id}" is already registered`, "pass a different id, or remove_app first");
        }
        if (args.migratesFrom) {
          if (args.migratesFrom === id) return fail("bad_request", "an app can't migrate from itself");
          if (!apps.some((a) => a.id === args.migratesFrom)) {
            return fail(
              "unknown_source_app",
              `migratesFrom "${args.migratesFrom}" is not a registered app`,
              "register the source app first (call list_apps to see ids)",
            );
          }
        }

        const probeFor = (b: string): App => ({ id, repo: args.repo, type: args.type ?? "react-native", defaultBranch: b, allowForkPRs: false, env: {} });
        let branch = args.branch ?? "main";
        let detected: { type: AppType | null; bundleId: string | null };
        try {
          // Auto-detect the repo's actual default branch (origin/HEAD) unless the
          // caller pinned one — repos on master/develop must not fail as "main".
          if (!args.branch) {
            const def = await engine.detectDefaultBranch(probeFor(branch));
            if (def) branch = def;
          }
          // Inspect the repo (clone + read at ref, no checkout) to detect type/bundle id.
          detected = await engine.inspectAppRepo(probeFor(branch), { kind: "branch", branch });
        } catch (e) {
          if (isAuthProblem(e)) {
            const url = ctx.setup
              ? `${publicBaseUrl(config)}/setup/${ctx.setup.mint("github-pat", owner)}`
              : undefined;
            const host = deckhandHost();
            const patStep = url
              ? `give the user this link and ask them to open it and paste a GitHub fine-grained PAT (Contents: Read-only for "${owner}"): ${url} — it's single-use and expires in 15 minutes. When they confirm, call add_app again. Never ask for the token in chat.`
              : `grant deckhand read access to "${owner}" (a fine-grained PAT with Contents: Read-only, or install the GitHub App), then call add_app again.`;
            return failWith(
              "github_auth_missing",
              `deckhand can't read ${args.repo} with any available credential — it's private (or the current credential lacks access).`,
              {
                ...(url ? { setupUrl: url } : {}),
                host,
                hint: `${localCheckoutHint(host, `${owner}/${name}`, id)} Otherwise, ${patStep}`,
              },
            );
          }
          if (e instanceof RefError) {
            return fail("repo_unreachable", e.message, `check the repo name and that branch "${branch}" exists`);
          }
          return toFail(e);
        }

        const type = args.type ?? detected.type ?? undefined;
        if (!type) {
          return fail(
            "undetectable_type",
            `couldn't determine the app type of ${args.repo}`,
            "ask the user, then pass type: expo | react-native | nativescript",
          );
        }
        if (type === "web") {
          const host = deckhandHost();
          return fail(
            "web_local_only",
            `${args.repo} looks like a frontend web project — web previews run a local dev server, not a git build`,
            `${localCheckoutHint(host, `${owner}/${name}`, id)} Register it with \`deckhand app add ${id} --path <abs-dir> --type web\` (a live dev server, hot-reload on save). A Vite app then works out of the box; a Nuxt/Next/static app also needs a \`webHost\` configured on the machine to be publicly shareable (\`deckhand doctor\` reports this).`,
          );
        }
        const bundleId = args.bundleId ?? detected.bundleId ?? undefined;

        const app = appSchema.parse({
          id,
          repo: args.repo,
          type,
          defaultBranch: branch,
          ...(bundleId ? { bundleId } : {}),
          ...(args.migratesFrom ? { migratesFrom: args.migratesFrom } : {}),
        });
        apps.push(app);
        persistApps(apps);

        return ok({
          registered: { id: app.id, repo: app.repo, type: app.type, defaultBranch: app.defaultBranch, bundleId: bundleId ?? null },
          checks: [
            { name: "repo reachable", ok: true },
            { name: "app type", ok: true, detail: app.type },
            {
              name: "bundle id",
              ok: Boolean(bundleId),
              detail: bundleId ?? "not detected — start_preview may still find it; if not, re-run add_app with bundleId",
            },
          ],
          nextStep: `Registered "${app.id}". Call start_preview with app:"${app.id}" and an iOS/Android device to build and boot it — the first build is the real end-to-end test.`,
        });
      }),
  );

  server.registerTool(
    "remove_app",
    {
      title: "Remove an app",
      description: "Unregister an app. Optionally delete its cached clone from disk.",
      inputSchema: {
        id: z.string().describe("app id from list_apps"),
        deleteCheckout: z.boolean().optional().describe("also remove the on-disk clone/worktrees"),
      },
    },
    (args) =>
      audited("remove_app", args, () => {
        const denied = requireAdmin();
        if (denied) return denied;
        const idx = apps.findIndex((a) => a.id === args.id);
        if (idx < 0) return fail("unknown_app", `no app named "${args.id}"`, "call list_apps to see registered apps");
        const [removed] = apps.splice(idx, 1);
        persistApps(apps);
        if (args.deleteCheckout && removed) {
          try {
            rmSync(paths.repo(removed.id), { recursive: true, force: true });
          } catch {
            // best-effort; the registry change is what matters
          }
        }
        return ok({ removed: args.id, deletedCheckout: Boolean(args.deleteCheckout) });
      }),
  );
}
