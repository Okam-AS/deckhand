import { createServer as createHttpServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import { WebSocketServer } from "ws";
import { loadConfig, loadApps, loadTokens, githubPatPath, resolveShareSecret, type App, type Config } from "./config.ts";
import { watchApps } from "./appsWatcher.ts";
import { TokenAuthenticator } from "./auth.ts";
import { AuditLog } from "./audit.ts";
import { StateStore } from "./state.ts";
import { PreviewEngine } from "./engine/preview.ts";
import { WorktreeManager } from "./engine/worktree.ts";
import { MetroManager } from "./engine/metro.ts";
import { Simctl } from "./devices/ios.ts";
import { AndroidManager } from "./devices/android.ts";
import { ServeSimBackend } from "./streaming/serveSim.ts";
import { AndroidAdbBackend } from "./streaming/androidAdb.ts";
import { WebBackend } from "./streaming/web.ts";
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
}

/** Build the Express app (no listener). Split out so tests can inject deps. */
export function createApp(deps: AppDeps): express.Application {
  const app = express();
  app.disable("x-powered-by");

  // Subdomain-web hosting: a request whose Host is a live <hostId>.<hostname>
  // preview is reverse-proxied to its dev server (at root) before any apex route
  // is considered. Non-matching hosts (the apex) fall straight through.
  app.use(createHostWebProxyMiddleware(deps.engine, deps.pinGate));

  app.get("/healthz", (_req, res) => res.json({ ok: true, ...serverInfo() }));

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
    // Subdomain-web HMR sockets first (matched by Host), then apex share sockets.
    if (handleHostWebUpgrade(engine, pinGate, wss, req, socket, head)) return;
    if (!handleShareUpgrade(engine, pinGate, wss, req, socket, head)) {
      socket.destroy(); // no other upgrade routes
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
  const apps = loadApps();
  const tokens = loadTokens();

  const [lo, hi] = config.streaming.serveSim.helperPortRange;
  const mid = Math.floor((lo + hi) / 2);
  const streaming = new StreamingRouter(
    new ServeSimBackend({ portRange: [lo, mid] }),
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
    auth: new TokenAuthenticator(tokens),
    pinGate,
    viewerDist,
    persistApps: writeApps,
    setup: { store: new SetupStore(), patPath: githubPatPath(config) },
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
      // Registering an app must not cost a restart — a restart tears down every
      // booted simulator on the machine.
      watchApps(apps, {
        onReload: (_apps, { added, removed }) => {
          for (const id of added) console.log(`apps.yaml: registered "${id}"`);
          for (const id of removed) console.log(`apps.yaml: removed "${id}"`);
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
