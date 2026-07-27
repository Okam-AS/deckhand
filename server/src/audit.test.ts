import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarizeArgs } from "./audit.ts";

describe("summarizeArgs redaction", () => {
  it("redacts a top-level pin and other sensitive keys", () => {
    const out = summarizeArgs({ app: "x", pin: "4821", token: "abc", remove: true });
    assert.equal(out?.pin, "[redacted]");
    assert.equal(out?.token, "[redacted]");
    assert.equal(out?.app, "x");
    assert.equal(out?.remove, true);
  });

  it("redacts a nested share.pin (start_preview) too", () => {
    const out = summarizeArgs({ app: "x", share: { access: "pin", pin: "4821" } });
    const share = out?.share as Record<string, unknown>;
    assert.equal(share.access, "pin");
    assert.equal(share.pin, "[redacted]");
  });

  it("does not over-redact lookalike keys (pinLength, spinner)", () => {
    const out = summarizeArgs({ pinLength: 4, spinner: "on" });
    assert.equal(out?.pinLength, 4);
    assert.equal(out?.spinner, "on");
  });

  it("truncates very long strings", () => {
    const out = summarizeArgs({ blob: "a".repeat(300) });
    assert.equal((out?.blob as string).length, 201); // 200 + ellipsis
  });
});
