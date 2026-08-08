import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { auditedTools, registeredTools, registerToolCallCount } from "./toolNames.ts";
import { repoFilesEndingWith } from "./repoFiles.ts";

/**
 * The rules PLAN.md states as acceptance criteria, as executable checks.
 *
 * PLAN §2 (locked decisions) and §11 (security model) say outright that they are
 * "acceptance criteria, not suggestions" — but nothing enforced them, so they
 * were criteria only for whoever remembered to read the whole document. Every
 * assertion below is one a reviewer would otherwise have to make by hand, and
 * several encode rules that were already broken once.
 *
 * Deliberately source-text checks rather than imports: these must hold for code
 * that is never executed by any other test, and importing the modules would
 * make the check depend on the very wiring it is meant to police.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(SRC, "..", "..");

// Both walks skip symlinks rather than following them, like `shipped()` below: a git worktree
// carries a dangling `server/node_modules` symlink, and a `statSync` through one throws ENOENT
// — a guardrail that fails for a reason nobody can act on.

/** Every .ts file under server/src, excluding tests and this directory. */
function sourceFiles(dir = SRC, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "test-support") sourceFiles(full, out);
      continue;
    }
    if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** Test files, which `sourceFiles` deliberately skips — some rules apply only to them. */
function testFiles(dir = SRC, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "test-support") testFiles(full, out);
      continue;
    }
    if (entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const read = (f: string) => readFileSync(f, "utf8");
const rel = (f: string) => f.slice(REPO.length + 1);

/**
 * The index just past the `)` closing the call whose `(` is at `from`, or -1 if it never closes.
 *
 * Balanced, not `[^)]*`: an args list may contain a call of its own, and `cli/setup.ts` already
 * writes one. Verified by mutation — `deckhandCli(["doctor", String(port)]).out.includes(…)`
 * passed "never branches on the text of deckhand's own output" while the same line without the
 * nested call failed it.
 * → "never branches on the text of deckhand's own output"
 */
function endOfCall(src: string, from: number): number {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * The TOP-LEVEL text of an object literal starting at `from` (whitespace allowed before the
 * `{`), with every nested `{}`/`[]`/`()` group and every string body blanked out. Returns null
 * when the argument is not an object literal at all, which the caller treats as a finding
 * rather than a pass: `new WebSocketServer(opts)` must not be a way round a rule about ports.
 *
 * Quotes are tracked so a brace inside a string cannot close the object. It does not lex regex
 * literals — the same limit `test-support/toolNames.ts` states — so a regex containing an
 * unbalanced brace or a quote inside an options object would desync it; none exists, and the
 * failure mode is a loud null rather than a silent pass.
 *
 * COMMENTS ARE NOT ITS JOB — call it on `stripComments(src)`, as `webSocketServerOptions` does.
 * An apostrophe in a `//` comment inside the object (`noServer: true, // don't bind`) reads as
 * a quote here, swallows the closing brace, and returns null: a FALSE RED telling the author to
 * inline an object that already is inline. Unactionable messages are how a guardrail gets
 * switched off wholesale.
 * → "binds every listening socket to loopback", "reads a WebSocketServer's options past a comment"
 */
function topLevelOptions(src: string, from: number): string | null {
  let i = from;
  while (i < src.length && /\s/.test(src[i]!)) i++;
  if (src[i] !== "{") return null;
  let depth = 0;
  let out = "";
  for (; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === "`") {
      const start = i;
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
      // Kept verbatim at the top level: `host: "127.0.0.1"` is the thing being asserted on.
      out += depth === 1 ? src.slice(start, i + 1) : " ";
      continue;
    }
    if (c === "{" || c === "[" || c === "(") {
      depth++;
      out += depth === 1 ? c : " ";
      continue;
    }
    if (c === "}" || c === "]" || c === ")") {
      depth--;
      if (depth === 0) return out + c;
      out += " ";
      continue;
    }
    out += depth === 1 ? c : " ";
  }
  return null;
}

// A pattern, not `indexOf("new WebSocketServer(")`. `ws` is generic, so `new
// WebSocketServer<Foo>({ port: 9999 })` is legal and the literal match found NO occurrence at
// all — not even the loud `null` the caller treats as a finding. "Write it slightly differently
// to avoid the rule" is not a rule, and it is the same argument that widened the detached-spawn
// and backend-import patterns.
const NEW_WSS = /new\s+WebSocketServer\s*(?:<[^<>()]*>)?\s*\(/g;

// A port is set two ways, and only one of them carries a colon. `{ port }` — ES6 shorthand, and
// the commonest spelling of the wildcard bind PLAN §11 item 1 bans — has none, so `/\bport\s*:/`
// read it as "no port here" and passed. Verified by mutation: `new WebSocketServer({ port })` in
// streaming/backend.ts left this file 25/25 green.
//
// The shorthand half is anchored to `{` or `,` and must reach `,` or `}` without a colon, so a
// VALUE named port (`handleProtocols: port`) is not read as a key. Both are applied to
// `topLevelOptions`' output, where nested groups are already blanked.
const HAS_PORT = /\bport\s*:|[{,]\s*port\s*(?=[,}])/;
// `{ ...opts }` hides the key one level further away, and nothing here can say what is in it.
// Refused for the same reason `new WebSocketServer(opts)` is refused rather than skipped: an
// unreadable options object must be a finding, not a pass.
const SPREAD_INTO_OPTIONS = /\.\.\./;

/** The options text of every `new WebSocketServer(` in `src`, in order; null where not a literal. */
function webSocketServerOptions(src: string): (string | null)[] {
  const stripped = stripComments(src);
  return [...stripped.matchAll(NEW_WSS)].map((m) => topLevelOptions(stripped, m.index + m[0].length));
}

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
    // `optionalDependencies` and `peerDependencies` for the same reason one layer down: npm
    // installs an optional dep exactly like a normal one, so reading only `dependencies` left
    // a rename of the KEY as a way past the rule. Caught by mutation — lodash under
    // `optionalDependencies` passed this check.
    for (const ws of ["", "server", "viewer", "landing"]) {
      const pkg = JSON.parse(read(join(REPO, ws, "package.json"))) as Record<string, Record<string, string> | undefined>;
      const runtime = { ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies };
      for (const dep of Object.keys(runtime)) {
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
    // version the patch does not apply to. (PLAN §11 item 1 caveat.)
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
    // `import\(?` rather than `import\(`, and both quote characters: a side-effect import
    // (`import "../streaming/serveSim.ts";`) has no `from` and no paren, and passed the whole
    // check — verified by mutation. The specifier may be `.ts` or `.js` for the same reason.
    const backends = /(?:from|import\(?)\s*["'](?:\.\.?\/)+(?:streaming\/)?(?:serveSim|androidAdb|androidH264|web)\.[tj]s["']/;
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

  it("makes every composition root name the vendored serve-sim binary", () => {
    // `ServeSimBackend`'s constructor falls back to `bin ?? "serve-sim"` — a bare PATH lookup,
    // which on a machine with a global serve-sim resolves an UNPATCHED copy whose /exec route
    // still runs host shell commands. That is precisely the channel the pin-and-patch check
    // above exists to remove, and the pin cannot see it: it inspects node_modules, not who
    // asks for it. doctor.ts shipped without a `bin` and spawned whatever PATH had; on a PATH
    // with no serve-sim at all it spawned nothing, and the device gate reported ios stream and
    // ios describe FAILED on a healthy machine. `npm run test:device` hid both, because npm
    // prepends node_modules/.bin — the vendored copy — to PATH, so the runner resolved the
    // right binary by accident. `deckhand doctor --device-only` does not.
    //
    // The assertion is `vendoredServeSimBin()`, not merely "some bin": `bin: "serve-sim"` is
    // the bug spelled out longhand. Tests under streaming/ are exempt — they inject a
    // detachImpl and never spawn anything.
    const argsOf = (src: string, at: number): string => {
      let depth = 0;
      for (let i = at; i < src.length; i++) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")" && --depth === 0) return src.slice(at, i + 1);
      }
      return src.slice(at);
    };
    let found = 0;
    for (const file of [...sourceFiles(), ...testFiles()]) {
      if (rel(file).startsWith("server/src/streaming/")) continue;
      const src = read(file);
      for (const m of src.matchAll(/new ServeSimBackend\s*\(/g)) {
        found++;
        assert.match(
          argsOf(src, m.index + m[0].length - 1),
          /vendoredServeSimBin\s*\(\s*\)/,
          `${rel(file)} constructs ServeSimBackend without bin: vendoredServeSimBin(). It will spawn ` +
            `whatever "serve-sim" PATH resolves — an unpatched build with a live /exec shell route, ` +
            `or nothing at all. See the docblock on vendoredServeSimBin in streaming/serveSim.ts.`,
        );
      }
    }
    assert.ok(found >= 2, `only ${found} ServeSimBackend constructions found outside streaming/ — the check is wrong, fix it`);
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
      assert.ok(audited.has(name), `MCP tool "${name}" is registered but never wrapped in audited() — PLAN §11 item 2`);
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
    //
    // The host must be the LITERAL, not a constant that holds it: `listen(port, LOOPBACK)` is
    // refused even though it is correct. That is deliberate — a name can be reassigned in a
    // second place and this check reads one line — but it means the fix for a red here is
    // sometimes "inline the string", which is worth knowing before you argue with it.
    const exempt = new Map([
      ["server/src/engine/metro.ts", "port-availability probe, bound and closed immediately"],
      ["server/src/cli.ts", "delegates to createServer().listen(); the real bind is in server.ts"],
    ]);
    // Comments stripped, for the reason the share gate below states: a comment writing
    // `.listen(port)` — the shape this very rule is explained with — is not a bind, and
    // reporting it is a FALSE RED on the author who documented the rule. The strip is
    // string-aware (`stripComments`), so an offender sharing a line with a URL survives it.
    for (const file of sourceFiles()) {
      if (exempt.has(rel(file))) continue;
      for (const m of stripComments(read(file)).matchAll(/\.listen\(([^)]*)\)/g)) {
        assert.match(
          m[1]!,
          /"127\.0\.0\.1"/,
          `${rel(file)} binds .listen(${m[1]}) — PLAN §11 item 1 requires loopback only. If this is a probe rather ` +
            `than a server, add it to the exempt map with the reason.`,
        );
      }
    }
    // `.listen(` is not the only way to open a port. `new WebSocketServer({ port })` binds one
    // itself, on every interface, and it is the constructor both of this repo's WebSocket
    // servers already use — with `noServer: true`, which binds nothing. Adding `port:` to
    // either was invisible to the scan above while reading as covered by "every listening
    // socket". Verified by mutation: server.ts's `noServer: true` swapped for `port: 9999`
    // passed this test before this loop existed.
    //
    // Brace-BALANCED, not `\{([^}]*)\}`. That pattern stopped at the first `}` in the file,
    // which server.ts's own options object reaches before its last property: it passes
    // `handleProtocols: (protocols) => { … }`, so anything written after that callback was
    // outside the capture entirely. `port: 9999` there found no `port:` and passed — the hole
    // was in the constructor this check was written for. Verified by mutation, both orders.
    //
    // Nested braces/brackets/parens are BLANKED rather than kept, so `port:` and `host:` are
    // read at the top level only: a `port` key inside a nested sub-object is not this
    // constructor's port, and matching it would fire on correct code.
    //
    // Comments stripped first, for the same reason as the share gate below: an apostrophe in a
    // `// don't bind` inside the object opened a string that ate the closing brace, and the
    // author of correct code was told to inline an object they had already inlined. Pinned by
    // "reads a WebSocketServer's options past a comment".
    for (const file of sourceFiles()) {
      for (const opts of webSocketServerOptions(read(file))) {
        assert.notEqual(
          opts,
          null,
          `${rel(file)} constructs a WebSocketServer from something other than an object literal, so this ` +
            `check cannot read its port or host. Pass the options inline — PLAN §11 item 1 is not opt-out-able ` +
            `by moving the object to a variable.`,
        );
        assert.doesNotMatch(
          opts!,
          SPREAD_INTO_OPTIONS,
          `${rel(file)} spreads into a WebSocketServer's options, so this check cannot tell whether a port is ` +
            `set — PLAN §11 item 1. List the options inline.`,
        );
        if (!HAS_PORT.test(opts!)) continue;
        assert.match(
          opts!,
          /\bhost\s*:\s*"127\.0\.0\.1"/,
          `${rel(file)} constructs a WebSocketServer with its own port and no loopback host — PLAN §11 item 1. ` +
            `Attach it to the HTTP server (\`noServer: true\`) or pass host: "127.0.0.1".`,
        );
      }
    }
    // The composition root keeps its stricter rule: exactly one server socket.
    // (Both directions of the reader itself are pinned by "reads a WebSocketServer's options
    // past a comment" — this loop only sees the two real constructors, so neither the false
    // red nor the catch would show up here.)
    // Same strip, and here it fails the other way: a comment mentioning `.listen(` in server.ts
    // makes the count two and reports a second socket that does not exist.
    const listens = [...stripComments(read(join(SRC, "server.ts"))).matchAll(/\.listen\(([^)]*)\)/g)];
    assert.equal(listens.length, 1, `expected exactly one .listen() in server.ts, found ${listens.length}`);
  });

  it("reads a WebSocketServer's options past a comment", () => {
    // The check above is a text scan, and both of its failure directions are invisible while
    // this repo has exactly two constructors, both correct. Fixtures, not the real files: a
    // false red only ever appears the day someone writes an ordinary comment.
    //
    // Direction 1 — correct code must not fire. The apostrophe in `don't` used to open a
    // string that swallowed the closing brace, so this returned null and the author was told
    // to "pass the options inline" for an object that was already inline.
    assert.deepEqual(
      webSocketServerOptions(`const wss = new WebSocketServer({\n  noServer: true, // don't bind\n});\n`),
      ["{\n  noServer: true, \n}"],
    );
    // Direction 2 — a real wildcard bind must still be caught, including the two shapes the
    // check was widened for: a port written after a nested callback, and a non-literal argument.
    const [afterCallback] = webSocketServerOptions(
      `new WebSocketServer({ handleProtocols: (p) => { return p[0]; }, port: 9999 })`,
    );
    assert.match(afterCallback!, /\bport\s*:/);
    assert.doesNotMatch(afterCallback!, /\bhost\s*:\s*"127\.0\.0\.1"/);
    // A `port` nested one level down is not this constructor's port, so it stays blanked.
    const [nested] = webSocketServerOptions(`new WebSocketServer({ noServer: true, foo: { port: 9999 } })`);
    assert.doesNotMatch(nested!, /\bport\s*:/);
    // And the escape hatch the null is there to refuse.
    assert.deepEqual(webSocketServerOptions(`new WebSocketServer(opts)`), [null]);
    // `ws` is generic, and a type argument used to make the constructor invisible to the
    // scan — no entry at all, so not even the null above. A rule you can step around by
    // writing the same call differently is not a rule.
    assert.deepEqual(webSocketServerOptions(`new WebSocketServer<Foo>({ port: 9999 })`), ["{ port: 9999 }"]);
  });

  it("reads a port set by shorthand, and refuses a spread it cannot read", () => {
    // The test above asserts only about the READER, and every shape in it was one the port
    // detector already handled — so it read as coverage of the check while the detector itself
    // was untested. It was also wrong: `{ port }` passed.
    const opts = (src: string) => webSocketServerOptions(src)[0]!;
    // Direction 1 — the shapes that must fire.
    assert.match(opts(`new WebSocketServer({ port })`), HAS_PORT);
    assert.match(opts(`new WebSocketServer({ noServer: true, port })`), HAS_PORT);
    assert.match(opts(`new WebSocketServer({\n  port,\n  host: h,\n})`), HAS_PORT);
    assert.match(opts(`new WebSocketServer({ ...opts })`), SPREAD_INTO_OPTIONS);
    // Direction 2 — correct code must not fire, or the check gets switched off wholesale.
    assert.doesNotMatch(opts(`new WebSocketServer({ noServer: true })`), HAS_PORT);
    assert.doesNotMatch(opts(`new WebSocketServer({ noServer: true })`), SPREAD_INTO_OPTIONS);
    // A value named `port` is not a port key, and neither is a longer word ending in one.
    assert.doesNotMatch(opts(`new WebSocketServer({ noServer: true, handleProtocols: port })`), HAS_PORT);
    assert.doesNotMatch(opts(`new WebSocketServer({ transport: t })`), HAS_PORT);
    // Shorthand one level down is not this constructor's port either — it is already blanked.
    assert.doesNotMatch(opts(`new WebSocketServer({ noServer: true, foo: { port } })`), HAS_PORT);
  });

  it("keeps secrets out of the MCP surface", () => {
    // PLAN.md:722 — "app secrets never through MCP or the viewer". The two write
    // channels are the CLI and the one-time setup URL.
    // Any import of the module, at any depth and in any of the three spellings. The pattern was
    // `from "../secrets.ts"` exactly, so a side-effect import and anything under a future
    // `mcp/` subdirectory (`"../../secrets.ts"`) both passed — verified by mutation.
    for (const file of sourceFiles(join(SRC, "mcp"))) {
      assert.doesNotMatch(
        read(file),
        /(?:from|import\(?)\s*["'][^"']*secrets\.ts["']/,
        `${rel(file)} imports secrets.ts — PLAN §11 item 5 keeps secrets off the MCP surface entirely`,
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
    const proxy = stripComments(read(join(SRC, "share", "proxy.ts")));
    const src = proxy.split("\n").filter((l) => l.includes("(dev|web|restart)"));
    assert.ok(src.length, "the share-gate route matcher moved — find it and re-pin this check");
    // The gate must resolve the shareId the way the HANDLERS do. `req.path` is not
    // percent-decoded and `req.params` is, so a gate reading the raw segment authorises a
    // different share than the one it then serves — the third bypass on this seam, after
    // case-sensitivity and pane pairing. All three had the same cause.
    //
    // Against the STRIPPED source, like everything else here. Written against the raw file it
    // was satisfied by a comment naming `decodeURIComponent(m[1]!)` — the same way the `i`-flag
    // check above was once satisfied from a comment, three lines after the strip that exists
    // for exactly that, on the seam that has had two auth bypasses.
    assert.match(
      proxy,
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
    //
    // The roots below are whole workspaces plus the two script directories, not `*/src`:
    // `viewer/index.html` IS the viewer page, `landing/index.html` IS the landing page, and
    // `ops/` and `scripts/` are read by whoever is installing or reviewing. All four were
    // outside the walk while this check's message said "shipped code and docs" — mutation put
    // a hostname in `viewer/index.html`, in `scripts/review-receipt.ts` and in an `ops/`
    // shell script, and all three passed.
    // The gap that remains, stated because the message below is broader than the walk: files at
    // the REPO ROOT and under `.github/` are read by no root here, so a hostname in the root
    // `package.json` or in `.github/workflows/ci.yml` passes. Verified by mutation. Every `.md`
    // anywhere is covered by the second loop, which is where the historical leaks lived.
    // `withFileTypes`, and skipping symlinks rather than following them: a git worktree carries
    // a DANGLING `server/node_modules` symlink, and `statSync` on it throws — the walk died
    // with ENOENT instead of reporting anything, which is a check that fails for a reason
    // nobody can act on.
    const shipped = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git" || entry.isSymbolicLink()) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          shipped(full, out);
          continue;
        }
        if (/\.(ts|tsx|css|html|mjs|sh|json|yml|yaml)$/.test(entry.name) && !entry.name.includes(".test.") && entry.name !== "package-lock.json") out.push(full);
      }
      return out;
    };
    // EVERY markdown file, not a hardcoded three. The list was README/AGENTS/PLAN, and
    // `docs/web-wildcard-hosting-plan.md` meanwhile carried 22 mentions of one person's domain,
    // their employer, and a verification recipe with their home directory in it — in a PUBLIC
    // repo, with this check green throughout. A document ships whatever directory it sits in,
    // and naming three of them made every other one look like a deliberate exemption.
    // Sourced from git rather than walked (see repoFiles.ts): the raw walk read ignored files
    // too, and `.claude/pr-body.md` — written by `review:handover` one step before the PR —
    // routinely quotes a path or a hostname from the work being described. It also died on the
    // dangling `server/node_modules` symlink a worktree carries, exactly as `shipped()` did.
    const markdown = (): string[] => repoFilesEndingWith(REPO, ".md").map((p) => join(REPO, p));
    const offenders: string[] = [];
    for (const root of ["server", "viewer", "landing", "ops", "scripts"]) {
      for (const file of shipped(join(REPO, root))) {
        const m = banned.exec(read(file));
        if (m) offenders.push(`${rel(file)}: "${m[0]}"`);
      }
    }
    const docs = markdown();
    assert.ok(docs.length > 8, `only ${docs.length} markdown files walked — the walk is wrong, fix this check`);
    for (const doc of docs) {
      const m = banned.exec(readFileSync(doc, "utf8"));
      if (m) offenders.push(`${rel(doc)}: "${m[0]}"`);
    }
    assert.deepEqual(
      offenders,
      [],
      "shipped code and docs must describe deckhand, not one installation of it. Use example.com / acme.",
    );
  });
});

/**
 * Strip comments without also eating code. The obvious `/\/\/.*$/gm` truncates a
 * line at the `//` inside a string literal — a URL is enough — and the failure
 * direction is toward PASSING: an offender sharing a line with a URL disappears
 * along with the "comment". So this walks the source instead, and a `//` or a
 * block opener inside a quoted string is left alone.
 *
 * It does not lex REGEX LITERALS — the same limit `topLevelOptions` and `test-support/
 * toolNames.ts` state — so a regex holding an odd number of `"`, `'` or `` ` `` opens a string
 * here that the source never opened, and everything to the next matching quote is copied as if
 * it were a literal. That desyncs toward PASSING, which is the direction that costs. Latent, not
 * theoretical: probed across every top-level statement boundary in the 55 files this walks, all
 * were still found — but a future regex is one edit away from breaking it silently.
 * → "puts no credential in an MCP route path", which plants exactly that.
 */
function stripComments(src: string): string {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === "`") {
      // Copy the literal whole. An unterminated one runs to the end of the file,
      // which is what the compiler would say about it too.
      out += c;
      for (i++; i < src.length; i++) {
        out += src[i];
        if (src[i] === "\\") {
          out += src[++i] ?? "";
          continue;
        }
        if (src[i] === c) break;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    out += c;
  }
  return out;
}

describe("the connector URL is public by construction", () => {
  // The premise: a connector added in a Claude team or Enterprise organisation is visible to
  // everyone in it. The credential used to be a path segment in that URL — `/mcp/<token>` —
  // which handed every colleague a working connector to this Mac. Both checks below guard the
  // two ways that could come back, and neither is visible to a type, a lint, or a unit test.

  it("puts no credential in an MCP route path", () => {
    // A `:token`-shaped path parameter on the MCP router is the old design returning. The
    // legacy 404 catch-all is allowed precisely because it authenticates nothing.
    // Comments stripped, like the share gate below: this file explains the rejected design at
    // length, and a check that reads the explanation as the code cries wolf at the author who
    // documents it. (Mutation: a comment reading `router.get("/:tok", …)` failed this test.)
    // Stripped string-aware, because the naive line-comment regex cuts at the `//` in a URL
    // and would take a real offender sharing that line with it.
    const router = stripComments(read(join(SRC, "mcp", "index.ts")));
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
    // Every source file that renders a page, found by the doctype it must contain, rather than
    // the three that did when this was written. A hardcoded list makes the NEXT page — the one
    // nobody has written yet — exempt by construction, and this repo has already been bitten by
    // a check whose scope was a literal list (the markdown walk below, and the shipped-code walk
    // above). The three files it used to name are exactly the three this finds today.
    const pages = sourceFiles().filter((f) => /<!doctype/i.test(read(f)));
    assert.ok(pages.length >= 3, `only ${pages.length} server-rendered pages found — the doctype scan is wrong, fix this check`);
    for (const full of pages) {
      const file = rel(full);
      const source = read(full);
      for (const hex of RETIRED) if (source.includes(hex)) offenders.push(`${file}: ${hex}`);
      // A USED custom property that nobody defines is the palette bug the hex list cannot see:
      // `color-mix(in srgb, var(--gone) …)` is invalid at computed-value time, so the whole
      // declaration drops and the element loses its border and background silently. That is how
      // the setup page's one call-to-action rendered as bare text after this very change.
      const defined = new Set([...source.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
      for (const m of source.matchAll(/var\((--[a-z0-9-]+)\)/g)) {
        const used = m[1]!;
        if (!defined.has(used)) offenders.push(`${file}: var(${used}) is used but never defined`);
      }
    }
    assert.deepEqual(offenders, [], "these pages must use viewer/src/global.css's tokens — see its header for why the warm palette went");
  });

  it("mounts the routers a connector needs, not merely defines them", () => {
    // Comments stripped, for the same reason the share gate and the hook check strip them: a
    // commented-out `app.use("/pair", createPairRouter({…}))` is EXACTLY the "written, tested,
    // never called" shape this check exists to catch, and reading server.ts raw made the
    // disabling line satisfy the check that should have failed on it. Verified by mutation.
    const server = stripComments(read(join(SRC, "server.ts")));
    for (const [what, call] of [
      ["the OAuth discovery documents", /app\.use\(createOAuthMetadataRouter\(/],
      ["/oauth", /app\.use\("\/oauth", createOAuthRouter\(/],
      ["/pair", /app\.use\("\/pair", createPairRouter\(/],
    ] as const) {
      assert.match(server, call, `${what} must be mounted in server.ts — a router nobody mounts is a 404 with passing tests`);
    }
  });

  it("puts no approval path outside the credential the machine holds", () => {
    // The public half of pairing asks for a code and proves nothing; the minting half needs
    // tokens.yaml. If `pairRouter` ever stopped authenticating, the connector URL alone would
    // approve its own request — a total bypass with nothing else failing.
    // Comments stripped, like every other source-text check here: the two positive assertions
    // would otherwise be satisfied by a comment naming the call it had just deleted, and the
    // negative one fires on a comment explaining why an OAuth grant must not approve.
    const source = stripComments(read(join(SRC, "oauth", "pairRouter.ts")));
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
    //
    // Comments stripped, like its sibling above: `// watchTokens(cfg)` is how a watcher gets
    // switched off during a debugging session and left switched off, and reading server.ts raw
    // let that line stand in for the call it disabled. Verified by mutation.
    const server = stripComments(read(join(SRC, "server.ts")));
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
    // Both spellings of the same cast, because a rule that only sees one of them is a rule
    // about spelling. `PreviewDeps["simctl"]` is how the harness reaches the dep; `Simctl` is
    // how anyone writing a standalone fake would name it, and that form passed until mutation
    // put `{} as unknown as Simctl` in a test file and nothing failed. The quote class is for
    // the same reason — `Deps['simctl']` is the same cast.
    const covered = "simctl|android|worktrees|reaper|metro|devProcs";
    const classes = "Simctl|AndroidManager|WorktreeManager|Reaper|MetroManager|DevProcessManager";
    const banned = new RegExp(`as unknown as (?:\\w*Deps\\[["'](${covered})["']\\]|(${classes})\\b)`);
    const fakeFor: Record<string, string> = {
      simctl: "fakeSimctl",
      android: "fakeAndroid",
      worktrees: "fakeWorktrees",
      reaper: "fakeReaper",
      metro: "fakeMetro",
      devProcs: "fakeDevProcs",
      Simctl: "fakeSimctl",
      AndroidManager: "fakeAndroid",
      WorktreeManager: "fakeWorktrees",
      Reaper: "fakeReaper",
      MetroManager: "fakeMetro",
      DevProcessManager: "fakeDevProcs",
    };
    for (const file of testFiles()) {
      const m = banned.exec(read(file));
      const dep = m?.[1] ?? m?.[2] ?? "";
      assert.equal(
        m,
        null,
        `${rel(file)} hand-rolls a fake for "${dep}" — use ${fakeFor[dep] ?? "the fake"}() ` +
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
    // `#` comment lines dropped from both, exactly as the sibling check below does to this same
    // hook, and for the same reason: BOTH files explain the one-definition rule in prose that
    // contains the words `npm run ci`, so reading them raw let the explanation stand in for the
    // step. A ci.yml whose only `npm run ci` is in the comment above the job satisfied this.
    const decomment = (src: string): string => src.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    const ci = decomment(readFileSync(join(REPO, ".github", "workflows", "ci.yml"), "utf8"));
    const hook = decomment(readFileSync(join(REPO, "ops", "hooks", "pre-commit"), "utf8"));
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

/** Any `detached:` whose value is not literally `false`. → "reads a detached flag past its ordinary spelling" */
const DETACHED_NOT_FALSE = /detached:(?!\s*false\b)/;

describe("the detached-spawn rule", () => {
  it("reads a detached flag past its ordinary spelling", () => {
    // Both directions, on fixtures: the repo has no `detached: false` today, so the false red
    // that the broken form produced was invisible here — it would have arrived as a red on
    // whoever next wrote a foreground spawn, which is how a guardrail gets deleted.
    for (const correct of ["detached: false", "detached:false", "detached:  false,"]) {
      assert.equal(DETACHED_NOT_FALSE.test(correct), false, `${correct} is a foreground spawn and must not trip the rule`);
    }
    for (const caught of ["detached: true", "detached:true", "detached: !opts.foreground", "detached: cfg.bg"]) {
      assert.equal(DETACHED_NOT_FALSE.test(caught), true, `${caught} must require a marker stamp`);
    }
  });

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
    // The negative lookahead has to swallow the whitespace, not sit behind it. Written
    // `/detached:\s*(?!false\b)/` — the broken form — `\s*` backtracks to empty, the lookahead
    // then sees `" false"`, which is not `false`, and the ordinary spelling `detached: false`
    // FIRED. Only `detached:false` was exempt. `DETACHED_NOT_FALSE` below is the fixed form and
    // is pinned by a fixture, because the two spellings differ by one character's position and
    // a reader who has only the prose reverts to the broken one.
    for (const file of sourceFiles()) {
      const src = read(file);
      if (!DETACHED_NOT_FALSE.test(src)) continue;
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
    //
    // The viewer and landing workspaces too, and `.tsx` as well as `.ts`: sourceFiles() reads
    // server/src and one extension, so a separator byte in a component was invisible while the
    // suite is called "source stays source". Verified by mutation on viewer/src/App.tsx.
    const others: string[] = [];
    const walkAll = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.isSymbolicLink()) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walkAll(full);
        else if (/\.tsx?$/.test(entry.name)) others.push(full);
      }
    };
    for (const ws of ["viewer/src", "landing/src", "scripts"]) walkAll(join(REPO, ws));
    for (const file of [...sourceFiles(), ...testFiles(), ...others]) {
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

describe("setup decides on state, not on its own prose", () => {
  it("finds the end of a call whose arguments contain a call", () => {
    // The check below reads the real setup.ts, so neither direction of its scanner shows up
    // there until someone writes the shape. `deckhandCli\([^)]*\)\s*\.out` stopped at the first
    // `)`, and setup.ts already writes an args list holding a nested call — so the inline shape
    // was unpoliced in the spelling it is most likely to wear.
    const at = (s: string) => s.slice(endOfCall(s, s.indexOf("(")));
    assert.equal(at(`deckhandCli(["doctor", String(port)]).out.includes("x")`), `.out.includes("x")`);
    assert.equal(at(`deckhandCli(["doctor"]).out`), ".out");
    // A `)` inside a string argument does not close the call.
    assert.equal(at(`deckhandCli([")"]).out`), ".out");
    // Unbalanced is -1 — an answer the caller can skip, not a wrong offset it would act on.
    assert.equal(endOfCall("deckhandCli(", 11), -1);
  });


  // Three times now, a `setup` branch has been broken by an unrelated edit to a message it was
  // grepping. It looked for "admin" (meaningless once roles went away), then for a non-empty
  // stdout (always non-empty, because silence reads as a broken command), then for "no tokens
  // yet" — renamed to "no credentials yet" one commit later, in a diff that touched no setup
  // code and passed every test. Each time the symptom was the same and severe: setup takes the
  // "already exists" branch on a FRESH install, mints nothing, ignores --token, and the install
  // finishes green with `deckhand pair` impossible, so nobody can ever be let in.
  //
  // The output of `deckhand <verb>` is written for a person and is meant to be edited freely.
  // So setup may PRINT it and may check an exit CODE, and may not branch on its text: the state
  // it wants is in tokens.yaml, config.yaml and apps.yaml, which are typed and loaded.
  it("never branches on the text of deckhand's own output", () => {
    const src = read(join(SRC, "cli", "setup.ts"))
      .replace(/\/\/[^\n]*/g, "")
      // Quoted message text is blanked so an ordinary "…?" cannot read as a ternary below.
      .replace(/'[^'\n]*'|"[^"\n]*"/g, (q) => " ".repeat(q.length));
    // An ALLOW-list, and scoped to ARGUMENT POSITION rather than to the line. Two earlier versions
    // of this check were weaker in opposite directions. A deny-list of string operations
    // (`.test()`, `.includes()`, `===`) missed `out.trim() !== ""` — the exact shape of failure #2
    // above. Then "a sink anywhere on the line" missed `if (t.out.includes(…)) ok(…)`, which is
    // this file's dominant style AND all three historical shapes, while refusing an ordinary
    // multi-line `say(` or `SetupError(` that setup.ts already writes elsewhere.
    //
    // So: the output may be an ARGUMENT to something that shows it. Anywhere else — a condition, a
    // comparison, an intermediate variable, a ternary — is a finding, however it is spelt or
    // wrapped across lines.
    const captures = [...src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*deckhandCli\s*\(/g)].map((m) => ({ name: m[1]!, at: m.index }));
    assert.ok(captures.length > 0, "no `deckhandCli` result is captured — this check has lost its subject");
    // Rebinding is the rule stepped around by writing it differently: `const res = doctor;` gives
    // the result a name nothing below has seen, and `res.out.includes(…)` then passed. Each pass
    // follows one hop, so a chain closes too. The limit that stays, because a text scan cannot do
    // better: a result reaching a name any OTHER way — a parameter, an array element, a property
    // — is still invisible to this check.
    const seen = new Set(captures.map((c) => `${c.name}@${c.at}`));
    for (let grew = true; grew; ) {
      grew = false;
      for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(\w+)\s*;/g)) {
        const key = `${m[1]}@${m.index}`;
        if (seen.has(key) || !captures.some((c) => c.name === m[2]! && c.at < m.index)) continue;
        seen.add(key);
        captures.push({ name: m[1]!, at: m.index });
        grew = true;
      }
    }
    const SINK = /(?:say|info|ok|step|console\.(?:log|error)|process\.stdout\.write|new\s+SetupError)\s*$/;

    /** Is this offset inside the argument list of something that only displays its argument? */
    const shownNotRead = (at: number): boolean => {
      let depth = 0;
      for (let i = at; i > 0; i--) {
        const ch = src[i]!;
        if (ch === ")") depth += 1;
        else if (ch === "(") {
          if (depth > 0) {
            depth -= 1;
            continue;
          }
          // An unclosed `(` to our left: whatever is called here encloses us.
          if (SINK.test(src.slice(Math.max(0, i - 40), i))) return true;
        } else if (ch === ";" || ch === "}") break; // left the statement without meeting a sink
      }
      return false;
    };

    /**
     * Argument position is necessary and not sufficient: `say(out.includes("x") ? "a" : "b")` is
     * inside a sink and still decides something from the text. So the mention must also not feed a
     * comparison or a ternary before its statement ends.
     */
    const displayed = (at: number): boolean => {
      if (!shownNotRead(at)) return false;
      const rest = src.slice(at, at + 240).split(";")[0]!;
      return !/\?(?![.?])|===|!==|&&|\|\|/.test(rest);
    };

    const offences: string[] = [];
    const lineOf = (at: number): number => src.slice(0, at).split("\n").length;
    // Destructuring detaches the text from the call it came from, so nothing downstream can tell
    // it apart from any other string — the rule cannot follow it. Keep the result whole.
    for (const m of src.matchAll(/(?:const|let)\s*\{[^}]*\bout\b[^}]*\}\s*=\s*deckhandCli\(/g)) {
      offences.push(`setup.ts:${lineOf(m.index)}`);
    }
    for (const m of src.matchAll(/(\w+)\.out\b/g)) {
      const name = m[1]!;
      // Only OUR results: `list` also names a `cloudflared tunnel list` result in this file, and
      // flagging that would blame deckhand's output for a third party's.
      const capture = captures.find((c) => c.name === name && c.at < m.index);
      if (!capture) continue;
      if (!displayed(m.index)) offences.push(`setup.ts:${lineOf(m.index)}`);
    }
    // An inline `deckhandCli([...]).out` captures nothing, so the loop above cannot see it.
    // Brace-BALANCED via `endOfCall`, not `deckhandCli\([^)]*\)`: that stopped at the first `)`,
    // and setup.ts already writes an args list containing a nested call, so the shape was live.
    for (const m of src.matchAll(/deckhandCli\s*\(/g)) {
      const end = endOfCall(src, m.index + m[0].length - 1);
      if (end < 0 || !/^\s*\.out\b/.test(src.slice(end, end + 16))) continue;
      if (!displayed(m.index)) offences.push(`setup.ts:${lineOf(m.index)}`);
    }
    assert.deepEqual(
      offences.sort(),
      [],
      "setup.ts uses the TEXT of a `deckhand` command's output for something other than showing it. " +
        "That text is written for a person and gets reworded — three setup branches have already " +
        "been broken that way. Read the state instead (tokens.yaml/config.yaml via their loaders), " +
        "or check the exit code. Printing it, or quoting it in a SetupError, is fine.",
    );
  });
});
