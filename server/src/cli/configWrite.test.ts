import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTokenEntry, addAppEntry, buildInitConfig, parseEnvAssignment, generateToken, writeApps } from "./configWrite.ts";
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
  });

  it("rejects a duplicate id and an invalid id", () => {
    const existing: App[] = [
      { id: "a", repo: "x/a", type: "expo", defaultBranch: "main", env: {} },
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

describe("writeApps refuses to write a file that would not load back", () => {
  // DECKHAND_HOME first, always. `writeApps` resolves paths.apps() from it, so without this
  // the test writes to the DEVELOPER'S OWN ~/.deckhand/apps.yaml — a file whose loss costs
  // every registered app. It is safe today only because the validation below throws before
  // the write; that is one refactor away from not being true, and this test exists precisely
  // to be run against versions where it is not.
  let home: string;
  let prevHome: string | undefined;
  before(() => {
    prevHome = process.env.DECKHAND_HOME;
    home = mkdtempSync(join(tmpdir(), "deckhand-cw-"));
    process.env.DECKHAND_HOME = home;
  });
  after(() => {
    if (prevHome === undefined) delete process.env.DECKHAND_HOME;
    else process.env.DECKHAND_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("throws rather than persisting a list the schema rejects", () => {
    // The write path and the read path had no relationship, so anything producing an
    // in-memory list `loadApps` would later reject got written happily — and surfaced on the
    // NEXT BOOT as "apps.yaml is invalid", with every registered app gone from the running
    // server and nothing pointing at the operation responsible.
    const bad = [{ id: "", repo: "owner/name", type: "expo" }] as unknown as App[];
    assert.throws(() => writeApps(bad), /would not load back/);
  });

  it("names the field, so the failure is actionable", () => {
    const bad = [{ id: "ok", type: "expo" }] as unknown as App[];
    assert.throws(() => writeApps(bad), (e: Error) => {
      assert.match(e.message, /refusing to write apps\.yaml/);
      assert.match(e.message, /existing file is unchanged/, "the operator needs to know nothing was lost");
      return true;
    });
  });
});
