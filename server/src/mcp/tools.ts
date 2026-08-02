import { readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hostname, userInfo } from "node:os";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { App, AppType, Config } from "../config.ts";
import { appSchema, ConfigError, parseRepo, publicBaseUrl } from "../config.ts";
import { versionStatus } from "../version.ts";
import { DEV_MENU_PREFLIGHT, devMenuHint } from "../testing/devMenu.ts";
import { selectorMissHint } from "../testing/tree.ts";
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

/**
 * Every successful tool response, and the one place the update notice can be attached
 * without anyone having to remember to.
 *
 * Attached only when there is genuinely something to say (this checkout is on main and main
 * has moved), so the normal case is byte-identical to before. Deliberately not restricted to
 * `start_preview`: whichever tool the agent reaches for next is the one that should tell it,
 * and a notice on a funnel cannot be forgotten by the next tool somebody adds.
 */
function ok(data: Record<string, unknown>): CallToolResult {
  const version = versionStatus();
  // Two different "you are behind" states, and the one that was missing is the common one:
  // the checkout was pulled and the process still runs the old code. Comparing the CHECKOUT
  // to origin/main reports "up to date" while the running server is hours stale.
  const notice =
    version?.restartNeeded || version?.updateAvailable
      ? {
          deckhandUpdate: {
            running: version.current,
            checkout: version.checkout,
            latest: version.latest,
            action: version.restartNeeded ? "restart" : "pull-and-restart",
          },
          nextStep: version.note,
        }
      : {};
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...data, ...notice }) }] };
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
  z.object({ type: z.literal("back") }).describe("the platform back gesture — use this instead of guessing an edge-swipe"),
  z.object({ type: z.literal("dismissKeyboard") }),
  z.object({ type: z.literal("sleep"), ms: z.number().int().positive() }),
  z.object({ type: z.literal("scrollUntilVisible"), selector: selectorSchema }),
  z.object({ type: z.literal("toggleAppearance") }).describe("flip the device between light and dark"),
  z.object({ type: z.literal("waitFor"), selector: selectorSchema, timeoutMs: z.number().int().positive().optional() }),
  z.object({ type: z.literal("waitForNot"), selector: selectorSchema, timeoutMs: z.number().int().positive().optional() }),
  z.object({ type: z.literal("assert"), selector: selectorSchema }),
  z.object({ type: z.literal("assertNot"), selector: selectorSchema }),
  z.object({ type: z.literal("query"), selector: selectorSchema }),
]);


/**
 * The checkouts belonging to a base clone, by reading each one's `.git` pointer
 * file rather than matching its directory NAME.
 *
 * The checkout key is `<appId>-<ref>` slugified, so a name match for app `web`
 * would also hit `dh-web-2-main-<hash>`, which belongs to app `web-2`. `base`
 * must be a REALPATH: `git worktree add` records the resolved path, so under a
 * symlinked DECKHAND_HOME an unresolved one matches nothing at all.
 */
export function checkoutsOfBase(worktreesDir: string, base: string): string[] {
  let names: string[];
  try {
    names = readdirSync(worktreesDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    const dir = join(worktreesDir, name);
    try {
      if (readFileSync(join(dir, ".git"), "utf8").includes(`${base}/`)) out.push(dir);
    } catch {
      // not a worktree (or unreadable) — leave it alone
    }
  }
  return out;
}

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
    // Compare/migration reference panes are public by construction and run under
    // a synthetic app id that is never in apps.yaml — the one legitimate miss.
    // Public to VIEW is not the same as drivable: scope it to the repo it booted
    // from, so a token scoped to another owner can't read its build logs or drive
    // it. (An against.worktree reference has no repo and is admin-gated already.)
    if (engine.isReference(previewId)) {
      const refApp = engine.appFor(previewId);
      if (isAdmin(principal) || (refApp && canAccessApp(principal, refApp))) return null;
      return fail(
        "forbidden",
        `you don't have access to preview "${previewId}"`,
        "this reference pane belongs to a repo owner this token isn't scoped to",
      );
    }
    const app = apps.find((a) => a.id === appId);
    // Deny by DEFAULT on a miss — EXCEPT for admins. apps.yaml is hot-reloaded, so
    // deleting an app while its preview runs orphans it; denying everyone left the
    // devices booted against maxTotalDevices with no MCP way to reclaim them.
    // Skipping the check entirely let any valid token drive `ui` / `screenshot` /
    // `logs` / `stop_preview` on such a preview.
    if (!app && isAdmin(principal)) return null;
    if (!app || !canAccessApp(principal, app)) {
      return fail(
        "forbidden",
        `you don't have access to preview "${previewId}"`,
        "this token is scoped to specific repo owners; call list_apps to see what you can reach",
      );
    }
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
      description:
        "List available iOS simulator runtimes and models, plus current capacity. Also reports PHYSICAL devices this machine can see (`physical`: paired iPhones/iPads via devicectl, adb-connected Android hardware). Read two fields there before answering about real devices: `physical.targetable` says whether start_preview can build to that hardware — while it is false, say deckhand sees the device but physical-device previews are not supported yet, and offer a matching simulator. And if `physical.errors` is present, the scan FAILED (tooling missing or hung) — say the scan failed and suggest `deckhand doctor`; never report a failed scan as 'no devices connected'.",
      inputSchema: {},
    },
    () => audited("list_devices", {}, async () => ok(await engine.listDevices())),
  );

  /**
   * The one sentence that makes the agent's work visible in the viewer. It rides in every
   * output that precedes driving the app, because an agent that only meets it once — buried
   * in a `preview_status` poll it may never repeat — drives the whole session invisibly: the
   * user watches a cursor move with no idea what is being done or whether it worked.
   *
   * Deliberately not limited to testing. A run is the label on whatever the agent is doing to
   * the app, so exploring and bug-reproduction get one too; the title is what tells the user
   * which it is.
   */
  /**
   * Deckhand used to ask the agent to hand the drive loop to a subagent on its cheapest
   * fast model. That is gone, and the measurements are why.
   *
   * Deckhand is not the slow part: `ui` answers in 0.43–0.69s, `describe` in 0.03–0.59s,
   * `screenshot` in 0.15s. A delegated run spent 583s over 66 tool calls on a five-step
   * test — roughly 5% deckhand, the rest model inference. A weaker model does not make
   * that cheaper, it makes it WORSE, because every mis-aimed tap costs three more round
   * trips, and the task needed about fifteen calls.
   *
   * The cost that actually mattered was not tokens. Two of those runs came back with
   * confident, wrong root causes — "the permission dialog is unresponsive" (one tap at
   * the right coordinate dismissed it) and "critical UI bugs, button ID mapping broken"
   * (the dev-menu overlay was eating the tap). Both were nearly reported to the user as
   * app bugs. Steering toward a cheaper model bought slower runs and false findings.
   *
   * So: no model advice at all. The agent that called the tool does the work.
   */
  const TEST_RUN_CONTRACT =
    "ALWAYS open a run before you drive the app — not just for tests: start_test_run with a title saying what you are about to do (\"Verify the new tab bar\", \"Reproduce the crash\", \"Look at the wash flow\") and the steps you plan, mark each one running→passed/failed with update_test_run as you go, and close it with finish_test_run. That is what puts a live spinner and step list in the viewer; without it the user sees a cursor moving over a silent app and cannot tell what you are doing.";

  /**
   * Keep the link within reach. Relaying it once, at the top of a long session, means the user
   * scrolls back through everything the agent has written since to find the sim again — so the
   * contract is not "relay it early" but "never let it leave the bottom of the conversation".
   */
  const linkFooter = (url: string): string =>
    `End EVERY message you write the user with this link on its own line — ${url} — so they never have to scroll back to find the sim.`;

  /** The daily-loop guidance attached to start/restart results (agent-led contract, PLAN §6). */
  const loopNextStep = (source: "git" | "local", url: string, ref?: string): string =>
    source === "local"
      ? `Give the user this link NOW: ${url} — it's already live (it shows build progress while the sim boots) and is stable for this app across restarts; relay it before any other work, don't wait for ready. Then poll preview_status for readiness. While the preview runs, file saves livesync to the simulator automatically, so after editing code there is nothing to call — just tell the user the change is on the sim. Only call restart_preview after native-level changes (new plugins, Podfile/gradle edits) or if the app looks stuck. ${TEST_RUN_CONTRACT} ${linkFooter(url)}`
      : `Give the user this link NOW: ${url} — it's already live (it shows build progress) and is stable for this app; relay it before any other work, don't wait for ready. Then poll preview_status for readiness. After pushing new commits to ${ref ?? "the branch"}, call restart_preview to rebuild the same simulators at the new tip — the link stays the same. ${TEST_RUN_CONTRACT} ${linkFooter(url)}`;

  /**
   * UI actions that change what the user sees, as opposed to the read-only verifiers
   * (waitFor/assert/query). A bare `assert` moves nothing on screen, so it is not the thing
   * the user is left guessing about.
   */
  /**
   * The actions that make a claim about the screen. A step reported `passed` right after one
   * of these FAILED is the shape of a verdict with no evidence behind it — see
   * `unevidencedPass`. `query` is absent: it returns matches, it does not assert anything.
   */
  const VERIFIER_ACTIONS = new Set(["waitFor", "waitForNot", "assert", "assertNot"]);

  // `sleep` and the waitForNot/assertNot verifiers are absent on purpose: they move nothing
  // on screen, so they are not what the user is being left in the dark about.
  const DRIVING_UI_ACTIONS = new Set([
    "tap", "tapElement", "type", "key", "button", "home", "swipe", "gesture", "openUrl",
    "back", "dismissKeyboard", "scrollUntilVisible", "toggleAppearance",
  ]);

  /**
   * The reminder attached to a driving `ui` action when nothing is being reported to the viewer.
   * The once-per-stretch bookkeeping lives on the engine — this layer is rebuilt per request and
   * cannot remember anything (see `shouldNudgeTestRun`).
   */
  const testRunNudge = (previewId: string, actionType: string): { hint?: string } => {
    if (!DRIVING_UI_ACTIONS.has(actionType)) return {};
    if (!engine.shouldNudgeTestRun(previewId)) return {};
    // Deliberately does NOT append TEST_RUN_CONTRACT: this fires in the middle of a flow, where
    // the agent has already met the full contract at start_preview. Restating it here says the
    // same thing twice in one payload — the reminder just needs to be unmissable, not long.
    return {
      hint: "You are driving the app with no run open, so the user is watching a cursor move over a silent app with no idea what you are doing. Open one NOW, even mid-flow: start_test_run titled with what you are doing, then report each step with update_test_run and close with finish_test_run.",
    };
  };

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
        "Returns the live viewer link INSTANTLY — surface it to the user first, before any other work (it's live the moment the preview starts and shows build progress while devices boot); then poll preview_status for readiness. Starts a preview and returns its shareable viewer link — or, if an equivalent preview is already running, returns THAT one (idempotent: each app keeps a stable URL, so this is also the way to answer \"what's the link?\"). With ref/pr it builds that git ref; with neither, an app with a local path previews its local working copy (dev mode — file saves then livesync to the simulator automatically, no pushing needed), and a repo-only app builds its default branch. Pass `alongside` to put more sources on the SAME page — another app, this app at another ref, a worktree, an arbitrary repo — and the viewer shows them side by side under one link and one PIN. That is how you compare old vs new: there is no separate compare tool or compare view. IMPORTANT: before every call you MUST ask the user whether to protect the link with a PIN or make it public, and pass that as `share` (this call fails until you do). If they choose a PIN, ask for a 4–6 digit code — never repeat that code back in chat.",
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
        alongside: z
          .array(
            z.object({
              app: z.string().optional().describe("another registered app id"),
              ref: z.string().optional().describe("a branch/PR/SHA of THIS app (or, with repo, of that repo)"),
              worktree: z.string().optional().describe("absolute path to another local checkout"),
              repo: z.string().optional().describe("an arbitrary repo (owner/name or url); pair with ref"),
            }),
          )
          .optional()
          .describe(
            "extra sources to show on the same page, in old → new order. An empty object {} means this app's registered migratesFrom. Each gets the same `devices`.",
          ),
        items: z.array(z.string()).optional().describe("parity checklist items to seed (flows/screens); update with parity_set"),
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
        const extra = args.alongside ?? [];
        if (isWeb && extra.length) {
          return fail("web_not_supported", "extra panes are for mobile apps (iOS/Android), not web previews");
        }
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

        // Hoisted so the extra panes boot on the same devices: a web preview's
        // pseudo-device would not typecheck as a simulator request, and extra
        // panes are rejected for web above anyway.
        const paneDevices = (args.devices ?? [{ platform: "ios" as const }]).map((d) => ({
          platform: d.platform ?? ("ios" as const),
          runtime: d.runtime,
          model: d.model,
        }));
        const devices = isWeb ? [{ platform: "web" as const }] : paneDevices;

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
        // Web shares are always PIN-protected. A mobile share exposes four
        // allow-listed helper subpaths; a web share exposes a whole dev-server
        // route surface, and for a subdomain-hosted framework the URL is a bare
        // public hostname with no 144-bit shareId in it at all — discoverable
        // from DNS or certificate transparency.
        if (isWeb && access !== "pin") {
          return fail(
            "web_needs_pin",
            `web app "${resolved.id}" can only be shared with a PIN`,
            "Ask the user for a 4–6 digit code, then call again with share: { access: \"pin\", pin: \"<4-6 digits>\" }. Don't repeat the PIN in chat.",
          );
        }

        // PIN FIRST, then boot: the share URL is stable per app and the gate
        // reads the live PIN record, so setting it afterwards leaves a window
        // where the link is open. (Also covers alreadyRunning: findReusable
        // ignores access.)
        // ...but roll it back if the boot then throws (device caps, one-device-per-
        // platform): the share id is stable per app, so a failed call must not leave
        // an ALREADY-RUNNING share of this app newly public.
        // Extra sources first, so their (public) panes exist before this app's
        // share takes the chosen access — same order the old compare tool used.
        const refs: { reference: CompareReference; previewId: string; booted: boolean }[] = [];
        // Undo the panes THIS call started; a reused running pane is left alone,
        // because another page may be showing it right now.
        const rollbackPanes = () => {
          for (const r of refs) if (r.booted) void engine.stopPreview(r.previewId).catch(() => {});
        };
        for (const target of extra) {
          let booted;
          try {
            booted = bootReference(resolved, target, paneDevices, args.share);
          } catch (e) {
            // A THROW here (device capacity, a git failure) used to escape with
            // the earlier panes still up and no previewId in the response — so
            // they held their devices with no MCP handle to reach them, and the
            // capacity that caused the failure stayed spent. Only the returned
            // failure was rolled back.
            rollbackPanes();
            throw e;
          }
          if ("content" in booted) {
            rollbackPanes();
            return booted;
          }
          refs.push(booted);
        }

        const priorPin = engine.pinRecordForApp(resolved.id);
        engine.setAppPin(resolved.id, access === "pin" ? args.share.pin! : null);
        let result;
        try {
          result = engine.startPreview({
            app: resolved,
            source,
            spec,
            devices,
            access: access === "pin" ? "password" : "public",
          });
        } catch (e) {
          engine.restoreAppPin(resolved.id, priorPin);
          // The extra panes already booted and took devices. The likeliest reason
          // this boot threw is device capacity — leaving them up would hold the
          // very slots that caused the failure, with no MCP handle to reach the
          // orphans. Only the ones THIS call booted: a reused pane may be live on
          // someone else's page.
          // best-effort: the original failure is what the caller needs to see
          rollbackPanes();
          throw e;
        }
        if (refs.length || args.items?.length) {
          engine.startCompare(
            result.previewId,
            refs.map((r) => ({ ...r.reference, previewId: r.previewId })),
            args.items ?? [],
          );
        }
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
          ...(refs.length ? { alongside: refs.map((r) => r.reference) } : {}),
          nextStep:
            // The mismatch goes FIRST, before the reassuring "already running" line. The
            // engine reports platforms it could not add (it cannot add a device to a live
            // preview); burying that under "same viewer link" is how a request for Android
            // came back looking satisfied with no Android on the page.
            (result.notAdded?.length ? `⚠ ${result.nextStep} ` : "") +
            (result.alreadyRunning
            ? `An equivalent preview is already running — same viewer link: ${result.url}. ` +
              (isWeb
                ? `Saving files hot-reloads the page automatically; call restart_preview only after dependency/config changes. ${linkFooter(result.url)}`
                : (source === "local"
                    ? "File saves livesync to it automatically; call restart_preview only after native-level changes. "
                    : "After pushing new commits, call restart_preview to rebuild it at the new tip. ") +
                  `${TEST_RUN_CONTRACT} ${linkFooter(result.url)}`)
            : isWeb
              ? `Give the user this link NOW: ${result.url} (stable for this app) — relay it before any other work; then poll preview_status for readiness. It's a live web dev server — saving files hot-reloads the page automatically, so after editing there is nothing to call. Use restart_preview only after dependency/config changes (new packages, vite.config edits) or if the server looks stuck. Deckhand runs this working copy in place and only reads/runs it — never commit or push any local changes deckhand caused (dev-server caches, a stray lockfile); its git state is not yours to write. ${linkFooter(result.url)}${webHostWarning}`
              : loopNextStep(source, result.url, args.ref ?? resolved.defaultBranch)) +
            (refs.length
              ? ` It shows ${refs.length + 1} sources side by side under this one link. Drive any pane with describe/ui/screenshot, judge each item yourself, and record the verdict with parity_set (done / adjusted / regression). The checklist is local to this session — keep the project plan in your task tracker.`
              : "") +
            protectionNote,
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

  // Resolve an `alongside` entry into a booted extra pane. Four kinds: another
  // registered app, this app at another git ref, an arbitrary local worktree, or
  // an arbitrary repo@ref.
  //
  // The pane takes the PAGE's access, not a forced public one. It used to boot
  // public unconditionally, because there was no cross-share unlock and a
  // protected pane would have hung on "Connecting…" forever. There is one now
  // (pairedShareIds), so a PIN-protected page no longer has to publish half of
  // itself on a second URL to show it.
  const bootReference = (
    workingApp: App,
    against: { app?: string; ref?: string; worktree?: string; repo?: string } | undefined,
    devices: { platform: "ios" | "android"; runtime?: string; model?: string }[],
    share: { access: "public" | "pin"; pin?: string },
  ): { reference: CompareReference; previewId: string; booted: boolean } | CallToolResult => {
    // An entry with nothing named means "my migratesFrom" — that is the whole
    // point of declaring it, and it saves the agent repeating the source app id.
    const named = against && (against.app || against.ref || against.worktree || against.repo);
    const a = named ? against : workingApp.migratesFrom ? { app: workingApp.migratesFrom } : undefined;
    if (!a) {
      return fail(
        "needs_reference",
        "an extra pane needs a source to build",
        "pass alongside: [{ app } | { ref } | { worktree } | { repo, ref }] — or register this app with migratesFrom and pass alongside: [{}].",
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
      // Admin only: an arbitrary local path has no owner to scope against, and
      // booting it runs that checkout's install/build scripts as the deckhand
      // user. That is exactly the capability requireAdmin() guards on add_app —
      // a member token must not reach it through the side door.
      const denied = requireAdmin();
      if (denied) return denied;
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
      // Owner scoping applies to an arbitrary repo too: check the synthetic app
      // the reference would boot, or a token scoped to one org could clone and
      // build any repo deckhand's credential can read.
      //
      // But `canAccessApp` returns TRUE for a principal with no `owners` — that
      // is correct for registered apps (an unscoped member may use them all) and
      // completely wrong here, where the point is reaching PAST the registered
      // set. Cloning an arbitrary repo runs its install and build scripts as the
      // deckhand user; that is the same capability `requireAdmin()` guards on the
      // worktree branch two cases up, so an unscoped member must not get it for
      // free just by leaving `owners` unset.
      const probe: App = { ...workingApp, repo: a.repo, path: undefined };
      const scoped = (principal.owners?.length ?? 0) > 0;
      if (!isAdmin(principal) && !scoped) {
        return fail(
          "forbidden",
          "building an arbitrary repo needs an owner-scoped or admin token",
          "use alongside: [{ app }] for a registered app, or ask an admin to scope this token to the repo's owner.",
        );
      }
      if (!canAccessApp(principal, probe)) {
        return fail(
          "forbidden",
          `you don't have access to repo "${a.repo}"`,
          "this token is scoped to specific repo owners",
        );
      }
      base = probe;
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
    if (base.type === "web") return fail("web_not_supported", "extra panes are for mobile apps (iOS/Android), not web previews");
    // The reference ALWAYS boots under a synthetic, distinct app id. Sharing the
    // working app's id (a same-app against.ref, or against.app pointing at itself)
    // would collide on the per-app stable shareId (self-pairing) and per-app PIN,
    // and a public reference boot would wipe a registered app's persisted PIN. A
    // fresh id keyed by `key` stays stable across restarts (so compare is idempotent).
    // The access class is part of the pane's identity: a public page and a
    // PIN-protected page must never land on the same pane, or one of them is
    // wrong about whether that content is exposed.
    const refApp: App = { ...base, id: shortHash(`${key}|${share.access}`), migratesFrom: undefined };
    // PIN before boot, same reasoning as the page's own share: the pane's share
    // id is stable per (synthetic) app, so applying it afterwards leaves a window
    // where the pane is open. The synthetic id is what makes this safe to write —
    // it can never be a registered app's persisted PIN.
    const paneProtected = share.access === "pin";
    // Do NOT re-key a pane that is already live. Its synthetic app id is derived
    // from CONTENT (repo+ref), not from the page asking for it, so two pages
    // comparing against the same source share one pane and one PIN — and this
    // call would silently rewrite the other page's protection underneath it.
    // With a different PIN that revokes their viewers' cookies mid-session
    // (the cookie binds the PIN in force); worse, a public page reusing a
    // protected pane would strip the protection off someone else's.
    //
    // Leaving it alone is safe because a viewer never proves the PANE's PIN:
    // cross-share minting issues its cookie off the PIN they proved on their own
    // page (see pairedShareIds). The key below keeps public and PIN-protected
    // pages on separate panes, so this only ever applies between two pages of
    // the same access class — the residual already documented in PLAN §11.
    if (!engine.hasLivePreviewForApp(refApp.id)) {
      engine.setAppPin(refApp.id, paneProtected ? share.pin! : null);
    }
    const result = engine.startPreview({
      app: refApp,
      source,
      spec,
      devices,
      access: paneProtected ? "password" : "public",
      reference: true,
    });
    const ref = source === "local" ? "local" : refDescription(spec!);
    return {
      reference: { shareId: result.shareId, repo: base.repo ?? refApp.id, ref },
      previewId: result.previewId,
      // Whether THIS call booted it. The reference app id is keyed by
      // repo+ref alone, not by the working app, so a second compare against the
      // same reference reuses the running one — and the rollback below must not
      // tear down a pane another compare session is using.
      booted: !result.alreadyRunning,
    };
  };

  server.registerTool(
    "parity_set",
    {
      title: "Record a checklist verdict",
      description:
        "Record your verdict on one checklist item after you've judged it in the viewer. YOU maintain this list — it is what the person watching reads to see how far along you are, so keep it current as you go rather than in a batch at the end. verdict: done (verified fine — use this when there is nothing to compare against, and when the port matches the reference) · adjusted (deliberately different from the reference and fine — a redesign, not a bug) · regression (unwanted divergence, still to fix) · doing (in progress) · pending (not looked at). An unknown item name is appended. Returns the updated counts. Pass previewId or the app id.",
      inputSchema: {
        previewId: z.string().optional().describe("from start_preview; or pass app instead"),
        app: z.string().optional().describe("the app id — targets its running preview"),
        item: z.string().describe("the item name (flow/screen)"),
        verdict: z.enum(["pending", "doing", "done", "adjusted", "regression"]),
        note: z.string().optional().describe("optional short note, e.g. why it's adjusted"),
      },
    },
    (args) =>
      audited("parity_set", args, () => {
        const id = resolvePreviewId(args);
        if (typeof id !== "string") return id;
        const denied = previewOwnedByPrincipal(id);
        if (denied) return denied;
        const counts = engine.setCompareItem(id, { item: args.item, verdict: args.verdict, note: args.note });
        return ok({ counts });
      }),
  );

  server.registerTool(
    "parity_status",
    {
      title: "Read the checklist",
      description:
        "Return the parity checklist — the extra pane(s) on the page, every item with its verdict/note, and the counts. Call this at the START of a session to pull the full checklist into context and see what's left. Pass previewId or the working app id.",
      inputSchema: {
        previewId: z.string().optional().describe("from start_preview; or pass app instead"),
        app: z.string().optional().describe("the app id — targets its running preview"),
      },
    },
    (args) =>
      audited("parity_status", args, () => {
        const id = resolvePreviewId(args);
        if (typeof id !== "string") return id;
        const denied = previewOwnedByPrincipal(id);
        if (denied) return denied;
        const status = engine.compareStatus(id);
        if (!status) return fail("no_checklist", "no parity checklist on this preview", "seed it with start_preview's `items`");
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
          nextStep: `Rebuilding on the same simulators. Poll preview_status until ready — the viewer link is unchanged: ${result.url}. ${linkFooter(result.url)}`,
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
                  `The preview is ready to drive: read the diff to pick the flows, then use \`describe\`+\`ui\`, and write the full report in chat when you are done. ${TEST_RUN_CONTRACT}${status.url ? ` ${linkFooter(status.url)}` : ""}`,
                // The last thing read before driving starts, which is the only moment this
                // is preventive rather than consoling. devMenuHint fires once the menu is
                // already in the tree — by then the corner has usually been tapped and a
                // theory about the app has already formed.
                devMenuPreflight: DEV_MENU_PREFLIGHT,
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
        "Tear down a preview's simulators (and its git worktree; a local app's source folder is never touched). In the daily loop you normally leave the preview running so its URL stays live — stop only to free capacity or end a session for good. Pass previewId or app id.",
      inputSchema: {
        previewId: z.string().optional().describe("from start_preview; or pass app instead"),
        app: z.string().optional().describe("app id — stops its running preview"),
      },
    },
    (args) =>
      audited("stop_preview", args, async () => {
        // Took previewId ONLY, while start_preview, preview_status and logs all accept `app`
        // — and the message that sent callers here did not mention it. An instruction that
        // cannot be followed with what the reader has is worse than none (CONSTITUTION §1).
        const id = resolvePreviewId(args);
        if (typeof id !== "string") return id;
        const denied = previewOwnedByPrincipal(id);
        if (denied) return denied;
        const stopped = await engine.stopPreview(id);
        return stopped ? ok({ stopped: true }) : fail("unknown_preview", `no active preview "${id}"`);
      }),
  );

  server.registerTool(
    "stop_device",
    {
      title: "Stop one device",
      description:
        "Tear down ONE device of a running preview and leave the rest going — the way back from `start_preview` with an extra platform. The preview keeps its URL, and the devices you are not removing are never touched. Cannot remove the last device: a preview with none is a stopped preview wearing a running one's URL, and `stop_preview` is what does that properly (it also frees the worktree and the share). Pass previewId or app id.",
      inputSchema: {
        previewId: z.string().optional().describe("from start_preview; or pass app instead"),
        app: z.string().optional().describe("app id — targets its running preview"),
        deviceId: z.string().describe("e.g. android-1 — see preview_status for the ids"),
      },
    },
    (args) =>
      audited("stop_device", args, async () => {
        const id = resolvePreviewId(args);
        if (typeof id !== "string") return id;
        const denied = previewOwnedByPrincipal(id);
        if (denied) return denied;
        const removed = await engine.removeDevices(id, [args.deviceId]);
        const left = engine.getStatus(id, { touch: false })?.devices ?? [];
        return ok({
          removed,
          devices: left.map((d) => ({ deviceId: d.deviceId, label: d.label, phase: d.phase })),
          nextStep: `${removed.join(", ")} is gone; ${left.map((d) => d.deviceId).join(", ")} kept running throughout. The viewer link is unchanged.`,
        });
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
        // The dev menu is the one thing on screen that is not the app. An agent that
        // does not know that files the overlay's behaviour as an app bug — observed.
        return ok({ describe: tree, ...devMenuHint(tree) });
      }),
  );

  server.registerTool(
    "ui",
    {
      title: "Drive the device UI",
      description:
        "Perform ONE UI action to drive the app end-to-end: tap {x,y} (0..1 normalized), tapElement {selector}, type {text}, key {name: enter|backspace|tab|escape|up|down|left|right}, button {name}, home, back, dismissKeyboard, sleep {ms}, swipe, gesture {preset: scroll-up|scroll-down|scroll-left|scroll-right}, scrollUntilVisible {selector}, toggleAppearance, openUrl {url}, and the verifiers waitFor/waitForNot/assert/assertNot/query {selector}. Selector semantics differ and it costs a timeout to learn: `text` matches an element's LABEL for waitFor/assert, while text living in a field's value or placeholder matches only `query` — prefer `id` when there is one. Prefer tapElement + waitFor/assert over raw coordinates: a coordinate read off a screenshot is the single most common way an agent taps the wrong thing. To reach something off-screen use scrollUntilVisible rather than a scroll-and-screenshot loop; to go back use `back` rather than guessing an edge-swipe; if the keyboard or a text-selection callout is covering what you need, dismissKeyboard. Note: iOS can't HID-type non-US characters — non-ASCII text is pasted via the clipboard (focus the field first). Needs the SimDeck testing backend.",
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
        const action = args.action as UiAction;
        // A failed verifier throws, and `audited` turns it into an error result — so the
        // failure has to be noted HERE or the fact is lost before update_test_run can use it.
        try {
          const result = await engine.ui(args.previewId, args.deviceId, action);
          if (VERIFIER_ACTIONS.has(action.type)) engine.noteVerification(args.previewId, true, action.type);
          return ok({ result, ...testRunNudge(args.previewId, action.type) });
        } catch (e) {
          // Any action carrying a selector can miss for the same two reasons, so the
          // diagnosis keys on the SELECTOR rather than on a list of action names. The list
          // version shipped without scrollUntilVisible — the one action that scrolls a whole
          // list before giving up, and therefore the one where the diagnosis is worth most.
          if (!("selector" in action)) throw e;
          const sel = "selector" in action ? JSON.stringify(action.selector) : undefined;
          if (VERIFIER_ACTIONS.has(action.type)) engine.noteVerification(args.previewId, false, action.type, sel);
          // "Not found" is the same answer for two situations that call for opposite next
          // moves: not rendered YET, or on screen but absent from the tree. Deckhand holds the
          // tree, so it can say which — and the miss has already cost the caller its timeout.
          let hint: string | undefined;
          try {
            const wanted = "selector" in action ? action.selector.text : undefined;
            hint = selectorMissHint(await engine.describe(args.previewId, args.deviceId, {}), wanted);
          } catch {
            /* the diagnosis must never replace the real error */
          }
          const msg = e instanceof Error ? e.message : String(e);
          return failWith("ui_error", msg, hint ? { screen: hint } : {});
        }
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
        "Protect a running preview's share link with a numeric PIN, change it, or remove it (make the link public again) — the viewer URL stays the same. A web preview is the exception: its share is always PIN-protected, so remove:true is refused for one. Ask the user for a 4–6 digit PIN and NEVER repeat it back in chat. Pass previewId or app id. To remove protection, pass remove:true.",
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
            "Drive the app with `describe`/`ui`. Mark each step running→passed/failed with update_test_run as you get to it, then finish_test_run + report in chat. " +
            "Two rules the viewer holds you to: every step you actually check must end as passed or failed — one left pending renders as never-run, so if you skipped it, say why in the summary rather than leaving it ambiguous. " +
            "And the closing verdict has to follow the steps: one failed step means the run failed, however minor it looked.",
        });
      }),
  );

  server.registerTool(
    "update_test_run",
    {
      title: "Update the test run",
      description:
        "Report progress on the current run so the viewer's step popover animates. Set a step running before you drive it, then passed/✓ or failed/✗ after you verify (with `ui` waitFor/assert). The step fields go INSIDE `step` — {\"previewId\":\"…\",\"step\":{\"n\":2,\"status\":\"passed\"}} — anything placed beside previewId is dropped by the schema and the call is rejected. Reference a step by its number `n` or `label`; an unknown label appends a new step. Optionally set runStatus. Pass previewId or app id.",
      inputSchema: {
        previewId: z.string().optional(),
        app: z.string().optional(),
        step: z
          .object({
            n: z.number().int().positive().optional().describe("step number (1-based); or match by label"),
            label: z.string().optional(),
            status: z.enum(["pending", "running", "passed", "failed"]),
            detail: z.string().optional().describe("optional note (e.g. what failed)"),
            evidence: z
              .string()
              .optional()
              .describe(
                "how you confirmed this WITHOUT a passing waitFor/assert — required to pass a step while your last check is failing. Shown to the user, so name what you actually did (\"screenshot: the six rows are visible\").",
              ),
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
        // An update that updates nothing used to answer `ok: {updated: true}` — the exact shape
        // of a success. That is principle 3: an empty result and a failed lookup must not be the
        // same value. Observed on a real run: an agent sent `{previewId, n, status, detail}` with
        // the step fields at the top level, where the schema ignores them. Five calls, five `ok`s,
        // and the viewer sat at 0/3 while the agent reported a pass it had no basis for. The
        // message names that specific mistake, because it is the one the shape invites.
        if (!args.step && !args.runStatus) {
          return fail(
            "nothing_to_update",
            "no step and no runStatus — nothing was updated",
            'The step fields go INSIDE `step`, not at the top level: {"previewId":"…","step":{"n":2,"status":"passed","detail":"…"}}. Anything you put beside `previewId` is dropped by the schema.',
          );
        }
        // A pass claimed straight after a verifier that did NOT hold.
        //
        // This was a warning first, and the warning did not work. In one session the agent
        // that wrote it went on to do exactly this three more times, each time reading past
        // the sentence — twice while batching calls with the response discarded. An advisory
        // in a payload nobody reads is not a guardrail, it is a note to the transcript.
        //
        // The shape underneath is the real defect: the agent was the ONLY source of truth for
        // a step's status while deckhand independently held the evidence. Two sources for one
        // fact, and the one with the evidence had no say. So it gets one: this is refused.
        //
        // Verifying by screenshot stays legitimate — on some screens it is the only thing that
        // works — but it has to be CLAIMED, with `evidence`, which makes it visible in the
        // viewer and in the audit log instead of indistinguishable from having checked nothing.
        if (args.step?.status === "passed") {
          const failed = engine.failedVerification(id);
          if (failed && !args.step.evidence) {
            return fail(
              "unevidenced_pass",
              `your last check — ${failed.action}${failed.selector ? ` ${failed.selector}` : ""} — failed, so this step has nothing behind it`,
              'Either check again until something holds, mark it "failed", or — if you confirmed it another way — say how with `evidence`, e.g. {"step":{"n":2,"status":"passed","evidence":"screenshot: the six rows are visible"}}. The evidence is shown to the user, so it has to be something you actually did.',
            );
          }
        }
        // Fold the claim into the detail the viewer already renders. A field the user cannot
        // see would make `evidence` a password rather than an account of what was done.
        const step = args.step
          ? {
              ...args.step,
              ...(args.step.evidence
                ? { detail: args.step.detail ? `${args.step.detail} — ${args.step.evidence}` : args.step.evidence }
                : {}),
            }
          : undefined;
        engine.updateTestRun(id, { step, runStatus: args.runStatus });
        // `{updated: true}` told the agent nothing. This tool is called throughout the run, so
        // it is the natural place to show what is still unmarked — the state that later turns
        // into a step rendered as never-run next to a verdict that ignored it.
        const c = engine.testRunCounts(id);
        const left = c ? c.pending + c.running : 0;
        const notes: string[] = [];
        if (left > 0) {
          notes.push(
            `${left} of ${c!.total} steps are still unmarked. Mark each one passed or failed as you check it — a step left pending renders in the viewer as never-run.` +
              (c!.failed > 0 ? ` ${c!.failed} step(s) have failed, so this run must finish as "failed".` : ""),
          );
        } else if (c && c.failed > 0) {
          notes.push(`All steps are marked and ${c.failed} failed, so finish this run as "failed".`);
        }
        // This is the tool called most often across a long run, which makes it where the link
        // quietly decays: relayed once at start_preview, then buried under everything written
        // since. Repeating it here keeps it within reach at the bottom of the conversation.
        const url = engine.getStatus(id, { touch: false })?.url;
        if (url) notes.push(linkFooter(url));
        return ok({
          updated: true,
          ...(c ? { steps: c } : {}),
          ...(notes.length ? { nextStep: notes.join(" ") } : {}),
        });
      }),
  );

  server.registerTool(
    "clear_test_run",
    {
      title: "Clear the test run",
      description:
        "Remove the preview's test run so the viewer shows none at all — the dock's run button disappears. Use it when a finished run is stale (the user has moved on) or was recorded wrongly and you are about to redo it; a finished run otherwise stays on screen for the life of the preview. This is not how you end a run: finish_test_run records the verdict, and clearing instead of finishing throws away what you just proved. Pass previewId or app id.",
      inputSchema: {
        previewId: z.string().optional().describe("from start_preview; or pass app instead"),
        app: z.string().optional().describe("app id — targets its running preview"),
      },
    },
    (args) =>
      audited("clear_test_run", args, () => {
        const id = resolvePreviewId(args);
        if (typeof id !== "string") return id;
        const denied = previewOwnedByPrincipal(id);
        if (denied) return denied;
        const cleared = engine.clearTestRun(id);
        return ok({
          cleared,
          nextStep: cleared
            ? "The viewer shows no run now. If you are about to test again, open a fresh one with start_test_run before you drive."
            : "There was no run on this preview — nothing to clear.",
        });
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
        // Read the tallies BEFORE finishing — finishing settles any running step, which would
        // hide the very mismatch we are checking for.
        const counts = engine.testRunCounts(id);
        // A run holding a failed step cannot be a pass. Left alone this renders as a green ✓ on
        // the dock button with a red ✗ inside it — the viewer faithfully showing a contradiction
        // the agent introduced. Record the honest verdict and say why, rather than refusing the
        // call and leaving the run open.
        // A run whose steps never moved proves nothing, so it cannot be a pass (principle 5).
        // Unlike the failed-step case below there is no information here to record honestly —
        // settling it either way invents a result — so this one refuses and leaves the run open.
        // From a real run: three steps, zero marked, finished "passed". The viewer showed
        // `0/3` beside a green tick, which is the user watching the agent grade its own
        // unattempted homework. A run started with no steps at all is not this case.
        if (args.status === "passed" && counts && counts.total > 0 && counts.passed === 0 && counts.failed === 0) {
          return fail(
            "no_steps_marked",
            `cannot pass a run where none of its ${counts.total} steps were ever marked`,
            "The run is still open. Mark what you actually checked with update_test_run (passed or failed, one call per step), then finish. If you did not check them, finish as \"failed\" or clear_test_run — do not record a verdict the steps do not support.",
          );
        }
        const contradicted = args.status === "passed" && !!counts && counts.failed > 0;
        const effective = contradicted ? "failed" : args.status;
        engine.finishTestRun(id, effective, args.summary);

        const notes: string[] = [];
        if (contradicted) {
          notes.push(
            `Recorded as FAILED, not passed: ${counts!.failed} of ${counts!.total} steps failed. A run's verdict follows its steps — if those failures are acceptable, say so in the summary and in your report, but do not call the run green.`,
          );
        }
        if (counts && counts.pending > 0) {
          notes.push(
            `${counts.pending} step(s) were never marked and now render as never-run. Tell the user plainly which checks you did not perform — an unmarked step is not a passed one.`,
          );
        }
        // The one moment the agent is certain to be writing a long message — so the single most
        // valuable place to say where the link goes.
        const url = engine.getStatus(id, { touch: false })?.url;
        return ok({
          finished: true,
          status: effective,
          ...(counts ? { steps: counts } : {}),
          nextStep: `${notes.join(" ")}${notes.length ? " " : ""}Now post the full test report in chat for the user — it must match the verdict recorded here.${url ? ` ${linkFooter(url)}` : ""}`,
        });
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
          .describe("app id this is being migrated FROM (the source/oracle) — start_preview then shows it alongside this app by default"),
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

        const probeFor = (b: string): App => ({ id, repo: args.repo, type: args.type ?? "react-native", defaultBranch: b, env: {} });
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
        // Deleting the checkout under a live preview pulls the tree out from
        // under a running xcodebuild/gradle. Unregistering alone is harmless, so
        // only the disk half is gated.
        if (args.deleteCheckout && engine.previewIdForApp(args.id)) {
          return fail(
            "preview_running",
            `"${args.id}" has a running preview — deleting its checkout now would break the build in progress`,
            "call stop_preview for it first, then remove_app again",
          );
        }
        // Persist FIRST, mutate the live registry only once the write succeeded.
        //
        // This used to splice and then write, so a write that throws — and it can: apps.yaml's
        // schema rejects a `migratesFrom` naming an app that is no longer registered, which is
        // precisely the shape `remove_app` creates — left the app gone from the array
        // `createServer` closed over while apps.yaml still had it. The tool then returned
        // internal_error saying "the existing file is unchanged", which was true of the disk
        // and false of the running server: the app was unreachable until a restart, and the
        // message actively told the operator not to look.
        const removed = apps[idx]!;
        persistApps(apps.filter((_, i) => i !== idx));
        apps.splice(idx, 1);
        if (args.deleteCheckout && removed) {
          try {
            // realpath BEFORE deleting: `git worktree add` records the RESOLVED
            // base path in each checkout's pointer file, so with a symlinked
            // DECKHAND_HOME the raw path never matches and nothing at all gets
            // deleted — while the response still claims it did.
            let base = paths.repo(removed.id);
            try {
              base = realpathSync(base);
            } catch {
              // never cloned — the unresolved path is still the best guess
            }
            rmSync(paths.repo(removed.id), { recursive: true, force: true });
            for (const dir of checkoutsOfBase(paths.worktreesDir(), base)) {
              rmSync(dir, { recursive: true, force: true });
            }
          } catch {
            // best-effort; the registry change is what matters
          }
        }
        return ok({ removed: args.id, deletedCheckout: Boolean(args.deleteCheckout) });
      }),
  );
}
