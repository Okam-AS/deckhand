import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { registeredTools, registerToolCallCount, schemaFieldNames, stringLiterals } from "./toolNames.ts";
import { repoFilesEndingWith } from "./repoFiles.ts";

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

/**
 * Every `it("…")`/`test("…")` name in the repo, indexed BY FILE.
 *
 * By file, not as one pool: a citation names a file AND a check, and checking only the name
 * accepts `docs.test.ts "pins serve-sim exactly"` — a citation that resolves while pointing a
 * reader at the wrong file. Both shapes were verified by mutation.
 *
 * `test("…")` as well as `it("…")`: the viewer and landing workspaces write the flat form, so
 * a citation into either could otherwise only ever read as dangling — which pushes the next
 * author to drop the citation rather than fix it.
 */
function testChecksByFile(): Map<string, Set<string>> {
  const byFile = new Map<string, Set<string>>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // Symlinks skipped, never followed: a git worktree carries a dangling
      // `server/node_modules` link, and reading through one kills the walk with an ENOENT
      // nobody can act on. Every walk in this file does this the same way.
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) {
        const names = new Set<string>();
        for (const m of readFileSync(full, "utf8").matchAll(/\b(?:it|test)\(\s*"([^"]+)"/g)) names.add(m[1]!);
        byFile.set(full.slice(REPO.length + 1), names);
      }
    }
  };
  // Every workspace, because `.claude/rules/` is scoped by path and those paths are not all
  // under `server/`. A rule for `landing/**` citing a landing check must be checkable.
  for (const ws of [SRC, join(REPO, "viewer", "src"), join(REPO, "landing", "src")]) if (existsSync(ws)) walk(ws);
  return byFile;
}

/**
 * The citations in one piece of text, as `<file>: "<name>"` findings for the ones that resolve
 * to nothing.
 *
 * `→` marks where citations START; each `<file>.test.ts "<name>"` pair after it is one,
 * wrapped across lines or not. Anchoring the whole citation to the arrow verified only the
 * FIRST check after it, and one line here cites two — so renaming the second was silent.
 *
 * The window after each arrow is bounded because this also reads SOURCE files, where an arrow
 * is usually ordinary prose (`build → install → launch`) and the rest of the file is not its
 * citation. Every citation written here fits well inside it; a longer one reads as dangling,
 * which is a visible failure rather than a silent pass.
 */
function danglingCitations(text: string, byFile: Map<string, Set<string>>): { found: number; dangling: string[] } {
  const dangling: string[] = [];
  let found = 0;
  const paths = [...byFile.keys()];
  const resolves = (path: string) => paths.some((k) => k === path || k.endsWith(`/${path}`));
  for (const chunk of text.split("→").slice(1).map((c) => c.slice(0, 400))) {
    // The FILE half of every citation, named or not. `→ `oauth/pairing.test.ts`` with no
    // quoted check is a citation too, and it was unverified entirely.
    for (const m of chunk.matchAll(/`([A-Za-z0-9_\-./]*\.test\.tsx?)`/g)) {
      found++;
      if (!resolves(m[1]!)) dangling.push(`${m[1]} (no such test file)`);
    }
    // The path character class is explicit rather than `\S*?`: a citation written inside
    // brackets — `(`invariants.test.ts` "…")` — captured the bracket as part of the path.
    // The quoted name is matched as a PREFIX of a real one, so a rule may cite a check by its
    // first clause.
    for (const m of chunk.matchAll(/`?([A-Za-z0-9_\-./]*\.test\.tsx?)`?\s+"([^"]+)"/g)) {
      found++;
      const path = m[1]!;
      // Collapse the wrap. A citation may run onto the next line — several do — and comparing
      // the raw capture then looks for a test name containing a newline and two spaces.
      const cited = m[2]!.replace(/\s+/g, " ").trim();
      const inFile = [...byFile.entries()].filter(([k]) => k === path || k.endsWith(`/${path}`)).flatMap(([, names]) => [...names]);
      if (!inFile.some((n) => n.startsWith(cited))) dangling.push(`${path} "${cited}"`);
    }
  }
  return { found, dangling };
}

/**
 * The COMMENT text of a source file, with the block-comment gutter (` * `) stripped so a
 * citation that wraps onto the next line reads as one sentence.
 *
 * Comments ONLY, because a string literal that happens to look like a citation is not one.
 * Two cheap guards do that without a full lexer: a `//` preceded by `:` is a URL, and a `//`
 * with an odd number of `"` or `` ` `` before it on the line is inside a string. Block
 * comments must open at the start of a line, which every doc block in this repo does.
 *
 * The limit that leaves: a `//` inside a multi-line template literal, on a line that opens no
 * quote of its own, reads as a comment. That costs a false finding only if such a string also
 * contains an arrow and a `*.test.ts "name"` pair, and it is a loud failure, not a silent pass.
 */
function commentsOf(src: string): string {
  const out: string[] = [];
  for (const m of src.matchAll(/^[ \t]*\/\*[\s\S]*?\*\//gm)) out.push(m[0].replace(/^[ \t]*\*[ \t]?/gm, ""));
  for (const line of src.split("\n")) {
    const i = line.indexOf("//");
    if (i < 0 || line[i - 1] === ":") continue;
    const before = line.slice(0, i);
    if ((before.match(/"/g)?.length ?? 0) % 2 || (before.match(/`/g)?.length ?? 0) % 2) continue;
    out.push(line.slice(i + 2));
  }
  return out.join("\n");
}

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
    //
    // Honest limit: PLAN and AGENTS only. `.claude/rules/*.md` and `.claude/skills/**` are read
    // by an agent too, and a dead tool name in one of them is unpoliced — verified by mutation.
    // Not widened on purpose: those files legitimately name OAuth error codes (`invalid_client`,
    // `redirect_uri`) and settings keys, which have a tool's shape, so covering them means a
    // growing allow-list of exemptions and a check that fails with a message about MCP tools
    // when someone documents an error code. `.claude/rules/mcp-tools.md` carries the rule for
    // a reader instead.
    const NOT_TOOLS = new Set(["app_is_a_pane", "deck_unlock", "github_auth_missing", "needs_access_choice", "node_modules", "web_needs_pin"]);
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
    //
    // The other limit is the FILE: tools.ts, not every file that produces agent-facing text.
    // `engine/preview.ts` writes `nextStep` strings an agent reads the same way. Widening
    // there means allow-listing the snake_case error codes the rest of server/src is full of
    // (`unknown_app`, `needs_pin`, `bad_request`, `invalid_client`), which trades a silent gap
    // for a check that fires on correct code — so this stays scoped, and the rule for a reader
    // is in `.claude/rules/mcp-tools.md`.
    const ghostsInSource = [...TOOLS.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)]
      .map((m) => m[1]!)
      .filter((name) => !registered.includes(name));
    assert.deepEqual(
      [...new Set(ghostsInSource)],
      [],
      `tools.ts mentions a tool-shaped name that is not registered — an agent reading that description will try to call it`,
    );
  });

  it("keeps dead parameter names out of agent-facing text", () => {
    // The sibling check above catches a dead TOOL name. It cannot catch a dead PARAMETER, and
    // that is the worse of the two: `compare` was deleted and three of its error strings kept
    // telling the caller to `pass against: { repo, ref }`. A model reading that sends an
    // argument the schema does not have, gets a validation rejection, and the message that was
    // supposed to unstick it is the thing that stuck it.
    //
    // Two shapes, each chosen because it is a name the text is telling the model to TYPE, not
    // a word it happens to use:
    //
    //  1. `pass X: {` / `use X: [` — an argument being demonstrated. The leading verb is what
    //     keeps English out: "not at the top level: {…}" is prose, and a bare `X:\s*[[{]`
    //     pattern reads `level` as a parameter.
    //  2. `X.y` where `y` IS a real field — "parameter dot subfield". `against.worktree` is
    //     caught because `worktree` is real and `against` is not, while `physical.targetable`
    //     (a RESPONSE field named in list_devices' description) is left alone because
    //     `targetable` is not an input field either. Descriptions legitimately name response
    //     shapes, so a rule demanding every dotted owner be a parameter would be false.
    //
    // Fields are collected at every nesting depth and across all tools, so a real name in the
    // wrong tool still passes — the check is "this name exists", not "this name belongs here".
    // Tightening it needs a real schema walk, not a wider regex.
    const fields = schemaFieldNames(TOOLS);
    assert.ok(fields.size > 20, `only ${fields.size} zod fields parsed — the schema style changed, fix this check`);
    const ghosts = new Set<string>();
    for (const text of stringLiterals(TOOLS)) {
      for (const m of text.matchAll(/\b(?:pass|use|with|set) ([a-z][A-Za-z0-9]*)\s*:\s*[[{]/g)) {
        if (!fields.has(m[1]!)) ghosts.add(`${m[1]}: {…}`);
      }
      for (const m of text.matchAll(/\b([a-z][A-Za-z0-9]+)\.([a-z][A-Za-z0-9]*)\b/g)) {
        if (fields.has(m[2]!) && !fields.has(m[1]!)) ghosts.add(`${m[1]}.${m[2]}`);
      }
    }
    assert.deepEqual(
      [...ghosts],
      [],
      `tools.ts tells the caller to pass an argument no tool's schema declares — the call it describes fails validation`,
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
    // EVERY test file, not just test-support. A rule for an area cites the check that
    // enforces it, and for a security invariant that is often the area's own regression
    // test — `oauth/router.test.ts` proves a client mid-pairing survives a registration flood,
    // and no repo-wide guardrail can. Scanning only test-support made those citations
    // dangle, which pushes the next author to drop the citation rather than fix it.
    const byFile = testChecksByFile();
    assert.ok([...byFile.values()].reduce((n, s) => n + s.size, 0) > 5, "no guardrail test names parsed — the `it(\"...\")` pattern changed");

    const dangling: string[] = [];
    let found = 0;
    for (const f of readdirSync(rulesDir)) {
      const r = danglingCitations(readFileSync(join(rulesDir, f), "utf8"), byFile);
      found += r.found;
      for (const d of r.dangling) dangling.push(`${f}: ${d}`);
    }
    // Anti-vacuity. The first version of this regex matched none of the citations actually
    // written here and the check was inert; only mutation showed it up, and nothing would have
    // shown it up on its own. A count is the cheap standing version of that mutation.
    assert.ok(found > 5, `only ${found} citations parsed in .claude/rules/ — the citation form changed, fix this check`);
    assert.deepEqual(
      dangling,
      [],
      "a rule in .claude/rules/ cites a guardrail check that no longer exists under that name",
    );
  });

  it("keeps source-comment citations pointing at checks that exist", () => {
    // The same citation form, in the same repo, three times as common — and unpoliced. The
    // check above reads `.claude/rules/` only, while `→ preview.test.ts "…"` is written in
    // source comments seventeen times, in preview.ts, proxy.ts, androidAdb.ts, androidH264.ts,
    // reaper.ts, metro.ts, control.ts, tools.ts, configWrite.ts, setup.ts and devices/android.ts.
    //
    // That is not a lesser case. AGENTS.md's third un-checkable rule is that a comment stating
    // a precondition needs a test that fails when the precondition breaks, and a citation IS
    // that pairing written down. A rename that leaves it pointing at nothing turns the one
    // mechanism holding those comments honest into decoration, silently.
    //
    // Comments only, and non-test files only: a test file naming its own checks in prose is
    // not making a claim about somewhere else.
    const byFile = testChecksByFile();
    const dangling: string[] = [];
    let found = 0;
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isSymbolicLink() || e.name === "node_modules" || e.name === "dist") continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
          const r = danglingCitations(commentsOf(readFileSync(full, "utf8")), byFile);
          found += r.found;
          for (const d of r.dangling) dangling.push(`${full.slice(REPO.length + 1)}: ${d}`);
        }
      }
    };
    for (const ws of [SRC, join(REPO, "viewer", "src"), join(REPO, "landing", "src"), join(REPO, "scripts")]) if (existsSync(ws)) walk(ws);
    // Anti-vacuity, and it is load-bearing here: this reads comments through `commentsOf`, so
    // a change that makes that return nothing would leave a green check that examines an empty
    // string. There are seventeen citations today.
    assert.ok(found > 12, `only ${found} source-comment citations parsed — the citation form or comment scan changed, fix this check`);
    assert.deepEqual(
      dangling,
      [],
      "a source comment cites a guardrail check that no longer exists under that name — the citation is what " +
        "makes the comment above it verifiable, so a dangling one leaves an unverifiable claim reading as a verified one",
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
    // The CLI's OWN output is checked too, and it is the harder half: a dead command hidden in
    // a `console.log` is invisible to every markdown guardrail, and it is read by the person
    // being onboarded at the exact moment they cannot tell a broken instruction from their own
    // mistake. Three commands this branch deleted survived in setup's closing screen, in
    // `deckhand token`, and in doctor — all of them green.
    // EVERY non-test source file, not the three that printed commands when this was written.
    // `cli/configWrite.ts` throws "no token named X — `deckhand token list` shows them", and
    // `mcp/tools.ts` tells an AGENT to run `deckhand app add <id> --path <dir>` — the two
    // places a dead verb costs the most, and both were outside a three-file list while this
    // check's own comment said "the CLI's OWN output is checked too". Green repo-wide today,
    // so the widening costs nothing and the next printed command is covered by default.
    const sources: [string, string][] = [];
    const walkSrc = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isSymbolicLink()) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) walkSrc(full);
        else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) sources.push([full.slice(REPO.length + 1), readFileSync(full, "utf8")]);
      }
    };
    walkSrc(SRC);
    for (const [name, body] of sources) {
      // Two shapes, because the biggest piece of CLI output is not backticked at all: the
      // usage screen, which is the first thing a lost user reads. So a verb counts when it is
      // quoted as a command AND when it is laid out as one — `deckhand pair` in prose, and
      // "  deckhand pair    mint a code" in the help — at the help's own indent, since a
      // deeply-indented continuation line is prose ("…deckhand uses your gh CLI session").
      // `deckhand listening on …` is a log line, and a check that cannot tell those apart gets
      // deleted rather than obeyed.
      // The third shape is the one the motivating bug actually wore: setup's closing screen
      // NUMBERS its steps ("   1.  deckhand token …"), which matched neither of the other two,
      // so a dead verb in the last thing an install prints stayed green.
      const shapes = [
        // The trailing alternative allows any number of words before the closing backtick:
        // with only one, `deckhand token add me` — the instruction this branch prints from five
        // places — was invisible, so a dead verb in the commonest command stayed green.
        /`deckhand ([a-z-]+)(?=`| <| --|(?: [a-z-]+)+`)/g,
        /(?:^|\n) {2,4}deckhand ([a-z-]+)(?=\s|$)/g,
        // Unanchored, unlike the one above it: this output is written as `say("   1.  deckhand
        // …")`, so the "line" the check reads starts with the call, not with the indent.
        /\d+\.\s{1,4}deckhand ([a-z-]+)(?=\s|$)/g,
      ];
      for (const m of shapes.flatMap((re) => [...body.matchAll(re)])) {
        const verb = m[1]!;
        if (!verbs.has(verb) && !subs.has(verb)) missing.push(`${name}: "deckhand ${verb}"`);
      }
    }
    for (const [name, body] of [
      ["AGENTS.md", AGENTS],
      ["CONSTITUTION.md", readFileSync(join(REPO, "CONSTITUTION.md"), "utf8")],
      ["README.md", readFileSync(join(REPO, "README.md"), "utf8")],
      // PLAN was the one document exempt from this check, and it is the document AGENTS.md
      // orders read END TO END. It named `deckhand service install|status|restart` — a verb that
      // has never existed — plus `app remove` and `env unset`, for as long as anyone can tell.
      // The check that exists precisely because "an instruction that cannot be followed is worse
      // than none" was not applied to the file most likely to be followed.
      ["PLAN.md", PLAN],
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
      // The alternation is part of the capture, because docs write a command family as
      // `deckhand app add|remove|list`. With `([a-z-]+)` alone the second word ended at the
      // first `|`, so `add` was checked and `remove` — which does not exist — was not text the
      // check could see at all. Every branch of the alternation is an instruction to type
      // something, so every branch is checked.
      for (const m of code.matchAll(/\bdeckhand ([a-z-]+)(?: ([a-z-]+(?:\|[a-z-]+)*))?/g)) {
        const verb = m[1]!;
        if (verb === "setup" || verbs.has(verb)) {
          // A second word is only a subcommand for the verbs that take one.
          for (const sub of m[2]?.split("|") ?? []) {
            if (sub && ["token", "app", "env"].includes(verb) && !subs.has(sub) && !/^</.test(sub)) {
              missing.push(`${name}: "deckhand ${verb} ${sub}"`);
            }
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
    // the flow instead of pointing at the command that cannot drift. README then had it too,
    // eight lines above its own "do not attempt those steps" — the check was scoped to one file
    // while the class belongs to every document an agent is pointed at.
    const HUMAN_ONLY = [/cloudflared tunnel login/];
    // EVERY markdown file in the repo, not the six that were listed. The list was the check's
    // own stated principle — "every document an agent is pointed at has to mean all of them, or
    // the sentence is the same kind of claim this file exists to catch" — written next to a
    // literal six, and `docs/**` and the third skill were outside it. Mutation put the login
    // command in a shell block in `docs/reference/serve-sim-notes.md` and in
    // `waiting-for-a-preview/SKILL.md`; both passed.
    // Every markdown file GIT knows about — see repoFiles.ts. A raw walk also read
    // `.claude/pr-body.md`, which `review:handover` writes minutes before the PR and which
    // routinely contains the very command being explained.
    const mdFiles = repoFilesEndingWith(REPO, ".md");
    assert.ok(mdFiles.length > 8, `only ${mdFiles.length} markdown files walked — the walk is wrong, fix this check`);
    const shellBlocks = mdFiles.flatMap((doc) =>
      [...readFileSync(join(REPO, doc), "utf8").matchAll(/```(?:sh|bash|console)\n([\s\S]*?)```/g)].map((m) => `${doc}: ${m[1]!}`),
    );
    for (const block of shellBlocks) {
      for (const banned of HUMAN_ONLY) {
        assert.doesNotMatch(
          block,
          banned,
          `${block.split(":")[0]} puts a human-only command in a runnable block. Describe it in prose ` +
            `as something to ASK for, or let \`deckhand setup\` report it — it already does.`,
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

  it("holds docs/ and .claude/ to the same claims as the root documents", () => {
    // Every check in this file took a hardcoded list of root-level documents, and `docs/**` was
    // on none of them. So the reference notes drifted invisibly for as long as they existed:
    // one of them stated a REJECTED design — "Deckhand's decision (locked): WebRTC + TURN" — as
    // the current locked decision, in a file AGENTS.md orders read before touching streaming
    // code. A document an agent is told to read is agent-facing whatever directory it sits in.
    //
    // Sourced from git rather than a raw walk (see repoFiles.ts): `.claude/pr-body.md` is
    // ignored, is generated by `review:handover` one step before the PR, and names the paths
    // the branch touched — including, on a branch that deletes one, a path that no longer
    // exists. That made the documented workflow fail a check on a file outside the diff.
    const docs: [string, string][] = repoFilesEndingWith(REPO, ".md")
      .filter((p) => p.startsWith("docs/") || p.startsWith(".claude/"))
      .map((p) => [p, readFileSync(join(REPO, p), "utf8")]);
    assert.ok(docs.length > 3, `only ${docs.length} docs found — the walk is wrong, fix this check`);

    const cli = readFileSync(join(SRC, "cli.ts"), "utf8");
    const verbs = new Set([...cli.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]!));
    const subs = new Set([...cli.matchAll(/sub === "([a-z-]+)"/g)].map((m) => m[1]!));
    const wrong: string[] = [];
    for (const [name, body] of docs) {
      // Same scoping as the root check: only where the doc tells someone to TYPE something.
      const code = [
        ...[...body.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!),
        ...[...body.matchAll(/```(?:sh|bash|console)\n([\s\S]*?)```/g)].map((m) => m[1]!),
      ].join("\n");
      for (const m of code.matchAll(/\bdeckhand ([a-z-]+)(?: ([a-z-]+(?:\|[a-z-]+)*))?/g)) {
        const verb = m[1]!;
        if (verb !== "setup" && !verbs.has(verb)) wrong.push(`${name}: "deckhand ${verb}"`);
        else for (const sub of m[2]?.split("|") ?? []) {
          if (sub && ["token", "app", "env"].includes(verb) && !subs.has(sub) && !/^</.test(sub)) wrong.push(`${name}: "deckhand ${verb} ${sub}"`);
        }
      }
      for (const m of body.matchAll(/`((?:server|viewer|landing|ops|patches|docs|scripts)\/[A-Za-z0-9_\-./]+\.(?:ts|tsx|md|json|sh|yml))`/g)) {
        if (!existsSync(join(REPO, m[1]!))) wrong.push(`${name}: ${m[1]!}`);
      }
    }
    assert.deepEqual([...new Set(wrong)], [], "a file under docs/ or .claude/ names a command or a source file that does not exist");
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
      for (const m of doc.matchAll(/`((?:server|viewer|landing|ops|patches|docs|scripts)\/[A-Za-z0-9_\-./]+\.(?:ts|tsx|md|json|sh|yml))`/g)) {
        const path = m[1]!;
        if (!existsSync(join(REPO, path))) missing.push(path);
      }
      // DIRECTORIES and globs, which the extension requirement above could never see. PLAN's
      // repo tree named `server/test/` and `fixtures/expo-smoke/` — neither has ever existed —
      // and pointed `mcp/` at a `tools/*.ts` that is one file. A reader goes looking for a
      // directory exactly as readily as for a file, and `doctor --smoke` was documented in terms
      // of the fixture directory. A glob is checked by its own directory: the claim "there are
      // files of this shape in here" is false the moment the directory is not there.
      for (const m of doc.matchAll(/`((?:server|viewer|landing|ops|patches|docs|scripts|fixtures)\/[A-Za-z0-9_\-./]*?)(?:\*[A-Za-z0-9_\-.*]*)?\/?`/g)) {
        const path = m[1]!.replace(/\/$/, "");
        if (path && !path.includes(".") && !existsSync(join(REPO, path))) missing.push(`${path}/`);
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
        if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".") || e.isSymbolicLink()) continue;
        if (e.isDirectory()) walk(join(dir, e.name));
        else sources.add(e.name);
      }
    };
    for (const ws of ["server", "viewer", "landing"]) walk(join(REPO, ws, "src"));
    // `scripts/` is not a workspace, but AGENTS.md now cites files there by path — and this
    // check's own comment lists `scripts/` among the phantom paths it was written to catch.
    walk(join(REPO, "scripts"));
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
