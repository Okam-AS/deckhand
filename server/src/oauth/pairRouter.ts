import express from "express";
import { bearerToken, type TokenAuthenticator } from "../auth.ts";
import type { OAuthStore } from "./store.ts";
import type { PairingStore } from "./pairing.ts";

/**
 * The operator's side of pairing: mint a code, and manage what it let in.
 *
 * Reachable through the tunnel like everything else, so it is NOT protected by being loopback —
 * it is protected by `tokens.yaml`, the credential you can only get by being at the machine
 * (`deckhand token add <name>`). That asymmetry is the whole design: the public half asks for a code
 * and proves nothing, this half MINTS one and needs the local secret.
 *
 * An OAuth grant deliberately cannot mint. A connector that talked its way in once would
 * otherwise be able to let the next one through, which turns one approval into a standing
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

  // Minting is the whole operator side now: there is no queue to list and nothing to pick.
  router.post("/code", (_req, res) => {
    res.json(deps.pairing.mint());
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
