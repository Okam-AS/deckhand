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
const REQ = { clientId: "c1", clientName: "Claude", redirectUri: "https://claude.ai/cb", codeChallenge: "chal" };

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
    const parked = pairing.park(REQ)!;
    for (const [path, body] of [
      ["pending", undefined],
      ["connections", undefined],
      ["approve", { code: parked.code }],
      ["deny", { code: parked.code }],
      ["revoke", { clientId: "c1" }],
    ] as const) {
      assert.equal((await call(path, undefined, body)).status, 401, `${path} must refuse`);
      assert.equal((await call(path, "not-the-token", body)).status, 401, `${path} must refuse a wrong credential`);
    }
    assert.equal(pairing.pending().length, 1, "and none of that may have changed anything");
  });

  it("lists what is waiting, then approves it by code", async () => {
    const parked = pairing.park(REQ)!;
    const listed = (await (await call("pending", LOCAL)).json()) as { pending: { code: string }[] };
    assert.deepEqual(
      listed.pending.map((p) => p.code),
      [parked.code],
    );

    const res = await call("approve", LOCAL, { code: parked.code });
    assert.equal(res.status, 200);
    const taken = pairing.take(parked.id)!;
    assert.equal(taken.status, "approved");
    assert.ok(taken.authCode, "approving is what mints — nothing before it does");
  });

  it("says so rather than inventing a request when the code is unknown", async () => {
    const res = await call("approve", LOCAL, { code: "NOP-E42" });
    assert.equal(res.status, 404);
    assert.match(String(((await res.json()) as { detail: string }).detail), /expired/);
  });

  it("denies without issuing anything", async () => {
    const parked = pairing.park(REQ)!;
    assert.equal((await call("deny", LOCAL, { code: parked.code })).status, 200);
    assert.deepEqual(pairing.poll(parked.id), { status: "denied" });
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
