import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOLS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "tools.ts"), "utf8");

/**
 * `ok()` is where the `deckhandUpdate` notice is attached, so a tool that builds its own
 * response object silently opts out of it — which is what `screenshot` did, undetected, while
 * the comment on `ok()` claimed a funnel nobody could forget. This does not prove the notice
 * reaches an agent (nothing does; `deckhandUpdate` has no test). What it proves is narrower
 * and is the thing that actually went wrong: exactly three places in tools.ts hand-build a
 * CallToolResult, and a fourth has to be argued for.
 *
 * Text form on purpose — a response built by a helper this file cannot see would still slip
 * past. It fails SAFE: a comment that quotes the shape breaks the check rather than
 * satisfying it, which is the opposite of how the share-gate check was once fooled.
 */
test("only the two response helpers and screenshot's image build a result by hand", () => {
  const blocks = [...TOOLS.matchAll(/return\s*\{\s*\n?\s*content:\s*\[\{\s*type:\s*"(\w+)"/g)].map((m) => m[1]!);

  assert.deepEqual(
    blocks,
    ["text", "text", "image"],
    "a tool is building its own response instead of going through ok()/failWith(), so it carries no deckhandUpdate notice — " +
      "route it through ok(), or if it genuinely cannot return JSON (an image, like screenshot), widen this list and say why here",
  );

  // Anchor the exemption to the tool that owns it, so moving the image return under a
  // different tool is a change someone has to make deliberately.
  const image = TOOLS.indexOf('type: "image"');
  const screenshot = TOOLS.indexOf('"screenshot"');
  const describe = TOOLS.indexOf('"describe"', screenshot);
  assert.ok(screenshot > 0 && image > screenshot && image < describe, "the image response is no longer inside the screenshot tool");
});
