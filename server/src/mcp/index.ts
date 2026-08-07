import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.ts";
import { bearerToken, type Principal, type TokenAuthenticator } from "../auth.ts";
import type { OAuthStore } from "../oauth/store.ts";
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
  /** Per-person OAuth grants. Absent only in tests that exercise the local credential alone. */
  oauth?: OAuthStore;
  /** Is this address still allowed to connect? Consulted on EVERY request, so removing an address revokes at once. */
  isAllowed?: (email: string) => boolean;
  /** Public origin, for the `WWW-Authenticate` pointer that starts the OAuth flow. */
  baseUrl?: string;
}

/**
 * The `/mcp` router. Stateless: a fresh McpServer + transport per POST, bound to the
 * authenticated principal, whose name the audit trail records.
 *
 * The credential is an `Authorization: Bearer` header and NEVER a path segment. It used
 * to be `/mcp/<token>`, which was safe on the assumption that the connector URL is a
 * secret — and that assumption does not survive Claude Enterprise, where a connector
 * added for the organisation is visible to everyone in it. The whole organisation could
 * therefore read the credential out of the URL and drive this Mac.
 *
 * So: two ways to hold a bearer credential, and both are per-person.
 *   - an OAuth grant, issued only after Cloudflare Access proved an email that is on the
 *     allowlist (`oauth/router.ts`)
 *   - a local tokens.yaml token, which requires already being at the machine
 *
 * A missing or unknown credential → 401 carrying `WWW-Authenticate` with the
 * resource-metadata URL, which is how an MCP client discovers where to authorize. It is
 * deliberately NOT the old silent 404: there is nothing secret about the fact that this
 * endpoint wants OAuth, and without the pointer the client cannot start the flow.
 *
 * GET/DELETE (session semantics) are rejected.
 */
export function createMcpRouter(deps: McpRouterDeps): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: "4mb" }));

  const authenticate = (token: string): Principal | null => {
    const grant = deps.oauth?.authenticate(token);
    if (grant) {
      // Re-checked here rather than only at issuance: `deckhand allow rm` has to
      // take a connector away NOW, not whenever the access token happens to expire.
      if (deps.isAllowed && !deps.isAllowed(grant.email)) return null;
      return { name: grant.email, email: grant.email };
    }
    return deps.auth.authenticate(token);
  };

  router.post("/", async (req, res) => {
    const presented = bearerToken(req.header("authorization"));
    const principal = presented ? authenticate(presented) : null;
    if (!principal) {
      const base = deps.baseUrl ?? "";
      res
        .status(401)
        .set("WWW-Authenticate", `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`)
        .json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized: authorize this connector to get a token" },
          id: null,
        });
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
  router.get("/", rejectStateless);
  router.delete("/", rejectStateless);
  // A client still holding the old `/mcp/<token>` URL gets a 404, not a fallback.
  // Serving it "just this once" would leave the credential-in-the-URL path alive,
  // which is the thing this router was changed to remove.
  router.all("/:legacyToken", (_req, res) => res.status(404).end());
  return router;
}
