import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema, type Config } from "../config.ts";
import { buildTokenResolver, CredentialsMissingError } from "./credentials.ts";

const baseConfig = (over: Record<string, unknown> = {}): Config =>
  configSchema.parse({
    hostname: "mate.example.com",
    streaming: { serveSim: { version: "0.1.34" } },
    ...over,
  });

// The credential ladder (PLAN §2/§6): PAT file → GitHub App → ambient gh CLI
// session → typed error. Explicit credentials always win over ambient ones.
describe("buildTokenResolver", () => {
  let home: string;
  before(() => {
    home = mkdtempSync(join(tmpdir(), "deckhand-cred-"));
    process.env.DECKHAND_HOME = home;
  });
  after(() => {
    delete process.env.DECKHAND_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it("prefers the PAT file and never consults gh", async () => {
    writeFileSync(join(home, "github-pat"), "github_pat_explicit\n");
    try {
      let ghCalls = 0;
      const resolve = buildTokenResolver(baseConfig(), {
        ghToken: async () => {
          ghCalls++;
          return "gho_ambient";
        },
      });
      assert.equal(await resolve("okam-as"), "github_pat_explicit");
      assert.equal(ghCalls, 0, "an explicit PAT must shadow the ambient session");
    } finally {
      rmSync(join(home, "github-pat"), { force: true });
    }
  });

  it("falls back to the gh CLI session when neither a PAT nor an App is configured", async () => {
    const resolve = buildTokenResolver(baseConfig(), { ghToken: async () => "gho_ambient" });
    assert.equal(await resolve("okam-as"), "gho_ambient");
  });

  it("does not consult gh when githubAmbient is off", async () => {
    let ghCalls = 0;
    const resolve = buildTokenResolver(baseConfig({ githubAmbient: false }), {
      ghToken: async () => {
        ghCalls++;
        return "gho_ambient";
      },
    });
    await assert.rejects(
      () => resolve("okam-as"),
      (e) => e instanceof CredentialsMissingError,
    );
    assert.equal(ghCalls, 0);
  });

  it("throws a typed error naming what was tried when gh has no session either", async () => {
    const resolve = buildTokenResolver(baseConfig(), { ghToken: async () => null });
    await assert.rejects(
      () => resolve("okam-as"),
      (e) => e instanceof CredentialsMissingError && /no gh CLI session/.test((e as Error).message),
    );
  });

  describe("an enterprise host", () => {
    const ghe = () => baseConfig({ githubEnterprise: [{ host: "ghe.example", patPath: "github-pat-ghe" }] });
    const noGh = { ghToken: async () => "gho_ambient" };

    it("gets its own PAT, not the github.com one", async () => {
      writeFileSync(join(home, "github-pat"), "github_pat_dotcom\n");
      writeFileSync(join(home, "github-pat-ghe"), "github_pat_ghe\n");
      try {
        const resolve = buildTokenResolver(ghe(), noGh);
        assert.equal(await resolve("uxmn", "app", undefined, "ghe.example"), "github_pat_ghe");
        assert.equal(await resolve("okam-as"), "github_pat_dotcom", "github.com keeps its own PAT");
      } finally {
        rmSync(join(home, "github-pat"), { force: true });
        rmSync(join(home, "github-pat-ghe"), { force: true });
      }
    });

    it("never falls back to the github.com PAT or gh session when its PAT is missing", async () => {
      writeFileSync(join(home, "github-pat"), "github_pat_dotcom\n");
      try {
        const resolve = buildTokenResolver(ghe(), noGh);
        await assert.rejects(
          () => resolve("uxmn", "app", undefined, "ghe.example"),
          (e) => e instanceof CredentialsMissingError && /github-pat-ghe/.test((e as Error).message),
        );
      } finally {
        rmSync(join(home, "github-pat"), { force: true });
      }
    });

    it("refuses a host that is not configured", async () => {
      const resolve = buildTokenResolver(ghe(), noGh);
      await assert.rejects(() => resolve("acme", "app", undefined, "other.example"), CredentialsMissingError);
    });
  });
});
