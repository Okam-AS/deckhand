import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, spawn } from "node:child_process";
import { IphoneSyslog, crashMarkers, parseIdeviceSyslog } from "./iphoneSyslog.ts";
import { IPHONE_MARKER_ENV } from "./iproxy.ts";

const now = new Date(2026, 9, 23, 18, 10, 0);

const CRASH = [
  `Oct 23 18:02:11.104512 Demo(React)[4120] <Notice>: Running "main" with {"rootTag":1,"initialProps":{}}`,
  `Oct 23 18:02:12.330118 Demo(CoreFoundation)[4120] <Error>: *** Terminating app due to uncaught exception 'NSInvalidArgumentException', reason: '-[__NSCFNumber length]: unrecognized selector'`,
  `Oct 23 18:02:12.330904 Demo(CoreFoundation)[4120] <Error>: *** First throw call stack:`,
  `Oct 23 18:02:12.512300 ReportCrash[4133] <Notice>: Formulating report for corpse[4120] Demo`,
  `Oct 23 18:02:12.900011 runningboardd(RunningBoard)[33] <Notice>: [app<com.example.preview(...)>:4120] termination reported by launchd (2, 6, 6)`,
].join("\n");

const NORMAL = [
  `Oct 23 18:05:01.104512 Demo(React)[4200] <Notice>: Running "main" with {"rootTag":1,"initialProps":{}}`,
  `Oct 23 18:05:03.900011 runningboardd(RunningBoard)[33] <Notice>: [app<com.example.preview(...)>:4200] termination reported by launchd (15, 0, 0)`,
  `Oct 23 18:05:04.000011 SpringBoard(FrontBoard)[60] <Notice>: Process exited: <RBSProcessIdentity| application<com.example.preview>> -> <RBSProcessExitContext| specific, status:<RBSProcessExitStatus| domain:signal(2) code:SIGKILL (9)>>`,
  `Oct 23 18:05:05.000011 ReportCrash[77] <Notice>: Formulating report for corpse[901] DemoWidget`,
].join("\n");

describe("idevicesyslog lines", () => {
  it("reads process, subsystem, pid, level and time", () => {
    const lines = parseIdeviceSyslog(
      [
        "[connected:00008120-000000000000001E]",
        "Oct 23 16:31:52.062552 audiomxd(CoreFoundation)[135] <Debug>: Bundle: <private>",
        "Oct 23 16:31:53.5 Demo[4412] <Error>: [javascript] TypeError: undefined is not a function",
        "    at render (index.bundle:1:2)",
        "Oct 23 16:31:54 ReportCrash[99] <Fault>: crash",
      ].join("\n"),
      now,
    );
    assert.deepEqual(lines.map((l) => [l.process, l.subsystem, l.pid, l.level]), [
      ["audiomxd", "CoreFoundation", 135, "D"],
      ["Demo", undefined, 4412, "E"],
      ["ReportCrash", undefined, 99, "F"],
    ]);
    assert.deepEqual(lines[0]!.at, new Date(2026, 9, 23, 16, 31, 52, 62));
    assert.equal(lines[1]!.message, "[javascript] TypeError: undefined is not a function\n    at render (index.bundle:1:2)");
  });

  it("puts a December line read in January in last year", () => {
    const [l] = parseIdeviceSyslog("Dec 31 23:59:59 SpringBoard[34] <Notice>: hi", new Date(2027, 0, 1, 0, 0, 5));
    assert.equal(l!.at.getFullYear(), 2026);
    const [today] = parseIdeviceSyslog("Jan 1 00:00:01 SpringBoard[34] <Notice>: hi", new Date(2027, 0, 1, 0, 0, 5));
    assert.equal(today!.at.getFullYear(), 2027);
  });
});

describe("crash markers", () => {
  const app = { process: "Demo", bundleId: "com.example.preview" };

  it("finds the app's own fatal exception and the crash reporter naming it", () => {
    const hits = crashMarkers(parseIdeviceSyslog(CRASH, now), app);
    assert.deepEqual(hits.map((l) => l.process), ["Demo", "ReportCrash"]);
  });

  it("does not read a terminate, or another process's crash, as the app crashing", () => {
    assert.deepEqual(crashMarkers(parseIdeviceSyslog(NORMAL, now), app), []);
  });
});

class FakeChild extends EventEmitter {
  pid = 777;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new PassThrough();
  kill(): boolean {
    this.exitCode = 0;
    this.emit("exit", 0, null);
    return true;
  }
}

describe("the syslog stream", () => {
  function stream(max?: number) {
    const spawned: { args: string[]; env?: NodeJS.ProcessEnv; child: FakeChild }[] = [];
    const impl = ((_cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      const child = new FakeChild();
      spawned.push({ args, env: opts.env, child });
      return child as unknown as ChildProcess;
    }) as unknown as typeof spawn;
    return { log: new IphoneSyslog({ udid: "U1", spawnImpl: impl, now: () => now, ...(max ? { maxLines: max } : {}) }), spawned };
  }

  it("streams idevicesyslog for one phone, marked, keeping lines split across reads", async () => {
    const { log, spawned } = stream();
    log.start();
    log.start();
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0]!.args, ["-u", "U1", "--no-colors", "-K"]);
    assert.equal(spawned[0]!.env?.[IPHONE_MARKER_ENV], "1");
    const out = spawned[0]!.child.stdout;
    out.write(CRASH.slice(0, 50));
    out.write(`${CRASH.slice(50)}\n`);
    await new Promise((r) => setImmediate(r));
    out.write("    stack line\n");
    await new Promise((r) => setImmediate(r));
    assert.equal(log.lines().length, 5);
    assert.equal(log.lines({ process: "Demo" }).length, 3);
    assert.equal(log.lines({ since: new Date(2026, 9, 23, 18, 2, 12, 500) }).length, 2);
    assert.match(log.lines().at(-1)!.message, /stack line$/);
  });

  it("holds a bounded number of lines, dropping the oldest", async () => {
    const { log, spawned } = stream(2);
    log.start();
    spawned[0]!.child.stdout.write(`${CRASH}\n`);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(log.lines().map((l) => l.process), ["ReportCrash", "runningboardd"]);
  });

  it("says when the stream ended by itself, and not when it was stopped", () => {
    const a = stream();
    a.log.start();
    a.spawned[0]!.child.kill();
    assert.match(a.log.ended ?? "", /exited/);
    const b = stream();
    b.log.start();
    b.log.stop();
    assert.equal(b.log.ended, undefined);
    assert.equal(b.log.running, false);
  });
});
