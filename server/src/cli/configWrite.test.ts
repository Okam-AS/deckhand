import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addTokenEntry, addAppEntry, buildInitConfig, parseEnvAssignment, generateToken } from "./configWrite.ts";
import type { App, TokenEntry } from "../config.ts";

describe("generateToken", () => {
  it("produces 64 lowercase hex chars", () => {
    assert.match(generateToken(), /^[0-9a-f]{64}$/);
    assert.notEqual(generateToken(), generateToken());
  });
});

describe("addTokenEntry", () => {
  it("appends a valid token with role and owners", () => {
    const { tokens, created } = addTokenEntry([], { name: "kari", role: "member", owners: ["ainfrastructure"] });
    assert.equal(tokens.length, 1);
    assert.equal(created.name, "kari");
    assert.deepEqual(created.owners, ["ainfrastructure"]);
    assert.match(created.token, /^[0-9a-f]{64}$/);
  });

  it("omits an empty owners list", () => {
    const { created } = addTokenEntry([], { name: "a", role: "admin", owners: [] });
    assert.equal(created.owners, undefined);
  });

  it("rejects a duplicate name", () => {
    const existing: TokenEntry[] = [{ name: "a", role: "admin", token: "0".repeat(64) }];
    assert.throws(() => addTokenEntry(existing, { name: "a", role: "member" }), /already exists/);
  });
});

describe("addAppEntry", () => {
  it("adds an app and applies defaults", () => {
    const apps = addAppEntry([], { id: "my-app", repo: "github.com/x/my-app", type: "expo" });
    assert.equal(apps[0]!.defaultBranch, "main");
    assert.equal(apps[0]!.allowForkPRs, false);
  });

  it("rejects a duplicate id and an invalid id", () => {
    const existing: App[] = [
      { id: "a", repo: "x/a", type: "expo", defaultBranch: "main", allowForkPRs: false, env: {} },
    ];
    assert.throws(() => addAppEntry(existing, { id: "a", repo: "x/a", type: "expo" }), /already exists/);
    assert.throws(() => addAppEntry([], { id: "Bad_Id", repo: "x/a", type: "expo" }));
  });
});

describe("buildInitConfig", () => {
  const app = { hostname: "h.example", githubAppId: "42", githubAppPem: "/tmp/k.pem" };

  it("omits githubApp entirely when neither flag is given, and asks for no pem", () => {
    const { config, pemPath } = buildInitConfig({ hostname: "h.example" });
    assert.equal(config.githubApp, undefined);
    assert.equal(pemPath, undefined);
    assert.equal(config.hostname, "h.example");
    assert.equal(config.githubAmbient, true);
    assert.equal(config.port, 4300);
  });

  it("configures the App and returns the pem to copy when both flags are given", () => {
    const { config, pemPath } = buildInitConfig(app);
    assert.deepEqual(config.githubApp, { appId: 42, privateKeyPath: "github-app.pem" });
    assert.equal(pemPath, "/tmp/k.pem");
  });

  it("requires a hostname", () => {
    assert.throws(() => buildInitConfig({}), /requires --hostname/);
  });

  it("rejects either App flag on its own", () => {
    assert.throws(() => buildInitConfig({ hostname: "h", githubAppId: "42" }), /must be given together/);
    assert.throws(() => buildInitConfig({ hostname: "h", githubAppPem: "/tmp/k.pem" }), /must be given together/);
  });

  // A non-integer app id used to be caught for free by `if (!appId)` on the coerced
  // number; once the flag is kept as a string it must be checked explicitly, or NaN
  // reaches the YAML as `.nan` and every later command dies on config load.
  it("rejects an app id that is not a positive integer", () => {
    for (const bad of ["abc", "0", "-5", "1.5", "1e999", ""]) {
      assert.throws(
        () => buildInitConfig({ ...app, githubAppId: bad }),
        /must be a positive integer|must be given together/,
        `expected "${bad}" to be rejected`,
      );
    }
  });

  it("honours an explicit port and falls back to 4300 on junk", () => {
    assert.equal(buildInitConfig({ hostname: "h", port: "8080" }).config.port, 8080);
    assert.equal(buildInitConfig({ hostname: "h", port: "junk" }).config.port, 4300);
  });
});

describe("parseEnvAssignment", () => {
  it("splits KEY=VALUE (value may contain =)", () => {
    assert.deepEqual(parseEnvAssignment("API_URL=https://x?a=b"), { key: "API_URL", value: "https://x?a=b" });
  });
  it("rejects malformed input", () => {
    assert.throws(() => parseEnvAssignment("noequals"), /KEY=VALUE/);
    assert.throws(() => parseEnvAssignment("=v"), /KEY=VALUE/);
    assert.throws(() => parseEnvAssignment("1bad=v"), /invalid env key/);
  });
});
