import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { basename } from "node:path";
import { paths } from "./paths.ts";

describe("paths.worktree", () => {
  it("never starts the dir name with a digit (NativeScript/Gradle project-name rule)", () => {
    // previewIds are random hex and can start with 0-9; the worktree dir name
    // becomes the build's project name, which Gradle rejects if it leads with a digit.
    for (const id of ["3d52b9a7c6e89dbb", "0abc", "9f", "deadbeef"]) {
      const name = basename(paths.worktree(id));
      assert.match(name, /^[A-Za-z]/, `worktree dir "${name}" must start with a letter`);
      assert.ok(name.includes(id), "the previewId must remain recoverable from the dir name");
    }
  });
});
