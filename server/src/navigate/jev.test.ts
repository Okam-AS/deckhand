import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { inspect } from "node:util";
import { join } from "node:path";
import { JEV_ENDPOINT, JEV_MODEL, JevClient, JevError } from "./jev.ts";
import { lookupTypesafeKey, typesafeProvider } from "./secrets.ts";

const KEY = "ts-test-key-3f9a7c";

function recorder(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    return new Response(JSON.stringify(r.body), { status: r.status });
  };
  return { calls, fetchImpl };
}

const answer = { model: JEV_MODEL, answers: { next: { type: "choice", choice: "a", probabilities: { a: 1 }, confidence: 1 } }, usage: { input_tokens: 5 } };

describe("Jev client", () => {
  it("posts state and questions to the systemone endpoint with the key only in the Authorization header", async () => {
    const { calls, fetchImpl } = recorder([{ status: 200, body: answer }]);
    const r = await new JevClient({ apiKey: KEY, fetchImpl }).ask({ goal: "g" }, { next: { type: "choice", instructions: "i", criteria: { a: null } } });
    assert.equal(r.answers.next?.type, "choice");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, JEV_ENDPOINT);
    assert.equal(new Headers(calls[0]!.init.headers).get("authorization"), `Bearer ${KEY}`);
    const body = JSON.parse(String(calls[0]!.init.body));
    assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
    assert.equal(body.model, JEV_MODEL);
    assert.ok(!calls[0]!.url.includes(KEY) && !String(calls[0]!.init.body).includes(KEY), "never in the URL or body");
  });

  it("keeps the key out of errors and out of anything that serializes or logs the client", async () => {
    const { fetchImpl } = recorder([{ status: 401, body: { detail: { error_type: "authentication_error", message: "Cannot authenticate" } } }]);
    const client = new JevClient({ apiKey: KEY, fetchImpl });
    const err = await client.ask("s", {}).catch((e: unknown) => e);
    assert.ok(err instanceof JevError);
    assert.equal(err.status, 401);
    assert.match(err.message, /401: Cannot authenticate/);
    assert.ok(!err.message.includes(KEY));
    assert.ok(!JSON.stringify(client).includes(KEY));
    assert.ok(!inspect(client, { showHidden: true, depth: 5 }).includes(KEY), "nor when something logs the client");
    assert.ok(!JSON.stringify(typesafeProvider(() => ({ state: "ok", key: KEY }))()).includes(KEY), "nor in what the MCP layer is handed");
  });

  it("retries a rate limit, then gives up with the status", async () => {
    const { calls, fetchImpl } = recorder([{ status: 429, body: {} }, { status: 200, body: answer }]);
    const r = await new JevClient({ apiKey: KEY, fetchImpl, sleep: async () => {} }).ask("s", {});
    assert.equal(r.model, JEV_MODEL);
    assert.equal(calls.length, 2);
    const always = recorder([{ status: 529, body: {} }]);
    const err = await new JevClient({ apiKey: KEY, fetchImpl: always.fetchImpl, sleep: async () => {}, retries: 2 }).ask("s", {}).catch((e: unknown) => e);
    assert.ok(err instanceof JevError && err.status === 529);
    assert.equal(always.calls.length, 3);
  });
});

describe("TypeSafe key lookup", () => {
  const dir = mkdtempSync(join(tmpdir(), "deckhand-typesafe-"));
  const file = join(dir, "typesafe.key");

  it("is off, not broken, when nothing is configured", () => {
    rmSync(file, { force: true, recursive: true });
    assert.deepEqual(lookupTypesafeKey({}, file), { state: "missing" });
    const access = typesafeProvider(() => lookupTypesafeKey({}, file))();
    assert.equal(access.ok, false);
    assert.ok(!access.ok && access.code === "navigate_disabled" && /deckhand secret set typesafe/.test(access.hint));
  });

  it("prefers the environment, then the file", () => {
    writeFileSync(file, `${KEY}-file\n`);
    assert.deepEqual(lookupTypesafeKey({}, file), { state: "ok", key: `${KEY}-file` });
    assert.deepEqual(lookupTypesafeKey({ TYPESAFE_API_KEY: KEY }, file), { state: "ok", key: KEY });
  });

  it("reports an unreadable or empty key file as an error, never as 'not configured'", () => {
    writeFileSync(file, "  \n");
    assert.equal(lookupTypesafeKey({}, file).state, "error");
    rmSync(file, { force: true });
    mkdirSync(file);
    const found = lookupTypesafeKey({}, file);
    assert.equal(found.state, "error");
    const access = typesafeProvider(() => found)();
    assert.ok(!access.ok && access.code === "navigate_key_unreadable");
    rmSync(dir, { recursive: true, force: true });
  });
});
