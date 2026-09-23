import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { verifyOrphansIn } from "./procs.ts";

describe("verifyOrphansIn", () => {
  it("collects processes whose verify owner has died, and nothing else", () => {
    const ps = [
      "  201 node metro DECKHAND_METRO=1 DECKHAND_VERIFY=7001",
      "  202 xcodebuild DECKHAND_BUILD=1 DECKHAND_VERIFY=7002",
      `  203 node metro DECKHAND_VERIFY=${process.pid}`,
      "  204 node metro DECKHAND_METRO=1",
    ].join("\n");
    assert.deepEqual(verifyOrphansIn(ps, (pid) => pid === 7002), [201]);
  });
});
