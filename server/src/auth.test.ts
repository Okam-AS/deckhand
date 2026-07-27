import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TokenAuthenticator, canAccessApp, visibleApps, isAdmin } from "./auth.ts";
import type { App, TokenEntry } from "./config.ts";

const tokenA = "a".repeat(64);
const tokenB = "b".repeat(64);

const tokens: TokenEntry[] = [
  { name: "audun", role: "admin", token: tokenA },
  { name: "kari", role: "member", owners: ["ainfrastructure"], token: tokenB },
];

function app(id: string, repo: string): App {
  return { id, repo, type: "expo", defaultBranch: "main", allowForkPRs: false, env: {} };
}

describe("TokenAuthenticator", () => {
  it("authenticates a known token to its principal", () => {
    const auth = new TokenAuthenticator(tokens);
    const p = auth.authenticate(tokenA);
    assert.equal(p?.name, "audun");
    assert.equal(p?.role, "admin");
  });

  it("carries owner scoping", () => {
    const auth = new TokenAuthenticator(tokens);
    assert.deepEqual(auth.authenticate(tokenB)?.owners, ["ainfrastructure"]);
  });

  it("returns null for unknown, empty, and wrong-length tokens", () => {
    const auth = new TokenAuthenticator(tokens);
    assert.equal(auth.authenticate("c".repeat(64)), null);
    assert.equal(auth.authenticate(""), null);
    assert.equal(auth.authenticate("short"), null);
    assert.equal(auth.authenticate(tokenA.slice(0, 63) + "0"), null);
  });
});

describe("app access control", () => {
  it("admin (no owners) can access any app", () => {
    const admin = { name: "audun", role: "admin" as const };
    assert.equal(canAccessApp(admin, app("x", "github.com/other/x")), true);
    assert.ok(isAdmin(admin));
  });

  it("owner-scoped member is restricted to matching owners", () => {
    const kari = { name: "kari", role: "member" as const, owners: ["ainfrastructure"] };
    assert.equal(canAccessApp(kari, app("a", "github.com/ainfrastructure/a")), true);
    assert.equal(canAccessApp(kari, app("b", "github.com/other-org/b")), false);
    assert.equal(isAdmin(kari), false);
  });

  it("unscoped member can access any app", () => {
    const bob = { name: "bob", role: "member" as const };
    assert.equal(canAccessApp(bob, app("b", "github.com/other-org/b")), true);
  });

  it("a local-only app (no repo) is out of reach for owner-scoped tokens, open to unscoped ones", () => {
    const local = { ...app("dev", "github.com/x/y"), repo: undefined, path: "/Users/dev/app" };
    const kari = { name: "kari", role: "member" as const, owners: ["ainfrastructure"] };
    const bob = { name: "bob", role: "member" as const };
    assert.equal(canAccessApp(kari, local), false, "owner scopes are GitHub owners; a pathless-repo app has none");
    assert.equal(canAccessApp(bob, local), true);
  });

  it("visibleApps filters by scope", () => {
    const kari = { name: "kari", role: "member" as const, owners: ["ainfrastructure"] };
    const apps = [
      app("a", "github.com/ainfrastructure/a"),
      app("b", "github.com/other/b"),
      app("c", "github.com/ainfrastructure/c"),
    ];
    assert.deepEqual(
      visibleApps(kari, apps).map((a) => a.id),
      ["a", "c"],
    );
  });
});
