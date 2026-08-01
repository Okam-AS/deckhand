import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot, refreshVersion, versionStatus, resetVersionCache } from "./version.ts";

/**
 * The self-version check.
 *
 * Deliberately light on mocking: the thing worth asserting is that it reads THIS checkout
 * and never lies about it. The one property that must hold no matter what git says is that
 * an unknown answer is not a green one.
 */

const SRC = dirname(fileURLToPath(import.meta.url));

describe("repoRoot", () => {
  it("finds the repo the running code came from, not the working directory", () => {
    // Resolved from import.meta.url on purpose: deckhand is launched by launchd from an
    // unrelated cwd, so anything cwd-relative would report on whatever directory the agent
    // happened to be sitting in.
    const root = repoRoot();
    assert.ok(root, "this test runs inside the checkout, so a root must be found");
    assert.equal(root, join(SRC, "..", ".."), "the root is the repo, not server/ or server/src/");
  });
});

describe("versionStatus", () => {
  it("reports nothing before the first check rather than reporting healthy", () => {
    // An unknown answer must not read as "you are up to date". Every tool response funnels
    // through ok(), which attaches the notice only when updateAvailable is true — so a null
    // here has to mean silence, not a false all-clear.
    resetVersionCache();
    assert.equal(versionStatus(), null);
  });

  it("describes this checkout truthfully", async () => {
    resetVersionCache();
    const v = await refreshVersion();
    assert.ok(v, "git is available in this repo");
    assert.match(v.current, /^[0-9a-f]{7,}$/, "a short sha");
    assert.ok(v.describe.length > 0);
    // The whole design: the version IS the commit, so it can never drift from the code.
    // Nothing to bump, nothing to remember, nothing that can be wrong while looking right.
    assert.ok(v.describe.includes(v.current) || /^v?\d/.test(v.describe), "describe is a tag or contains the sha");
  });

  it("never claims an update while off main, or with a dirty tree", async () => {
    // A developer on a feature branch is not out of date, and a tool that says so on every
    // call gets tuned out — which costs us the one message that matters when it is real.
    resetVersionCache();
    const v = await refreshVersion();
    assert.ok(v);
    if (v.branch !== "main" || v.dirty) {
      assert.equal(v.updateAvailable, false, "only a clean checkout ON main can be behind main");
    }
    if (v.updateAvailable) assert.ok(v.note, "an actionable claim must carry the line to relay");
  });

  it("caches, so a tool response never waits on the network", async () => {
    resetVersionCache();
    await refreshVersion();
    const first = versionStatus();
    assert.ok(first);
    // Same object, no second ls-remote: versionStatus() is called on EVERY successful tool
    // response, so anything that reached the network there would tax every call.
    assert.equal(versionStatus(), first);
  });
});

describe("the update check is actually wired in", () => {
  /**
   * The bug this exists to prevent has already happened once here, one layer over:
   * `StreamingRouter.reapOrphans()` was written, unit-tested, and never called from boot.
   * Every test passed. Nothing swept. A check nothing invokes is worse than no check,
   * because the tests say it works.
   */
  const read = (p: string) => readFileSync(join(SRC, p), "utf8");

  it("refreshes at boot", () => {
    assert.match(
      read("server.ts"),
      /refreshVersion\(\)/,
      "server.ts must start the first check at boot — otherwise the first tool response after " +
        "a restart has nothing to say, every time",
    );
  });

  it("reaches the agent through the tool-response funnel", () => {
    const tools = read("mcp/tools.ts");
    assert.match(tools, /versionStatus\(\)/, "tools.ts must consult the version");
    // Inside ok(), not inside one handler: a notice attached to a single tool is one an
    // agent only sees if it happens to call that tool, and one the next tool added here
    // silently will not carry.
    const okBody = tools.slice(tools.indexOf("function ok("), tools.indexOf("function fail("));
    assert.match(okBody, /versionStatus\(\)/, "the notice belongs on the shared ok() funnel");
    assert.match(okBody, /updateAvailable/, "and must be gated on updateAvailable, so the normal case is unchanged");
  });
});
