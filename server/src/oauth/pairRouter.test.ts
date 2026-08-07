import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { TokenAuthenticator } from "../auth.ts";
import { createPairRouter } from "./pairRouter.ts";
import { PairingStore } from "./pairing.ts";
import { OAuthStore } from "./store.ts";

const LOCAL = "local-credential-value";

let base: string;
let server: Server;
let store: OAuthStore;
let pairing: PairingStore;

before(async () => {
  const app = express();
  app.use(
    "/pair",
    createPairRouter({
      get store() {
        return store;
      },
      get pairing() {
        return pairing;
      },
      auth: new TokenAuthenticator([{ name: "me", token: LOCAL }]),
    }),
  );
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());

beforeEach(() => {
  store = new OAuthStore({ persist: false });
  pairing = new PairingStore();
});

const call = (path: string, token?: string, body?: unknown): Promise<Response> =>
  fetch(`${base}/pair/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("the operator's half of pairing", () => {
  // This endpoint rides the same public tunnel as the parking half. If it ever answered without
  // the local credential, holding the connector URL would be enough to approve your own request
  // — the whole mechanism inverted.
  it("refuses every route without the local credential", async () => {
    for (const [path, body] of [
      ["connections", undefined],
      ["code", {}],
      ["revoke", { clientId: "c1" }],
    ] as const) {
      assert.equal((await call(path, undefined, body)).status, 401, `${path} must refuse`);
      assert.equal((await call(path, "not-the-token", body)).status, 401, `${path} must refuse a wrong credential`);
    }
    assert.equal(pairing.outstanding(), null, "and none of that may have minted anything");
  });

  it("mints a code, and only for the credential that asked", async () => {
    const res = await call("code", LOCAL, {});
    assert.equal(res.status, 200);
    const { code, expiresMs } = (await res.json()) as { code: string; expiresMs: number };
    assert.match(code, /^[A-Z0-9]{3}-[A-Z0-9]{3}$/);
    assert.ok(expiresMs > Date.now(), "a code that is already expired is a support ticket");
    assert.ok(pairing.claim(code), "the minted code is the one the browser can spend");
  });

  it("revokes a client's grants and reports how many went", async () => {
    store.issueGrant({ label: "Claude", clientId: "c1" });
    store.issueGrant({ label: "Other", clientId: "c2" });
    const res = (await (await call("revoke", LOCAL, { clientId: "c1" })).json()) as { revoked: number };
    assert.equal(res.revoked, 1);
    // Keyed by client because a client is what was approved: revoking one connector must not
    // disturb another the same person authorized separately.
    assert.deepEqual(
      store.activeClients().map((c) => c.clientId),
      ["c2"],
    );
  });
});
