import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, spawn } from "node:child_process";
import { IPHONE_MARKER_ENV, IproxyForward, iproxyArgs, wdaPortsFor } from "./iproxy.ts";
import {
  loopbackXctestrunName, WdaRunner, WdaStartError, parseServerUrl, probeWifiPort, startFailureHint, wifiExposure, xctestrunTargets,
} from "./wdaRunner.ts";
import { defaultExec, type Exec } from "./ios.ts";
import { fakeWda } from "../test-support/wdaFake.ts";

interface Spawned {
  cmd: string;
  args: string[];
  opts: { detached?: boolean; env?: NodeJS.ProcessEnv };
  child: FakeChild;
}

class FakeChild extends EventEmitter {
  pid = 900_000_000 + Math.floor(Math.random() * 1000);
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed: string[] = [];
  kill(sig: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed.push(sig);
    this.exit(null, sig);
    return true;
  }
  unref(): void {}
  exit(code: number | null, sig: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = sig;
    this.emit("exit", code, sig);
  }
}

function fakeSpawn(onSpawn: (s: Spawned) => void = () => {}): { impl: typeof spawn; spawned: Spawned[] } {
  const spawned: Spawned[] = [];
  const impl = ((cmd: string, args: string[], opts: Spawned["opts"]) => {
    const s = { cmd, args, opts, child: new FakeChild() };
    spawned.push(s);
    onSpawn(s);
    return s.child as unknown as ChildProcess;
  }) as unknown as typeof spawn;
  return { impl, spawned };
}

const UDID = "00008120-000000000000001E";

function products(): string {
  const dir = mkdtempSync(join(tmpdir(), "deckhand-wda-"));
  writeFileSync(
    join(dir, "WebDriverAgentRunner_iphoneos27.1-arm64.xctestrun"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>WebDriverAgentRunner</key><dict><key>EnvironmentVariables</key><dict><key>USE_IP</key><string></string><key>TERM</key><string>dumb</string></dict><key>TestHostPath</key><string>__TESTROOT__/Debug-iphoneos/WebDriverAgentRunner-Runner.app</string></dict>
<key>SecondTarget</key><dict><key>TestHostPath</key><string>x</string></dict>
<key>__xctestrun_metadata__</key><dict><key>FormatVersion</key><integer>1</integer></dict>
</dict></plist>`,
  );
  return dir;
}

async function plist(file: string): Promise<Record<string, Record<string, Record<string, string>>>> {
  const r = await defaultExec("plutil", ["-convert", "json", "-o", "-", file]);
  return JSON.parse(r.stdout.toString()) as Record<string, Record<string, Record<string, string>>>;
}

const noExec: Exec = async () => {
  throw new Error("exec not expected");
};

describe("iproxy", () => {
  it("binds the Mac side to loopback, explicitly", () => {
    const args = iproxyArgs(UDID, [[18401, 8100], [18501, 9100]]);
    const s = args.indexOf("-s");
    assert.ok(s >= 0 && args[s + 1] === "127.0.0.1", `iproxy without -s 127.0.0.1 listened on every interface: ${args.join(" ")}`);
    assert.deepEqual(args.slice(-2), ["18401:8100", "18501:9100"]);
  });

  it("spawns detached with deckhand's marker and that argv, and refuses a port someone else holds", async () => {
    const { impl, spawned } = fakeSpawn();
    let up = false;
    const f = new IproxyForward({ udid: UDID, pairs: [[18401, 8100]], spawnImpl: impl, portAnswersImpl: async () => up, sleep: async () => void (up = true) });
    await f.ensure();
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0]!.cmd, "iproxy");
    assert.deepEqual(spawned[0]!.args, iproxyArgs(UDID, [[18401, 8100]]));
    assert.equal(spawned[0]!.opts.detached, true);
    assert.equal(spawned[0]!.opts.env?.[IPHONE_MARKER_ENV], "1");
    assert.deepEqual(f.livePids(), [spawned[0]!.child.pid]);
    await f.ensure();
    assert.equal(spawned.length, 1, "a live forward is reused");

    const busy = new IproxyForward({ udid: UDID, pairs: [[18401, 8100]], spawnImpl: fakeSpawn().impl, portAnswersImpl: async () => true });
    await assert.rejects(() => busy.ensure(), /already held by another process/);
  });

  it("says how to fix an iproxy that exits", async () => {
    const { impl } = fakeSpawn((s) => setImmediate(() => s.child.exit(1)));
    const f = new IproxyForward({ udid: UDID, pairs: [[18401, 8100]], spawnImpl: impl, portAnswersImpl: async () => false, sleep: () => new Promise((r) => setImmediate(r)) });
    await assert.rejects(() => f.ensure(), /brew install libimobiledevice/);
    assert.deepEqual(f.livePids(), []);
  });

  it("gives each phone stable Mac ports clear of WDA's own", () => {
    const p = wdaPortsFor(UDID);
    assert.deepEqual(p, wdaPortsFor(UDID.toLowerCase()));
    assert.ok(p.http >= 18400 && p.http < 18500 && p.mjpeg >= 18500 && p.mjpeg < 18600);
    assert.notEqual(p.http, 8100);
  });
});

describe("the loopback .xctestrun", () => {
  it("sets USE_IP=127.0.0.1 on every test target of a copy, and never edits the original", async () => {
    const dir = products();
    try {
      const runner = new WdaRunner({ udid: UDID, productsDir: dir, logPath: join(dir, "wda.log") });
      const original = readFileSync(runner.sourceXctestrun(), "utf8");
      const copy = await runner.loopbackXctestrun();
      assert.equal(copy, join(dir, loopbackXctestrunName(UDID)));
      assert.equal(readFileSync(runner.sourceXctestrun(), "utf8"), original);
      const j = await plist(copy);
      for (const t of ["WebDriverAgentRunner", "SecondTarget"]) {
        assert.equal(j[t]!.EnvironmentVariables!.USE_IP, "127.0.0.1", t);
        assert.equal(j[t]!.EnvironmentVariables!.USE_PORT, "8100", t);
        assert.equal(j[t]!.EnvironmentVariables!.MJPEG_SERVER_PORT, "9100", t);
      }
      assert.equal(j.WebDriverAgentRunner!.EnvironmentVariables!.TERM, "dumb");
      assert.match(runner.sourceXctestrun(), /WebDriverAgentRunner_iphoneos/, "deckhand's own copy is never the source");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never leaves a started runner's copy unbound while another start rewrites it", async () => {
    const dir = products();
    try {
      const a = new WdaRunner({ udid: UDID, productsDir: dir, logPath: join(dir, "a.log") });
      const running = await a.loopbackXctestrun();
      const seen: unknown[] = [];
      const watching: Exec = async (cmd, args, o) => {
        seen.push((await plist(running)).WebDriverAgentRunner!.EnvironmentVariables!.USE_IP);
        return defaultExec(cmd, args, o);
      };
      const sameUdid = new WdaRunner({ udid: UDID, productsDir: dir, logPath: join(dir, "b.log"), exec: watching });
      assert.equal(await sameUdid.loopbackXctestrun(), running);
      assert.ok(seen.length > 0);
      assert.deepEqual([...new Set(seen)], ["127.0.0.1"], "a concurrent start exposed the unbound copy to a running xcodebuild");
      assert.notEqual(await new WdaRunner({ udid: "00008110-000000000000AAAA", productsDir: dir }).loopbackXctestrun(), running);
      assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".tmp")), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds the targets of both .xctestrun formats", () => {
    assert.deepEqual(xctestrunTargets({ A: { EnvironmentVariables: {} }, __xctestrun_metadata__: {} }), ["A"]);
    assert.deepEqual(xctestrunTargets({ TestConfigurations: [{ TestTargets: [{}, {}] }] }), ["TestConfigurations.0.TestTargets.0", "TestConfigurations.0.TestTargets.1"]);
  });

  it("names the fix when there is no WDA to run", () => {
    const runner = new WdaRunner({ udid: UDID, productsDir: join(tmpdir(), "deckhand-no-such-wda") });
    assert.throws(() => runner.sourceXctestrun(), (e: unknown) => e instanceof WdaStartError && /copy a WDA Products folder/.test(e.hint ?? ""));
  });
});

function runnerFixture(opts: { ready?: () => boolean; onSpawn?: (s: Spawned, log: string) => void; wifi?: Exec; startTimeoutMs?: number } = {}) {
  const dir = products();
  const log = join(dir, "wda.log");
  const wda = fakeWda();
  let ready = false;
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    if (!(opts.ready?.() ?? ready)) throw new TypeError("fetch failed");
    return wda.fetch(input as string, init);
  }) as typeof fetch;
  const xcode = fakeSpawn((s) => {
    if (s.cmd !== "xcodebuild") return;
    if (opts.onSpawn) return opts.onSpawn(s, log);
    appendFileSync(log, "t = 0.01s ServerURLHere->http://127.0.0.1:8100<-ServerURLHere\n");
    ready = true;
  });
  const forward = new IproxyForward({ udid: UDID, pairs: [[18401, 8100]], spawnImpl: fakeSpawn().impl, portAnswersImpl: async () => true });
  let fwdUp = false;
  forward.ensure = async () => void (fwdUp = true);
  const exec: Exec = async (cmd, args, o) => (cmd === "curl" ? (opts.wifi ?? noExec)(cmd, args, o) : defaultExec(cmd, args, o));
  const runner = new WdaRunner({
    udid: UDID, productsDir: dir, logPath: log, spawnImpl: xcode.impl, fetchImpl, forward, exec, sleep: () => new Promise((r) => setImmediate(r)), restartDelayMs: 1, startTimeoutMs: opts.startTimeoutMs ?? 50_000,
  });
  return { dir, log, runner, spawned: xcode.spawned, wda, setReady: (v: boolean) => (ready = v), fwd: () => fwdUp };
}

describe("WdaRunner", () => {
  it("runs the loopback copy, detached and marked, and is ready once WDA logs its URL and answers /status", async () => {
    const f = runnerFixture();
    try {
      const st = await f.runner.ensureRunning();
      assert.equal(st.ready, true);
      assert.equal(f.fwd(), true);
      const x = f.spawned.find((s) => s.cmd === "xcodebuild")!;
      assert.deepEqual(x.args, ["test-without-building", "-xctestrun", join(f.dir, loopbackXctestrunName(UDID)), "-destination", `id=${UDID}`]);
      assert.equal(x.opts.detached, true);
      assert.equal(x.opts.env?.[IPHONE_MARKER_ENV], "1");
      assert.ok(f.runner.livePids().includes(x.child.pid));
      await f.runner.ensureRunning();
      assert.equal(f.spawned.length, 1, "a live runner is reused");
    } finally {
      f.runner.stop();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("says what the phone needs when xcodebuild gives up", async () => {
    const f = runnerFixture({
      onSpawn: (s, log) => {
        appendFileSync(log, "2026-11-03 14:08:36.479 xcodebuild[1:2] [MT] IDESchemeActionSDKRecord: operatingSystemBuild = <DVTBuildVersion 24A94232>, error = invalidDigitCount(94232).\nTesting failed:\n\tTimed out while enabling automation mode.\n");
        setImmediate(() => s.child.exit(65));
      },
    });
    try {
      await assert.rejects(
        () => f.runner.ensureRunning(),
        (e: unknown) => e instanceof WdaStartError && /Automation Mode prompt/.test(e.hint ?? "") && /Timed out while enabling/.test(e.message) && !/invalidDigitCount/.test(e.message),
      );
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(f.spawned.length, 1, "a runner that never came up was restarted behind the caller's back");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("gives up on a runner that launched and never served, stops it, and says what to look for", async () => {
    const f = runnerFixture({ startTimeoutMs: 200, onSpawn: (_s, log) => appendFileSync(log, "WebDriverAgentRunner-Runner[1:2] [Default] Running tests...\n") });
    try {
      await assert.rejects(() => f.runner.ensureRunning(), (e: unknown) => e instanceof WdaStartError && /not ready after/.test(e.message) && /Automation Mode prompt/.test(e.hint ?? ""));
      assert.deepEqual(f.spawned[0]!.child.killed, ["SIGTERM"]);
      assert.deepEqual(f.runner.livePids(), []);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("restarts a runner that exits on its own, and not one it stopped", async () => {
    const f = runnerFixture();
    try {
      await f.runner.ensureRunning();
      f.setReady(false);
      f.spawned[0]!.child.exit(0);
      for (let i = 0; i < 200 && f.spawned.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(f.spawned.length, 2, "the runner was not restarted");
      f.runner.stop();
      f.spawned[1]!.child.exit(0);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(f.spawned.length, 2, "a stopped runner came back");
    } finally {
      f.runner.stop();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("does not restart a runner that was stopped while its restart was pending", async () => {
    const f = runnerFixture();
    try {
      await f.runner.ensureRunning();
      f.setReady(false);
      f.spawned[0]!.child.exit(0);
      f.runner.stop();
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(f.spawned.length, 1);
    } finally {
      f.runner.stop();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("keeps a WDA it did not start only when its Wi-Fi address refuses WDA's ports", async () => {
    const refused = runnerFixture({ ready: () => true, wifi: async () => ({ code: 7, stdout: Buffer.alloc(0), stderr: "" }) });
    const exposed = runnerFixture({ ready: () => true, wifi: async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: "" }) });
    try {
      await refused.runner.ensureRunning();
      assert.equal(refused.spawned.length, 0);
      await exposed.runner.ensureRunning();
      assert.equal(exposed.spawned.length, 1, "a WDA answering on Wi-Fi was kept");
    } finally {
      exposed.runner.stop();
      rmSync(refused.dir, { recursive: true, force: true });
      rmSync(exposed.dir, { recursive: true, force: true });
    }
  });
});

describe("Wi-Fi exposure", () => {
  const curl = (code: number): Exec => async () => ({ code, stdout: Buffer.alloc(0), stderr: "" });

  it("reads only a refusal as not exposed, and anything unexplained as can't tell", async () => {
    assert.equal(await probeWifiPort("192.168.1.20", 8100, curl(0)), "exposed");
    assert.equal(await probeWifiPort("192.168.1.20", 8100, curl(7)), "refused");
    assert.equal(await probeWifiPort("192.168.1.20", 8100, curl(28)), "cant-tell");
    assert.deepEqual((await wifiExposure("192.168.1.20", curl(7))).verdict, "not-exposed");
    assert.deepEqual((await wifiExposure("192.168.1.20", curl(28))).verdict, "cant-tell");
    assert.deepEqual((await wifiExposure(undefined, noExec)).verdict, "no-wifi");
  });

  it("probes both WDA ports, and an answer on either is exposure", async () => {
    const seen: string[] = [];
    const mixed: Exec = async (_c, args) => {
      seen.push(args.at(-1)!);
      return { code: args.at(-1)!.includes(":9100") ? 0 : 7, stdout: Buffer.alloc(0), stderr: "" };
    };
    assert.equal((await wifiExposure("10.0.0.7", mixed)).verdict, "exposed");
    assert.deepEqual(seen, ["http://10.0.0.7:8100/status", "http://10.0.0.7:9100/status"]);
  });

  it("never hands curl an address that is not an IP literal", async () => {
    assert.equal(await probeWifiPort("-o/tmp/x", 8100, noExec), "cant-tell");
  });
});

describe("WDA log reading", () => {
  it("finds ServerURLHere", () => {
    assert.equal(parseServerUrl("noise\n t = 0.01s ServerURLHere->http://127.0.0.1:8100<-ServerURLHere\n"), "http://127.0.0.1:8100");
    assert.equal(parseServerUrl("ServerURLHere->http://192.168.1.20:8100"), "http://192.168.1.20:8100");
    assert.equal(parseServerUrl("Testing started"), null);
  });

  it("names the operator's fix for the failures a phone produces", () => {
    assert.match(startFailureHint("Timed out while enabling automation mode.")!, /approve the Automation Mode prompt/);
    assert.match(startFailureHint("UI Automation is not enabled")!, /Enable UI Automation/);
    assert.match(startFailureHint("Developer Mode disabled")!, /Developer Mode/);
    assert.match(startFailureHint("The device is locked.")!, /unlock/);
    assert.equal(startFailureHint("something new"), undefined);
  });
});

