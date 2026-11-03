import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXPO_GRAPHQL, EasClient, EasError, artifactKind, channelBranchIds, devClientUpdateUrl, type EasBuild } from "./client.ts";
import { expoTokenSource, lookupExpoToken } from "./secrets.ts";

const TOKEN = "expo-robot-test-token-9c1d";
const PROJECT = "6ff82c98-0000-4000-8000-000000000001";

function recorder(respond: (body: { query: string; variables: Record<string, unknown> }) => { status?: number; body: unknown }) {
  const calls: { url: string; init: RequestInit; body: { query: string; variables: Record<string, unknown> } }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url: String(url), init: init ?? {}, body });
    const r = respond(body);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  };
  return { calls, fetchImpl };
}

function build(over: Partial<EasBuild> = {}): EasBuild {
  return {
    id: "9a14f495-ad71-4e37-9648-b51a4620cea5",
    platform: "ANDROID",
    buildProfile: "e2e",
    status: "FINISHED",
    distribution: "INTERNAL",
    appVersion: "3.61.0",
    appBuildVersion: "412",
    gitCommitHash: "abc",
    createdAt: "2026-11-01T10:00:00Z",
    completedAt: "2026-11-01T10:20:00Z",
    artifacts: { buildUrl: "https://expo.dev/artifacts/eas/abc.apk" },
    ...over,
  };
}

const ok = () => expoTokenSource(() => ({ state: "ok", token: TOKEN }));

describe("EasClient", () => {
  it("sends the token only to the Expo GraphQL endpoint, in the Authorization header", async () => {
    const { calls, fetchImpl } = recorder(() => ({ body: { data: { app: { byId: { builds: [build()] } } } } }));
    const got = await new EasClient(ok(), fetchImpl).latest(PROJECT, "e2e", "ANDROID");
    assert.equal(got?.id, build().id);
    assert.equal(calls[0]!.url, EXPO_GRAPHQL);
    assert.equal(new Headers(calls[0]!.init.headers).get("authorization"), `Bearer ${TOKEN}`);
    assert.deepEqual(calls[0]!.body.variables, { id: PROJECT, limit: 20, filter: { platform: "ANDROID", buildProfile: "e2e", status: "FINISHED" } });
    assert.ok(!calls[0]!.url.includes(TOKEN) && !JSON.stringify(calls[0]!.body).includes(TOKEN));
  });

  it("takes the newest build the caller accepts, so an iOS simulator build is not handed to a phone", async () => {
    const sim = build({ id: "11111111-1111-4111-8111-111111111111", platform: "IOS", isForIosSimulator: true });
    const dev = build({ id: "22222222-2222-4222-8222-222222222222", platform: "IOS", isForIosSimulator: false });
    const { fetchImpl } = recorder(() => ({ body: { data: { app: { byId: { builds: [sim, dev] } } } } }));
    const got = await new EasClient(ok(), fetchImpl).latest(PROJECT, "development", "IOS", (b) => !b.isForIosSimulator);
    assert.equal(got?.id, dev.id);
  });

  it("resolves a unique id prefix and refuses an ambiguous one", async () => {
    const a = build({ id: "26c068be-0000-4000-8000-000000000001" });
    const b = build({ id: "26c068bf-0000-4000-8000-000000000002" });
    const { fetchImpl } = recorder(() => ({ body: { data: { app: { byId: { builds: [a, b] } } } } }));
    const client = new EasClient(ok(), fetchImpl);
    assert.equal((await client.build(PROJECT, "26c068be"))?.id, a.id);
    await assert.rejects(client.build(PROJECT, "26c068b"), (e: unknown) => e instanceof EasError && /matches 2 builds/.test(e.message));
    await assert.rejects(client.build(PROJECT, "x'); drop"), (e: unknown) => e instanceof EasError && e.code === "bad_request");
  });

  it("asks EAS for a full id directly", async () => {
    const { calls, fetchImpl } = recorder(() => ({ body: { data: { builds: { byId: build() } } } }));
    await new EasClient(ok(), fetchImpl).build(PROJECT, build().id.toUpperCase());
    assert.match(calls[0]!.body.query, /byId\(buildId: \$id\)/);
    assert.equal(calls[0]!.body.variables.id, build().id);
  });

  it("names the fix when there is no token, and sends nothing", async () => {
    const { calls, fetchImpl } = recorder(() => ({ body: {} }));
    const client = new EasClient(expoTokenSource(() => ({ state: "missing" })), fetchImpl);
    await assert.rejects(client.whoami(), (e: unknown) => e instanceof EasError && e.code === "eas_token_missing" && /deckhand secret set expo/.test(e.hint ?? ""));
    assert.equal(calls.length, 0);
  });

  it("says the token was refused on a 401, and never repeats it", async () => {
    const { fetchImpl } = recorder(() => ({ status: 401, body: { errors: [{ message: `bad token ${TOKEN}` }] } }));
    await assert.rejects(new EasClient(ok(), fetchImpl).whoami(), (e: unknown) => {
      assert.ok(e instanceof EasError && e.code === "eas_token_rejected");
      assert.ok(!`${e.message} ${e.hint}`.includes(TOKEN));
      return true;
    });
  });

  it("finds the newest update only on the branches the build's channel maps to", async () => {
    const mapping = JSON.stringify({ version: 0, data: [{ branchId: "br-uat", branchMappingLogic: "true" }] });
    const { fetchImpl } = recorder(() => ({
      body: {
        data: {
          app: {
            byId: {
              updateBranches: [
                { id: "br-prod", name: "production", updates: [{ id: "u2", group: "g2", platform: "android", createdAt: "2026-11-02T00:00:00Z", message: null }] },
                { id: "br-uat", name: "uat", updates: [{ id: "u1", group: "g1", platform: "android", createdAt: "2026-11-01T00:00:00Z", message: "m" }] },
              ],
            },
          },
        },
      },
    }));
    const client = new EasClient(ok(), fetchImpl);
    const u = await client.latestUpdateFor(PROJECT, { platform: "ANDROID", runtime: { version: "1.0" }, updateChannel: { name: "uat", branchMapping: mapping } });
    assert.equal(u?.group, "g1");
    assert.equal(await client.latestUpdateFor(PROJECT, { platform: "ANDROID", runtime: { version: "1.0" }, updateChannel: null }), null);
  });
});

describe("EAS helpers", () => {
  it("classifies artifacts by the URL path", () => {
    assert.equal(artifactKind(build()), "apk");
    assert.equal(artifactKind(build({ artifacts: { buildUrl: "https://x/y.aab?sig=1" } })), "aab");
    assert.equal(artifactKind(build({ artifacts: { buildUrl: "https://x/y.ipa" } })), "ipa");
    assert.equal(artifactKind(build({ artifacts: { buildUrl: "https://x/y.tar.gz" } })), "simulator");
    assert.equal(artifactKind(build({ artifacts: null })), "unknown");
  });

  it("reads branch ids from a channel mapping and survives a bad one", () => {
    assert.deepEqual(channelBranchIds(JSON.stringify({ data: [{ branchId: "a" }, { branchId: "b" }] })), ["a", "b"]);
    assert.deepEqual(channelBranchIds("{"), []);
  });

  it("builds the dev-client link for an update group, and refuses odd parts", () => {
    assert.equal(
      devClientUpdateUrl("exp+my-app", PROJECT, "0f6c1d2e-0000-4000-8000-000000000003"),
      `exp+my-app://expo-development-client/?url=${encodeURIComponent(`https://u.expo.dev/${PROJECT}/group/0f6c1d2e-0000-4000-8000-000000000003`)}`,
    );
    assert.throws(() => devClientUpdateUrl("evil://x", PROJECT, "g"));
  });
});

describe("the Expo token", () => {
  it("is read from the file only, and an unreadable file is not 'missing'", () => {
    const dir = mkdtempSync(join(tmpdir(), "deckhand-expo-"));
    try {
      const file = join(dir, "expo.token");
      assert.deepEqual(lookupExpoToken(file), { state: "missing" });
      writeFileSync(file, `${TOKEN}\n`);
      assert.deepEqual(lookupExpoToken(file), { state: "ok", token: TOKEN });
      const asDir = join(dir, "d");
      mkdirSync(asDir);
      assert.equal(lookupExpoToken(asDir).state, "error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
