import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

  it("keeps the path-scoped rules pointing at checks that exist", () => {
    // `.claude/rules/*.md` is what an agent is handed the moment it opens a file in that
    // area, and each rule cites the guardrail that enforces it — `→ invariants.test.ts
    // "binds every listening socket to loopback"`. That citation is the whole reason the
    // rule is trustworthy rather than one more paragraph of prose, so a renamed check must
    // not leave it pointing at nothing. Same failure as a doc naming a file that does not
    // exist, one layer up.
    const rulesDir = join(REPO, ".claude", "rules");
    const testNames = new Set<string>();
    for (const f of readdirSync(join(SRC, "test-support"))) {
      if (!f.endsWith(".test.ts")) continue;
      for (const m of readFileSync(join(SRC, "test-support", f), "utf8").matchAll(/\bit\(\s*"([^"]+)"/g)) {
        testNames.add(m[1]!);
      }
    }
    assert.ok(testNames.size > 5, "no guardrail test names parsed — the `it(\"...\")` pattern changed");

    const dangling: string[] = [];
    for (const f of readdirSync(rulesDir)) {
      const src = readFileSync(join(rulesDir, f), "utf8");
      // `→ <file>.test.ts "<check name>"`, possibly abbreviated — match on the quoted name
      // being a PREFIX of a real one, so a rule may cite a check by its first clause.
      // The backticks are not optional decoration to skip: the first version of this regex
      // required `\S+\.test\.ts` followed by whitespace, so it matched none of the
      // backticked citations actually written here and the check was vacuous. It only
      // showed up under mutation — renaming a cited check produced no failure at all.
      for (const m of src.matchAll(/→\s*`?\S*?\.test\.ts`?\s+"([^"]+)"/g)) {
        const cited = m[1]!;
        if (![...testNames].some((n) => n.startsWith(cited))) dangling.push(`${f}: "${cited}"`);
      }
    }
    assert.deepEqual(
      dangling,
      [],
      "a rule in .claude/rules/ cites a guardrail check that no longer exists under that name",
    );
  });

  it("only tells people to run deckhand commands that exist", () => {
    // Principle 1: an instruction that cannot be followed is worse than none, because the
    // reader assumes the mistake is theirs. It happened three times in one day — `deckhand`
    // was not a command while every document said to type it; `token list` was documented as
    // showing the connector URL and did not; `init` demanded a hostname you could not have
    // yet. Each was found by a person typing what we told them to.
    //
    // So the docs' own claims are checked against the CLI's switch: every `deckhand <verb>`
    // in agent-facing prose must be a verb cli.ts actually handles.
    const cli = readFileSync(join(SRC, "cli.ts"), "utf8");
    const verbs = new Set([...cli.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]!));
    const subs = new Set([...cli.matchAll(/sub === "([a-z-]+)"/g)].map((m) => m[1]!));
    assert.ok(verbs.size > 4, `only ${verbs.size} cli verbs parsed — the switch changed, fix this check`);

    const missing: string[] = [];
    for (const [name, body] of [
      ["AGENTS.md", AGENTS],
      ["CONSTITUTION.md", readFileSync(join(REPO, "CONSTITUTION.md"), "utf8")],
      ["README.md", readFileSync(join(REPO, "README.md"), "utf8")],
    ] as const) {
      // Only where the doc is telling someone to TYPE something: inside backticks or a
      // fenced block. "deckhand can read repos" is English, not an instruction, and a check
      // that cannot tell the difference gets deleted rather than obeyed.
      const code = [
        ...[...body.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!),
        // Shell blocks only. A fenced block is not automatically a command: README's
        // architecture diagram contains the words "deckhand server (loopback only)".
        ...[...body.matchAll(/```(?:sh|bash|console)\n([\s\S]*?)```/g)].map((m) => m[1]!),
      ].join("\n");
      for (const m of code.matchAll(/\bdeckhand ([a-z-]+)(?: ([a-z-]+))?/g)) {
        const verb = m[1]!;
        if (verb === "setup" || verbs.has(verb)) {
          // A second word is only a subcommand for the verbs that take one.
          const sub = m[2];
          if (sub && ["token", "app", "env"].includes(verb) && !subs.has(sub) && !/^</.test(sub)) {
            missing.push(`${name}: "deckhand ${verb} ${sub}"`);
          }
          continue;
        }
        missing.push(`${name}: "deckhand ${verb}"`);
      }
    }
    assert.deepEqual([...new Set(missing)], [], "the docs tell people to run commands that do not exist");
  });

  it("never puts a human-only command in a block an agent will copy", () => {
    // preflight.ts classifies each prerequisite by WHO can fix it, and the human-only ones
    // need a browser and someone's Cloudflare account. A doc that lists `cloudflared tunnel
    // login` inside the install block an agent copy-pastes undoes that classification
    // entirely — the agent runs it and hangs on a prompt nobody sees.
    //
    // AGENTS.md had exactly that, one day after the section was written, because it restated
    // the flow instead of pointing at the command that cannot drift.
    const HUMAN_ONLY = [/cloudflared tunnel login/];
    const agentFacing = readFileSync(join(REPO, "AGENTS.md"), "utf8");
    const shellBlocks = [...agentFacing.matchAll(/```(?:sh|bash|console)\n([\s\S]*?)```/g)].map((m) => m[1]!);
    for (const block of shellBlocks) {
      for (const banned of HUMAN_ONLY) {
        assert.doesNotMatch(
          block,
          banned,
          `AGENTS.md puts a human-only command in a runnable block. Describe it in prose as ` +
            `something to ASK for, or let \`deckhand setup\` report it — it already does.`,
        );
      }
    }
  });

  it("documents every CLI verb, the way it documents every MCP tool", () => {
    // The existing checks all run ONE WAY: they catch PLAN naming something that does not
    // exist. Nothing caught the reverse — code existing that PLAN has never heard of — and it
    // rotted exactly as you would expect. `deckhand setup`, the single most important command
    // in the product, appeared in PLAN zero times; §10 meanwhile credited `init` with
    // creating the tunnel, the DNS route, the launchd agents and the first token, none of
    // which it has ever done.
    //
    // Verbs, not files. A file list in a document is drift by construction — this one has
    // rotted twice — but the CLI's verbs are the contract a user actually types.
    const cli = readFileSync(join(SRC, "cli.ts"), "utf8");
    const verbs = [...cli.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]!);
    assert.ok(verbs.length > 4, `only ${verbs.length} verbs parsed — the switch changed, fix this check`);
    for (const verb of verbs) {
      assert.ok(
        new RegExp(`\`deckhand ${verb}[\`\\s]`).test(PLAN),
        `\`deckhand ${verb}\` is a command but PLAN.md never mentions it. PLAN calls itself the ` +
          `single source of truth; a command it has not heard of is invisible to the next agent.`,
      );
    }
  });

  it("references only skills that exist", () => {
    // AGENTS and CONSTITUTION now make `shipping-a-change` mandatory before every PR. A
    // mandatory procedure that points at a directory nobody wrote is worse than no procedure:
    // the reader concludes the instruction is stale and skips the rest of the file too.
    // Same failure as a doc naming a command that does not exist, one layer up.
    const named = new Set<string>();
    for (const doc of [AGENTS, PLAN, readFileSync(join(REPO, "CONSTITUTION.md"), "utf8")]) {
      for (const m of doc.matchAll(/`([a-z][a-z0-9-]+)`\s*skill|\.claude\/skills\/([a-z0-9-]+)/g)) {
        const name = m[1] ?? m[2];
        if (name) named.add(name);
      }
    }
    assert.ok(named.size > 0, "no skills referenced — the pattern changed, fix this check");
    for (const name of named) {
      assert.ok(
        existsSync(join(REPO, ".claude", "skills", name, "SKILL.md")),
        `a doc points at the "${name}" skill, which does not exist at .claude/skills/${name}/SKILL.md`,
      );
    }
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
    // Bare module names too — `janitor.ts` and `scrcpy.ts` sat in PLAN for months naming
    // files nobody ever wrote, and this check could not see them: it required a directory
    // prefix, and PLAN's architecture prose and its repo-layout tree both write the module
    // alone. A bare name is checked by BASENAME anywhere under the workspaces, because that
    // is the strongest claim the prose actually makes ("there is a module called this").
    const sources = new Set<string>();
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
        if (e.isDirectory()) walk(join(dir, e.name));
        else sources.add(e.name);
      }
    };
    for (const ws of ["server", "viewer", "landing"]) walk(join(REPO, ws, "src"));
    for (const doc of [PLAN, AGENTS]) {
      for (const m of doc.matchAll(/(?:`|\s)([a-zA-Z][A-Za-z0-9_-]*\.tsx?)\b/g)) {
        const name = m[1]!;
        if (!sources.has(name)) missing.push(name);
      }
    }
    assert.deepEqual(
      [...new Set(missing)],
      [],
      `PLAN.md / AGENTS.md name source files that do not exist. Either build them, or delete the mention.`,
    );
  });
});
