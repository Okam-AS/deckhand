import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { AvccSource } from "./androidH264.ts";
import { AVCC_TAG_DELTA, AVCC_TAG_DESCRIPTION, AVCC_TAG_KEYFRAME } from "./h264.ts";

const hdr = (t: number) => 0x60 | t;
const nal = (t: number, ...body: number[]) => Buffer.from([hdr(t), ...body]);
const SPS = nal(7, 0x64, 0x00, 0x28, 0xac);
const PPS = nal(8, 0xea, 0x8f);
const IDR = nal(5, 0x88, 0x84);
const SLICE = nal(1, 0x9a, 0x11);
const SC = Buffer.from([0, 0, 0, 1]);
const annexb = (...nals: Buffer[]) => Buffer.concat(nals.flatMap((n) => [SC, n]));

/** A stand-in for the `adb exec-out screenrecord` child process. */
class FakeRecorder extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit("close", 0));
    return true;
  }
}

function harness() {
  const spawned: FakeRecorder[] = [];
  const source = new AvccSource("emulator-5554", () => {
    const rec = new FakeRecorder();
    spawned.push(rec);
    return rec as unknown as ChildProcessWithoutNullStreams;
  });
  return { source, spawned, latest: () => spawned[spawned.length - 1]! };
}

/** Split a concatenation of framed chunks back into [tag, payloadLength] pairs. */
function tags(chunks: Buffer[]): number[] {
  const all = Buffer.concat(chunks);
  const out: number[] = [];
  let o = 0;
  while (o + 4 <= all.length) {
    const len = all.readUInt32BE(o);
    out.push(all[o + 4]!);
    o += 4 + len;
  }
  return out;
}

const collector = () => {
  const chunks: Buffer[] = [];
  let closed = false;
  return {
    chunks,
    isClosed: () => closed,
    sub: {
      write: (c: Buffer) => {
        chunks.push(c);
        return true;
      },
      close: () => {
        closed = true;
      },
    },
  };
};

const tick = () => new Promise((r) => setTimeout(r, 0));
/** Past IDLE_FLUSH_MS, so the trailing access unit has been shipped. */
const settle = () => new Promise((r) => setTimeout(r, 180));

test("ready() resolves true once the device emits parameter sets", async () => {
  const { source, latest } = harness();
  const ready = source.ready();
  await tick();
  latest().stdout.write(annexb(SPS, PPS, IDR));
  assert.equal(await ready, true);
  source.dispose();
});

test("ready() resolves false when the recorder dies without producing video", async () => {
  const { source, latest } = harness();
  const ready = source.ready();
  await tick();
  // What the API 29 emulator does: "Encoder failed (err=-38)" then exit.
  latest().stderr.write("Encoder failed (err=-38)\n");
  latest().emit("close", 1);
  assert.equal(await ready, false);
  source.dispose();
});

test("an encoder-less device is not respawned in a loop", async () => {
  const { source, spawned, latest } = harness();
  const c = collector();
  source.subscribe(c.sub);
  const ready = source.ready();
  await tick();
  latest().emit("close", 1);
  await ready;
  await tick();
  assert.equal(spawned.length, 1);
  assert.equal(c.isClosed(), true, "subscribers are released rather than left hanging");
  source.dispose();
});

test("subscribers receive description, keyframe then deltas in order", async () => {
  const { source, latest } = harness();
  const c = collector();
  source.subscribe(c.sub);
  await tick();
  latest().stdout.write(annexb(SPS, PPS, IDR, SLICE, SLICE));
  await settle();
  assert.deepEqual(tags(c.chunks).slice(0, 3), [AVCC_TAG_DESCRIPTION, AVCC_TAG_KEYFRAME, AVCC_TAG_DELTA]);
  source.dispose();
});

test("a late joiner is caught up with the description and the whole current GOP", async () => {
  const { source, latest } = harness();
  const first = collector();
  source.subscribe(first.sub);
  await tick();
  latest().stdout.write(annexb(SPS, PPS, IDR, SLICE, SLICE, SLICE));
  await settle();

  const late = collector();
  source.subscribe(late.sub);
  // Description + keyframe + the three deltas that followed it: enough to
  // decode to the live frame without waiting for the next IDR.
  assert.deepEqual(tags(late.chunks), [
    AVCC_TAG_DESCRIPTION,
    AVCC_TAG_KEYFRAME,
    AVCC_TAG_DELTA,
    AVCC_TAG_DELTA,
    AVCC_TAG_DELTA,
  ]);
  source.dispose();
});

test("a new keyframe resets the replay buffer so it cannot grow forever", async () => {
  const { source, latest } = harness();
  const c = collector();
  source.subscribe(c.sub);
  await tick();
  latest().stdout.write(annexb(SPS, PPS, IDR, SLICE, SLICE));
  await tick();
  latest().stdout.write(annexb(IDR, SLICE));
  await settle();

  const late = collector();
  source.subscribe(late.sub);
  assert.deepEqual(tags(late.chunks), [AVCC_TAG_DESCRIPTION, AVCC_TAG_KEYFRAME, AVCC_TAG_DELTA]);
  source.dispose();
});

test("one recorder serves every viewer", async () => {
  const { source, spawned, latest } = harness();
  const a = collector();
  const b = collector();
  source.subscribe(a.sub);
  source.subscribe(b.sub);
  await tick();
  latest().stdout.write(annexb(SPS, PPS, IDR));
  await tick();
  assert.equal(spawned.length, 1);
  assert.deepEqual(tags(a.chunks), tags(b.chunks));
  source.dispose();
});

test("a backed-up subscriber is dropped and closed, not buffered", async () => {
  const { source, latest } = harness();
  const good = collector();
  let slowClosed = false;
  const slowChunks: Buffer[] = [];
  source.subscribe(good.sub);
  source.subscribe({
    write: (c) => {
      slowChunks.push(c);
      return false; // "I am full"
    },
    close: () => {
      slowClosed = true;
    },
  });
  await tick();
  latest().stdout.write(annexb(SPS, PPS, IDR, SLICE, SLICE));
  await settle();

  assert.equal(slowClosed, true);
  assert.equal(slowChunks.length, 1, "dropped on its first refusal");
  assert.ok(tags(good.chunks).length >= 3, "the healthy viewer keeps streaming");
  source.dispose();
});

test("the recorder lingers briefly after the last viewer leaves", async () => {
  const { source, latest } = harness();
  const c = collector();
  const off = source.subscribe(c.sub);
  await tick();
  const rec = latest();
  off();
  // Killing here would race the device-side pkill against the reconnect that
  // the viewer is about to make, which is what produced intermittent 502s.
  assert.equal(rec.killed, false, "still recording during the linger window");
  source.dispose();
});

test("a reconnect inside the linger window reuses the same recorder", async () => {
  const { source, spawned, latest } = harness();
  const first = collector();
  const off = source.subscribe(first.sub);
  await tick();
  latest().stdout.write(annexb(SPS, PPS, IDR));
  await settle();
  off();

  const again = collector();
  source.subscribe(again.sub);
  await tick();
  assert.equal(spawned.length, 1, "no teardown/respawn cycle");
  assert.equal(latest().killed, false);
  // And it is caught up immediately from the replay buffer.
  assert.deepEqual(tags(again.chunks), [AVCC_TAG_DESCRIPTION, AVCC_TAG_KEYFRAME]);
  source.dispose();
});

test("the recorder is stopped once the linger window expires unattended", async () => {
  const { source, latest } = harness();
  const c = collector();
  const off = source.subscribe(c.sub);
  await tick();
  const rec = latest();
  off();
  await new Promise((r) => setTimeout(r, 3200));
  assert.equal(rec.killed, true);
  source.dispose();
});

test("a device that has streamed before is restarted, not declared encoder-less", async () => {
  const { source, spawned, latest } = harness();
  const c = collector();
  source.subscribe(c.sub);
  const ready = source.ready();
  await tick();
  latest().stdout.write(annexb(SPS, PPS, IDR));
  await settle();
  assert.equal(await ready, true);

  // adb link drops and the segment dies instantly — previously this looked
  // identical to "no encoder" and closed every viewer.
  latest().emit("close", 1);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(c.isClosed(), false, "viewer is kept");
  assert.equal(spawned.length, 2, "a new segment is started");
  source.dispose();
});

test("a segment ending normally is restarted for viewers still attached", async () => {
  const { source, spawned, latest } = harness();
  const c = collector();
  source.subscribe(c.sub);
  await tick();
  latest().stdout.write(annexb(SPS, PPS, IDR, SLICE));
  await tick();
  // Rotation or the time limit ends the segment while a viewer is watching.
  latest().emit("close", 0);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(spawned.length, 2, "a fresh segment is opened");

  // The new segment re-sends its parameter sets so decoders reconfigure.
  latest().stdout.write(annexb(SPS, PPS, IDR));
  await tick();
  const seen = tags(c.chunks);
  assert.equal(seen.filter((t) => t === AVCC_TAG_DESCRIPTION).length, 2);
  source.dispose();
});

test("dispose closes subscribers and kills the recorder", async () => {
  const { source, latest } = harness();
  const c = collector();
  source.subscribe(c.sub);
  await tick();
  const rec = latest();
  source.dispose();
  assert.equal(c.isClosed(), true);
  assert.equal(rec.killed, true);
});

test("a joiner facing an oversized replay gets a fresh segment instead of the backlog", async () => {
  const { source, spawned, latest } = harness();
  const first = collector();
  source.subscribe(first.sub);
  await tick();
  latest().stdout.write(annexb(SPS, PPS, IDR));
  // Push the GOP past MAX_REPLAY_BYTES (768 KB) with bulky deltas.
  const fat = Buffer.concat([Buffer.from([hdr(1)]), Buffer.alloc(200_000, 0x11)]);
  for (let i = 0; i < 5; i++) latest().stdout.write(annexb(fat));
  await settle();

  const late = collector();
  source.subscribe(late.sub);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(late.chunks.length, 0, "no megabyte replay pushed at the newcomer");
  assert.equal(spawned.length, 2, "the segment was bounced for a fresh keyframe");
  source.dispose();
});

test("a spawn failure does not pin the device to MJPEG for the rest of the process", async () => {
  // ready() cached its promise unconditionally, so ANY false became the
  // permanent answer for that device — including one caused by a momentary adb
  // failure or a readiness timer that fired while the emulator was still coming
  // up. The device then served the ~4 MB/s MJPEG fallback until the server was
  // restarted, with nothing reporting why.
  let failNext = true;
  const spawned: FakeRecorder[] = [];
  // retryAfterMs: 0 — this test is about the failure not being PERMANENT, not
  // about how long the backoff lasts.
  const source = new AvccSource(
    "emulator-5554",
    () => {
      if (failNext) throw new Error("adb: device offline");
      const rec = new FakeRecorder();
      spawned.push(rec);
      return rec as unknown as ChildProcessWithoutNullStreams;
    },
    0,
  );

  assert.equal(await source.ready(), false, "the failing attempt reports false");

  // The circumstance passes. The next probe must actually re-probe.
  failNext = false;
  const second = source.ready();
  spawned[spawned.length - 1]!.stdout.write(annexb(SPS, PPS, IDR));
  assert.equal(await second, true, "a transient failure must not be remembered as a capability");
});

test("a dead-looking encoder is backed off, not written off", async () => {
  // "Started, produced nothing, died at once" reads as a broken encoder — and is
  // ALSO exactly what contention looks like. The host's H.264 encoder is
  // effectively single-instance across emulators: whichever one holds
  // `screenrecord` wins and every other device silently produces zero bytes,
  // with no error. Verified on the machine: an emulator yielding 0 bytes
  // produced 207KB the moment the other recorder stopped. Caching that as a
  // verdict pinned a capable device to the ~4 MB/s MJPEG path for good.
  const { source, spawned, latest } = harness();
  const c = collector();
  source.subscribe(c.sub);
  const first = source.ready();
  await tick();
  latest().stderr.write("Encoder failed (err=-38)\n");
  latest().emit("close", 1);
  assert.equal(await first, false);

  const before = spawned.length;
  assert.equal(await source.ready(), false, "a retry inside the backoff window reuses the answer");
  assert.equal(spawned.length, before, "…without respawning, so a polling viewer cannot spin");
  source.dispose();
});

test("a probe nobody subscribed to releases the recorder", async () => {
  // ready() starts a recorder, but only unsubscribe() ever scheduled the stop —
  // so a readiness probe no viewer followed up on held the host's single H.264
  // encoder indefinitely, which is what pushed the OTHER emulator onto MJPEG.
  const { source, spawned, latest } = harness();
  const ready = source.ready();
  await tick();
  latest().stdout.write(annexb(SPS, PPS, IDR));
  assert.equal(await ready, true);

  assert.equal(spawned[0]!.killed, false, "still recording during the linger window");
  await new Promise((r) => setTimeout(r, 3_100));
  assert.equal(spawned[0]!.killed, true, "and released once nobody arrived");
  source.dispose();
});
