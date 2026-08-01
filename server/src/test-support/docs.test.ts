import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

const registered = [...TOOLS.matchAll(/server\.registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]!);

describe("docs describe the code that exists", () => {
  it("finds tools to check", () => {
    assert.ok(registered.length > 5, `only ${registered.length} tools parsed — the registerTool pattern changed`);
  });

  it("documents every registered MCP tool in PLAN", () => {
    // A tool that exists but is undocumented is invisible to the next agent,
    // who will reach for the one PLAN describes instead. `set_pin` and
    // `clear_test_run` were both in this state.
    for (const name of registered) {
      assert.ok(PLAN.includes(`\`${name}\``), `MCP tool "${name}" is registered but appears nowhere in PLAN.md`);
    }
  });

  it("mentions no MCP tool that was never built", () => {
    // PLAN documented `start_migration_preview` — a tool that never existed —
    // for two weeks, and §11.3 gated a `compare_start` it never defined. Worse,
    // the dead name leaked into a tool DESCRIPTION, i.e. into text an agent
    // reads as instructions.
    // A name is allowed on a line that says it is gone — "was `compare_set`",
    // "absorbed `compare_start`", "the removed X" are how this document records
    // its own history, and deleting that history is its own kind of drift. What
    // is not allowed is a dead name presented as callable.
    const historical = /\b(was|were|removed|renamed|dropped|absorbed|no longer|never built|superseded|instead of)\b/i;
    const ghosts = PLAN.split("\n")
      .filter((line) => !historical.test(line))
      .flatMap((line) => [
        ...line.matchAll(/`(start_[a-z_]+|list_[a-z_]+|add_[a-z_]+|remove_[a-z_]+|compare_[a-z_]+|parity_[a-z_]+)`/g),
      ])
      .map((m) => m[1]!)
      .filter((name) => !registered.includes(name));
    assert.deepEqual(
      [...new Set(ghosts)],
      [],
      `PLAN.md names MCP tools that are not registered. Either build them, or say plainly that they were dropped.`,
    );
  });

  it("keeps dead tool names out of agent-facing text", () => {
    // The strictest of these: a stale name in a tool description is not drift in
    // a document a human might skim — it is an instruction the model follows.
    const ghostsInSource = [...TOOLS.matchAll(/(start_migration_preview|compare_start|compare_set|compare_status)/g)].map(
      (m) => m[1]!,
    );
    assert.deepEqual(
      [...new Set(ghostsInSource)],
      [],
      `tools.ts mentions a tool that no longer exists — an agent reading that description will try to call it`,
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
