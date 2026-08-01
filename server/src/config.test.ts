import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  loadApps,
  loadTokens,
  ConfigError,
  parseRepo,
  repoOwner,
  githubPrivateKeyPath,
  loadAppsForBoot,
} from "./config.ts";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "deckhand-config-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

describe("loadConfig", () => {
  it("parses a minimal config and applies defaults", () => {
    const f = write(
      "config.yaml",
      [
        "hostname: mate.example.com",
        "streaming:",
        "  serveSim:",
        "    version: 0.1.34",
        "githubApp:",
        "  appId: 12345",
        "  privateKeyPath: github-app.pem",
      ].join("\n"),
    );
    const c = loadConfig(f);
    assert.equal(c.hostname, "mate.example.com");
    assert.equal(c.port, 4300);
    assert.equal(c.streaming.serveSim.codec, "auto");
    assert.deepEqual(c.streaming.serveSim.helperPortRange, [3100, 3199]);
    assert.equal(c.githubAmbient, true);
    assert.equal(c.allowPublicRepos, false);
    assert.equal(c.limits.maxDevicesPerPreview, 4);
    assert.equal(c.limits.disk.critical, 20);
    assert.match(String(c.modelHints.claude), /haiku/i);
  });

  it("resolves the private key path under the home dir", () => {
    const prev = process.env.DECKHAND_HOME;
    process.env.DECKHAND_HOME = "/opt/deckhand";
    try {
      const f = write(
        "config2.yaml",
        [
          "hostname: h",
          "streaming: { serveSim: { version: 1.0.0 } }",
          "githubApp: { appId: 1, privateKeyPath: github-app.pem }",
        ].join("\n"),
      );
      assert.equal(githubPrivateKeyPath(loadConfig(f)), "/opt/deckhand/github-app.pem");
    } finally {
      if (prev === undefined) delete process.env.DECKHAND_HOME;
      else process.env.DECKHAND_HOME = prev;
    }
  });

  it("throws ConfigError with a field path on invalid input", () => {
    const f = write("bad.yaml", "hostname: ''\nstreaming: {}\ngithubApp: {}");
    assert.throws(() => loadConfig(f), (e) => e instanceof ConfigError);
  });

  it("throws ConfigError (not ENOENT) for a missing file", () => {
    assert.throws(
      () => loadConfig(join(dir, "nope.yaml")),
      (e) => e instanceof ConfigError && /not found/.test((e as Error).message),
    );
  });
});

describe("loadApps", () => {
  it("parses apps with defaults and rejects a bad id", () => {
    const f = write(
      "apps.yaml",
      [
        "apps:",
        "  - id: my-app",
        "    repo: github.com/ainfrastructure/my-app",
        "    type: expo",
      ].join("\n"),
    );
    const apps = loadApps(f);
    assert.equal(apps.length, 1);
    assert.equal(apps[0]!.defaultBranch, "main");
    assert.deepEqual(apps[0]!.env, {});

    const bad = write("apps-bad.yaml", "apps:\n  - id: My_App\n    repo: x/y\n    type: expo");
    assert.throws(() => loadApps(bad), (e) => e instanceof ConfigError);
  });

  it("still loads an apps.yaml carrying the removed allowForkPRs key", () => {
    // The schema is .strict(), so dropping a field would otherwise break every
    // existing installation's apps.yaml on the next start.
    const f = write(
      "apps-legacy.yaml",
      ["apps:", "  - id: my-app", "    repo: github.com/ainfrastructure/my-app", "    type: expo", "    allowForkPRs: true"].join("\n"),
    );
    const apps = loadApps(f);
    assert.equal(apps.length, 1);
    assert.equal("allowForkPRs" in apps[0]!, false, "the legacy key is dropped, not carried forward");

    // A genuinely unknown key is still rejected.
    const bad = write("apps-unknown.yaml", "apps:\n  - id: a\n    repo: x/y\n    type: expo\n    nonsense: 1");
    assert.throws(() => loadApps(bad), (e) => e instanceof ConfigError);
  });

  it("rejects an unknown app type", () => {
    const f = write("apps-type.yaml", "apps:\n  - id: a\n    repo: x/y\n    type: flutter");
    assert.throws(() => loadApps(f), (e) => e instanceof ConfigError);
  });

  it("accepts a local-path app (dev mode), with or without a repo", () => {
    const f = write(
      "apps-local.yaml",
      [
        "apps:",
        "  - id: local-only",
        "    path: /Users/dev/apps/demo",
        "    type: nativescript",
        "  - id: both",
        "    repo: github.com/okam/demo",
        "    path: /Users/dev/apps/demo",
        "    type: nativescript",
      ].join("\n"),
    );
    const apps = loadApps(f);
    assert.equal(apps[0]!.path, "/Users/dev/apps/demo");
    assert.equal(apps[0]!.repo, undefined);
    assert.equal(apps[1]!.repo, "github.com/okam/demo");
  });

  it("rejects an app with neither repo nor path, and a relative path", () => {
    const neither = write("apps-neither.yaml", "apps:\n  - id: a\n    type: expo");
    assert.throws(() => loadApps(neither), (e) => e instanceof ConfigError && /repo/.test((e as Error).message));
    const relative = write("apps-rel.yaml", "apps:\n  - id: a\n    path: apps/demo\n    type: expo");
    assert.throws(() => loadApps(relative), (e) => e instanceof ConfigError && /absolute/.test((e as Error).message));
  });

  it("accepts migratesFrom when the source app exists", () => {
    const f = write(
      "apps-mig.yaml",
      [
        "apps:",
        "  - id: old-app",
        "    repo: github.com/okam/old",
        "    type: nativescript",
        "  - id: new-app",
        "    repo: github.com/okam/new",
        "    type: react-native",
        "    migratesFrom: old-app",
      ].join("\n"),
    );
    const apps = loadApps(f);
    assert.equal(apps.find((a) => a.id === "new-app")!.migratesFrom, "old-app");
  });

  it("rejects migratesFrom pointing at an unknown app or itself", () => {
    const unknown = write(
      "apps-mig-unknown.yaml",
      "apps:\n  - id: new-app\n    repo: x/y\n    type: react-native\n    migratesFrom: ghost",
    );
    assert.throws(() => loadApps(unknown), (e) => e instanceof ConfigError && /not a registered app/.test((e as Error).message));
    const self = write(
      "apps-mig-self.yaml",
      "apps:\n  - id: new-app\n    repo: x/y\n    type: react-native\n    migratesFrom: new-app",
    );
    assert.throws(() => loadApps(self), (e) => e instanceof ConfigError && /itself/.test((e as Error).message));
  });
});

describe("loadTokens", () => {
  it("parses tokens and enforces 64-hex format", () => {
    const good = "a".repeat(64);
    const f = write(
      "tokens.yaml",
      ["tokens:", `  - name: audun`, "    role: admin", `    token: ${good}`].join("\n"),
    );
    const tokens = loadTokens(f);
    assert.equal(tokens[0]!.name, "audun");
    assert.equal(tokens[0]!.role, "admin");

    const bad = write("tokens-bad.yaml", "tokens:\n  - name: x\n    role: member\n    token: short");
    assert.throws(() => loadTokens(bad), (e) => e instanceof ConfigError);
  });

  it("rejects an unknown role", () => {
    const f = write(
      "tokens-role.yaml",
      ["tokens:", "  - name: x", "    role: superuser", `    token: ${"b".repeat(64)}`].join("\n"),
    );
    assert.throws(() => loadTokens(f), (e) => e instanceof ConfigError);
  });
});

describe("parseRepo / repoOwner", () => {
  it("parses the supported repo string forms", () => {
    assert.deepEqual(parseRepo("github.com/ainfrastructure/my-app"), {
      host: "github.com",
      owner: "ainfrastructure",
      name: "my-app",
    });
    assert.deepEqual(parseRepo("https://github.com/acme/app.git"), {
      host: "github.com",
      owner: "acme",
      name: "app",
    });
    assert.deepEqual(parseRepo("git@github.com:acme/app.git"), {
      host: "github.com",
      owner: "acme",
      name: "app",
    });
    assert.deepEqual(parseRepo("acme/app"), { host: "github.com", owner: "acme", name: "app" });
    assert.equal(repoOwner("github.com/ainfrastructure/x"), "ainfrastructure");
  });

  it("strips userinfo from an https URL (else the host is `user@github.com`)", () => {
    // The askpass host pin rejects anything that isn't a plain hostname, so a
    // pasted `https://user@host/...` used to throw instead of cloning.
    assert.deepEqual(parseRepo("https://user@github.com/acme/app.git"), {
      host: "github.com",
      owner: "acme",
      name: "app",
    });
  });

  it("throws on an unparseable repo", () => {
    assert.throws(() => parseRepo("justaname"), (e) => e instanceof ConfigError);
  });
});

describe("loadAppsForBoot", () => {
  const withFile = (body: string, fn: (file: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), "deckhand-apps-boot-"));
    const file = join(dir, "apps.yaml");
    writeFileSync(file, body);
    try {
      fn(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("comes up with no apps rather than refusing to start", () => {
    // The trade that matters for a NEW user: a half-finished `add_app`, or a hand edit, used
    // to produce a server that would not boot — and therefore could not be repaired through
    // add_app or the setup URL, which is all a remote agent has. It was latent too: watchApps
    // keeps the last good list, so a running server tolerates the same file until the next
    // restart, long after whatever wrote it.
    withFile("apps:\n  - id: ok\n    type: expo\n", (file) => {
      const r = loadAppsForBoot(file);
      assert.deepEqual(r.apps, [], "empty, not fatal");
      assert.match(r.error ?? "", /repo, a local path, or both/, "and the reason names the entry to fix");
    });
  });

  it("leaves the file alone, because it is the operator's work", () => {
    const body = "apps:\n  - id: ok\n    type: expo\n";
    withFile(body, (file) => {
      loadAppsForBoot(file);
      assert.equal(readFileSync(file, "utf8"), body, "unchanged — the fix belongs to whoever wrote it");
    });
  });

  it("reports no error for a file that loads", () => {
    withFile("apps:\n  - id: a\n    repo: github.com/o/r\n    type: expo\n", (file) => {
      const r = loadAppsForBoot(file);
      assert.equal(r.error, undefined);
      assert.equal(r.apps[0]?.id, "a");
    });
  });

  it("treats a missing file as an empty registry, with no error", () => {
    // A first boot, before `deckhand init` has written anything.
    const r = loadAppsForBoot(join(tmpdir(), "deckhand-nope", "apps.yaml"));
    assert.deepEqual(r.apps, []);
    assert.ok(r.error, "still reported, so a typo'd DECKHAND_HOME is visible rather than silent");
  });
});
