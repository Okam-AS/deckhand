import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runStep, buildPids, BUILD_MARKER_ENV } from "./procs.ts";
import type { CommandStep } from "./recipes.ts";

/**
 * `procs.ts` spawns every build step, detached, and owns the process-group kill. It had no
 * tests. These cover the part the boot sweep depends on.
 */

const sh = (script: string): CommandStep => ({ name: "t", run: { kind: "shell", script }, cwd: process.cwd(), env: {}, idleTimeoutMs: 0 });
const argv = (command: string, args: string[] = []): CommandStep => ({ name: "t", run: { kind: "argv", command, args }, cwd: process.cwd(), env: {}, idleTimeoutMs: 0 });

describe("buildPids", () => {
  it("lists a step while it runs and forgets it when it exits", async () => {
    // The boot orphan sweep SIGTERMs every process carrying DECKHAND_BUILD, and used to pass
    // an empty keep-set on the reasoning that "build steps are awaited, so nothing is owned
    // across a boot". True of a boot; false of the sweep, which runs AFTER the port is bound —
    // so an agent's start_preview can land in between and have its brand-new xcodebuild killed
    // by the server it just asked for a preview. This is what spares it.
    assert.deepEqual(buildPids(), [], "nothing running to begin with");

    let during: number[] = [];
    const done = runStep(sh("sleep 0.4"));
    await new Promise((r) => setTimeout(r, 120));
    during = buildPids();
    assert.equal(during.length, 1, "the running step is listed");
    assert.ok(Number.isInteger(during[0]) && during[0]! > 0);

    await done;
    assert.deepEqual(buildPids(), [], "and is forgotten once it exits");
  });

  it("forgets a step that fails to spawn, not just one that exits cleanly", async () => {
    // A pid left in the set would spare a DEAD build forever — and worse, could spare an
    // unrelated process that later reuses the number.
    await runStep(argv("definitely-not-a-command"));
    assert.deepEqual(buildPids(), []);
  });

  it("forgets a step killed by its idle timeout", async () => {
    const res = await runStep(sh("sleep 5"), { idleTimeoutMs: 150, killGraceMs: 50 });
    assert.equal(res.timedOut, true);
    assert.deepEqual(buildPids(), [], "the timeout path clears it too");
  });

  it("tracks concurrent steps independently", async () => {
    const a = runStep(sh("sleep 0.4"));
    const b = runStep(sh("sleep 0.4"));
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(buildPids().length, 2, "a multi-device preview builds more than one thing at once");
    await Promise.all([a, b]);
    assert.deepEqual(buildPids(), []);
  });
});

describe("runStep", () => {
  it("stamps the build marker so a later boot can find an orphan", async () => {
    // The marker is how a restart tells deckhand's own abandoned xcodebuild from the
    // developer's — killing the latter is the emulator-hijack class of bug.
    let seen = "";
    await runStep(sh(`echo "$${BUILD_MARKER_ENV}"`), { onLog: (line) => (seen += line) });
    assert.match(seen, /1/, "every build step carries DECKHAND_BUILD=1");
  });

  it("reports the exit code, and a spawn failure as 127", async () => {
    assert.equal((await runStep(sh("exit 3"))).code, 3);
    const missing = await runStep(argv("definitely-not-a-command"));
    assert.equal(missing.code, 127, "command-not-found, the convention the recipes rely on");
  });

  it("aborts on signal rather than running to completion", async () => {
    const ctl = new AbortController();
    const done = runStep(sh("sleep 5"), { signal: ctl.signal, killGraceMs: 50 });
    setTimeout(() => ctl.abort(), 100);
    const res = await done;
    assert.equal(res.aborted, true);
  });
});
