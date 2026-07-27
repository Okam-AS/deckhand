import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { allocatePort, helperBasePath, isAllowedSubpath, PROXY_ALLOWED_SUBPATHS } from "./backend.ts";

describe("allocatePort", () => {
  it("returns the first free port in range", () => {
    assert.equal(allocatePort(3100, 3199, new Set()), 3100);
    assert.equal(allocatePort(3100, 3199, new Set([3100, 3101])), 3102);
  });

  it("throws when the range is exhausted", () => {
    assert.throws(() => allocatePort(3100, 3101, new Set([3100, 3101])), /no free helper port/);
  });
});

describe("helperBasePath", () => {
  it("builds /helper/<udid>", () => {
    assert.equal(helperBasePath("ABC-123"), "/helper/ABC-123");
  });
});

describe("isAllowedSubpath", () => {
  it("permits only stream/input/ax subpaths", () => {
    for (const ok of PROXY_ALLOWED_SUBPATHS) assert.equal(isAllowedSubpath(ok), true);
    for (const bad of ["exec", "exec-ws", "config", "grid/api", "devtools", "../secret", "foreground"]) {
      assert.equal(isAllowedSubpath(bad), false, `must reject ${bad}`);
    }
  });
});
