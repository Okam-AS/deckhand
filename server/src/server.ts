import { createServer as createHttpServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import { WebSocketServer } from "ws";
import {
  loadConfig,
  loadAppsForBoot,
  loadTokens,
  githubPatPath,
  resolveShareSecret,
  publicBaseUrl,
  type App,
  type Config,
} from "./config.ts";
import { watchApps } from "./appsWatcher.ts";
import { watchTokens } from "./tokensWatcher.ts";
import { TokenAuthenticator } from "./auth.ts";
import { AuditLog } from "./audit.ts";
import { StateStore } from "./state.ts";
import { PreviewEngine } from "./engine/preview.ts";
import { WorktreeManager } from "./engine/worktree.ts";
import { MetroManager } from "./engine/metro.ts";
import { Simctl } from "./devices/ios.ts";
import { AndroidManager } from "./devices/android.ts";
import { PhysicalDeviceScanner } from "./devices/physical.ts";
import { ServeSimBackend, vendoredServeSimBin } from "./streaming/serveSim.ts";
import { AndroidAdbBackend } from "./streaming/androidAdb.ts";
import { WebBackend } from "./streaming/web.ts";
import { refreshVersion, versionStatus } from "./version.ts";
import { StreamingRouter } from "./streaming/router.ts";
import { buildTokenResolver } from "./github/credentials.ts";
import { createMcpRouter } from "./mcp/index.ts";
import {
  createShareRouter,
  createHostWebProxyMiddleware,
  createPinGate,
  handleShareUpgrade,
  handleHostWebUpgrade,
  type PinGate,
} from "./share/proxy.ts";
import { SetupStore } from "./setup/setupStore.ts";
import { createSetupRouter } from "./setup/router.ts";
import { OAuthStore } from "./oauth/store.ts";
import { PairingStore } from "./oauth/pairing.ts";
import { createPairRouter } from "./oauth/pairRouter.ts";
import { createOAuthRouter, createOAuthMetadataRouter } from "./oauth/router.ts";
import { writeApps } from "./cli/configWrite.ts";
import { serverInfo } from "./meta.ts";

export interface AppDeps {
  engine: PreviewEngine;
  apps: App[];
  config: Config;
  audit: AuditLog;
  auth: TokenAuthenticator;
  /** Share PIN gate (cookie validation + throttle). Shared by the routers and the WS upgrade. */
  pinGate: PinGate;
  viewerDist?: string;
  /** Persist apps.yaml after add_app/remove_app. Defaults to a no-op (tests). */
  persistApps?: (apps: App[]) => void;
  /** Credential onboarding: shared nonce store + PAT destination path. */
  setup?: { store: SetupStore; patPath: string };
  /** Connector grants, and the requests waiting for the operator to approve them. */
  connector?: { store: OAuthStore; pairing: PairingStore; baseUrl: string };
}

/** Build the Express app (no listener). Split out so tests can inject deps. */
export function createApp(deps: AppDeps): express.Application {
  const app = express();
  app.disable("x-powered-by");

  // Subdomain-web hosting: a request whose Host is a live <hostId>.<hostname>
  // preview is reverse-proxied to its dev server (at root) before any apex route
  // is considered. Non-matching hosts (the apex) fall straight through.
  app.use(createHostWebProxyMiddleware(deps.engine, deps.pinGate));

  /**
   * Liveness, plus — on loopback only — which commit this process is actually running.
   *
   * The commit is NOT public. This endpoint answers from the internet through the tunnel, and
   * telling a passer-by exactly which build is live is a targeting aid for whatever is fixed
   * in the next one. `doctor` runs on the machine, so loopback is all it needs.
   *
   * It exists because a server too old to report its own staleness cannot warn about itself:
   * the check that says "you pulled, now restart" only runs once you have restarted. doctor
   * is a FRESH process every time, so it always has the newest logic — it can catch a stale
   * server that cannot catch itself.
   */
  app.get("/healthz", (req, res) => {
    const local = req.ip === "127.0.0.1" || req.ip === "::1" || req.ip === "::ffff:127.0.0.1";
    const version = local ? versionStatus() : null;
    res.json({ ok: true, ...serverInfo(), ...(version ? { commit: version.current, describe: version.describe } : {}) });
  });

  // Viewer static assets (Vite emits absolute /assets/... URLs).
  if (deps.viewerDist) app.use(express.static(deps.viewerDist, { index: false }));

  app.use(
    "/mcp",
    createMcpRouter({
      engine: deps.engine,
      apps: deps.apps,
      config: deps.config,
      audit: deps.audit,
      auth: deps.auth,
      persistApps: deps.persistApps,
      setup: deps.setup?.store,
      oauth: deps.connector?.store,
      baseUrl: deps.connector?.baseUrl,
    }),
  );
  app.use("/s", createShareRouter({ engine: deps.engine, pinGate: deps.pinGate, viewerDist: deps.viewerDist }));
  if (deps.setup) app.use("/setup", createSetupRouter({ store: deps.setup.store, patPath: deps.setup.patPath }));

  return app;
}

/** Attach the share WebSocket-input proxy to an http.Server's upgrade event. */
export function attachUpgrade(httpServer: Server, engine: PreviewEngine, pinGate: PinGate): void {
  // Echo the client's first requested subprotocol back in the handshake. A
  // browser that asks for one (Vite HMR asks for "vite-hmr") fails the
  // connection unless the server echoes it; the device input ws requests none.
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => {
      for (const p of protocols) return p;
      return false;
    },
  });
  httpServer.on("upgrade", (req, socket, head) => {
    // An 'upgrade' listener has NO error boundary: express never sees these, so
    // anything thrown here escapes to the process-level handler and the client
    // just gets a dead socket with no status and no log line. The viewer then
    // retries forever showing "Connecting…", which is indistinguishable from a
    // network problem. Contain it, and say so on the way out.
    try {
      // Subdomain-web HMR sockets first (matched by Host), then apex share sockets.
      if (handleHostWebUpgrade(engine, pinGate, wss, req, socket, head)) return;
      if (!handleShareUpgrade(engine, pinGate, wss, req, socket, head)) {
        socket.destroy(); // no other upgrade routes
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      try {
        socket.write(`HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n`);
      } catch {
        /* the socket may already be gone */
      }
      socket.destroy();
      // daemon.log, not the audit trail: this is a server fault, not an actor's
      // action, and the URL is the only handle for finding it again.
      console.error(`ws upgrade threw for ${req.url ?? "?"}: ${msg.slice(0, 200)}`);
    }
  });
}

export interface DeckhandServer {
  app: express.Application;
  httpServer: Server;
  engine: PreviewEngine;
  config: Config;
  listen: () => Promise<void>;
}

/** Assemble the full server from config files under ~/.deckhand. */
export function createServer(): DeckhandServer {
  const config = loadConfig();
  // Never fatal: a server that cannot start cannot be repaired through add_app or the setup
  // URL, which is all a remote agent has. The reason is logged and surfaced through list_apps.
  const { apps, error: appsError } = loadAppsForBoot();
  const tokens = loadTokens();
  // Named, because watchTokens updates THIS instance in place — createApp closes over it.
  const auth = new TokenAuthenticator(tokens);

  const [lo, hi] = config.streaming.serveSim.helperPortRange;
  const mid = Math.floor((lo + hi) / 2);
  const streaming = new StreamingRouter(
    new ServeSimBackend({ portRange: [lo, mid], bin: vendoredServeSimBin() }),
    new AndroidAdbBackend({ portRange: [mid + 1, hi] }),
    new WebBackend(),
  );

  const engine = new PreviewEngine({
    config,
    worktrees: new WorktreeManager({
      tokenResolver: buildTokenResolver(config),
      allowAnonymous: config.allowPublicRepos,
    }),
    simctl: new Simctl(),
    android: new AndroidManager(),
    physical: new PhysicalDeviceScanner(),
    streaming,
    metro: new MetroManager(),
    store: new StateStore(),
    audit: new AuditLog(),
  });

  const pinGate = createPinGate(engine, resolveShareSecret(config));
  const viewerDist = resolveViewerDist();
  const app = createApp({
    engine,
    apps, // mutable + shared: add_app/remove_app edit this array in place
    config,
    audit: new AuditLog(),
    auth,
    pinGate,
    viewerDist,
    persistApps: writeApps,
    setup: { store: new SetupStore(), patPath: githubPatPath(config) },
    connector: { store: new OAuthStore(), pairing: new PairingStore(), baseUrl: publicBaseUrl(config) },
  });
  const httpServer = createHttpServer(app);
  attachUpgrade(httpServer, engine, pinGate);

  return {
    app,
    httpServer,
    engine,
    config,
    listen: async () => {
      // Bind FIRST. The reaper's "an empty preview map means every deckhand-named
      // device is an orphan" assumption only holds if we are the only server, and
      // the port is what proves it: a second `deckhand serve` must die on
      // EADDRINUSE *before* it deletes the running server's sims and AVDs.
      await new Promise<void>((resolve, reject) => {
        // Loopback only: the sole public path in is the Cloudflare tunnel.
        const onError = (err: Error) => reject(err);
        httpServer.once("error", onError);
        httpServer.listen(config.port, "127.0.0.1", () => {
          httpServer.off("error", onError);
          resolve();
        });
      });
      // Now collect whatever the previous process left booted, then keep
      // sweeping idle previews for as long as we run.
      await engine.reapOrphans().catch(() => {});
      engine.startJanitor();
      // Log the running commit, and start the first update check. Not awaited: `ls-remote`
      // is a network call and nothing about serving depends on the answer. It exists so the
      // first tool response after a boot already has something to say.
      // Loud, and next to the listen line, because a server that came up with NO apps looks
      // healthy from the outside and its first `list_apps` looks like a fresh install.
      if (appsError) {
        console.error(`deckhand: apps.yaml could not be loaded — starting with NO registered apps.`);
        console.error(`  ${appsError}`);
        console.error(`  The file is untouched. Fix that entry and deckhand picks it up without a restart.`);
      }
      void refreshVersion().then((v) => {
        if (!v) return;
        console.log(`deckhand ${v.describe}${v.dirty ? " (uncommitted changes)" : ""} on ${v.branch ?? "a detached HEAD"}`);
        if (v.note) console.log(`  ${v.note}`);
      });
      // Registering an app must not cost a restart — a restart tears down every
      // booted simulator on the machine.
      // A token minted while the server runs must work immediately. It did not: setup starts
      // the LaunchAgent and then mints the token, so a brand-new install's only token
      // was invisible until a restart — the connector 404'd and claude.ai reported an OAuth
      // failure for a server that does not use OAuth.
      watchTokens(auth, {
        onReload: (names) => console.log(`tokens.yaml: reloaded (${names.length}: ${names.join(", ")})`),
        onError: (err) => console.error(`tokens.yaml: keeping the previous list — ${(err as Error).message}`),
      });
      watchApps(apps, {
        onReload: (_apps, { added, removed }) => {
          for (const id of added) console.log(`apps.yaml: registered "${id}"`);
          for (const id of removed) {
            console.log(`apps.yaml: removed "${id}"`);
            // Its stable share id and PIN hash are unreachable now; keeping them would grow
            // state.json forever and leave a credential hash on disk for nothing.
            engine.forgetApp(id);
          }
        },
        onError: (err) => console.error(`apps.yaml: keeping the previous list — ${(err as Error).message}`),
      });
    },
  };
}

function resolveViewerDist(): string | undefined {
  const candidate = join(import.meta.dirname, "..", "..", "viewer", "dist");
  try {
    readFileSync(join(candidate, "index.html"));
    return candidate;
  } catch {
    return undefined;
  }
}
