import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AndroidAdbBackend } from "./androidAdb.ts";

/**
 * The `AndroidAdbBackend` class — the 280 lines of `androidAdb.ts` that were
 * never covered.
 *
 * `androidAdb.test.ts` next door tests only the pure helpers at the top of the
 * file. The class beneath them spawns a per-device HTTP server, holds a port
 * from a range, drives adb, and must detach cleanly or leak — and TWO bugs
 * escaped through it in one session:
 *
 *   - readiness was one `screencap` with a 5s timeout, which a cold emulator
 *     under load routinely exceeds, so a healthy device was declared dead and
 *     the engine's retry faithfully repeated the same too-short wait;
 *   - `AvccSource.ready()` cached any failure permanently, pinning a capable
 *     device to the ~4 MB/s MJPEG fallback.
 *
 * Both were found by hand on real hardware. Neither could have been caught,
 * because there was no harness — and the file's own header said so: "the
 * per-device HTTP/WS server and adb calls are validated on-device."
 *
 * Nothing here needs a new dependency. `AndroidAdbOptions.adb` is already
 * injectable, and that is the whole seam.
 */

/** An adb that answers `wm size` and hands each `screencap` from a queue. */
function fakeAdb(opts: { frames?: (Buffer | null)[]; slowMs?: number } = {}) {
  const calls: string[][] = [];
  const frames = opts.frames ?? [];
  const adb = async (serial: string, args: string[], o: { timeoutMs?: number } = {}) => {
    calls.push(args);
    if (args.includes("size")) return { stdout: Buffer.from("Physical size: 1080x2400"), code: 0 };
    if (args.includes("screencap")) {
      // A capture slower than the caller's per-attempt timeout fails, exactly as
      // a real cold emulator does — this is the shape of the bug that shipped.
      if (opts.slowMs && (o.timeoutMs ?? 0) < opts.slowMs) return { stdout: Buffer.alloc(0), code: 1 };
      const next = frames.length ? frames.shift() : Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      return next ? { stdout: next, code: 0 } : { stdout: Buffer.alloc(0), code: 1 };
    }
    return { stdout: Buffer.alloc(0), code: 0 };
  };
  return { adb, calls };
}

const device = { platform: "android" as const, udid: "emulator-5554", serial: "emulator-5554" };

/**
 * Attach, run the body, and ALWAYS detach.
 *
 * `attach()` starts a real HTTP server, so a failing assertion that skips
 * `detach()` leaves it listening and `node --test` never exits — a genuine
 * regression would hang CI instead of reporting. Found the first time these
 * tests were mutation-checked, which is the point of mutation-checking them.
 */
async function withStream(
  b: AndroidAdbBackend,
  body: (s: Awaited<ReturnType<AndroidAdbBackend["attach"]>>) => Promise<void> | void,
): Promise<void> {
  const s = await b.attach(device);
  try {
    await body(s);
  } finally {
    await s.detach().catch(() => {});
  }
}

describe("AndroidAdbBackend.attach", () => {
  it("rejects a device that is not an android serial", async () => {
    const b = new AndroidAdbBackend({ portRange: [3300, 3310], adb: fakeAdb().adb });
    await assert.rejects(() => b.attach({ platform: "ios", udid: "UDID" }), /requires an android device/);
  });

  it("is idempotent per device — a second attach reuses the helper, not a second port", async () => {
    // The engine calls attach() on every retry. A second helper per attempt
    // would hold a second port from a 10-wide range and a second screencap loop
    // against the same device.
    const { adb } = fakeAdb();
    const b = new AndroidAdbBackend({ portRange: [3300, 3310], adb });
    await withStream(b, async (first) => {
      const second = await b.attach(device);
      assert.equal(first.origin, second.origin, "the same helper answers both attaches");
    });
  });

  it("serves the device under its own base path", async () => {
    const { adb } = fakeAdb();
    const b = new AndroidAdbBackend({ portRange: [3300, 3310], adb });
    await withStream(b, (s) => {
      assert.match(s.helperBasePath, /emulator-5554/, "the path names the device it streams");
      assert.match(s.origin, /^http:\/\/127\.0\.0\.1:\d+$/, "helpers bind loopback only — PLAN §11.1");
    });
  });

  it("frees the port on detach, so a device can be re-attached", async () => {
    const { adb } = fakeAdb();
    const b = new AndroidAdbBackend({ portRange: [3300, 3302], adb }); // deliberately tiny
    // Four attaches through a two-port range only works if detach actually
    // releases. A leak here exhausts the range and every later preview fails
    // with a port error that reads like someone else's fault.
    for (let i = 0; i < 4; i++) await withStream(b, (s) => assert.ok(s.origin));
  });
});

describe("AndroidAdbBackend.waitForFirstFrame", () => {
  it("keeps asking a slow device until the deadline instead of failing on one attempt", async () => {
    // The shipped bug: ONE screencap with a 5s timeout. `screencap` renders the
    // whole framebuffer to PNG, and a freshly booted emulator under load
    // routinely takes longer — so a healthy device was reported as "produced no
    // first frame", and the engine's three retries repeated the same too-short
    // wait. Verified by hand at the time: the same command returned 70KB.
    const { adb, calls } = fakeAdb({ frames: [null, null, Buffer.from([0x89, 0x50, 0x4e, 0x47])] });
    const b = new AndroidAdbBackend({ portRange: [3300, 3310], adb });
    await withStream(b, async (s) => {
      assert.equal(await s.waitForFirstFrame(5_000), true, "a device that answers on the third try is not dead");
      assert.ok(calls.filter((c) => c.includes("screencap")).length >= 3, "it polled rather than taking a single shot");
    });
  });

  it("gives up at the deadline rather than hanging", async () => {
    const { adb } = fakeAdb({ frames: Array(50).fill(null) });
    const b = new AndroidAdbBackend({ portRange: [3300, 3310], adb });
    await withStream(b, async (s) => assert.equal(await s.waitForFirstFrame(600), false));
  });

  it("allows a single capture longer than five seconds", async () => {
    // The per-attempt timeout was raised alongside the deadline: a
    // slow-but-succeeding capture should finish, not be cut off and retried.
    const { adb } = fakeAdb({ slowMs: 6_000 });
    const b = new AndroidAdbBackend({ portRange: [3300, 3310], adb });
    await withStream(b, async (s) =>
      assert.equal(await s.waitForFirstFrame(3_000), true, "a 6s capture must be given time, not declared a failure"),
    );
  });
});

describe("AndroidAdbBackend.attach — a port it cannot bind", () => {
  it("fails the device instead of hanging forever", async () => {
    // Without an 'error' listener the http.Server throws on EADDRINUSE, the promise never
    // settles, and attach() never returns. The engine awaits it, so the preview sits in
    // "starting the stream" with no error and no timeout — and cli.ts's crash guard keeps the
    // process alive on purpose, so nothing else surfaces it either. A hang is the one failure
    // nobody can debug from the outside.
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(3320, "127.0.0.1", r));
    try {
      const b = new AndroidAdbBackend({ portRange: [3320, 3320], adb: fakeAdb().adb }); // the only port is taken
      await assert.rejects(() => b.attach(device), /could not bind 127\.0\.0\.1:3320/);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });
});
