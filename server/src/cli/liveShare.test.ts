import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LiveShareClient, LIVE_URL_PREFIX } from "./liveShare.ts";

function client(fetchImpl: typeof fetch, token: string | null = "tok") {
  const lines: string[] = [];
  const calls: string[] = [];
  const wrapped = (async (url: string | URL, init?: RequestInit) => {
    calls.push(`${init?.method} ${String(url).replace(/^http:\/\/127\.0\.0\.1:7777/, "")}`);
    return fetchImpl(url, init);
  }) as typeof fetch;
  const c = new LiveShareClient({ port: 7777, token, appId: "pos", pid: 42, log: (l) => lines.push(l), fetchImpl: wrapped });
  return { c, lines, calls };
}

const created = async () => new Response(JSON.stringify({ shareId: "s1", url: "https://deck.example/s/s1" }), { status: 201 });

describe("LiveShareClient", () => {
  it("prints the URL exactly once and revokes it on close", async () => {
    const { c, lines, calls } = client(async (_u, init) => (init?.method === "POST" ? created() : new Response(null, { status: 204 })));
    assert.equal(await c.open("U1"), "https://deck.example/s/s1");
    assert.equal(await c.open("U1"), "https://deck.example/s/s1");
    await c.close();
    await c.close();
    assert.deepEqual(lines, [`${LIVE_URL_PREFIX}https://deck.example/s/s1`]);
    assert.deepEqual(calls, ["POST /admin/live-shares", "DELETE /admin/live-shares/s1"]);
  });

  it("warns and carries on when the server is not running", async () => {
    const { c, lines } = client(async () => {
      throw new TypeError("fetch failed");
    });
    assert.equal(await c.open("U1"), null);
    await c.close();
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^warning: --share: the deckhand server is not answering on 127\.0\.0\.1:7777/);
  });

  it("warns without asking when the host has no credential, and on a refusal", async () => {
    const none = client(created, null);
    assert.equal(await none.c.open("U1"), null);
    assert.deepEqual(none.calls, []);
    assert.match(none.lines[0]!, /tokens\.yaml/);
    const refused = client(async () => new Response(JSON.stringify({ error: "no first frame" }), { status: 504 }));
    assert.equal(await refused.c.open("U1"), null);
    assert.match(refused.lines[0]!, /refused \(504: no first frame\)/);
  });

  it("a run that ends while the share is still opening revokes it and never prints it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { c, lines, calls } = client(async (_u, init) => {
      if (init?.method === "POST") {
        await gate;
        return created();
      }
      return new Response(null, { status: 204 });
    });
    const opening = c.open("U1");
    const closing = c.close();
    release();
    assert.equal(await opening, null);
    await closing;
    assert.deepEqual(lines, []);
    assert.deepEqual(calls, ["POST /admin/live-shares", "DELETE /admin/live-shares/s1"]);
  });
});
