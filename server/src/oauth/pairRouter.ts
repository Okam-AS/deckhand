import express from "express";
import { bearerToken, type TokenAuthenticator } from "../auth.ts";
import type { OAuthStore } from "./store.ts";
import type { PairingStore } from "./pairing.ts";

/**
 * The operator's side of pairing: see what is waiting, and say yes or no.
 *
 * Reachable through the tunnel like everything else, so it is NOT protected by being loopback —
 * it is protected by `tokens.yaml`, the credential you can only get by being at the machine
 * (`deckhand token`). That asymmetry is the whole design: the public half parks requests and
 * proves nothing, this half decides and needs the local secret.
 *
 * An OAuth grant deliberately cannot approve. A connector that talked its way in once would
 * otherwise be able to wave the next one through, which turns one approval into a standing
 * one — the opposite of what the operator agreed to.
 */
export interface PairRouterDeps {
  store: OAuthStore;
  pairing: PairingStore;
  auth: TokenAuthenticator;
}

export function createPairRouter(deps: PairRouterDeps): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: "16kb" }));

  router.use((req, res, next) => {
    const token = bearerToken(req.header("authorization"));
    if (!token || !deps.auth.authenticate(token)) {
      // No hint about what a valid credential looks like: this endpoint is public
      // and the answer is the same to everyone who has not got one.
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  });

  router.get("/pending", (_req, res) => {
    res.json({ pending: deps.pairing.pending() });
  });

  router.post("/approve", (req, res) => {
    const code = typeof (req.body as { code?: unknown })?.code === "string" ? (req.body as { code: string }).code : "";
    const approved = deps.pairing.approve(code, (p) =>
      deps.store.mintCode({ clientId: p.clientId, redirectUri: p.redirectUri, label: p.clientName, codeChallenge: p.codeChallenge }),
    );
    if (!approved) {
      res.status(404).json({ error: "no_such_request", detail: "no request is waiting with that code — it may have expired" });
      return;
    }
    res.json({ approved: { code: approved.code, clientName: approved.clientName } });
  });

  router.post("/deny", (req, res) => {
    const code = typeof (req.body as { code?: unknown })?.code === "string" ? (req.body as { code: string }).code : "";
    const denied = deps.pairing.deny(code);
    if (!denied) {
      res.status(404).json({ error: "no_such_request", detail: "no request is waiting with that code — it may have expired" });
      return;
    }
    res.json({ denied: { code: denied.code, clientName: denied.clientName } });
  });

  router.get("/connections", (_req, res) => {
    res.json({ connections: deps.store.activeClients() });
  });

  router.post("/revoke", (req, res) => {
    const clientId = typeof (req.body as { clientId?: unknown })?.clientId === "string" ? (req.body as { clientId: string }).clientId : "";
    const dropped = deps.store.revokeClient(clientId);
    res.json({ revoked: dropped });
  });

  return router;
}
