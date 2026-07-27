import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../server.ts";
import { createPinGate } from "../share/proxy.ts";
import { publicBaseUrl } from "../config.ts";
import { PreviewEngine, type PreviewEngineDeps } from "../engine/preview.ts";
import { TokenAuthenticator } from "../auth.ts";
import { StateStore } from "../state.ts";
import { SetupStore } from "../setup/setupStore.ts";
import { CredentialsMissingError } from "../github/credentials.ts";
import type { App, Config, TokenEntry } from "../config.ts";
import type { AttachedStream, StreamDeviceRef } from "../streaming/backend.ts";

const config: Config = {
  hostname: "mate.example.com",
  port: 0,
  streaming: { serveSim: { version: "0.1.34", codec: "auto", helperPortRange: [3100, 3199] } },
  githubApp: { appId: 1, privateKeyPath: "k.pem" },
  githubAmbient: true,
  allowPublicRepos: false,
  limits: { maxDevicesPerPreview: 4, maxTotalDevices: 6, idleMinutes: 45, failedGraceMinutes: 15, stuckMinutes: 90, reuseDevices: false, disk: { watch: 50, pressure: 35, critical: 20 } },
};

const localDir = mkdtempSync(join(tmpdir(), "deckhand-mcp-local-"));
const webDir = mkdtempSync(join(tmpdir(), "deckhand-mcp-web-"));
const webNuxtDir = mkdtempSync(join(tmpdir(), "deckhand-mcp-nuxt-"));
writeFileSync(join(webNuxtDir, "package.json"), JSON.stringify({ dependencies: { nuxt: "^2.14.11" } }));
const apps: App[] = [
  { id: "app-a", repo: "github.com/ainfrastructure/a", type: "react-native", defaultBranch: "main", allowForkPRs: false, bundleId: "com.a", env: {} },
  { id: "app-b", repo: "github.com/other-org/b", type: "react-native", defaultBranch: "main", allowForkPRs: false, bundleId: "com.b", env: {} },
  { id: "app-local", path: localDir, type: "nativescript", defaultBranch: "main", allowForkPRs: false, bundleId: "org.ns.local", env: {} },
  { id: "app-web", path: webDir, type: "web", defaultBranch: "main", allowForkPRs: false, env: {} },
  { id: "app-web-nuxt", path: webNuxtDir, type: "web", defaultBranch: "main", allowForkPRs: false, env: {} },
];

const ADMIN = "a".repeat(64);
const MEMBER = "b".repeat(64);
const tokens: TokenEntry[] = [
  { name: "admin", role: "admin", token: ADMIN },
  { name: "kari", role: "member", owners: ["ainfrastructure"], token: MEMBER },
];

function fakeEngine(): PreviewEngine {
  const fakeStream: AttachedStream = {
    origin: "http://127.0.0.1:3100",
    helperBasePath: "/helper/x",
    waitForFirstFrame: async () => true,
    describe: async () => "tree",
    detach: async () => {},
  };
  const deps: PreviewEngineDeps = {
    config,
    worktrees: {
      createWorktree: async (_a: App, id: string) => ({ path: `/wt/${id}`, ref: "r", description: "main", usedToken: false }),
      removeWorktree: async () => {},
    } as unknown as PreviewEngineDeps["worktrees"],
    simctl: {
      listRuntimes: async () => [{ identifier: "rt26", name: "iOS 26.0", version: "26.0", isAvailable: true }],
      listDeviceTypes: async () => [{ identifier: "dt", name: "iPhone 16 Pro" }],
      create: async () => "UDID",
      bootAndWait: async () => {},
      appContainer: async () => "/App.app",
      launch: async () => {},
      openUrl: async () => {},
      shutdown: async () => {},
      delete: async () => {},
      screenshotPng: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    } as unknown as PreviewEngineDeps["simctl"],
    streaming: { attach: async (_d: StreamDeviceRef) => fakeStream, reapOrphans: async () => {} } as unknown as PreviewEngineDeps["streaming"],
    metro: { ensure: async () => ({ manifestUrl: "http://127.0.0.1:8081" }), stop: async () => {} } as unknown as PreviewEngineDeps["metro"],
    store: new StateStore(`/tmp/deckhand-mcp-${Math.random().toString(36).slice(2)}.json`),
    audit: { record: () => {} } as unknown as PreviewEngineDeps["audit"],
    devProcs: {
      start: () => {},
      isAlive: () => true,
      exitCode: () => null,
      restart: () => true,
      stop: () => {},
      stopAll: () => {},
    } as unknown as PreviewEngineDeps["devProcs"],
    runStep: async () => ({ code: 0, timedOut: false, aborted: false }),
    secretsEnv: () => ({}),
    simdeck: {
      describe: async () => ({ source: "native-ax", nodes: [{ role: "Button", label: "Continue" }] }),
      action: async () => ({ ok: true }),
    } as unknown as PreviewEngineDeps["simdeck"],
  };
  return new PreviewEngine(deps);
}

let base: string;
let server: ReturnType<typeof import("node:http").createServer>;

before(async () => {
  const { createServer } = await import("node:http");
  const engine = fakeEngine();
  const app = createApp({
    engine,
    apps,
    config,
    audit: { record: () => {} } as never,
    auth: new TokenAuthenticator(tokens),
    pinGate: createPinGate(engine, "test-secret"),
  });
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});
after(() => {
  server?.close();
  rmSync(localDir, { recursive: true, force: true });
  rmSync(webDir, { recursive: true, force: true });
  rmSync(webNuxtDir, { recursive: true, force: true });
});

async function client(token: string): Promise<Client> {
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${token}`)));
  return c;
}

function parse(result: unknown): Record<string, unknown> {
  const items = ((result as { content?: Array<{ type: string; text?: string }> }).content ?? []) as Array<{
    type: string;
    text?: string;
  }>;
  const text = items.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text);
}

describe("MCP server (end-to-end over HTTP)", () => {
  it("rejects an unknown token with 404", async () => {
    const res = await fetch(`${base}/mcp/${"z".repeat(64)}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 404);
  });

  it("rejects GET (stateless) with 405", async () => {
    const res = await fetch(`${base}/mcp/${ADMIN}`, { headers: { accept: "text/event-stream" } });
    assert.equal(res.status, 405);
  });

  it("admin sees all apps; member sees only its owner-scoped apps", async () => {
    const admin = await client(ADMIN);
    const adminApps = parse(await admin.callTool({ name: "list_apps", arguments: {} })) as { apps: { id: string }[] };
    assert.deepEqual(adminApps.apps.map((a) => a.id).sort(), ["app-a", "app-b", "app-local", "app-web", "app-web-nuxt"]);
    await admin.close();

    const member = await client(MEMBER);
    const memberApps = parse(await member.callTool({ name: "list_apps", arguments: {} })) as { apps: { id: string }[] };
    assert.deepEqual(memberApps.apps.map((a) => a.id), ["app-a"]);
    await member.close();
  });

  it("member cannot start a preview of an app outside its scope", async () => {
    const member = await client(MEMBER);
    const res = parse(await member.callTool({ name: "start_preview", arguments: { app: "app-b", devices: [{ platform: "ios" }] } }));
    assert.equal(res.ok, false);
    assert.equal((res.error as { code: string }).code, "forbidden");
    await member.close();
  });

  it("compare_start with no against and no migratesFrom asks for a reference (no devices booted)", async () => {
    const admin = await client(ADMIN);
    const res = parse(await admin.callTool({ name: "compare_start", arguments: { app: "app-a", share: { access: "public" } } }));
    assert.equal(res.ok, false);
    assert.equal((res.error as { code: string }).code, "needs_reference");
    assert.match(String((res.error as { hint?: string }).hint), /against|migratesFrom/);
    await admin.close();
  });

  it("compare_start against an arbitrary repo requires a ref (no devices booted)", async () => {
    const admin = await client(ADMIN);
    const res = parse(await admin.callTool({ name: "compare_start", arguments: { app: "app-a", against: { repo: "acme/proj" }, share: { access: "public" } } }));
    assert.equal(res.ok, false);
    assert.equal((res.error as { code: string }).code, "needs_ref");
    await admin.close();
  });

  it("compare_start against the same app boots the reference on a distinct shareId (no self-pair)", async () => {
    const admin = await client(ADMIN);
    const res = parse(await admin.callTool({ name: "compare_start", arguments: { app: "app-a", against: { app: "app-a" }, share: { access: "public" } } }));
    assert.equal(res.ok, true);
    const reference = res.reference as { shareId: string };
    assert.ok(reference.shareId);
    assert.notEqual(reference.shareId, res.shareId); // reference must not collide with the working app's shareId
    await admin.callTool({ name: "stop_preview", arguments: { previewId: res.previewId as string } }); // cascades to the reference
    await admin.close();
  });

  it("start_preview returns a viewer url and previewId", async () => {
    const admin = await client(ADMIN);
    const res = parse(await admin.callTool({ name: "start_preview", arguments: { app: "app-a", ref: "main", devices: [{ platform: "ios" }], share: { access: "public" } } }));
    assert.equal(res.ok, true);
    assert.match(String(res.url), /^https:\/\/mate\.example\.com\/s\//);
    assert.ok(String(res.previewId).length > 0);
    await admin.close();
  });

  it("list_devices reports available runtimes", async () => {
    const admin = await client(ADMIN);
    const res = parse(await admin.callTool({ name: "list_devices", arguments: {} })) as { ios: { runtimes: unknown[] } };
    assert.ok(Array.isArray(res.ios.runtimes));
    await admin.close();
  });
});

// ---------------------------------------------------------------------------
// The agent-led onboarding contract (PLAN §6): empty-state nextStep, add_app as
// a state machine (private-repo → one-time setup URL → detect+register),
// remove_app, and the setup page that receives the PAT out-of-band.
// ---------------------------------------------------------------------------

/** A PreviewEngine whose repo inspection is faked: a NativeScript app, unless the
 *  repo name says it needs a credential (then it throws like a private clone). */
function onboardingEngine(): PreviewEngine {
  const nsFiles: Record<string, string> = {
    "package.json": JSON.stringify({ dependencies: { "@nativescript/core": "^8" } }),
    "nativescript.config.ts": "export default { id: 'no.okam.admin', appPath: 'app' };",
  };
  const deps: PreviewEngineDeps = {
    config,
    worktrees: {
      defaultBranch: async (app: App) => {
        if (/needs-cred/.test(app.repo ?? "")) throw new CredentialsMissingError("okam-as", "no credential configured");
        return "trunk"; // not "main" — proves add_app auto-detects the real default branch
      },
      inspect: async (app: App) => {
        if (/needs-cred/.test(app.repo ?? "")) throw new CredentialsMissingError("okam-as", "no credential configured");
        return {
          localRef: "refs/remotes/origin/trunk",
          read: async (p: string) => nsFiles[p] ?? null,
          hasEntry: async (p: string) => Object.keys(nsFiles).some((k) => k === p || k.startsWith(`${p}/`)),
        };
      },
      createWorktree: async (_a: App, id: string) => ({ path: `/wt/${id}`, ref: "r", description: "main", usedToken: false }),
      removeWorktree: async () => {},
    } as unknown as PreviewEngineDeps["worktrees"],
    simctl: {
      listRuntimes: async () => [],
      listDeviceTypes: async () => [],
    } as unknown as PreviewEngineDeps["simctl"],
    streaming: { attach: async () => ({}) as AttachedStream, reapOrphans: async () => {} } as unknown as PreviewEngineDeps["streaming"],
    metro: {} as unknown as PreviewEngineDeps["metro"],
    store: new StateStore(`/tmp/deckhand-onboard-${Math.random().toString(36).slice(2)}.json`),
    audit: { record: () => {} } as unknown as PreviewEngineDeps["audit"],
    runStep: async () => ({ code: 0, timedOut: false, aborted: false }),
    secretsEnv: () => ({}),
  };
  return new PreviewEngine(deps);
}

describe("MCP onboarding contract (add_app / empty state / setup URL)", () => {
  const registry: App[] = []; // starts empty — the "fresh install" state
  const persisted: App[][] = [];
  const setupStore = new SetupStore();
  const patPath = join(tmpdir(), `deckhand-pat-${Math.random().toString(36).slice(2)}`);

  let obase: string;
  let oserver: ReturnType<typeof import("node:http").createServer>;

  before(async () => {
    const { createServer } = await import("node:http");
    const oengine = onboardingEngine();
    const app = createApp({
      engine: oengine,
      apps: registry,
      config,
      audit: { record: () => {} } as never,
      auth: new TokenAuthenticator(tokens),
      pinGate: createPinGate(oengine, "test-secret"),
      persistApps: (a) => persisted.push([...a]),
      setup: { store: setupStore, patPath },
    });
    oserver = createServer(app);
    await new Promise<void>((r) => oserver.listen(0, "127.0.0.1", r));
    obase = `http://127.0.0.1:${(oserver.address() as AddressInfo).port}`;
  });
  after(() => {
    oserver?.close();
    rmSync(patPath, { force: true });
  });

  const oclient = async (token: string): Promise<Client> => {
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${obase}/mcp/${token}`)));
    return c;
  };

  it("list_apps on a fresh install returns a no_apps onboarding nextStep", async () => {
    const admin = await oclient(ADMIN);
    const res = parse(await admin.callTool({ name: "list_apps", arguments: {} })) as {
      apps: unknown[];
      onboarding?: { state: string; nextStep: string; host?: { hostname: string; user: string } };
    };
    assert.deepEqual(res.apps, []);
    assert.equal(res.onboarding?.state, "no_apps");
    assert.match(res.onboarding!.nextStep, /add_app/);
    // Local-checkout-first (PLAN §6): a co-located agent must be told to look
    // for an existing working copy before any GitHub credential flow.
    assert.match(res.onboarding!.nextStep, /deckhand app add [^ ]* ?--path/);
    assert.ok(res.onboarding?.host?.hostname, "onboarding must carry the deckhand host identity");
    await admin.close();
  });

  it("add_app on a private repo returns a one-time setup URL, not a token prompt", async () => {
    const admin = await oclient(ADMIN);
    const res = parse(
      await admin.callTool({ name: "add_app", arguments: { repo: "github.com/okam-as/needs-cred-app" } }),
    ) as { ok: boolean; error?: { code: string; setupUrl?: string; hint?: string; host?: { hostname: string } } };
    assert.equal(res.ok, false);
    assert.equal(res.error?.code, "github_auth_missing");
    // hostname "mate.example.com" → public https URL.
    assert.match(String(res.error?.setupUrl), /^https:\/\/mate\.example\.com\/setup\/[A-Za-z0-9_-]+$/);
    assert.match(String(res.error?.hint), /setup|link|read access/i);
    // The hint's first step is the local checkout, PAT is the fallback.
    assert.match(String(res.error?.hint), /deckhand app add needs-cred-app --path/);
    assert.ok(res.error?.host?.hostname);
    await admin.close();
  });

  it("the setup URL serves a form, rejects junk, and accepts a plausible PAT (out-of-band)", async () => {
    const admin = await oclient(ADMIN);
    const add = parse(await admin.callTool({ name: "add_app", arguments: { repo: "github.com/okam-as/needs-cred-app" } })) as {
      error: { setupUrl: string };
    };
    await admin.close();
    const nonce = new URL(add.error.setupUrl).pathname.split("/").pop()!;

    const form = await fetch(`${obase}/setup/${nonce}`);
    assert.equal(form.status, 200);
    assert.match(await form.text(), /<form/);

    const bad = await fetch(`${obase}/setup/${nonce}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "token=not-a-real-token",
    });
    assert.equal(bad.status, 400);

    const good = await fetch(`${obase}/setup/${nonce}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `token=${encodeURIComponent("github_pat_11ABCDEFG0123456789_abcdefghijklmnop")}`,
    });
    assert.equal(good.status, 200);
    assert.equal(readFileSync(patPath, "utf8").trim(), "github_pat_11ABCDEFG0123456789_abcdefghijklmnop");

    // Nonce is single-use: a second POST is rejected.
    const replay = await fetch(`${obase}/setup/${nonce}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `token=${encodeURIComponent("github_pat_22ZZZZ0123456789_qrstuvwxyzabcdef")}`,
    });
    assert.equal(replay.status, 404);
  });

  it("add_app detects type+bundleId, registers, persists, and clears the empty state", async () => {
    const admin = await oclient(ADMIN);
    const res = parse(await admin.callTool({ name: "add_app", arguments: { repo: "github.com/okam-as/admin-app" } })) as {
      ok: boolean;
      registered?: { id: string; type: string; bundleId: string | null; defaultBranch: string };
      nextStep?: string;
    };
    assert.equal(res.ok, true);
    assert.equal(res.registered?.id, "admin-app");
    assert.equal(res.registered?.type, "nativescript");
    assert.equal(res.registered?.bundleId, "no.okam.admin");
    assert.equal(res.registered?.defaultBranch, "trunk"); // auto-detected, not "main"
    assert.match(String(res.nextStep), /start_preview/);
    // Mutated the shared registry + persisted it.
    assert.ok(registry.some((a) => a.id === "admin-app"));
    assert.ok(persisted.length > 0);

    // list_apps now shows it and drops the onboarding block.
    const list = parse(await admin.callTool({ name: "list_apps", arguments: {} })) as {
      apps: { id: string }[];
      onboarding?: unknown;
    };
    assert.deepEqual(list.apps.map((a) => a.id), ["admin-app"]);
    assert.equal(list.onboarding, undefined);
    await admin.close();
  });

  it("add_app rejects a duplicate id", async () => {
    const admin = await oclient(ADMIN);
    const res = parse(await admin.callTool({ name: "add_app", arguments: { repo: "github.com/okam-as/admin-app" } })) as {
      ok: boolean;
      error?: { code: string };
    };
    assert.equal(res.ok, false);
    assert.equal(res.error?.code, "duplicate_app");
    await admin.close();
  });

  it("a member token cannot add_app or remove_app", async () => {
    const member = await oclient(MEMBER);
    const add = parse(await member.callTool({ name: "add_app", arguments: { repo: "github.com/ainfrastructure/x" } })) as {
      ok: boolean;
      error?: { code: string };
    };
    assert.equal(add.error?.code, "forbidden");
    const rm = parse(await member.callTool({ name: "remove_app", arguments: { id: "admin-app" } })) as {
      error?: { code: string };
    };
    assert.equal(rm.error?.code, "forbidden");
    await member.close();
  });

  it("remove_app unregisters and the empty state returns", async () => {
    const admin = await oclient(ADMIN);
    const res = parse(await admin.callTool({ name: "remove_app", arguments: { id: "admin-app" } })) as {
      ok: boolean;
      removed?: string;
    };
    assert.equal(res.ok, true);
    assert.equal(res.removed, "admin-app");
    assert.ok(!registry.some((a) => a.id === "admin-app"));

    const list = parse(await admin.callTool({ name: "list_apps", arguments: {} })) as { onboarding?: { state: string } };
    assert.equal(list.onboarding?.state, "no_apps");
    await admin.close();
  });
});

describe("publicBaseUrl", () => {
  const cfg = (hostname: string, port = 4300): Config => ({ ...config, hostname, port });
  it("uses the public https host for a real hostname", () => {
    assert.equal(publicBaseUrl(cfg("mate.example.com")), "https://mate.example.com");
  });
  it("uses the http loopback for local hostnames (no tunnel)", () => {
    assert.equal(publicBaseUrl(cfg("localhost", 4399)), "http://127.0.0.1:4399");
    assert.equal(publicBaseUrl(cfg("127.0.0.1", 4300)), "http://127.0.0.1:4300");
  });
});

// ---------------------------------------------------------------------------
// The daily-loop contract: idempotent start_preview with a stable URL, status
// lookup by app id ("what's the link to the sim?"), restart_preview in place.
// ---------------------------------------------------------------------------

async function waitReadyByApp(c: Client, app: string, timeoutMs = 3000): Promise<{ url: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = parse(await c.callTool({ name: "preview_status", arguments: { app } }));
    const status = res.status as { ready?: boolean; url?: string } | undefined;
    if (res.ok && status?.ready && status.url) return { url: status.url };
    if (Date.now() > deadline) throw new Error(`preview for ${app} never became ready: ${JSON.stringify(res)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("daily-loop contract (local previews, stable URLs)", () => {
  it("start_preview defaults a local app to dev mode and is idempotent with a stable url", async () => {
    const admin = await client(ADMIN);
    const first = parse(await admin.callTool({ name: "start_preview", arguments: { app: "app-local", share: { access: "public" } } }));
    assert.equal(first.ok, true);
    assert.equal(first.source, "local");
    assert.equal(first.alreadyRunning, false);
    assert.match(String(first.nextStep), /livesync/i, "the loop contract must ride in the tool response");

    const again = parse(await admin.callTool({ name: "start_preview", arguments: { app: "app-local", share: { access: "public" } } }));
    assert.equal(again.ok, true);
    assert.equal(again.alreadyRunning, true);
    assert.equal(again.url, first.url, "the app's viewer url must be stable");
    await admin.close();
  });

  it("preview_status and restart_preview resolve by app id and keep the url", async () => {
    const admin = await client(ADMIN);
    const started = parse(await admin.callTool({ name: "start_preview", arguments: { app: "app-local", share: { access: "public" } } }));
    const ready = await waitReadyByApp(admin, "app-local");
    assert.equal(ready.url, started.url);

    const restarted = parse(await admin.callTool({ name: "restart_preview", arguments: { app: "app-local", share: { access: "public" } } }));
    assert.equal(restarted.ok, true);
    assert.equal(restarted.url, started.url, "restart must keep the same viewer url");
    assert.match(String(restarted.nextStep), /unchanged/);
    await admin.close();
  });

  it("status/restart for an app with no running preview return an actionable no_preview", async () => {
    const admin = await client(ADMIN);
    const res = parse(await admin.callTool({ name: "preview_status", arguments: { app: "app-b" } }));
    assert.equal(res.ok, false);
    const err = res.error as { code: string; hint?: string };
    assert.equal(err.code, "no_preview");
    assert.match(String(err.hint), /start_preview/);
    await admin.close();
  });
});

// ---------------------------------------------------------------------------
// Web previews: a device-less local dev server, reverse-proxied through the
// share URL. start_preview needs no devices; screenshot has no target.
// ---------------------------------------------------------------------------

describe("web previews (device-less, local dev server)", () => {
  it("start_preview of a web app is local, needs no devices, and hands over a stable url", async () => {
    const admin = await client(ADMIN);
    const res = parse(await admin.callTool({ name: "start_preview", arguments: { app: "app-web", share: { access: "public" } } })) as {
      ok: boolean;
      source?: string;
      url?: string;
      devices?: { deviceId: string }[];
      nextStep?: string;
    };
    assert.equal(res.ok, true);
    assert.equal(res.source, "local");
    assert.match(String(res.url), /^https:\/\/mate\.example\.com\/s\//);
    assert.equal(res.devices?.length, 1, "a web preview has exactly one pseudo-device");
    assert.equal(res.devices?.[0]?.deviceId, "web-0");
    assert.match(String(res.nextStep), /hot-reload|dev server/i);
    await admin.close();
  });

  it("rejects ref/pr for a web app (it previews local files only)", async () => {
    const admin = await client(ADMIN);
    const res = parse(await admin.callTool({ name: "start_preview", arguments: { app: "app-web", ref: "main" } })) as {
      ok: boolean;
      error?: { code: string };
    };
    assert.equal(res.ok, false);
    assert.equal(res.error?.code, "web_local_only");
    await admin.close();
  });

  it("a Nuxt (subdomain-hosted) web app with no webHost gets a loopback url + an advisory", async () => {
    const admin = await client(ADMIN);
    const res = parse(await admin.callTool({ name: "start_preview", arguments: { app: "app-web-nuxt", share: { access: "public" } } })) as {
      ok: boolean;
      url?: string;
      nextStep?: string;
    };
    assert.equal(res.ok, true);
    // No webHost configured (test config omits it) → the URL is loopback-only, not /s/… .
    assert.match(String(res.url), /\.localhost/);
    assert.doesNotMatch(String(res.url), /\/s\//);
    // …and the response tells the agent exactly why + what to do.
    assert.match(String(res.nextStep), /webHost/);
    await admin.close();
  });

  it("screenshot on a web preview fails with a clear, actionable error", async () => {
    const admin = await client(ADMIN);
    const started = parse(await admin.callTool({ name: "start_preview", arguments: { app: "app-web", share: { access: "public" } } })) as {
      previewId: string;
    };
    const ready = await waitReadyByApp(admin, "app-web");
    assert.ok(ready.url);
    const shot = parse(await admin.callTool({ name: "screenshot", arguments: { previewId: started.previewId, deviceId: "web-0" } })) as {
      ok: boolean;
      error?: { code: string; message: string };
    };
    assert.equal(shot.ok, false);
    assert.match(String(shot.error?.message), /web preview/i);
    await admin.close();
  });
});

// ---------------------------------------------------------------------------
// Share PIN protection: start_preview forces the PIN-or-public choice, and the
// per-app PIN (set via start_preview or set_pin) is reflected by the proxy gate.
// ---------------------------------------------------------------------------

describe("share PIN protection", () => {
  it("start_preview forces the access choice and a valid PIN", async () => {
    const admin = await client(ADMIN);
    const noShare = parse(await admin.callTool({ name: "start_preview", arguments: { app: "app-local" } }));
    assert.equal(noShare.ok, false);
    assert.equal((noShare.error as { code: string }).code, "needs_access_choice");

    const noPin = parse(await admin.callTool({ name: "start_preview", arguments: { app: "app-local", share: { access: "pin" } } }));
    assert.equal((noPin.error as { code: string }).code, "needs_pin");

    const badPin = parse(await admin.callTool({ name: "start_preview", arguments: { app: "app-local", share: { access: "pin", pin: "12" } } }));
    assert.equal((badPin.error as { code: string }).code, "needs_pin");
    await admin.close();
  });

  it("access:pin protects the share (proxy /state locks); set_pin removes it", async () => {
    const admin = await client(ADMIN);
    const started = parse(await admin.callTool({ name: "start_preview", arguments: { app: "app-local", share: { access: "pin", pin: "4821" } } })) as {
      ok: boolean;
      shareId: string;
    };
    assert.equal(started.ok, true);
    const locked = (await (await fetch(`${base}/s/${started.shareId}/state`)).json()) as { locked?: boolean; pinLength?: number };
    assert.equal(locked.locked, true);
    assert.equal(locked.pinLength, 4);

    const removed = parse(await admin.callTool({ name: "set_pin", arguments: { app: "app-local", remove: true } })) as { ok: boolean; protected?: boolean };
    assert.equal(removed.ok, true);
    assert.equal(removed.protected, false);
    const open = (await (await fetch(`${base}/s/${started.shareId}/state`)).json()) as { locked?: boolean };
    assert.equal(open.locked, false);
    await admin.close();
  });

  it("set_pin adds a PIN to an already-running preview later", async () => {
    const admin = await client(ADMIN);
    const started = parse(await admin.callTool({ name: "start_preview", arguments: { app: "app-local", share: { access: "public" } } })) as { shareId: string };
    const set = parse(await admin.callTool({ name: "set_pin", arguments: { app: "app-local", pin: "135790" } })) as { protected?: boolean };
    assert.equal(set.protected, true);
    const after = (await (await fetch(`${base}/s/${started.shareId}/state`)).json()) as { locked?: boolean; pinLength?: number };
    assert.equal(after.locked, true);
    assert.equal(after.pinLength, 6);
    await admin.callTool({ name: "set_pin", arguments: { app: "app-local", remove: true } }); // cleanup
    await admin.close();
  });
});

describe("agent-driven testing tools (describe/ui + test runs)", () => {
  it("drives describe/ui and records a test run end-to-end over MCP", async () => {
    const admin = await client(ADMIN);
    const started = parse(await admin.callTool({ name: "start_preview", arguments: { app: "app-local", share: { access: "public" } } }));
    const previewId = started.previewId as string;
    await waitReadyByApp(admin, "app-local");

    // preview_status carries a testing hint once ready, and the deviceId to drive.
    const st = parse(await admin.callTool({ name: "preview_status", arguments: { app: "app-local" } }));
    assert.match(String(st.testingHint), /describe/);
    const status = st.status as { ready: boolean; devices: { deviceId: string }[] };
    const deviceId = status.devices[0]!.deviceId;

    const desc = parse(await admin.callTool({ name: "describe", arguments: { previewId, deviceId, interactiveOnly: true } }));
    assert.equal(desc.ok, true);
    assert.ok(desc.describe, "describe returns the accessibility tree");

    // logs reads the device's captured build/dev-server output (defaults to `build`).
    const logs = parse(await admin.callTool({ name: "logs", arguments: { previewId, deviceId } }));
    assert.equal(logs.ok, true);
    assert.equal(logs.source, "build");
    assert.equal(typeof logs.log, "string");
    // Unknown device is a structured, actionable failure — not a throw.
    const badLogs = parse(await admin.callTool({ name: "logs", arguments: { previewId, deviceId: "nope-0" } }));
    assert.equal(badLogs.ok, false);
    assert.equal((badLogs.error as { code: string }).code, "unknown_device");

    const tapped = parse(await admin.callTool({ name: "ui", arguments: { previewId, deviceId, action: { type: "tap", x: 0.5, y: 0.5 } } }));
    assert.equal(tapped.ok, true);

    const run = parse(await admin.callTool({ name: "start_test_run", arguments: { previewId, title: "Smoke", steps: ["Open", "Tap"] } }));
    assert.equal(run.ok, true);
    assert.ok(run.runId);

    assert.equal(parse(await admin.callTool({ name: "update_test_run", arguments: { previewId, step: { n: 1, status: "passed" } } })).ok, true);
    const fin = parse(await admin.callTool({ name: "finish_test_run", arguments: { previewId, status: "passed", summary: "all good" } }));
    assert.equal(fin.ok, true);
    await admin.close();
  });

  it("rejects ui/test-run tools for a member without access to the preview's app", async () => {
    const admin = await client(ADMIN);
    const started = parse(await admin.callTool({ name: "start_preview", arguments: { app: "app-b", ref: "main", devices: [{ platform: "ios" }], share: { access: "public" } } }));
    const previewId = started.previewId as string;
    await admin.close();

    const member = await client(MEMBER); // scoped to "ainfrastructure"; app-b is "other-org"
    const desc = parse(await member.callTool({ name: "describe", arguments: { previewId, deviceId: "ios-0" } }));
    assert.equal(desc.ok, false);
    assert.equal((desc.error as { code: string }).code, "forbidden");
    const run = parse(await member.callTool({ name: "start_test_run", arguments: { previewId, title: "x" } }));
    assert.equal(run.ok, false);
    const logs = parse(await member.callTool({ name: "logs", arguments: { previewId, deviceId: "ios-0" } }));
    assert.equal(logs.ok, false);
    assert.equal((logs.error as { code: string }).code, "forbidden");
    await member.close();
  });
});
