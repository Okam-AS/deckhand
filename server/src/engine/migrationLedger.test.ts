import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMigrationLedger, LEDGER_FILENAME } from "./migrationLedger.ts";

describe("readMigrationLedger", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "dh-ledger-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const writeLedger = (body: string) => writeFileSync(join(dir, LEDGER_FILENAME), body);

  it("returns null when the dir is unknown or the file is absent", () => {
    assert.equal(readMigrationLedger(undefined), null);
    assert.equal(readMigrationLedger(join(dir, "does-not-exist")), null);
  });

  it("parses screens and defaults status to not-started", () => {
    writeLedger(
      ["screens:", "  - name: Onboarding", "    status: matches", "    note: ported nav", "  - name: Settings"].join("\n"),
    );
    const led = readMigrationLedger(dir);
    assert.ok(led);
    assert.equal(led!.screens.length, 2);
    assert.deepEqual(led!.screens[0], { name: "Onboarding", status: "matches", note: "ported nav" });
    assert.equal(led!.screens[1]!.status, "not-started");
  });

  it("soft-fails to null on malformed YAML, a bad status, or no screens", () => {
    writeLedger("screens: [ this is : not valid");
    assert.equal(readMigrationLedger(dir), null);
    writeLedger("screens:\n  - name: X\n    status: bogus");
    assert.equal(readMigrationLedger(dir), null);
    writeLedger("screens: []");
    assert.equal(readMigrationLedger(dir), null);
  });
});
