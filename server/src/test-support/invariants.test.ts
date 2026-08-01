import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
    for (const ws of ["server", "viewer", "landing"]) {
      const pkg = JSON.parse(read(join(REPO, ws, "package.json"))) as { dependencies?: Record<string, string> };
      for (const dep of Object.keys(pkg.dependencies ?? {})) {
        assert.ok(
          approved.has(dep),
          `${ws}/package.json adds "${dep}", which is not in PLAN §3's approved list. ` +
            `Adding a dependency is a PLAN §2 decision — argue it there first, then widen this set.`,
        );
      }
    }
  });

  it("uses no database driver", () => {
    // PLAN.md:49 — "No database." State is config.yaml/apps.yaml/tokens.yaml +
    // a small state.json.
    const banned = /\b(pg|mysql2?|sqlite3?|better-sqlite3|mongodb|mongoose|redis|ioredis|prisma|drizzle-orm|typeorm|knex)\b/;
    for (const ws of ["server", "viewer", "landing"]) {
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
    const backends = /from "\.{1,2}\/(streaming\/)?(serveSim|androidAdb|androidH264|web)\.ts"/;
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
    const tools = read(join(SRC, "mcp", "tools.ts"));
    const registered = [...tools.matchAll(/server\.registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]!);
    const audited = new Set([...tools.matchAll(/audited\(\s*"([a-z_]+)"/g)].map((m) => m[1]!));
    assert.ok(registered.length > 0, "no tools found — the registerTool pattern changed, fix this check");
    for (const name of registered) {
      assert.ok(audited.has(name), `MCP tool "${name}" is registered but never wrapped in audited() — PLAN §11.2`);
    }
  });

  it("binds the HTTP server to loopback and nowhere else", () => {
    // PLAN.md:43 — "Deckhand binds 127.0.0.1 only." Everything public reaches it
    // through the tunnel; a wildcard bind would put the whole MCP surface on the
    // LAN.
    const server = read(join(SRC, "server.ts"));
    const listens = [...server.matchAll(/\.listen\(([^)]*)\)/g)].map((m) => m[1]!);
    assert.equal(listens.length, 1, `expected exactly one .listen() in server.ts, found ${listens.length}`);
    assert.match(listens[0]!, /"127\.0\.0\.1"/, `server.ts binds ${listens[0]} — PLAN §11.1 requires loopback only`);
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
    // Matched by locating the line rather than by parsing the literal: a regex
    // that parses a regex breaks on any harmless edit, and a guardrail that
    // cries wolf gets deleted.
    const gate = read(join(SRC, "share", "proxy.ts"))
      .split("\n")
      .find((l) => l.includes("(dev|web|restart)"));
    assert.ok(gate, "the share-gate route matcher moved — find it and re-pin this check");
    assert.match(
      gate,
      /\/[a-z]*i[a-z]*\.exec/,
      "the share gate regex lost its `i` flag — Express dispatches routes case-insensitively, " +
        "so /Dev/ and /RESTART would reach a locked share's stream and rebuild with no PIN",
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
    for (const file of sourceFiles()) {
      const src = read(file);
      if (!/detached:\s*true/.test(src)) continue;
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
