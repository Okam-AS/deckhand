import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { DevProcessManager, type SpawnFn } from "./devProcess.ts";

// A scripted fake child: emits one stdout line, stays "alive" until killed.
function fakeSpawn() {
  const spawned: { command: string; args: string[]; cwd?: string; child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; pid: number; kill: (s?: string) => boolean } }[] = [];
  let nextPid = 100;
  const spawnFn = ((command: string, args: string[], opts: { cwd?: string }) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: nextPid++,
      kill: () => true,
    });
    spawned.push({ command, args, cwd: opts.cwd, child });
    return child;
  }) as unknown as SpawnFn;
  return { spawnFn, spawned };
}

describe("DevProcessManager", () => {
  it("spawns, reports alive, tails output, and marks exit", async () => {
    const { spawnFn, spawned } = fakeSpawn();
    const mgr = new DevProcessManager(spawnFn);
    const lines: string[] = [];
    mgr.start({ key: "app:ios", command: "ns", args: ["run", "ios", "--no-hmr"], cwd: "/src", env: {}, onLog: (l) => lines.push(l) });

    assert.equal(mgr.isAlive("app:ios"), true);
    assert.equal(spawned[0]!.command, "ns");
    assert.equal(spawned[0]!.cwd, "/src");

    spawned[0]!.child.stdout.write("Successfully synced application\n");
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(lines, ["Successfully synced application"]);

    spawned[0]!.child.emit("close", 1);
    assert.equal(mgr.isAlive("app:ios"), false);
    assert.equal(mgr.exitCode("app:ios"), 1);
  });

  it("restart re-spawns with the remembered spec", () => {
    const { spawnFn, spawned } = fakeSpawn();
    const mgr = new DevProcessManager(spawnFn);
    mgr.start({ key: "app:ios", command: "ns", args: ["run", "ios"], cwd: "/src", env: {} });
    assert.equal(mgr.restart("app:ios"), true);
    assert.equal(spawned.length, 2);
    assert.deepEqual(spawned[1]!.args, ["run", "ios"]);
    assert.equal(mgr.isAlive("app:ios"), true);
    assert.equal(mgr.restart("unknown"), false);
  });

  it("stop forgets the process; a replaced start does not resurrect the old one", () => {
    const { spawnFn, spawned } = fakeSpawn();
    const mgr = new DevProcessManager(spawnFn);
    mgr.start({ key: "a", command: "ns", args: [], cwd: "/x", env: {} });
    mgr.start({ key: "a", command: "ns", args: ["v2"], cwd: "/x", env: {} }); // replaces
    assert.equal(spawned.length, 2);
    mgr.stop("a");
    assert.equal(mgr.isAlive("a"), false);
    mgr.stop("a"); // idempotent
  });
});
