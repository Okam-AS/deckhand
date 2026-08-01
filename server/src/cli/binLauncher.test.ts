import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The `deckhand` command, run from somewhere that is not the deckhand checkout.
 *
 * The first version passed `--import tsx`, which node resolves against the PROCESS'S working
 * directory. So it worked inside the repo and died everywhere else with
 * `Cannot find package 'tsx'` — which is every real use, since the whole point of putting it
 * on PATH is to run it from wherever your project happens to be. Reported by a user typing
 * `deckhand token list` in their own project, one hour after it shipped.
 */

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "deckhand.mjs");

describe("the deckhand launcher", () => {
  it("runs from a directory with no node_modules at all", () => {
    // tmpdir has no package.json and no tsx. If the launcher resolves tsx by name rather than
    // by absolute path, this throws ERR_MODULE_NOT_FOUND.
    const out = execFileSync(process.execPath, [BIN], { cwd: tmpdir(), encoding: "utf8" });
    assert.match(out, /deckhand — simulator previews over MCP/, "it printed its usage, from a foreign cwd");
  });

  it("resolves tsx from its own checkout, not from the caller's", () => {
    const src = execFileSync("cat", [BIN], { encoding: "utf8" });
    assert.match(src, /require\.resolve\("tsx"\)/, "an absolute path, resolved from this file");
    assert.doesNotMatch(
      src.replace(/\/\/.*$/gm, ""),
      /"--import",\s*"tsx"/,
      "passing the bare name makes node resolve it against the caller's cwd",
    );
  });
});
