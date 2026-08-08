import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { MetroManager, type MetroManagerOptions } from "./metro.ts";

/** A MetroManager whose port probing, health check and spawn are all faked. */
function makeManager(opts: {
  free: (port: number) => boolean;
  pgid?: (port: number) => number | null;
  healthy?: (port: number) => boolean;
  childPid?: number;
}) {
  const spawned: { args: string[]; cwd?: string }[] = [];
  const childPid = opts.childPid ?? 4242;
  const spawnFn = ((_cmd: string, args: string[], o: { cwd?: string }) => {
    spawned.push({ args, cwd: o?.cwd });
    return { pid: childPid, kill: () => true } as unknown as ChildProcess;
  }) as unknown as typeof nodeSpawn;

  const signals: { pid: number; sig: string }[] = [];
  const options: MetroManagerOptions = {
    portRange: [8081, 8084],
    spawnFn,
    portFreeImpl: async (p) => opts.free(p),
    listenerPgidImpl: async (p) => (opts.pgid ? opts.pgid(p) : childPid),
    healthyImpl: async (p) => (opts.healthy ? opts.healthy(p) : true),
    // Faked, and not optional: with the real defaults these tests send SIGTERM
    // to process group 4242 on the machine running the suite — and on a machine
    // where that pid does not exist `pidAlive` throws, `stopLocked` returns
    // before doing anything, and the teardown logic they read as covering never
    // executes at all.
    pidAliveImpl: () => true,
    killImpl: (pid, sig) => void signals.push({ pid, sig }),
    stopWaitMs: [50, 50],
  };
  return { mgr: new MetroManager(options), spawned, signals };
}

const portOf = (url: string): number => Number(new URL(url).port);

describe("MetroManager port allocation", () => {
  it("uses 8081 when it is free", async () => {
    const { mgr, spawned } = makeManager({ free: () => true });
    const h = await mgr.ensure("app-a", "/wt", {});
    assert.equal(h.manifestUrl, "http://127.0.0.1:8081");
    assert.deepEqual(spawned[0]!.args, ["expo", "start", "--dev-client", "--port", "8081"]);
    await mgr.stop();
  });

  it("skips a port a foreign dev server already holds", async () => {
    // The bug this replaced: 8081 held by ANOTHER project's `expo start` still
    // answered /status with packager-status:running, so deckhand pointed the dev
    // client at it and the previewed app's native shell loaded a foreign bundle.
    const { mgr, spawned } = makeManager({ free: (p) => p >= 8083 });
    const h = await mgr.ensure("app-a", "/wt", {});
    assert.equal(portOf(h.manifestUrl), 8083);
    assert.deepEqual(spawned[0]!.args.slice(-2), ["--port", "8083"]);
    await mgr.stop();
  });

  it("fails with an actionable error when every port in the range is taken", async () => {
    const { mgr, spawned } = makeManager({ free: () => false });
    await assert.rejects(
      () => mgr.ensure("app-a", "/wt", {}),
      (e: Error) => /no free Metro port in 8081-8084/.test(e.message) && /stop a running/.test(e.message),
    );
    assert.equal(spawned.length, 0, "must not spawn when there is nowhere to bind");
  });

  it("refuses a healthy Metro that is not in our process group", async () => {
    // Someone claimed the port between the free check and startup: healthy, but
    // theirs. Serving it would load their bundle into this app's shell.
    const { mgr } = makeManager({ free: () => true, pgid: () => 9999, childPid: 4242 });
    await assert.rejects(
      () => mgr.ensure("app-a", "/wt", {}),
      (e: Error) => /did not start/.test(e.message),
    );
  });

  it("accepts the port when ownership cannot be determined", async () => {
    // lsof missing or a race: the port was verified free moments earlier, so
    // don't fail a legitimate preview over an inconclusive probe.
    const { mgr } = makeManager({ free: () => true, pgid: () => null });
    const h = await mgr.ensure("app-a", "/wt", {});
    assert.equal(portOf(h.manifestUrl), 8081);
    await mgr.stop();
  });

  it("treats a port held on the IPv6 wildcard as busy (real socket)", async () => {
    // Metro binds `*:8081` (IPv6 wildcard). On macOS a 127.0.0.1-only bind
    // SUCCEEDS next to it, so the original loopback-only probe called a busy
    // port free and deckhand took 8081 from a developer's own `expo start`.
    const base = 18181;
    const squatter = createServer();
    await new Promise<void>((r) => squatter.listen(base, "::", () => r()));
    try {
      const spawned: string[][] = [];
      const mgr = new MetroManager({
        portRange: [base, base + 2],
        spawnFn: ((_c: string, args: string[]) => {
          spawned.push(args);
          return { pid: 4242, kill: () => true } as unknown as ChildProcess;
        }) as unknown as typeof nodeSpawn,
        // portFreeImpl left REAL — that is what this test exercises.
        listenerPgidImpl: async () => 4242,
        healthyImpl: async () => true,
      });
      const h = await mgr.ensure("app-a", "/wt", {});
      assert.equal(portOf(h.manifestUrl), base + 1, "must skip the IPv6-held port");
      await mgr.stop();
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()));
    }
  });

  it("serializes concurrent ensure() calls onto one server", async () => {
    // PreviewEngine.launch calls ensure() once per device, concurrently. Without
    // a lock both callers saw `current === null`, both spawned on different
    // ports, and the second overwrote the first — orphaning a Metro that holds
    // its port out of the range forever.
    const taken = new Set<number>();
    const { mgr, spawned } = makeManager({ free: (p) => !taken.has(p) });
    const [a, b, c] = await Promise.all([
      mgr.ensure("app-a", "/wt", {}),
      mgr.ensure("app-a", "/wt", {}),
      mgr.ensure("app-a", "/wt", {}),
    ]);
    assert.equal(spawned.length, 1, "one Metro for three concurrent devices");
    assert.equal(a!.manifestUrl, b!.manifestUrl);
    assert.equal(b!.manifestUrl, c!.manifestUrl);
    await mgr.stop();
  });

  it("stop() waits for the port to be released and escalates to SIGKILL", async () => {
    // SIGTERM-and-forget leaked a port per stubborn Metro until the whole range
    // was gone and every Expo preview failed with "no free Metro port".
    let held = false;
    const signals: string[] = [];
    const spawnFn = ((_cmd: string, _args: string[]) =>
      ({ pid: 4242, kill: () => true }) as unknown as ChildProcess) as unknown as typeof nodeSpawn;
    const mgr = new MetroManager({
      portRange: [8081, 8084],
      spawnFn,
      stopWaitMs: [50, 50],
      pidAliveImpl: () => true,
      killImpl: (_pid, sig) => {
        signals.push(sig);
        if (sig === "SIGKILL") held = false; // only SIGKILL gets this one to let go
      },
      // Free before the spawn, held by the running Metro afterwards.
      portFreeImpl: async (p) => (p === 8081 ? !held : true),
      listenerPgidImpl: async () => 4242,
      healthyImpl: async () => true,
    });
    await mgr.ensure("app-a", "/wt", {});
    held = true; // Metro is up and listening
    await mgr.stop();
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(held, false, "port must actually be released before stop() returns");
  });

  it("starts a second server for a second checkout of the same app", async () => {
    // Two live previews of one Expo app at different refs. Keyed on app+env
    // alone, the second one was handed the FIRST checkout's bundle — the
    // foreign-bundle failure this file exists to prevent, with deckhand as the
    // intruder, so no process-group check can catch it.
    // Ports are handed out per instance, so the free-port fake has to move on
    // after the first one is taken.
    const taken = new Set<number>();
    const { mgr, spawned, signals } = makeManager({ free: (p) => !taken.has(p) });
    const first = await mgr.ensure("app-a", "/wt/app-a-main", {});
    taken.add(portOf(first.manifestUrl));
    await mgr.ensure("app-a", "/wt/app-a-main", {});
    assert.equal(spawned.length, 1, "same checkout must reuse");
    const second = await mgr.ensure("app-a", "/wt/app-a-feature", {});
    assert.equal(spawned.length, 2, "a different checkout needs its own server");
    assert.equal(spawned[1]!.cwd, "/wt/app-a-feature");
    assert.notEqual(second.manifestUrl, first.manifestUrl);
    assert.deepEqual(signals, [], "the first preview's Metro must survive");
    await mgr.stop();
    assert.equal(signals.length > 0, true, "stop() reaps both");
  });

  it("reuses the running server for the same app and env, and restarts it when env changes", async () => {
    const { mgr, spawned } = makeManager({ free: () => true });
    const first = await mgr.ensure("app-a", "/wt", { API: "staging" });
    const again = await mgr.ensure("app-a", "/wt", { API: "staging" });
    assert.equal(again.manifestUrl, first.manifestUrl);
    assert.equal(spawned.length, 1, "same app + same env must not respawn");

    await mgr.ensure("app-a", "/wt", { API: "prod" });
    assert.equal(spawned.length, 2, "changed env must restart Metro");
    await mgr.stop();
  });
});
