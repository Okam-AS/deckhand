import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
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

  it("scopes the token to one repo, and caches per repo", async () => {
    // An installation token with no body covers every repo in the installation,
    // so a single leak exposed the whole org instead of the previewed repo.
    const bodies: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/app/installations?per_page=100")) {
        return new Response(JSON.stringify([{ id: 7, account: { login: "acme" } }]), { status: 200 });
      }
      bodies.push(String(init?.body ?? ""));
      const expires = new Date(2_000_000_000_000).toISOString();
      return new Response(JSON.stringify({ token: "ghs_tok", expires_at: expires }), { status: 201 });
    }) as unknown as typeof fetch;
    const auth = new GitHubAppAuth({ appId: 42, privateKey, fetchImpl, now: () => 1_000_000_000_000 });

    await auth.installationToken("acme", "widgets");
    assert.deepEqual(JSON.parse(bodies[0]!), { repositories: ["widgets"] });
    await auth.installationToken("acme", "widgets"); // cached
    assert.equal(bodies.length, 1);
    await auth.installationToken("acme", "gadgets"); // different repo → new token
    assert.deepEqual(JSON.parse(bodies[1]!), { repositories: ["gadgets"] });

    // A repo's own private submodules widen the scope (and key the cache), or
    // `submodule update` would 404 on them under the repo-scoped token.
    await auth.installationToken("acme", "widgets", ["shared", "widgets"]);
    assert.deepEqual(JSON.parse(bodies[2]!), { repositories: ["widgets", "shared"] });
    await auth.installationToken("acme", "widgets", ["shared"]); // cached
    assert.equal(bodies.length, 3);
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
  /** Run the generated script with a git-style prompt; returns what it printed. */
  const ask = (script: string, prompt: string): string => {
    try {
      return execFileSync(script, [prompt], { encoding: "utf8" });
    } catch {
      return ""; // non-zero exit = refused
    }
  };

  it("writes a script answering username and password prompts, and cleans up", () => {
    const handle = createAskpass("ghs_secret_123", "github.com");
    const script = handle.env.GIT_ASKPASS!;
    assert.ok(existsSync(script));
    assert.equal(handle.env.GIT_TERMINAL_PROMPT, "0");
    const body = readFileSync(script, "utf8");
    assert.match(body, /x-access-token/);
    assert.match(body, /ghs_secret_123/);
    assert.equal(ask(script, "Username for 'https://github.com': "), "x-access-token");
    assert.equal(ask(script, "Password for 'https://x-access-token@github.com': "), "ghs_secret_123");
    handle.cleanup();
    assert.equal(existsSync(script), false);
  });

  it("answers nothing for a host other than the pinned one", () => {
    // A hostile .gitmodules pointing at any of these, fetched by `submodule
    // update --init --recursive` under the same env, must not receive the token.
    const handle = createAskpass("ghs_secret_123", "github.com");
    const script = handle.env.GIT_ASKPASS!;
    for (const host of ["attacker.example.com", "evilgithub.com", "github.com.evil.test", "github.como"]) {
      assert.equal(ask(script, `Password for 'https://x-access-token@${host}': `), "", host);
      assert.equal(ask(script, `Username for 'https://${host}': `), "", host);
    }
    handle.cleanup();
  });

  it("answers for the pinned host on a self-hosted instance, with or without a port", () => {
    const handle = createAskpass("ghs_secret_123", "git.acme.internal");
    const script = handle.env.GIT_ASKPASS!;
    assert.equal(ask(script, "Username for 'https://git.acme.internal': "), "x-access-token");
    assert.equal(ask(script, "Password for 'https://x-access-token@git.acme.internal:8443': "), "ghs_secret_123");
    handle.cleanup();
  });

  it("answers the credential.useHttpPath prompt form (host followed by the repo path)", () => {
    // With `credential.useHttpPath=true` inherited from the user's gitconfig, git
    // appends the path to its own prompt. Refusing it broke every clone/fetch.
    const handle = createAskpass("ghs_secret_123", "github.com");
    const script = handle.env.GIT_ASKPASS!;
    assert.equal(ask(script, "Username for 'https://github.com/acme/app.git': "), "x-access-token");
    assert.equal(ask(script, "Password for 'https://x-access-token@github.com/acme/app.git': "), "ghs_secret_123");
    // ...and the path form doesn't open a lookalike-host hole.
    for (const host of ["evilgithub.com", "github.com.evil.test"]) {
      assert.equal(ask(script, `Username for 'https://${host}/acme/app.git': `), "", host);
    }
    handle.cleanup();
  });

  it("refuses a host pin embedded in the attacker-controlled URL PATH", () => {
    // With credential.useHttpPath git appends the url-DECODED path to the prompt,
    // and the path comes from the previewed repo's .gitmodules. A substring test
    // for "//host/" or "@host/" accepts these and hands over the credential.
    const handle = createAskpass("ghs_secret_123", "github.com");
    const script = handle.env.GIT_ASKPASS!;
    const prompts = [
      "Password for 'http://x@attacker.example/x///github.com/y.git': ", // %2F%2F decoded
      "Username for 'https://attacker.example//github.com/y': ",
      "Username for 'https://attacker.example/a@github.com/b': ",
      "Password for 'https://x@attacker.example/p/@github.com:443/q': ",
      "Username for 'https://attacker.example/x/github.com': ",
    ];
    for (const p of prompts) assert.equal(ask(script, p), "", p);
    handle.cleanup();
  });

  it("matches the pinned host case-insensitively (an old base clone keeps its mixed-case remote)", () => {
    const handle = createAskpass("ghs_secret_123", "github.com");
    const script = handle.env.GIT_ASKPASS!;
    assert.equal(ask(script, "Username for 'https://GitHub.com/acme/app.git': "), "x-access-token");
    assert.equal(ask(script, "Password for 'https://x-access-token@GITHUB.COM': "), "ghs_secret_123");
    handle.cleanup();
  });

  it("refuses to pin to a host that isn't a plain hostname", () => {
    for (const bad of ["github.com'; rm -rf /", "localhost", "", "-nope.com", "gith ub.com"]) {
      assert.throws(() => createAskpass("t", bad), /invalid host/);
    }
  });
});
