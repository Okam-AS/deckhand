import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { FLOWS_FILENAME, readFlow } from "./flows.ts";

const action = z.discriminatedUnion("type", [z.object({ type: z.literal("back") }), z.object({ type: z.literal("openUrl"), url: z.string() })]);

function withFile(text: string | null, run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "deckhand-flows-"));
  try {
    if (text !== null) writeFileSync(join(dir, FLOWS_FILENAME), text);
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("readFlow", () => {
  it("returns a flow's actions, validated", () => {
    withFile("flows:\n  settings:\n    - {type: openUrl, url: 'okampos://go/settings'}\n    - {type: back}\n", (dir) => {
      assert.deepEqual(readFlow(dir, "settings", action, 25), { ok: true, actions: [{ type: "openUrl", url: "okampos://go/settings" }, { type: "back" }] });
    });
  });

  it("tells a missing file from a broken one", () => {
    withFile(null, (dir) => assert.equal((readFlow(dir, "x", action, 25) as { code: string }).code, "no_flows_file"));
    withFile("flows: [oops]\n", (dir) => assert.equal((readFlow(dir, "x", action, 25) as { code: string }).code, "invalid_flows_file"));
    assert.equal((readFlow(undefined, "x", action, 25) as { code: string }).code, "no_flows_file");
  });

  it("names the flows that do exist when the asked one does not", () => {
    withFile("flows:\n  a: [{type: back}]\n  b: [{type: back}]\n", (dir) => {
      assert.deepEqual(readFlow(dir, "c", action, 25), { ok: false, code: "unknown_flow", message: `no flow "c" in ${FLOWS_FILENAME}`, available: ["a", "b"] });
      assert.equal((readFlow(dir, "constructor", action, 25) as { code: string }).code, "unknown_flow", "an inherited property is not a flow");
    });
  });

  it("refuses a step the ui tool would refuse, naming the step", () => {
    withFile("flows:\n  a:\n    - {type: back}\n    - {type: teleport}\n", (dir) => {
      const r = readFlow(dir, "a", action, 25);
      assert.equal(r.ok, false);
      assert.match((r as { message: string }).message, /step 2/);
    });
  });

  it("holds a flow to the same length as a list of actions", () => {
    withFile(`flows:\n  a:\n${"    - {type: back}\n".repeat(26)}`, (dir) => {
      assert.match((readFlow(dir, "a", action, 25) as { message: string }).message, /1 to 25 actions/);
    });
  });

  it("does not follow a link out of the checkout, nor quote what it read", () => {
    const outside = mkdtempSync(join(tmpdir(), "deckhand-outside-"));
    try {
      writeFileSync(join(outside, "secret.env"), "flows:\n  a:\n    - {type: SECRET_VALUE}\n");
      withFile(null, (dir) => {
        symlinkSync(join(outside, "secret.env"), join(dir, FLOWS_FILENAME));
        const r = readFlow(dir, "a", action, 25) as { code: string; message: string };
        assert.equal(r.code, "invalid_flows_file");
        assert.doesNotMatch(r.message, /SECRET_VALUE/);
      });
      withFile("flows:\n  a:\n    - {type: SECRET_VALUE}\n", (dir) => {
        assert.doesNotMatch((readFlow(dir, "a", action, 25) as { message: string }).message, /SECRET_VALUE/);
      });
      withFile("TOKEN=SECRET_VALUE: [\n", (dir) => {
        assert.doesNotMatch((readFlow(dir, "a", action, 25) as { message: string }).message, /SECRET_VALUE/);
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
