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
  { id: "app-a", repo: "github.com/ainfrastructure/a", type: "react-native", defaultBranch: "main", bundleId: "com.a", env: {} },
  { id: "app-b", repo: "github.com/other-org/b", type: "react-native", defaultBranch: "main", bundleId: "com.b", env: {} },
  { id: "app-local", path: localDir, type: "nativescript", defaultBranch: "main", bundleId: "org.ns.local", env: {} },
  { id: "app-web", path: webDir, type: "web", defaultBranch: "main", env: {} },
  { id: "app-web-nuxt", path: webNuxtDir, type: "web", defaultBranch: "main", env: {} },
];

const ADMIN = "a".repeat(64);
const MEMBER = "b".repeat(64);
/** A member with no `owners` — the common shape, and the one the repo gate used to wave through. */
const UNSCOPED = "c".repeat(64);
const tokens: TokenEntry[] = [
  { name: "admin", role: "admin", token: ADMIN },
  { name: "kari", role: "member", owners: ["ainfrastructure"], token: MEMBER },
  { name: "ola", role: "member", token: UNSCOPED },
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
      localBranch: async () => "main",
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
    metro: { ensure: async () => ({ manifestUrl: "http://127.0.0.1:8081" }), stop: async () => {}, stopApp: async () => {} } as unknown as PreviewEngineDeps["metro"],
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
let engine: PreviewEngine;

before(async () => {
  const { createServer } = await import("node:http");
  engine = fakeEngine();
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

  it("an extra pane with nothing named and no migratesFrom asks for a source (no devices booted)", async () => {
    const admin = await client(ADMIN);
    const res = parse(await admin.callTool({ name: "start_preview", arguments: { app: "app-a", alongside: [{}], share: { access: "public" } } }));
    assert.equal(res.ok, false);
    assert.equal((res.error as { code: string }).code, "needs_reference");
    assert.match(String((res.error as { hint?: string }).hint), /alongside|migratesFrom/);
    await admin.close();
  });

  it("an extra pane from an arbitrary repo requires a ref (no devices booted)", async () => {
    const admin = await client(ADMIN);
    const res = parse(await admin.callTool({ name: "start_preview", arguments: { app: "app-a", alongside: [{ repo: "acme/proj" }], share: { access: "public" } } }));
    assert.equal(res.ok, false);
    assert.equal((res.error as { code: string }).code, "needs_ref");
    await admin.close();
  });

  it("an extra pane does not let a scoped member escape owner scoping or the admin gate", async () => {
    // start_preview is a member-role tool, and the worktree/repo branches used
    // to skip resolveApp() entirely — so a token scoped to one org could clone
    // any repo deckhand can read, run its install scripts, and publish a
    // PIN-less share of the live simulator. That is the exact capability
    // requireAdmin() guards on add_app. Folding compare_start into start_preview
    // moved these branches onto a tool every member can already call, so the
    // gates matter more here, not less.
    const member = await client(MEMBER);

    const worktree = parse(
      await member.callTool({
        name: "start_preview",
        arguments: { app: "app-a", alongside: [{ worktree: "/tmp/anything" }], share: { access: "public" } },
      }),
    );
    assert.equal(worktree.ok, false);
    assert.equal((worktree.error as { code: string }).code, "forbidden");

    const repo = parse(
      await member.callTool({
        name: "start_preview",
        arguments: { app: "app-a", alongside: [{ repo: "acme/proj", ref: "main" }], share: { access: "public" } },
      }),
    );
    assert.equal(repo.ok, false, "acme is outside this token's owners");
    assert.equal((repo.error as { code: string }).code, "forbidden");

    await member.close();
  });

  it("an UNSCOPED member cannot build an arbitrary repo either", async () => {
    // canAccessApp returns true for a principal with no `owners` — right for
    // registered apps, wrong here, where the whole point is reaching past the
    // registered set. Cloning an arbitrary repo runs its install and build
    // scripts as the deckhand user, which is the capability requireAdmin()
    // guards on the worktree branch. Leaving `owners` unset must not buy it.
    const member = await client(UNSCOPED);
    const res = parse(
      await member.callTool({
        name: "start_preview",
        arguments: { app: "app-a", alongside: [{ repo: "acme/proj", ref: "main" }], share: { access: "public" } },
      }),
    );
    assert.equal(res.ok, false);
    assert.equal((res.error as { code: string }).code, "forbidden");
    assert.deepEqual(engine.list().map((p) => p.previewId), [], "and nothing was booted");
    await member.close();
  });

  it("an extra pane of the same app boots on a distinct shareId (no self-pair)", async () => {
    const admin = await client(ADMIN);
    const res = parse(await admin.callTool({ name: "start_preview", arguments: { app: "app-a", alongside: [{ app: "app-a" }], share: { access: "public" } } }));
    assert.equal(res.ok, true);
    const extra = (res.alongside as { shareId: string }[])[0]!;
    assert.ok(extra.shareId);
    assert.notEqual(extra.shareId, res.shareId); // the pane must not collide with this app's own shareId
    await admin.callTool({ name: "stop_preview", arguments: { previewId: res.previewId as string } }); // cascades to the reference
    await admin.close();
  });

  it("gives an extra pane the page's PIN instead of publishing it", async () => {
    // Panes used to boot public unconditionally: a PIN-protected page published
    // half of itself on a second URL, because there was no cross-share unlock and
    // a protected pane would have hung on "Connecting…". There is one now, so the
    // pane must be gated too — otherwise the padlock on the page is a lie.
    const admin = await client(ADMIN);
    const res = parse(
      await admin.callTool({
        name: "start_preview",
        arguments: { app: "app-a", alongside: [{ app: "app-a" }], share: { access: "pin", pin: "1234" } },
      }),
    );
    assert.equal(res.ok, true);
    const extra = (res.alongside as { shareId: string }[])[0]!;
    assert.equal(engine.pinInfoForShare(res.shareId as string).required, true, "the page is gated");
    assert.equal(engine.pinInfoForShare(extra.shareId).required, true, "and so is its extra pane");
    // …and one PIN reaches both, or the pane is gated into uselessness.
    assert.deepEqual(engine.pairedShareIds(res.shareId as string), [extra.shareId]);

    await admin.callTool({ name: "stop_preview", arguments: { previewId: res.previewId as string } });
    await admin.close();
  });

  it("never lets a public page reuse (and strip) a protected page's pane", async () => {
    // A pane's synthetic app id comes from its CONTENT, so two pages comparing
    // against the same source used to share one pane and one PIN. A public page
    // reusing a protected one called setAppPin(null) and quietly published
    // someone else's protected content; with two different PINs it revoked their
    // viewers' cookies mid-session instead. Access class is now part of the
    // pane's identity, so the two can never meet.
    const admin = await client(ADMIN);
    const locked = parse(
      await admin.callTool({
        name: "start_preview",
        arguments: { app: "app-a", alongside: [{ app: "app-a" }], share: { access: "pin", pin: "1234" } },
      }),
    );
    assert.equal(locked.ok, true);
    const lockedPane = (locked.alongside as { shareId: string }[])[0]!;
    assert.equal(engine.pinInfoForShare(lockedPane.shareId).required, true);

    const open = parse(
      await admin.callTool({
        name: "start_preview",
        arguments: { app: "app-b", alongside: [{ app: "app-a" }], share: { access: "public" } },
      }),
    );
    assert.equal(open.ok, true);
    const openPane = (open.alongside as { shareId: string }[])[0]!;

    assert.notEqual(openPane.shareId, lockedPane.shareId, "the public page gets its own pane");
    assert.equal(engine.pinInfoForShare(lockedPane.shareId).required, true, "and the protected pane stays protected");

    for (const r of [locked, open]) await admin.callTool({ name: "stop_preview", arguments: { previewId: r.previewId as string } });
    await admin.close();
  });

  it("leaves an extra pane public when the page itself is public", async () => {
    const admin = await client(ADMIN);
    const res = parse(
      await admin.callTool({ name: "start_preview", arguments: { app: "app-a", alongside: [{ app: "app-a" }], share: { access: "public" } } }),
    );
    assert.equal(res.ok, true);
    const extra = (res.alongside as { shareId: string }[])[0]!;
    assert.equal(engine.pinInfoForShare(extra.shareId).required, false, "a public page must not gate a pane behind a PIN nobody has");
    await admin.callTool({ name: "stop_preview", arguments: { previewId: res.previewId as string } });
    await admin.close();
  });

  it("tears the extra panes back down when the main boot fails (no orphaned devices)", async () => {
    // The extra panes boot first and take devices. If the main boot then throws —
    // most likely BECAUSE of device capacity — leaving them up permanently holds
    // the slots that caused the failure, with no MCP handle to reach them.
    const admin = await client(ADMIN);
    const devices = Array.from({ length: 4 }, () => ({ platform: "ios" as const })); // 4 + 4 > maxTotalDevices 6
    const args = { app: "app-a", alongside: [{ app: "app-a" }], devices, share: { access: "public" } };
    const res = await admin.callTool({ name: "start_preview", arguments: args });
    // NOT `res.isError ||` — an unknown tool name is also an isError, so that
    // form would pass vacuously if this tool were ever renamed again.
    assert.equal(parse(res).ok, false, "the main boot must fail on capacity");

    for (let i = 0; i < 100 && engine.list().length > 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(engine.list().map((p) => p.previewId), [], "no pane may survive the failed call");

    // ...and the freed capacity is usable again.
    const after = parse(await admin.callTool({ name: "start_preview", arguments: { app: "app-a", ref: "main", devices, share: { access: "public" } } }));
    assert.equal(after.ok, true);
    await admin.callTool({ name: "stop_preview", arguments: { previewId: after.previewId as string } });
    await admin.close();
  });

  it("denies a preview whose app is no longer registered, and still allows an extra pane", async () => {
    // previewOwnedByPrincipal used to SKIP the scope check when apps.find()
    // missed, so any valid token could drive `logs` / `ui` / `stop_preview` on
    // an orphaned preview. It now denies by default — and a compare reference
    // (synthetic app id, never in apps.yaml, public by construction) stays
    // reachable only because it is marked as a reference on the record.
    const admin = await client(ADMIN);
    const member = await client(MEMBER);

    // An extra pane: allowed, and marked as such on the record rather than inferred.
    const cmp = parse(await admin.callTool({ name: "start_preview", arguments: { app: "app-a", alongside: [{ app: "app-a" }], share: { access: "public" } } }));
    assert.equal(cmp.ok, true);
    const refId = engine
      .list()
      .map((p) => p.previewId)
      .find((id) => id !== cmp.previewId && (engine.appIdFor(id) ?? "").startsWith("cmp-"));
    assert.ok(refId, "the compare reference booted");
    assert.equal(engine.isReference(refId), true);
    assert.equal(engine.isReference(cmp.previewId as string), false);

    // An orphan: app-a's preview, with app-a no longer registered.
    const own = parse(await admin.callTool({ name: "start_preview", arguments: { app: "app-a", ref: "main", devices: [{ platform: "ios" }], share: { access: "public" } } }));
    assert.equal(own.ok, true);
    const idx = apps.findIndex((a) => a.id === "app-a");
    const [removed] = apps.splice(idx, 1);
    try {
      const orphan = parse(await member.callTool({ name: "logs", arguments: { previewId: own.previewId as string } }));
      assert.equal(orphan.ok, false, "an orphaned preview must not be driveable");
      assert.equal((orphan.error as { code: string }).code, "forbidden");
    } finally {
      apps.splice(idx, 0, removed!);
    }

    await member.close();
    await admin.callTool({ name: "stop_preview", arguments: { previewId: cmp.previewId as string } });
    await admin.callTool({ name: "stop_preview", arguments: { previewId: own.previewId as string } });
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
      localBranch: async () => "main",
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

  it("a failed start_preview does not leave the running share un-protected", async () => {
    // The PIN is applied BEFORE the boot (the share url is stable per app), so a
    // boot that throws afterwards must roll it back — otherwise the still-live
    // share of this app silently goes public.
    const admin = await client(ADMIN);
    const started = parse(await admin.callTool({ name: "start_preview", arguments: { app: "app-local", share: { access: "pin", pin: "1234" } } }));
    assert.equal(started.ok, true);
    const shareId = String(started.shareId);
    assert.equal(engine.pinInfoForShare(shareId).required, true);

    // Two iOS devices on a local app is rejected inside startPreview.
    const failed = parse(
      await admin.callTool({
        name: "start_preview",
        arguments: { app: "app-local", share: { access: "public" }, devices: [{ platform: "ios" }, { platform: "ios" }] },
      }),
    );
    assert.equal(failed.ok, false);
    assert.equal(engine.pinInfoForShare(shareId).required, true, "the live share must still be PIN-protected");

    await admin.callTool({ name: "start_preview", arguments: { app: "app-local", share: { access: "public" } } });
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
    const res = parse(await admin.callTool({ name: "start_preview", arguments: { app: "app-web", share: { access: "pin", pin: "4321" } } })) as {
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

  it("refuses to share a web app publicly, at the tool AND at the engine", async () => {
    // A mobile share exposes four allow-listed helper subpaths; a web share
    // exposes the dev server's whole route surface, and a subdomain-hosted
    // framework serves at a bare public hostname with no shareId in the URL.
    const admin = await client(ADMIN);
    const res = parse(await admin.callTool({ name: "start_preview", arguments: { app: "app-web", share: { access: "public" } } }));
    assert.equal(res.ok, false);
    assert.equal((res.error as { code: string }).code, "web_needs_pin");

    // The engine holds the line on its own, so no other caller can route around
    // it. A fresh app id, so no PIN from an earlier test is in force for it.
    const webApp = { ...apps.find((a) => a.id === "app-web")!, id: "app-web-unpinned" };
    assert.throws(
      () => engine.startPreview({ app: webApp, source: "local", devices: [{ platform: "web" }], access: "public" }),
      /needs a share PIN/,
    );

    // And a live web share can't be un-protected after the fact.
    const started = parse(await admin.callTool({ name: "start_preview", arguments: { app: "app-web", share: { access: "pin", pin: "4321" } } }));
    assert.equal(started.ok, true);
    const unlocked = parse(await admin.callTool({ name: "set_pin", arguments: { app: "app-web", remove: true } }));
    assert.equal(unlocked.ok, false, "removing the PIN of a live web share must fail");
    await admin.callTool({ name: "stop_preview", arguments: { previewId: started.previewId as string } });
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
    const res = parse(await admin.callTool({ name: "start_preview", arguments: { app: "app-web-nuxt", share: { access: "pin", pin: "4321" } } })) as {
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
    const started = parse(await admin.callTool({ name: "start_preview", arguments: { app: "app-web", share: { access: "pin", pin: "4321" } } })) as {
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

  it("reminds the agent to open a test run while it drives the app untracked", async () => {
    // The whole point of a test run is that the user can watch what is being verified. An
    // agent that never opens one leaves the viewer showing a cursor moving over a silent
    // app — so the reminder has to ride in the outputs, not just in a doc.
    const admin = await client(ADMIN);
    const started = parse(await admin.callTool({ name: "start_preview", arguments: { app: "app-local", share: { access: "public" } } }));
    const previewId = started.previewId as string;
    const deviceId = "ios-0";
    assert.match(String(started.nextStep), /start_test_run/, "the contract must ride in start_preview");

    const ready = parse(await admin.callTool({ name: "preview_status", arguments: { previewId } }));
    if ((ready.status as { ready?: boolean }).ready) {
      assert.match(String(ready.testingHint), /start_test_run/, "and in preview_status once ready");
    }

    const tap = { type: "tap", x: 0.5, y: 0.5 };
    const first = parse(await admin.callTool({ name: "ui", arguments: { previewId, deviceId, action: tap } }));
    assert.equal(first.ok, true);
    assert.match(String(first.hint), /start_test_run/, "driving with no run open must nudge");

    // Once is enough per stretch: a hint repeated on every tap is one the model learns to skip.
    const second = parse(await admin.callTool({ name: "ui", arguments: { previewId, deviceId, action: tap } }));
    assert.equal(second.hint, undefined, "the nudge must not repeat on every action");

    // With a run open there is nothing to remind about — the viewer already shows the steps.
    assert.equal(parse(await admin.callTool({ name: "start_test_run", arguments: { previewId, title: "Smoke", steps: ["Tap"] } })).ok, true);
    const tracked = parse(await admin.callTool({ name: "ui", arguments: { previewId, deviceId, action: tap } }));
    assert.equal(tracked.hint, undefined, "an open run silences the nudge");

    // ...and it re-arms after the run closes, so the next untracked stretch is caught too.
    assert.equal(parse(await admin.callTool({ name: "finish_test_run", arguments: { previewId, status: "passed" } })).ok, true);
    const afterFinish = parse(await admin.callTool({ name: "ui", arguments: { previewId, deviceId, action: tap } }));
    assert.match(String(afterFinish.hint), /start_test_run/, "the nudge must re-arm once the run is closed");

    // A read-only verifier is not what the user is missing — it must stay quiet.
    assert.equal(parse(await admin.callTool({ name: "start_test_run", arguments: { previewId, title: "Second", steps: ["Tap"] } })).ok, true);
    assert.equal(parse(await admin.callTool({ name: "finish_test_run", arguments: { previewId, status: "passed" } })).ok, true);
    const asserted = parse(await admin.callTool({ name: "ui", arguments: { previewId, deviceId, action: { type: "assert", selector: { text: "x" } } } }));
    assert.equal(asserted.hint, undefined, "verifiers must not nudge");
    await admin.close();
  });

  it("tells the agent to close every message with the viewer link", async () => {
    // Relaying the link once, at the top of a long session, buries it: the user ends up
    // scrolling back through everything written since to find the sim again.
    const admin = await client(ADMIN);
    const started = parse(await admin.callTool({ name: "start_preview", arguments: { app: "app-local", share: { access: "public" } } }));
    const previewId = started.previewId as string;
    const url = started.url as string;
    const carriesFooter = (s: unknown): boolean => String(s).includes("End EVERY message") && String(s).includes(url);

    assert.ok(carriesFooter(started.nextStep), "start_preview must carry the link footer");

    // The already-running branch is where a resumed session lands — it needs it most.
    const again = parse(await admin.callTool({ name: "start_preview", arguments: { app: "app-local", share: { access: "public" } } }));
    assert.equal(again.alreadyRunning, true);
    assert.ok(carriesFooter(again.nextStep), "the alreadyRunning branch must carry it too");

    await waitReadyByApp(admin, "app-local");
    const st = parse(await admin.callTool({ name: "preview_status", arguments: { previewId } }));
    assert.ok(carriesFooter(st.testingHint), "preview_status must carry it once ready");

    // finish_test_run is the one moment the agent is certain to be writing a long message.
    await admin.callTool({ name: "start_test_run", arguments: { previewId, title: "Smoke", steps: ["Tap"] } });
    const fin = parse(await admin.callTool({ name: "finish_test_run", arguments: { previewId, status: "passed" } }));
    assert.ok(carriesFooter(fin.nextStep), "finish_test_run must carry it");

    const restarted = parse(await admin.callTool({ name: "restart_preview", arguments: { previewId } }));
    assert.ok(carriesFooter(restarted.nextStep), "restart_preview must carry it");
    await admin.close();
  });

  it("will not let a run with a failed step be recorded as passed", async () => {
    // Otherwise the dock button settles to a green ✓ while the popover lists a red ✗ — the
    // viewer faithfully rendering a contradiction, and the user reading a pass that wasn't one.
    const admin = await client(ADMIN);
    const started = parse(await admin.callTool({ name: "start_preview", arguments: { app: "app-local", share: { access: "public" } } }));
    const previewId = started.previewId as string;
    await admin.callTool({ name: "start_test_run", arguments: { previewId, title: "Tab bar", steps: ["Home", "Wash", "Stations"] } });

    // Mid-run, the update tells the agent what it still has outstanding.
    await admin.callTool({ name: "update_test_run", arguments: { previewId, step: { n: 1, status: "passed" } } });
    const mid = parse(await admin.callTool({ name: "update_test_run", arguments: { previewId, step: { n: 2, status: "failed" } } }));
    assert.deepEqual(mid.steps, { total: 3, passed: 1, failed: 1, pending: 1, running: 0 });
    assert.match(String(mid.nextStep), /still unmarked/);
    assert.match(String(mid.nextStep), /must finish as "failed"/);

    const fin = parse(await admin.callTool({ name: "finish_test_run", arguments: { previewId, status: "passed", summary: "looks fine" } }));
    assert.equal(fin.ok, true);
    assert.equal(fin.status, "failed", "the verdict must follow the steps, not the agent's optimism");
    assert.match(String(fin.nextStep), /Recorded as FAILED/);
    assert.match(String(fin.nextStep), /never marked/, "and unmarked steps must be called out");

    // An honest pass is left exactly as the agent reported it.
    await admin.callTool({ name: "start_test_run", arguments: { previewId, title: "Clean", steps: ["Only"] } });
    await admin.callTool({ name: "update_test_run", arguments: { previewId, step: { n: 1, status: "passed" } } });
    const clean = parse(await admin.callTool({ name: "finish_test_run", arguments: { previewId, status: "passed" } }));
    assert.equal(clean.status, "passed");
    assert.doesNotMatch(String(clean.nextStep), /Recorded as FAILED|never marked/);
    await admin.close();
  });

  it("clears a run so a stale or wrongly-recorded verdict can be taken off screen", async () => {
    const admin = await client(ADMIN);
    const started = parse(await admin.callTool({ name: "start_preview", arguments: { app: "app-local", share: { access: "public" } } }));
    const previewId = started.previewId as string;
    await admin.callTool({ name: "start_test_run", arguments: { previewId, title: "Stale", steps: ["One"] } });
    await admin.callTool({ name: "finish_test_run", arguments: { previewId, status: "passed" } });

    const cleared = parse(await admin.callTool({ name: "clear_test_run", arguments: { previewId } }));
    assert.equal(cleared.ok, true);
    assert.equal(cleared.cleared, true);
    assert.match(String(cleared.nextStep), /start_test_run/, "and it points at reopening one before driving again");

    // Gone from the share state, which is what the viewer renders.
    const st = parse(await admin.callTool({ name: "preview_status", arguments: { previewId } }));
    assert.equal((st.status as { testRun?: unknown }).testRun, undefined);

    // Clearing nothing is a calm no-op, not an error.
    const again = parse(await admin.callTool({ name: "clear_test_run", arguments: { previewId } }));
    assert.equal(again.ok, true);
    assert.equal(again.cleared, false);
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
