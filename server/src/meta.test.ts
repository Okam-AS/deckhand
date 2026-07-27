import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DECKHAND_NAME, DECKHAND_VERSION, serverInfo } from "./meta.ts";

describe("meta", () => {
  it("reports a stable server identity", () => {
    assert.equal(serverInfo().name, DECKHAND_NAME);
    assert.equal(serverInfo().version, DECKHAND_VERSION);
  });

  it("uses a semver-shaped version string", () => {
    assert.match(DECKHAND_VERSION, /^\d+\.\d+\.\d+/);
  });
});
