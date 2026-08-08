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
 *
 * The pattern is the CONTENT BLOCK, not the return statement wrapped round it. It used to
 * require `return {` immediately before `content: [{`, all adjacent — so a fourth hand-built
 * result written the way a formatter would break it (`content: [\n  { type: "text"`), or
 * returned from anything other than a bare `return {`, was invisible while this comment
 * claimed "exactly three places". Verified by mutation: a fourth helper in that shape passed.
 *
 * Both quote characters, for the same reason. There is no lint and no formatter here, and
 * tools.ts already writes single quotes elsewhere, so `type: 'text'` was a fourth hand-built
 * result that this check could not see while the comment on `ok()` claimed it was the only
 * funnel. Verified by mutation: a single-quoted fourth block passed.
 */
test("only the two response helpers and screenshot's image build a result by hand", () => {
  const blocks = [...TOOLS.matchAll(/content:\s*\[\s*\{\s*type:\s*["'](\w+)["']/g)].map((m) => m[1]!);

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
  // The upper bound is the next tool registered after screenshot, so this check depends on
  // `describe` being registered after it. Asserted, not assumed: reorder the two and the search
  // returns -1, `image < -1` is false, and the failure below would report the image response as
  // having left the screenshot tool — a true-sounding message about something that did not
  // happen, sending the reader to the wrong file.
  assert.ok(screenshot > 0, 'tools.ts no longer registers a tool named "screenshot" — fix this check');
  assert.ok(
    describe > screenshot,
    'no "describe" appears after "screenshot" in tools.ts, so this check has no upper bound for the ' +
      "screenshot tool's span — pick the tool that now follows it as the anchor",
  );
  assert.ok(image > screenshot && image < describe, "the image response is no longer inside the screenshot tool");
});
