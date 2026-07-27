import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.ts";
import type { TokenAuthenticator } from "../auth.ts";
import type { App, Config } from "../config.ts";
import type { PreviewEngine } from "../engine/preview.ts";
import type { AuditLog } from "../audit.ts";
import type { SetupStore } from "../setup/setupStore.ts";
import { serverInfo } from "../meta.ts";

export interface McpRouterDeps {
  engine: PreviewEngine;
  apps: App[];
  config: Config;
  audit: AuditLog;
  auth: TokenAuthenticator;
  persistApps?: (apps: App[]) => void;
  setup?: SetupStore;
}

/**
 * The `/mcp/:token` router. Stateless: a fresh McpServer + transport per POST,
 * bound to the authenticated principal so role/owner-scope are enforced per
 * call. An unknown token → 404 (indistinguishable from a wrong path). GET/DELETE
 * (session semantics) are rejected.
 */
export function createMcpRouter(deps: McpRouterDeps): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: "4mb" }));

  router.post("/:token", async (req, res) => {
    const principal = deps.auth.authenticate(req.params.token);
    if (!principal) {
      res.status(404).end();
      return;
    }
    const server = new McpServer(serverInfo());
    registerTools(server, {
      engine: deps.engine,
      apps: deps.apps,
      config: deps.config,
      principal,
      audit: deps.audit,
      persistApps: deps.persistApps,
      setup: deps.setup,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).end();
    }
  });

  const rejectStateless = (_req: express.Request, res: express.Response) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method Not Allowed (stateless server)" }, id: null });
  };
  router.get("/:token", rejectStateless);
  router.delete("/:token", rejectStateless);
  return router;
}
