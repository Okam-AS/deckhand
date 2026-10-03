import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fetchShareState } from "./api.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fetchShareState", () => {
  it("reads a revoked share (410) as gone, not as a reconnect", async () => {
    for (const status of [404, 410]) {
      globalThis.fetch = (async () => new Response("{}", { status })) as typeof fetch;
      assert.equal(await fetchShareState("s1"), "gone", String(status));
    }
    globalThis.fetch = (async () => new Response("", { status: 502 })) as typeof fetch;
    assert.equal(await fetchShareState("s1"), null);
  });
});
