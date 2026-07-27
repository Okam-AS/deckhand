import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { buildAppJwt, GitHubAppAuth, createAskpass } from "./appAuth.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

function decodeJwt(jwt: string) {
  const [h, p, s] = jwt.split(".");
  return {
    header: JSON.parse(Buffer.from(h!, "base64url").toString()),
    payload: JSON.parse(Buffer.from(p!, "base64url").toString()),
    signingInput: `${h}.${p}`,
    signature: Buffer.from(s!, "base64url"),
  };
}

describe("buildAppJwt", () => {
  it("produces a verifiable RS256 JWT with correct claims", () => {
    const now = 1_800_000_000;
    const jwt = buildAppJwt({ appId: 42, privateKey, now });
    const { header, payload, signingInput, signature } = decodeJwt(jwt);
    assert.equal(header.alg, "RS256");
    assert.equal(payload.iss, 42);
    assert.equal(payload.iat, now - 60);
    assert.equal(payload.exp, now - 60 + 60 + 540);

    const v = createVerify("RSA-SHA256");
    v.update(signingInput);
    assert.equal(v.verify(publicKey, signature), true);
  });
});

describe("GitHubAppAuth.installationToken", () => {
  function fakeFetch(calls: string[], tokenValue = "ghs_tok"): typeof fetch {
    return (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/app/installations?per_page=100")) {
        return new Response(JSON.stringify([{ id: 7, account: { login: "AinFrastructure" } }]), { status: 200 });
      }
      if (/\/app\/installations\/7\/access_tokens$/.test(url)) {
        const expires = new Date(2_000_000_000_000).toISOString();
        return new Response(JSON.stringify({ token: tokenValue, expires_at: expires }), { status: 201 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
  }

  it("mints a token for an owner (case-insensitive) and caches it", async () => {
    const calls: string[] = [];
    let clock = 1_000_000_000_000;
    const auth = new GitHubAppAuth({
      appId: 42,
      privateKey,
      fetchImpl: fakeFetch(calls),
      now: () => clock,
    });
    assert.equal(await auth.installationToken("ainfrastructure"), "ghs_tok");
    // Second call within TTL: served from cache, no new HTTP.
    const before = calls.length;
    assert.equal(await auth.installationToken("ainfrastructure"), "ghs_tok");
    assert.equal(calls.length, before);
    // installations list + access_tokens = 2 calls total.
    assert.equal(calls.filter((c) => c.includes("access_tokens")).length, 1);
  });

  it("throws an actionable error when the owner has no installation", async () => {
    const auth = new GitHubAppAuth({ appId: 42, privateKey, fetchImpl: fakeFetch([]) });
    await assert.rejects(
      () => auth.installationToken("unknown-org"),
      (e: Error) => /no GitHub App installation/.test(e.message),
    );
  });
});

describe("createAskpass", () => {
  it("writes a script answering username and password prompts, and cleans up", () => {
    const handle = createAskpass("ghs_secret_123");
    const script = handle.env.GIT_ASKPASS!;
    assert.ok(existsSync(script));
    assert.equal(handle.env.GIT_TERMINAL_PROMPT, "0");
    const body = readFileSync(script, "utf8");
    assert.match(body, /x-access-token/);
    assert.match(body, /ghs_secret_123/);
    handle.cleanup();
    assert.equal(existsSync(script), false);
  });
});
