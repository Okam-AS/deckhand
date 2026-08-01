import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { registeredTools, registerToolCallCount } from "./toolNames.ts";

/**
 * PLAN.md and AGENTS.md, checked against the code they claim to describe.
 *
 * PLAN.md calls itself "the single source of truth" and is what a new agent is
 * told to read first. It had drifted badly: it documented a tool that was never
 * built, gated one it never defined, named five files that do not exist, and
 * said "~11 tools" of nineteen. AGENTS.md still claimed 168 tests when there
 * were 481.
 *
 * That is not cosmetic. During the last review both documents asserted the
 * change "touched no proxy code" — the sentence most likely to stop a reviewer
 * looking exactly where a cross-page auth bypass was sitting. A false map is
 * worse than no map, because it is trusted.
 *
 * These checks are deliberately narrow. They cannot judge whether prose is
 * *right*; they can only catch claims that are mechanically false, which is the
 * kind that accumulates silently.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(SRC, "..", "..");
const read = (f: string) => readFileSync(join(REPO, f), "utf8");

const PLAN = read("PLAN.md");
const AGENTS = read("AGENTS.md");
const TOOLS = read("server/src/mcp/tools.ts");

const registered = registeredTools(TOOLS);

describe("docs describe the code that exists", () => {
  it("finds tools to check", () => {
    assert.ok(registered.length > 5, `only ${registered.length} tools parsed — the registerTool pattern changed`);
  });

  it("registers every tool under a name this file can read", () => {
    // A `registerTool(TOOL.SET_PIN, …)` or `registerTool(\`ui_\${v}\`, …)` is invisible to the
    // scan, and an invisible tool is exempt from BOTH the documentation check below and the
    // audited() check in invariants.test.ts. Neither would fail — the other tools keep the
    // sentinels green. So the ban is on the unreadable form itself.
    const all = registerToolCallCount(TOOLS);
    assert.equal(
      registered.length,
      all,
      `${all} registerTool() calls but only ${registered.length} readable names — the rest use a computed or ` +
        `template name, which is exempt from every check keyed on it. Use a plain string literal.`,
    );
  });

  it("documents every registered MCP tool in PLAN", () => {
    // A tool that exists but is undocumented is invisible to the next agent,
    // who will reach for the one PLAN describes instead. `set_pin` and
    // `clear_test_run` were both in this state.
    for (const name of registered) {
      assert.ok(PLAN.includes(`\`${name}\``), `MCP tool "${name}" is registered but appears nowhere in PLAN.md`);
    }
  });

  it("mentions no MCP tool that does not exist", () => {
    // PLAN documented `start_migration_preview` — a tool that never existed — for two weeks,
    // and §11.3 gated a `compare_start` it never defined. Worse, the dead name leaked into a
    // tool DESCRIPTION, i.e. into text an agent reads as instructions.
    //
    // There is no escape hatch for "recording history". There was one — any line containing
    // was/were/removed/renamed/dropped — and it exempted the WHOLE line on words that occur in
    // ordinary prose, so "call `start_x` when the preview was created by a migration" passed.
    // These documents describe what exists now; a rename is a rename, and git holds the past.
    //
    // Matched on the SHAPE of a tool name (backticked snake_case) rather than on six known
    // prefixes: of the 19 live tools, `describe`, `ui`, `logs`, `screenshot`, `set_pin` and
    // the `*_test_run` family had shapes the old pattern could never see, so a dead name in
    // any of them was unpoliced. The allow-list below is for the handful of snake_case terms
    // in these docs that are genuinely not tools.
    const NOT_TOOLS = new Set(["deck_unlock", "github_auth_missing", "needs_access_choice", "node_modules", "web_needs_pin"]);
    const ghosts = [PLAN, AGENTS]
      .flatMap((doc) => [...doc.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)])
      .map((m) => m[1]!)
      .filter((name) => !registered.includes(name) && !NOT_TOOLS.has(name));
    assert.deepEqual(
      [...new Set(ghosts)],
      [],
      `PLAN.md / AGENTS.md name MCP tools that are not registered. Either build them, or delete the mention — ` +
        `if the name is not a tool at all, add it to NOT_TOOLS with that as the reason.`,
    );
  });

  it("keeps dead tool names out of agent-facing text", () => {
    // The strictest of these: a stale name in a tool description is not drift in a document a
    // human might skim — it is an instruction the model follows.
    //
    // Derived, not hardcoded. This was a fixed list of four dead names, which by construction
    // could only catch the renames that had ALREADY happened — the next one would sail past
    // the check written for exactly that failure. So: any tool-shaped name appearing in
    // tools.ts that nothing registers.
    // Scoped to BACKTICKED snake_case, which is how this file's prose refers to a tool
    // (`compare_start` was written exactly that way). Bare identifiers are not usable here:
    // tools.ts is full of snake_case error codes — `unknown_app`, `needs_pin`, `bad_request` —
    // that share the shape and are not tools. Names without an underscore (`describe`, `ui`,
    // `logs`) are ordinary English and stay out of reach; that is the honest limit of a
    // text scan.
    const ghostsInSource = [...TOOLS.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)]
      .map((m) => m[1]!)
      .filter((name) => !registered.includes(name));
    assert.deepEqual(
      [...new Set(ghostsInSource)],
      [],
      `tools.ts mentions a tool-shaped name that is not registered — an agent reading that description will try to call it`,
    );
  });

  it("names no source file that does not exist", () => {
    // PLAN §4 described a layout that had drifted from the tree: janitor.ts,
    // scrcpy.ts, server/test/, fixtures/, scripts/ — five paths a new agent
    // would go looking for, and `doctor --smoke` is documented in terms of a
    // fixture directory that was never created.
    const missing: string[] = [];
    for (const doc of [PLAN, AGENTS]) {
      for (const m of doc.matchAll(/`((?:server|viewer|landing|ops|patches|docs)\/[A-Za-z0-9_\-./]+\.(?:ts|tsx|md|json|sh|yml))`/g)) {
        const path = m[1]!;
        if (!existsSync(join(REPO, path))) missing.push(path);
      }
    }
    assert.deepEqual([...new Set(missing)], [], `documented paths that do not exist`);
  });
});
