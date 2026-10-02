import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scrubTyped, summarizeArgs } from "./audit.ts";

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

  it("redacts and truncates inside a list, as `ui` sends its actions", () => {
    const out = summarizeArgs({ actions: [{ type: "openUrl", url: "a".repeat(300) }, { type: "x", password: "hunter2" }] });
    const [long, secret] = out?.actions as Array<Record<string, unknown>>;
    assert.equal((long!.url as string).length, 201);
    assert.equal(secret!.password, "[redacted]");
  });

  it("never keeps what a type action typed, alone or in a list", () => {
    const out = summarizeArgs({ action: { type: "type", text: "123123" }, actions: [{ type: "type", text: "4321" }, { type: "tapElement", selector: { text: "Logg inn" } }] });
    assert.doesNotMatch(JSON.stringify(out), /123123|4321/);
    assert.match(JSON.stringify(out), /Logg inn/, "a selector's text is not what was typed");
  });

  it("takes what a type action typed out of an error before it is logged", () => {
    const msg = scrubTyped('type "4321" failed: field rejected 4321', { actions: [{ type: "tapElement", selector: { id: "pin" } }, { type: "type", text: "4321" }] });
    assert.doesNotMatch(msg, /4321/);
    assert.equal(scrubTyped("No accessibility element matched.", { action: { type: "type", text: "x1" } }), "No accessibility element matched.");
  });
});
