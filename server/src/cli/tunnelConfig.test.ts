import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parse as parseYaml } from "yaml";
import { mergeTunnelConfig, renderTunnelConfig, parseTunnelConfig, tunnelIdFor, needsLogin } from "./tunnelConfig.ts";

/**
 * `~/.cloudflared/config.yml` is NOT deckhand's file.
 *
 * The machine this was written on had three ingress rules in it, one of them an unrelated
 * backend on another port. A setup command that generated this file from scratch would have
 * silently deleted a service the operator runs — the same class as rewriting a tracked file in
 * a borrowed checkout, and just as invisible until something stops answering.
 */

const REAL_WORLD = `tunnel: 7b111851-2df2-4d62-8584-50420869b714
credentials-file: /Users/x/.cloudflared/7b111851.json
ingress:
  - hostname: deckhand.example.com
    service: http://127.0.0.1:4300
  - hostname: deckhandwebpreview.example.com
    service: http://127.0.0.1:4300
  - hostname: somethingelse.example.com
    service: http://127.0.0.1:5080
  - service: http_status:404
`;

const merge = (text: string | null, hostnames: string[], port = 4300) =>
  mergeTunnelConfig(parseTunnelConfig(text), {
    tunnelId: "NEW-ID",
    credentialsFile: "/creds.json",
    hostnames,
    port,
  });

describe("mergeTunnelConfig", () => {
  it("never drops a rule for someone else's service", () => {
    // The one that matters. This rule belongs to an unrelated backend on port 5080.
    const out = merge(REAL_WORLD, ["deckhand.example.com"]);
    const other = out.ingress!.find((r) => r.hostname === "somethingelse.example.com");
    assert.deepEqual(other, { hostname: "somethingelse.example.com", service: "http://127.0.0.1:5080" });
  });

  it("updates our own hostname in place instead of duplicating it", () => {
    // cloudflared matches the FIRST rule for a hostname, so a duplicate is dead config that
    // looks like it should work.
    const out = merge(REAL_WORLD, ["deckhand.example.com"], 4399);
    const ours = out.ingress!.filter((r) => r.hostname === "deckhand.example.com");
    assert.equal(ours.length, 1);
    assert.equal(ours[0]!.service, "http://127.0.0.1:4399", "and it points at the new port");
  });

  it("keeps the catch-all last, always", () => {
    // cloudflared rejects a config whose last rule has a hostname.
    for (const input of [REAL_WORLD, null, "ingress:\n  - hostname: a.example.com\n    service: http://127.0.0.1:1\n"]) {
      const out = merge(input, ["new.example.com"]);
      const last = out.ingress![out.ingress!.length - 1]!;
      assert.equal(last.hostname, undefined, "the last rule must be the catch-all");
      assert.equal(last.service, "http_status:404");
      assert.equal(out.ingress!.filter((r) => r.hostname === undefined).length, 1, "and there is exactly one");
    }
  });

  it("writes a complete config when there is none yet", () => {
    const out = merge(null, ["a.example.com", "b.example.com"]);
    assert.equal(out.tunnel, "NEW-ID");
    assert.equal(out["credentials-file"], "/creds.json");
    assert.deepEqual(
      out.ingress!.map((r) => r.hostname),
      ["a.example.com", "b.example.com", undefined],
    );
  });

  it("does not repoint a config that already names a different tunnel", () => {
    // Adopting someone's existing tunnel is a decision they get to make, not one we make by
    // overwriting two lines.
    const out = merge(REAL_WORLD, ["deckhand.example.com"]);
    assert.equal(out.tunnel, "7b111851-2df2-4d62-8584-50420869b714", "theirs, not ours");
    assert.match(out["credentials-file"]!, /7b111851/);
  });

  it("preserves unknown top-level keys", () => {
    // cloudflared has many options; a merge that dropped them would break setups it does not
    // understand, which is most of them.
    const out = merge(`${REAL_WORLD}warp-routing:\n  enabled: true\nloglevel: debug\n`, ["deckhand.example.com"]);
    assert.deepEqual(out["warp-routing"], { enabled: true });
    assert.equal(out.loglevel, "debug");
  });

  it("round-trips through YAML unchanged", () => {
    const out = merge(REAL_WORLD, ["deckhand.example.com"]);
    assert.deepEqual(parseYaml(renderTunnelConfig(out)), out);
  });

  it("is idempotent", () => {
    // Setup is meant to be re-runnable — that is how it doubles as a repair tool.
    const once = merge(REAL_WORLD, ["deckhand.example.com", "new.example.com"]);
    const twice = mergeTunnelConfig(once, {
      tunnelId: "NEW-ID",
      credentialsFile: "/creds.json",
      hostnames: ["deckhand.example.com", "new.example.com"],
      port: 4300,
    });
    assert.deepEqual(twice, once);
  });
});

describe("parseTunnelConfig", () => {
  it("treats an unreadable or empty file as absent rather than throwing", () => {
    assert.equal(parseTunnelConfig(null), null);
    assert.equal(parseTunnelConfig("{{{ not yaml"), null);
    assert.equal(parseTunnelConfig(""), null);
  });
});

describe("tunnelIdFor", () => {
  const LIST = `ID                                   NAME        CREATED              CONNECTIONS
7b111851-2df2-4d62-8584-50420869b714 deckhand    2026-07-14T23:17:20Z 2xarn07
d4ded2ed-9246-40be-8fad-5807a21567ed mac-mini-ci 2026-04-23T13:22:57Z 1xarn06
`;

  it("finds an existing tunnel so setup adopts it instead of creating a second", () => {
    // cloudflared happily allows two tunnels with the same name, and connections then split
    // between them at random — a mess that is much harder to diagnose than to avoid.
    assert.equal(tunnelIdFor(LIST, "deckhand"), "7b111851-2df2-4d62-8584-50420869b714");
    assert.equal(tunnelIdFor(LIST, "mac-mini-ci"), "d4ded2ed-9246-40be-8fad-5807a21567ed");
  });

  it("does not match on a prefix", () => {
    assert.equal(tunnelIdFor(LIST, "deck"), null, "a different name is a different tunnel");
  });

  it("returns null when there is nothing to adopt", () => {
    assert.equal(tunnelIdFor(LIST, "nope"), null);
    assert.equal(tunnelIdFor("", "deckhand"), null);
  });
});

describe("needsLogin", () => {
  it("recognises the not-authenticated failure, which needs a human and a browser", () => {
    assert.equal(needsLogin("Cannot determine default origin certificate path", 1), true);
    assert.equal(needsLogin("error: cert.pem not found", 1), true);
  });

  it("does not mistake an ordinary failure for a login problem", () => {
    assert.equal(needsLogin("API error: 530", 1), false, "telling someone to log in again would waste their time");
    assert.equal(needsLogin("anything at all", 0), false);
  });
});
