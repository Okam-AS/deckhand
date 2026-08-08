import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { UpdateStatus } from "../version.ts";
import { withUpdateNotice } from "./tools.ts";

const TOOLS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "tools.ts"), "utf8");

/**
 * `ok()` is where the `deckhandUpdate` notice is attached, so a tool that builds its own
 * response object silently opts out of it — which is what `screenshot` did, undetected, while
 * the comment on `ok()` claimed a funnel nobody could forget. This does not prove the notice
 * reaches an agent (the test below pins its SHAPE; nothing pins the delivery). What it proves is narrower
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

/**
 * The notice is a NAG; the tool's `nextStep` is the thing the user needs. Spreading the
 * notice over the data made the nag win, and it wins in the steady state — any install on
 * main that is behind, or pulled and not restarted. `start_preview`'s "Give the user this
 * link NOW" was replaced by "restart deckhand", so the agent relayed the restart and never
 * the link.
 */
test("the update notice never replaces a tool's own nextStep", () => {
  const version: UpdateStatus = {
    current: "aaaaaaa",
    checkout: "bbbbbbb",
    restartNeeded: true,
    describe: "v0.3.0-12-gbbbbbbb",
    latest: "bbbbbbb",
    branch: "main",
    updateAvailable: false,
    dirty: false,
    note: "deckhand has been updated on disk but is still running the old code — restart it?",
    checkedAt: new Date().toISOString(),
  };

  const own = withUpdateNotice({ url: "https://x/s/abc", nextStep: "Give the user this link NOW" }, version);
  assert.equal(own.nextStep, "Give the user this link NOW", "the tool's own instruction was lost under the update nag");
  assert.deepEqual(
    own.deckhandUpdate,
    { running: "aaaaaaa", checkout: "bbbbbbb", latest: "bbbbbbb", action: "restart", note: version.note },
    "and the notice must still arrive — carrying its note, since it no longer owns nextStep",
  );

  // A tool with nothing of its own to say is where the note belongs at top level: that is
  // the field an agent is told to relay.
  const silent = withUpdateNotice({ apps: [] }, version);
  assert.equal(silent.nextStep, version.note);

  // Nothing to say: byte-identical to a response with no notice at all.
  assert.deepEqual(withUpdateNotice({ apps: [] }, null), { ok: true, apps: [] });
  assert.deepEqual(
    withUpdateNotice({ apps: [] }, { ...version, restartNeeded: false, updateAvailable: false }),
    { ok: true, apps: [] },
  );
});
