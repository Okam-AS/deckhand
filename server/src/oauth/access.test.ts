import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign, type KeyObject } from "node:crypto";
import { AccessVerifier } from "./access.ts";

const TEAM = "acme.cloudflareaccess.com";
const AUD = "aud-tag-for-the-deckhand-app";
const NOW_MS = 1_800_000_000_000;
const nowSec = Math.floor(NOW_MS / 1000);

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });

function jwks(key: KeyObject, kid: string): { keys: unknown[] } {
  return { keys: [{ ...key.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" }] };
}

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");

function sign(
  payload: Record<string, unknown>,
  opts: { kid?: string; alg?: string; key?: KeyObject; tamper?: boolean } = {},
): string {
  const header = { alg: opts.alg ?? "RS256", kid: opts.kid ?? "k1", typ: "JWT" };
  const input = `${b64(header)}.${b64(payload)}`;
  const sig = createSign("RSA-SHA256").update(input).sign(opts.key ?? privateKey).toString("base64url");
  return `${input}.${opts.tamper ? sig.slice(0, -2) + (sig.endsWith("aa") ? "bb" : "aa") : sig}`;
}

const goodPayload = {
  iss: `https://${TEAM}`,
  aud: [AUD],
  exp: nowSec + 600,
  email: "Owner@Example.com",
};

function verifier(body: unknown = jwks(publicKey, "k1")): {
  v: AccessVerifier;
  fetches: () => number;
  advance: (ms: number) => void;
} {
  let fetches = 0;
  let clock = NOW_MS;
  const fetchImpl = (async () => {
    fetches += 1;
    return { ok: true, json: async () => body } as Response;
  }) as unknown as typeof fetch;
  return {
    v: new AccessVerifier({ teamDomain: TEAM, aud: AUD, fetchImpl, now: () => clock }),
    fetches: () => fetches,
    advance: (ms) => {
      clock += ms;
    },
  };
}

describe("AccessVerifier", () => {
  it("accepts a well-formed assertion and lowercases the email", async () => {
    const { v } = verifier();
    assert.deepEqual(await v.verify(sign(goodPayload)), { email: "owner@example.com" });
  });

  it("refuses a signature made with a key that is not in the JWKS", async () => {
    const { v } = verifier();
    assert.equal(await v.verify(sign(goodPayload, { key: other.privateKey })), null);
  });

  it("refuses a tampered signature", async () => {
    const { v } = verifier();
    assert.equal(await v.verify(sign(goodPayload, { tamper: true })), null);
  });

  // `alg` comes from the attacker-supplied header. Honouring it is how alg=none
  // and HS256-with-the-public-key forgeries work, so it is pinned to RS256.
  it("refuses alg=none and any alg other than RS256", async () => {
    const { v } = verifier();
    const header = b64({ alg: "none", kid: "k1", typ: "JWT" });
    assert.equal(await v.verify(`${header}.${b64(goodPayload)}.`), null);
    assert.equal(await v.verify(sign(goodPayload, { alg: "HS256" })), null);
  });

  it("refuses an Access token minted for a different application on the same team", async () => {
    const { v } = verifier();
    assert.equal(await v.verify(sign({ ...goodPayload, aud: ["some-other-app"] })), null);
  });

  it("refuses a different team's issuer", async () => {
    const { v } = verifier();
    assert.equal(await v.verify(sign({ ...goodPayload, iss: "https://evil.cloudflareaccess.com" })), null);
  });

  it("refuses an expired assertion", async () => {
    const { v } = verifier();
    assert.equal(await v.verify(sign({ ...goodPayload, exp: nowSec - 1 })), null);
  });

  it("refuses an assertion carrying no email", async () => {
    const { v } = verifier();
    assert.equal(await v.verify(sign({ ...goodPayload, email: undefined })), null);
  });

  it("refuses junk, including a missing header", async () => {
    const { v } = verifier();
    assert.equal(await v.verify(undefined), null);
    assert.equal(await v.verify(""), null);
    assert.equal(await v.verify("a.b"), null);
    assert.equal(await v.verify("...."), null);
  });

  // A stream of unknown kids must not become a stream of JWKS fetches.
  it("refetches at most once per floor window for unknown kids", async () => {
    const { v, fetches, advance } = verifier();
    await v.verify(sign(goodPayload)); // warms the cache: 1 fetch
    const warm = fetches();

    for (let i = 0; i < 5; i++) await v.verify(sign(goodPayload, { kid: `forged-${i}` }));
    assert.equal(fetches(), warm, "inside the floor window an unknown kid must not trigger a fetch");

    advance(61_000);
    for (let i = 0; i < 5; i++) await v.verify(sign(goodPayload, { kid: `forged-${i}` }));
    assert.equal(fetches(), warm + 1, "past the floor, a burst of unknown kids is still one fetch");
  });

  it("keeps cached keys when the JWKS fetch fails", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) return { ok: true, json: async () => jwks(publicKey, "k1") } as Response;
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const v = new AccessVerifier({ teamDomain: TEAM, aud: AUD, fetchImpl, now: () => NOW_MS });
    assert.ok(await v.verify(sign(goodPayload)));
    await v.verify(sign(goodPayload, { kid: "unknown" })); // forces the failing refetch
    assert.ok(await v.verify(sign(goodPayload)), "a failed refetch must not invalidate the cached keys");
  });
});
