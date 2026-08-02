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

describe("a key reused by a newer preview", () => {
  it("does not let an old teardown kill the new owner's process", async () => {
    // The key is per app+platform, not per preview, and teardown runs asynchronously. So
    // `stop_preview` then `start_preview` — the only way to add a device today — had the OLD
    // preview's teardown arrive after the NEW preview had taken the key, and kill a livesync
    // that had just started. The viewer said "livesync process exited" on a fresh preview.
    const procs = new DevProcessManager();
    procs.start({ key: "app:ios", owner: "pv1", command: "sleep", args: ["30"], cwd: process.cwd(), env: {} });
    procs.start({ key: "app:ios", owner: "pv2", command: "sleep", args: ["30"], cwd: process.cwd(), env: {} });

    procs.stop("app:ios", "pv1"); // the old preview's teardown, arriving late
    assert.equal(procs.isAlive("app:ios"), true, "pv2's process survives its predecessor's teardown");

    procs.stop("app:ios", "pv2");
    assert.equal(procs.isAlive("app:ios"), false, "and its own owner can still stop it");
  });

  it("still stops unconditionally when no owner is given", async () => {
    // The reaper and the idle sweep have no previewId to offer.
    const procs = new DevProcessManager();
    procs.start({ key: "app:ios", owner: "pv1", command: "sleep", args: ["30"], cwd: process.cwd(), env: {} });
    procs.stop("app:ios");
    assert.equal(procs.isAlive("app:ios"), false);
  });
});

/** Wait for the process to actually exit, rather than sleeping a guessed number of ms. */
const untilExited = async (procs: DevProcessManager, key: string): Promise<void> => {
  for (let i = 0; i < 100 && procs.isAlive(key); i++) await new Promise((r) => setTimeout(r, 50));
};

describe("exitReason", () => {
  it("says a process was killed, rather than showing an unknown code", async () => {
    // `close` reports code=null when a signal killed the process, so recording only the code
    // threw away the most diagnostic fact there is. The viewer showed "(code ?)", which reads
    // as a mystery instead of "something SIGTERMed it".
    // stop() forgets the record, so ask about one that died on its own.
    const p2 = new DevProcessManager();
    p2.start({ key: "k2", command: "sh", args: ["-c", "exit 3"], cwd: process.cwd(), env: {} });
    await untilExited(p2, "k2");
    assert.match(p2.exitReason("k2"), /exit code 3/);
  });

  it("names the signal when one killed it", async () => {
    const procs = new DevProcessManager();
    procs.start({ key: "k3", command: "sleep", args: ["30"], cwd: process.cwd(), env: {} });
    await new Promise((r) => setTimeout(r, 150));
    const [pid] = procs.livePids();
    assert.ok(pid, "fixture sanity: the process is running and tracked");
    process.kill(-pid!, "SIGTERM"); // the group, as the reaper does
    await untilExited(procs, "k3");
    assert.match(procs.exitReason("k3"), /killed by SIGTERM/);
  });
});
