import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { auditedTools, registeredTools, registerToolCallCount } from "./toolNames.ts";

/**
 * The rules PLAN.md states as acceptance criteria, as executable checks.
 *
 * PLAN §2 (locked decisions) and §11 (security model) say outright that they are
 * "acceptance criteria, not suggestions" — but nothing enforced them, so they
 * were criteria only for whoever remembered to read 885 lines of prose. Every
 * assertion below is one a reviewer would otherwise have to make by hand, and
 * several encode rules that were already broken once.
 *
 * Deliberately source-text checks rather than imports: these must hold for code
 * that is never executed by any other test, and importing the modules would
 * make the check depend on the very wiring it is meant to police.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(SRC, "..", "..");

/** Every .ts file under server/src, excluding tests and this directory. */
function sourceFiles(dir = SRC, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "test-support") sourceFiles(full, out);
      continue;
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** Test files, which `sourceFiles` deliberately skips — some rules apply only to them. */
function testFiles(dir = SRC, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "test-support") testFiles(full, out);
      continue;
    }
    if (entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const read = (f: string) => readFileSync(f, "utf8");
const rel = (f: string) => f.slice(REPO.length + 1);

describe("PLAN §2 — locked decisions", () => {
  it("adds no dependency outside the approved set", () => {
    // "Keep the dependency list ruthlessly short" (PLAN.md:136-138) is the rule
    // most easily broken by a future agent reaching for a familiar library, and
    // the one with no other signal — nothing fails, the repo just grows.
    const approved = new Set([
      "@modelcontextprotocol/sdk",
      "express",
      "zod",
      "yaml",
      "ws",
      "serve-sim",
      "patch-package",
      "react",
      "react-dom",
    ]);
    // The ROOT package.json is in this list because it was the cheapest way around the rule:
    // a dependency added there hoists into the shared node_modules and is importable from
    // every workspace, while a check that only read the three workspaces saw nothing.
    for (const ws of ["", "server", "viewer", "landing"]) {
      const pkg = JSON.parse(read(join(REPO, ws, "package.json"))) as { dependencies?: Record<string, string> };
      for (const dep of Object.keys(pkg.dependencies ?? {})) {
        assert.ok(
          approved.has(dep),
          `${ws || "."}/package.json adds "${dep}", which is not in PLAN §3's approved list. ` +
            `Adding a dependency is a PLAN §2 decision — argue it there first, then widen this set.`,
        );
      }
    }
  });

  it("adds no build-time dependency outside the approved set either", () => {
    // devDependencies were unchecked, and "it's only a devDependency" is exactly the argument
    // a future agent reaching for a familiar library will make. The set is separate because
    // the tradeoff is: these never ship to the mini, but they do have to be installed,
    // audited and kept working, which is the cost PLAN §2 is protecting.
    const approvedDev = new Set([
      "patch-package",
      "typescript",
      "tsx",
      "@types/node",
      "@types/express",
      "@types/ws",
      "@types/react",
      "@types/react-dom",
      "@types/dom-webcodecs",
      "vite",
      "@vitejs/plugin-react",
    ]);
    for (const ws of ["", "server", "viewer", "landing"]) {
      const pkg = JSON.parse(read(join(REPO, ws, "package.json"))) as { devDependencies?: Record<string, string> };
      for (const dep of Object.keys(pkg.devDependencies ?? {})) {
        assert.ok(
          approvedDev.has(dep),
          `${ws || "."}/package.json adds devDependency "${dep}", which is not approved. ` +
            `Same rule as runtime deps (PLAN §2): argue it there first, then widen this set.`,
        );
      }
    }
  });

  it("uses no database driver", () => {
    // PLAN.md:49 — "No database." State is config.yaml/apps.yaml/tokens.yaml +
    // a small state.json.
    const banned =
      /\b(pg|postgres|postgres\.js|mysql2?|sqlite3?|better-sqlite3|libsql|@libsql\/client|mongodb|mongoose|redis|ioredis|prisma|drizzle-orm|sequelize|typeorm|kysely|knex|lowdb|nedb)\b/;
    for (const ws of ["", "server", "viewer", "landing"]) {
      const pkg = read(join(REPO, ws, "package.json"));
      assert.doesNotMatch(pkg, banned, `${ws}/package.json looks like it added a database driver`);
    }
  });

  it("pins serve-sim exactly, and ships the patch that strips its exec routes", () => {
    // The pin is a security control, not hygiene: serve-sim exposes /exec and
    // /exec-ws, reachable from inside the simulator, which shares the host's
    // loopback. patch-package removes them. A caret range would silently take a
    // version the patch does not apply to. (PLAN §11.1 caveat.)
    const pkg = JSON.parse(read(join(REPO, "server", "package.json"))) as { dependencies: Record<string, string> };
    const pinned = pkg.dependencies["serve-sim"];
    assert.match(pinned ?? "", /^\d+\.\d+\.\d+$/, "serve-sim must be pinned exactly — a range can drift past the patch");
    const patches = readdirSync(join(REPO, "patches"));
    assert.ok(
      patches.includes(`serve-sim+${pinned}.patch`),
      `patches/ has ${patches.join(", ")} but serve-sim is pinned to ${pinned} — the patch would not apply, ` +
        `and the exec routes would ship. Re-run patch-package after any bump.`,
    );
  });
});

describe("PLAN §8 — the streaming seam", () => {
  it("keeps concrete backends out of everything but the composition root", () => {
    // PLAN.md:506 — "Nothing outside server/src/streaming/ may import a backend
    // directly; the engine, proxy and MCP tools see only this interface."
    // server.ts and doctor.ts construct them, which is what a composition root
    // is for — they are named here so the exception is a decision rather than
    // an erosion.
    const roots = new Set(["server/src/server.ts", "server/src/cli/doctor.ts"]);
    // `(\.\.?\/)+` rather than `\.{1,2}\/`: the old form only matched one level, so a file two
    // directories deep imported a backend directly and passed. `import(` covers the dynamic
    // form, which cli.ts already uses elsewhere and which has no `from` for a pattern to find.
    const backends = /(?:from|import\()\s*"(?:\.\.?\/)+(?:streaming\/)?(?:serveSim|androidAdb|androidH264|web)\.ts"/;
    for (const file of sourceFiles()) {
      if (rel(file).startsWith("server/src/streaming/") || roots.has(rel(file))) continue;
      assert.doesNotMatch(
        read(file),
        backends,
        `${rel(file)} imports a concrete streaming backend. Depend on StreamingBackend (backend.ts) instead, ` +
          `or add this file to the composition-root list and say why in PLAN §8.`,
      );
    }
  });
});

describe("PLAN §11 — security model", () => {
  it("audits every registered MCP tool", () => {
    // PLAN.md:712 — "JSONL audit of every call". Nothing enforced it, so a tool
    // added without the wrapper is invisible to the audit trail and no test
    // fails. Pair each registerTool with the audited() call in its handler.
    // One parse, shared with docs.test.ts (see toolNames.ts): a tool this scan cannot read is
    // exempt from the audit rule AND from the documentation rule, and neither would fail.
    const tools = read(join(SRC, "mcp", "tools.ts"));
    const registered = registeredTools(tools);
    const audited = auditedTools(tools);
    assert.ok(registered.length > 0, "no tools found — the registerTool pattern changed, fix this check");
    assert.equal(
      registered.length,
      registerToolCallCount(tools),
      "a registerTool() call uses a computed name, which opts it out of this check entirely",
    );
    for (const name of registered) {
      assert.ok(audited.has(name), `MCP tool "${name}" is registered but never wrapped in audited() — PLAN §11.2`);
    }
  });

  it("binds every listening socket to loopback and nowhere else", () => {
    // PLAN.md:43 — "Deckhand binds 127.0.0.1 only." Everything public reaches it through the
    // tunnel; a wildcard bind would put the whole MCP surface on the LAN.
    //
    // Repo-wide, because it used to read server.ts alone while AGENTS.md stated the guarantee
    // for the whole tree. The per-device Android helper (androidAdb.ts) binds a socket too,
    // and rewriting it as a wildcard would have passed — including past the test next to it,
    // which asserts on a hardcoded `http://127.0.0.1:${port}` template string built two lines
    // AFTER the listen() call and unaffected by its host argument.
    //
    // The exemption is by file+reason, not by silence: metro.ts's second listen() is a
    // bindability PROBE that binds and immediately closes, deliberately without a host,
    // because "is this port free" must mean free on every interface — a loopback-only probe
    // would report a port free that something else holds on 0.0.0.0.
    // Argument-less `.listen()` needs an exemption too, not a pass: `srv.listen()` really does
    // bind every interface on a random port. cli.ts's is a delegation to the server object,
    // whose own bind is the one checked below.
    const exempt = new Map([
      ["server/src/engine/metro.ts", "port-availability probe, bound and closed immediately"],
      ["server/src/cli.ts", "delegates to createServer().listen(); the real bind is in server.ts"],
    ]);
    for (const file of sourceFiles()) {
      if (exempt.has(rel(file))) continue;
      for (const m of read(file).matchAll(/\.listen\(([^)]*)\)/g)) {
        assert.match(
          m[1]!,
          /"127\.0\.0\.1"/,
          `${rel(file)} binds .listen(${m[1]}) — PLAN §11.1 requires loopback only. If this is a probe rather ` +
            `than a server, add it to the exempt map with the reason.`,
        );
      }
    }
    // The composition root keeps its stricter rule: exactly one server socket.
    const listens = [...read(join(SRC, "server.ts")).matchAll(/\.listen\(([^)]*)\)/g)];
    assert.equal(listens.length, 1, `expected exactly one .listen() in server.ts, found ${listens.length}`);
  });

  it("keeps secrets out of the MCP surface", () => {
    // PLAN.md:722 — "app secrets never through MCP or the viewer". The two write
    // channels are the CLI and the one-time setup URL.
    for (const file of sourceFiles(join(SRC, "mcp"))) {
      assert.doesNotMatch(
        read(file),
        /from "\.\.\/secrets\.ts"/,
        `${rel(file)} imports secrets.ts — PLAN §11.5 keeps secrets off the MCP surface entirely`,
      );
    }
  });

  it("gates the share proxy's route matcher case-insensitively", () => {
    // Express dispatches string routes case-insensitively, so a case-sensitive
    // gate regex let /Dev/ and /RESTART reach a locked share's stream and
    // rebuild with no PIN. That was a live auth bypass, fixed with one flag.
    // Matched by locating the line rather than by parsing the literal: a regex that parses a
    // regex breaks on any harmless edit, and a guardrail that cries wolf gets deleted.
    //
    // EVERY matching line, and comments stripped first. This used to take `.find()` — the
    // FIRST match — over the raw source, so writing the pattern in a comment above the real
    // line (this codebase's own comment style) satisfied the assertion from the comment and
    // left the check permanently inert, with no signal. A guardrail that can be disabled by
    // documenting it is worse than none.
    const src = read(join(SRC, "share", "proxy.ts"))
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .filter((l) => l.includes("(dev|web|restart)"));
    assert.ok(src.length, "the share-gate route matcher moved — find it and re-pin this check");
    // The gate must resolve the shareId the way the HANDLERS do. `req.path` is not
    // percent-decoded and `req.params` is, so a gate reading the raw segment authorises a
    // different share than the one it then serves — the third bypass on this seam, after
    // case-sensitivity and pane pairing. All three had the same cause.
    assert.match(
      read(join(SRC, "share", "proxy.ts")),
      /decodeURIComponent\(m\[1\]/,
      "the share gate must percent-decode the id it authorises, because req.params does and the handlers read that",
    );
    for (const gate of src) {
      assert.match(
        gate,
        /\/[gimsuy]*i[gimsuy]*\.exec/,
        "the share gate regex lost its `i` flag — Express dispatches routes case-insensitively, " +
          "so /Dev/ and /RESTART would reach a locked share's stream and rebuild with no PIN",
      );
    }
  });
});

describe("the boot sweep spares what is live", () => {
  it("passes a keep-set to every marker reap, never an empty one", () => {
    // The build reap passed `[]` on the reasoning that "build steps are awaited, so nothing is
    // owned across a boot". True of a boot; false of THIS sweep, which runs after the port is
    // bound — so a start_preview lands in between and its brand-new xcodebuild carries the
    // same marker and is SIGTERMed by the server it just asked for a preview. Metro and the
    // livesync runners already spared their own; builds were the one resource that did not.
    // Behavioural coverage is in procs.test.ts (buildPids lifecycle); this catches the wiring
    // being reverted, which no unit test can see because the harness fakes runStep.
    const src = read(join(SRC, "engine", "preview.ts"));
    const reap = src.slice(src.indexOf("reapOrphansByMarker"));
    const table = src.slice(src.indexOf("[\"reap_metro\""), src.indexOf("] as const"));
    assert.ok(reap.length > 0 && table.length > 0, "the marker reap table moved — find it and re-pin this check");
    assert.doesNotMatch(
      table.replace(/\/\/.*$/gm, ""),
      /=>\s*\[\]/,
      "a marker reap with an empty keep-set kills the running server's own children",
    );
  });
});

describe("tests never touch the real ~/.deckhand", () => {
  it("no test calls a writer that resolves paths from DECKHAND_HOME", () => {
    // paths.ts says "tests point it at a temp dir" — a precondition nothing enforced. A test
    // that calls writeApps/writeTokens/writeSecretEnv without setting DECKHAND_HOME writes to
    // the DEVELOPER'S OWN config, and apps.yaml is a file whose loss costs every registered
    // app. Pass the file/dir explicitly, or set DECKHAND_HOME first.
    const writers = /\b(writeApps|writeTokens|writeSecretEnv)\s*\(/;
    for (const file of testFiles()) {
      const src = read(file);
      if (!writers.test(src)) continue;
      // An ASSIGNMENT, not a mention: the first version matched the bare name, which the
      // cleanup line `delete process.env.DECKHAND_HOME` satisfies on its own.
      //
      // Honest limit, since a green check should not imply more than it proves: this catches
      // a file that never sets DECKHAND_HOME at all — the realistic case, someone adding a
      // test that calls writeApps without thinking about isolation. It cannot tell a setup
      // assignment from the restore in `after()`, so deleting only the setup line still
      // passes. Verified by mutation both ways.
      assert.match(
        src,
        /process\.env\.DECKHAND_HOME\s*=/,
        `${rel(file)} calls a config writer but never sets DECKHAND_HOME — it would write to the ` +
          `developer's real ~/.deckhand. Point it at a temp dir for the duration of the test.`,
      );
    }
  });
});

describe("deckhand ships nothing about one particular install", () => {
  it("names no specific host, user or private repo in shipped code or docs", () => {
    // A brand-new machine must not learn about somebody else's tunnel or somebody else's
    // repos. The landing page shipped one person's hostname as the product screenshot
    // (`deckhand.<someone>.no/s/••••••`), a viewer doc comment used a private repo as its
    // worked example, and AGENTS recorded a validation run by naming both. None of it broke
    // anything — it just quietly told every new user that this is somebody's internal tool.
    //
    // Tests are exempt: a fixture needs SOME concrete string, and a test does not ship.
    // `Okam-AS/deckhand` is allowed because that genuinely is where deckhand lives.
    const banned = /\b(sharghi|okam(?!-AS\/deckhand)|unox|elton-mobility|asharghi)\b/i;
    // Its own walker, because sourceFiles() filters to `.ts` — so every .tsx in the viewer
    // and the landing page was invisible to the first version of this check, which is exactly
    // where the offending string lived. Caught by mutation: putting the hostname back into a
    // component failed nothing.
    const shipped = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry !== "node_modules" && entry !== "dist") shipped(full, out);
          continue;
        }
        if (/\.(ts|tsx|css|html)$/.test(entry) && !entry.includes(".test.")) out.push(full);
      }
      return out;
    };
    const docs = ["README.md", "AGENTS.md", "PLAN.md"];
    const offenders: string[] = [];
    for (const root of ["server/src", "viewer/src", "landing/src"]) {
      for (const file of shipped(join(REPO, root))) {
        const m = banned.exec(read(file));
        if (m) offenders.push(`${rel(file)}: "${m[0]}"`);
      }
    }
    for (const doc of docs) {
      const body = readFileSync(join(REPO, doc), "utf8");
      const m = banned.exec(body);
      if (m) offenders.push(`${doc}: "${m[0]}"`);
    }
    assert.deepEqual(
      offenders,
      [],
      "shipped code and docs must describe deckhand, not one installation of it. Use example.com / acme.",
    );
  });
});

describe("the connector URL is public by construction", () => {
  // The premise: a connector added in a Claude team or Enterprise organisation is visible to
  // everyone in it. The credential used to be a path segment in that URL — `/mcp/<token>` —
  // which handed every colleague a working connector to this Mac. Both checks below guard the
  // two ways that could come back, and neither is visible to a type, a lint, or a unit test.

  it("puts no credential in an MCP route path", () => {
    // A `:token`-shaped path parameter on the MCP router is the old design returning. The
    // legacy 404 catch-all is allowed precisely because it authenticates nothing.
    const router = read(join(SRC, "mcp", "index.ts"));
    const offenders: string[] = [];
    for (const m of router.matchAll(/router\.(get|post|delete|put|all)\(\s*"([^"]*)"/g)) {
      const path = m[2]!;
      if (!path.includes(":")) continue;
      // The one exemption, by path and reason: it exists to REFUSE the old URL.
      if (path === "/:legacyToken") continue;
      offenders.push(`router.${m[1]} "${path}"`);
    }
    assert.deepEqual(
      offenders,
      [],
      "an MCP route may not take a path parameter: a URL carrying a credential gets pasted into a shared connector, " +
        "a screenshot and a log. The credential belongs in an Authorization header.",
    );
  });

  // Written, tested, and never called is this repo's most expensive shape — it cost the orphan
  // sweep, and it cost this: a stray regex during a refactor deleted the whole `if
  // (deps.connector)` block, every unit test stayed green because they build the routers
  // directly, and the connector answered 404 to claude.ai's very first request. A user found
  // it, which is exactly who this check exists to spare.
  // A user meets these three pages and the device grid within minutes of each other, so they
  // are one surface or they look broken. The viewer was re-paletted to neutral dark and the
  // server-rendered pages were left warm — brown auth pages in front of a grey app.
  it("renders every server-side page in the viewer's palette, not the retired warm one", () => {
    const RETIRED = ["#241b20", "#2c2025", "#31242a", "#f2e8dc", "#c9baae", "#e0a971", "#d98873", "#e8b86d", "242,232,220"];
    const offenders: string[] = [];
    for (const file of ["oauth/router.ts", "setup/router.ts", "share/proxy.ts"]) {
      const source = read(join(SRC, ...file.split("/")));
      for (const hex of RETIRED) if (source.includes(hex)) offenders.push(`${file}: ${hex}`);
    }
    assert.deepEqual(offenders, [], "these pages must use viewer/src/global.css's tokens — see its header for why the warm palette went");
  });

  it("mounts the routers a connector needs, not merely defines them", () => {
    const server = read(join(SRC, "server.ts"));
    for (const [what, call] of [
      ["the OAuth discovery documents", /app\.use\(createOAuthMetadataRouter\(/],
      ["/oauth", /app\.use\("\/oauth", createOAuthRouter\(/],
      ["/pair", /app\.use\("\/pair", createPairRouter\(/],
    ] as const) {
      assert.match(server, call, `${what} must be mounted in server.ts — a router nobody mounts is a 404 with passing tests`);
    }
  });

  it("puts no approval path outside the credential the machine holds", () => {
    // The public half of pairing parks requests and proves nothing; the deciding half needs
    // tokens.yaml. If `pairRouter` ever stopped authenticating, the connector URL alone would
    // approve its own request — a total bypass with nothing else failing.
    const source = read(join(SRC, "oauth", "pairRouter.ts"));
    assert.match(source, /bearerToken\(/, "pairRouter must authenticate every call");
    assert.match(source, /deps\.auth\.authenticate\(/, "…against tokens.yaml, not against an OAuth grant");
    assert.doesNotMatch(source, /oauth\?\.authenticate|store\.authenticate\(/, "an OAuth grant must not be able to approve the next one");
  });
});

describe("config that changes at runtime is watched", () => {
  it("watches tokens.yaml as well as apps.yaml", () => {
    // tokens.yaml was read once at boot. `setup` starts the server and THEN mints the admin
    // token, so a brand-new install's only token was invisible: /mcp/<token> answered 404 and
    // claude.ai, finding no MCP server, reported an OAuth failure for a server that does not
    // use OAuth. The user's first impression of deckhand was a broken connector.
    //
    // A unit test cannot see the wiring — the same gap that left StreamingRouter.reapOrphans
    // written, tested and never called.
    const server = read(join(SRC, "server.ts"));
    for (const [what, call] of [
      ["apps.yaml", /watchApps\(/],
      ["tokens.yaml", /watchTokens\(/],
    ] as const) {
      assert.match(server, call, `${what} must be watched — reading it once at boot means an edit needs a restart, and nothing says so`);
    }
  });
});

describe("fakes are complete", () => {
  it("uses test-support/fakes.ts for every dependency that has one", () => {
    // `{ ... } as unknown as Simctl` disables BOTH excess-property and missing-property
    // checking, so a method added to the real class leaves the fake silently behind and the
    // failure surfaces far from the cause. It cost four bugs in one day, and once made the
    // entire orphan sweep a no-op THAT REPORTED SUCCESS.
    //
    // Scoped to the dependencies a complete fake exists for, deliberately. A one- or
    // two-member interface (`audit`, `streaming`) is safe to write inline — the point is not
    // to ban a syntax, it is to stop hand-rolling a partial stand-in for a 14-method class
    // when a complete one is a function call away. Widen the alternation when you add a fake.
    const covered = "simctl|android|worktrees|reaper|metro|devProcs";
    const banned = new RegExp(`as unknown as \\w*Deps\\["(${covered})"\\]`);
    for (const file of testFiles()) {
      const m = banned.exec(read(file));
      assert.equal(
        m,
        null,
        `${rel(file)} hand-rolls a fake for "${m?.[1]}" — use fake${(m?.[1] ?? "").replace(/^./, (c) => c.toUpperCase())}() ` +
          `from test-support/fakes.ts, which is checked against the real class at compile time.`,
      );
    }
  });
});

describe("one definition of the gate", () => {
  it("has CI and the pre-commit hook both invoke `npm run ci`, not a copy of its steps", () => {
    // The gate had THREE definitions: package.json's `ci` script, ci.yml's three steps, and
    // the hook's three steps. They diverged exactly as you would expect — the hook was
    // missing `npm run build`, so a build-only failure reached CI after a push, which is the
    // one place a pre-commit gate is no use. Nothing failed, because each copy was internally
    // consistent.
    const ci = readFileSync(join(REPO, ".github", "workflows", "ci.yml"), "utf8");
    const hook = readFileSync(join(REPO, "ops", "hooks", "pre-commit"), "utf8");
    for (const [name, src] of [["ci.yml", ci], ["ops/hooks/pre-commit", hook]] as const) {
      assert.match(src, /npm run ci\b/, `${name} must invoke \`npm run ci\`, so there is one definition of the gate`);
      // Re-implementing the steps is the failure mode, not a style preference.
      for (const step of ["npm run typecheck", "npm test", "npm run build"]) {
        assert.ok(
          !new RegExp(`(run:|^\\s*)\\s*${step.replace(/ /g, "\\s+")}\\b`, "m").test(src),
          `${name} re-implements "${step}" instead of calling \`npm run ci\` — that is how the ` +
            `hook silently lost the build step. Change package.json's ci script instead.`,
        );
      }
    }
  });

  it("checks the index rather than the working tree", () => {
    // A hook that tests the checkout as-is passes a broken commit whenever an unstaged fix
    // is sitting next to it, and blocks a clean one whenever an unrelated experiment is.
    // `git add -p` is the normal case that exposes both.
    // Comments stripped first: the hook explains at length WHY stash/pop was rejected, and a
    // check that reads the explanation as the code is the wrong-reason failure this file has
    // now hit three times.
    const hook = readFileSync(join(REPO, "ops", "hooks", "pre-commit"), "utf8")
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    assert.match(
      hook,
      /git checkout-index/,
      "the hook must materialise the staged tree (git checkout-index) rather than run against the working tree",
    );
    assert.doesNotMatch(
      hook,
      /git stash/,
      "stash/pop was tried and wedges the tree when one file has both staged and unstaged edits",
    );
  });
});

describe("the detached-spawn rule", () => {
  it("marks every long-lived detached spawn so a later boot can collect it", () => {
    // Four resources are spawned detached and outlive the server that owns them;
    // three of them leaked, one to 36 orphans at 418% CPU. An in-memory Map is
    // not an owner. Anything spawned detached must stamp an env marker the boot
    // reaper hunts for.
    // Match the STAMP (`[SOMETHING_MARKER_ENV]: "1"`), not the identifier. The
    // first version of this check looked for the bare name and passed after the
    // stamp was deleted, because the marker's own `export const` line still
    // mentioned it — a guardrail passing for the wrong reason, which is exactly
    // the bug class it exists to catch. File-level rather than near the spawn,
    // because Metro stamps correctly but indirectly, through a baseEnv() helper.
    // The trigger matches any `detached:` that is not literally `false`. Pinned to
    // `detached: true`, the guard was skipped entirely by `detached: !opts.foreground` or by
    // hiding the option in a spread — so the way to avoid the rule was to write the spawn
    // slightly differently, which is not a rule.
    for (const file of sourceFiles()) {
      const src = read(file);
      if (!/detached:\s*(?!false\b)/.test(src)) continue;
      assert.match(
        src,
        /MARKER_ENV\]:/,
        `${rel(file)} spawns a detached process without stamping an env marker on it. ` +
          `A detached child survives this process; without a marker no later boot can tell it from ` +
          `the developer's own \`expo start\` or \`ns run\` — and killing those is the emulator hijack again.`,
      );
    }
  });
});

describe("source stays source", () => {
  it("holds no control characters, so git never treats a .ts file as binary", () => {
    // Caught by eye, not by a test: a fingerprint built with `\x00`/`\x01` as field
    // separators compiled, passed every test, and turned tokensWatcher.ts into
    // `Bin 3906 -> 4509 bytes` in `git diff` — a security-relevant file no reviewer
    // could read the diff of. Nothing else here looks at bytes, and a diff nobody
    // can read is exactly how the cross-page auth bypass survived its first review.
    // Tab, newline and carriage return are the legitimate ones.
    for (const file of [...sourceFiles(), ...testFiles()]) {
      const bad = [...read(file)].findIndex((ch) => {
        const c = ch.codePointAt(0)!;
        return (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f;
      });
      assert.equal(
        bad,
        -1,
        `${rel(file)} contains a control character at offset ${bad}. Git will treat the file as ` +
          `binary and show no diff. Use a readable serialization (JSON.stringify) instead of a ` +
          `hand-rolled byte separator.`,
      );
    }
  });
});
