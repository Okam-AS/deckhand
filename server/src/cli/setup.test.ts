import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deckhandOnUserPath } from "./setup.ts";

const REPO = "/Users/x/Repos/deckhand";

const which = (out: string, code = 0) => () => ({ code, out });

describe("whether `deckhand` is a command the user can type", () => {
  it("accepts a link in a real bin directory", () => {
    assert.equal(deckhandOnUserPath(REPO, which("/Users/x/.nvm/versions/node/v25.8.1/bin/deckhand\n")), true);
  });

  // Setup runs under `npx`, which prepends this repo's node_modules/.bin — where npm keeps a
  // workspace shim. Trusting that answer reported a green install whose documented commands
  // did not exist in the user's shell.
  it("rejects the npx shim inside the repo, which no shell of the user's can see", () => {
    assert.equal(deckhandOnUserPath(REPO, which(`${REPO}/node_modules/.bin/deckhand\n`)), false);
  });

  // `run` folds stderr into stdout, so a `which` that explains its failure hands back a
  // sentence where a path is expected. The exit code is the answer; the output is only a path.
  it("believes the exit code, not the output", () => {
    assert.equal(deckhandOnUserPath(REPO, which("deckhand not found", 1)), false);
    assert.equal(deckhandOnUserPath(REPO, which("which: no deckhand in (/usr/bin /bin)", 1)), false);
    assert.equal(deckhandOnUserPath(REPO, which("", 0)), false, "a zero exit with no path is not a path");
  });

  it("is not fooled by a repo-shaped prefix that is a different directory", () => {
    assert.equal(deckhandOnUserPath(REPO, which(`${REPO}-other/node_modules/.bin/deckhand`)), true);
  });
});
