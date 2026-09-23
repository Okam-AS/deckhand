import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryLock } from "./lock.ts";

const root = mkdtempSync(join(tmpdir(), "verify-lock-"));
after(() => rmSync(root, { recursive: true, force: true }));

describe("tryLock", () => {
  it("lets one holder in, and only that holder's release frees it", () => {
    const dir = join(root, "one.lock");
    const release = tryLock(dir);
    assert.ok(release);
    assert.equal(tryLock(dir), null);
    const [pid] = readFileSync(join(dir, "owner"), "utf8").split(" ");
    assert.equal(pid, String(process.pid));
    writeFileSync(join(dir, "owner"), `${process.pid} someone-else`);
    release!();
    assert.ok(existsSync(dir), "a release never removes a lock it no longer owns");
    rmSync(dir, { recursive: true });
  });

  it("takes over a dead holder's lock", () => {
    const dir = join(root, "dead.lock");
    mkdirSync(dir);
    writeFileSync(join(dir, "owner"), "999999 old");
    const release = tryLock(dir);
    assert.ok(release, "pid 999999 is not running");
    assert.match(readFileSync(join(dir, "owner"), "utf8"), new RegExp(`^${process.pid} `));
    release!();
    assert.ok(!existsSync(dir));
  });

  it("treats an owner-less lock as mid-creation until it is old enough to be a crash's leftover", () => {
    const dir = join(root, "bare.lock");
    mkdirSync(dir);
    assert.equal(tryLock(dir), null);
    const past = new Date(Date.now() - 60_000);
    utimesSync(dir, past, past);
    const release = tryLock(dir);
    assert.ok(release);
    release!();
  });
});
