import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addTokenEntry, addAppEntry, parseEnvAssignment, generateToken } from "./configWrite.ts";
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
