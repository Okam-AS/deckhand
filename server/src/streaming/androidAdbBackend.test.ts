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

/**
 * The boot-time sweep of on-device `screenrecord` orphans.
 *
 * Until this existed the ONLY device-side `pkill screenrecord` was in
 * `AvccSource.stop()` — our graceful teardown. A server killed with SIGKILL (or
 * one that crashed) left the recorder running inside the emulator, and the next
 * process swept only its own in-memory helper map, which is empty at boot. The
 * cost is not one dead device: the host H.264 encoder is single-instance across
 * emulators, so one orphan makes EVERY other emulator produce zero bytes with
 * no error, which androidH264.ts can only read as "this device cannot encode"
 * and answers by dropping the whole machine to the ~4 MB/s MJPEG fallback.
 */
function sweepHarness(opts: { serials: string[]; avds: Record<string, string>; busy?: string[]; psFails?: boolean }) {
  const calls: { serial: string; args: string[] }[] = [];
  const adb = async (serial: string, args: string[]) => {
    calls.push({ serial, args });
    if (args[0] === "emu") {
      const name = opts.avds[serial];
      return name ? { stdout: Buffer.from(`${name}\nOK\n`), code: 0 } : { stdout: Buffer.alloc(0), code: 1 };
    }
    if (args.includes("size")) return { stdout: Buffer.from("Physical size: 1080x2400"), code: 0 };
    return { stdout: Buffer.alloc(0), code: 0 };
  };
  const backend = new AndroidAdbBackend({
    portRange: [3400, 3410],
    adb,
    listSerials: async () => opts.serials,
    hostRecorderSerials: async () => {
      if (opts.psFails) throw new Error("ps unavailable");
      return new Set(opts.busy ?? []);
    },
  });
  const killed = () => calls.filter((c) => c.args[0] === "shell" && c.args[1] === "pkill").map((c) => c.serial);
  return { backend, calls, killed };
}

describe("AndroidAdbBackend.reapOrphans — recorders left inside the emulator", () => {
  it("kills a recorder nobody owns on a deckhand emulator", async () => {
    const h = sweepHarness({ serials: ["emulator-5554"], avds: { "emulator-5554": "deckhand_p1_1" } });
    await h.backend.reapOrphans();
    assert.deepEqual(h.killed(), ["emulator-5554"], "the orphaned recorder is swept");
    const kill = h.calls.find((c) => c.args[1] === "pkill")!;
    assert.deepEqual(
      kill.args,
      ["shell", "pkill", "-INT", "-f", "'screenrecord --output-format=h264'"],
      "matched on OUR recorder's argv — the only ownership evidence that crosses adb",
    );
  });

  it("kills a pooled emulator's recorder too — the pool outlives the preview, the recorder must not", async () => {
    const h = sweepHarness({ serials: ["emulator-5556"], avds: { "emulator-5556": "deckhand_pool_pixel_1" } });
    await h.backend.reapOrphans();
    assert.deepEqual(h.killed(), ["emulator-5556"]);
  });

  it("spares a device whose host-side `adb exec-out screenrecord` is still alive", async () => {
    // `deckhand doctor --device-only` calls reapOrphans() from a SECOND process
    // while the server may be streaming: empty helper map, empty keep-set. The
    // host-side owner is the only signal that survives that boundary, and
    // without it the doctor kills the live server's video.
    const h = sweepHarness({
      serials: ["emulator-5554", "emulator-5556"],
      avds: { "emulator-5554": "deckhand_p1_1", "emulator-5556": "deckhand_p2_1" },
      busy: ["emulator-5554"],
    });
    await h.backend.reapOrphans();
    assert.deepEqual(h.killed(), ["emulator-5556"], "the owned recorder survives; the orphan does not");
  });

  it("spares a live preview's device, whether keep names the AVD or the serial", async () => {
    // The boot sweep runs AFTER the port is bound, so a start_preview can be
    // mid-attach. `keep` carries both the AVD name and the serial, and EITHER
    // must spare the device: an emulator that is still booting is in `keep` by
    // name only, since `record.serial` is not set until it answers adb.
    const byAvd = sweepHarness({ serials: ["emulator-5554"], avds: { "emulator-5554": "deckhand_p1_1" } });
    await byAvd.backend.reapOrphans(new Set(["deckhand_p1_1"]));
    assert.deepEqual(byAvd.killed(), [], "an AVD a live preview holds is not swept");

    const bySerial = sweepHarness({ serials: ["emulator-5554"], avds: { "emulator-5554": "deckhand_p1_1" } });
    await bySerial.backend.reapOrphans(new Set(["emulator-5554"]));
    assert.deepEqual(bySerial.killed(), [], "a serial a live preview holds is not swept");
  });

  it("leaves a developer's own emulator alone, and one that will not name its AVD", async () => {
    const h = sweepHarness({
      serials: ["emulator-5554", "emulator-5556"],
      avds: { "emulator-5554": "Pixel_7_API_34" }, // 5556 answers nothing at all
    });
    await h.backend.reapOrphans();
    assert.deepEqual(h.killed(), [], "not deckhand's device, and an unnamed one is not provably deckhand's either");
  });

  it("never touches a physical device", async () => {
    // Physical hardware is BORROWED (devices/physical.ts): deckhand does not
    // stream it, so a screenrecord there is always somebody else's capture.
    const h = sweepHarness({ serials: ["R5CT30ABCDE"], avds: {} });
    await h.backend.reapOrphans();
    assert.deepEqual(h.killed(), []);
    assert.deepEqual(h.calls, [], "a physical serial is not even probed");
  });

  it("kills nothing when it cannot read who owns what", async () => {
    const h = sweepHarness({ serials: ["emulator-5554"], avds: { "emulator-5554": "deckhand_p1_1" }, psFails: true });
    await h.backend.reapOrphans();
    assert.deepEqual(h.killed(), [], "an unreadable owner list means unknown, not unowned");
  });

  it("spares a device attached AFTER the keep-set was taken", async () => {
    // What `sweepDeviceRecorders`'s helper-map check is for, and the only
    // situation in which it decides anything.
    //
    // `keep` is a snapshot the engine takes before it calls (preview.ts
    // `liveDeviceHandles`), and `reapOrphans` prunes `this.helpers` down to
    // that snapshot before the sweep runs — so for every serial the prune
    // leaves behind, `keep.has(serial)` on the next line is already true. A
    // `start_preview` that attaches DURING the sweep is in neither: not in the
    // snapshot, not in the pruned map. The helper map is read after an await,
    // which is what lets it see that attach at all.
    //
    // This is why the earlier version of this test proved nothing: it attached
    // a helper AND passed `keep = {deckhand_p1_1}` while the fake console
    // answered with that same AVD name, so the sweep spared the device on the
    // `keep.has(avd)` branch and the helper check was never reached.
    const { adb } = fakeAdb();
    const seen: string[] = [];
    let attaching: Promise<unknown> | null = null;
    const b: AndroidAdbBackend = new AndroidAdbBackend({
      portRange: [3420, 3430],
      adb: async (serial, args, o) => {
        if (args[0] === "shell" && args[1] === "pkill") seen.push(serial);
        if (args[0] === "emu") return { stdout: Buffer.from("deckhand_p1_1\nOK\n"), code: 0 };
        return adb(serial, args, o);
      },
      // The attach lands mid-sweep: after reapOrphans has pruned the helper
      // map, before sweepDeviceRecorders reads it.
      listSerials: async () => {
        attaching ??= b.attach(device);
        await attaching;
        return ["emulator-5554"];
      },
      hostRecorderSerials: async () => new Set<string>(),
    });
    try {
      await b.reapOrphans();
      assert.deepEqual(seen, [], "a helper we hold is live work, not an orphan");
    } finally {
      await b.detach(device.serial).catch(() => {});
    }
  });

  it("spares a device attached after it was already a candidate", async () => {
    // The other half of the same window, and the one the candidate list cannot close.
    // Ownership is decided per device as the list is built, then `hostRecorderSerials`
    // is read and the loop awaits one 5s-timeout pkill per candidate — so an attach can
    // land after a serial has been judged an orphan and before its kill goes out, up to
    // N × 5s later. The `busy` snapshot is taken once and cannot see it; the helper map
    // can, which is exactly what the method's docblock says the map is for. Re-checking
    // it in the loop is what makes that true for a device already on the list.
    const { adb } = fakeAdb();
    const seen: string[] = [];
    let attaching: Promise<unknown> | null = null;
    const b: AndroidAdbBackend = new AndroidAdbBackend({
      portRange: [3440, 3450],
      adb: async (serial, args, o) => {
        if (args[0] === "shell" && args[1] === "pkill") seen.push(serial);
        if (args[0] === "emu") return { stdout: Buffer.from("deckhand_p1_1\nOK\n"), code: 0 };
        return adb(serial, args, o);
      },
      listSerials: async () => ["emulator-5554"],
      // Read AFTER the candidate list is built: emulator-5554 is already condemned by
      // the time this attach lands.
      hostRecorderSerials: async () => {
        attaching ??= b.attach(device);
        await attaching;
        return new Set<string>();
      },
    });
    try {
      await b.reapOrphans();
      assert.deepEqual(seen, [], "a candidate we started streaming is no longer an orphan");
    } finally {
      await b.detach(device.serial).catch(() => {});
    }
  });
});
