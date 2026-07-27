import { test } from "node:test";
import assert from "node:assert/strict";
import { AnnexBToAvcc, buildAvcC, frameChunk, toAvccAccessUnit } from "./h264.ts";

const SC4 = Buffer.from([0, 0, 0, 1]);
const SC3 = Buffer.from([0, 0, 1]);
/** NAL header byte for a given type (nal_ref_idc=3). */
const hdr = (t: number) => 0x60 | t;
const nal = (t: number, ...body: number[]) => Buffer.from([hdr(t), ...body]);

const SPS = nal(7, 0x64, 0x00, 0x28, 0xac, 0xd9);
const PPS = nal(8, 0xea, 0x8f, 0x2c);
const IDR = nal(5, 0x88, 0x84, 0x00);
const SLICE = nal(1, 0x9a, 0x11);

const annexb = (...nals: Buffer[]) => Buffer.concat(nals.flatMap((n) => [SC4, n]));

test("buildAvcC lifts profile/compat/level from the SPS", () => {
  const c = buildAvcC(SPS, PPS);
  assert.equal(c[0], 1);
  assert.equal(c[1], 0x64); // profile
  assert.equal(c[2], 0x00); // compatibility
  assert.equal(c[3], 0x28); // level
  assert.equal(c[4], 0xff); // 4-byte NAL lengths
  assert.equal(c[5], 0xe1); // one SPS
  assert.equal(c.readUInt16BE(6), SPS.length);
  assert.deepEqual(c.subarray(8, 8 + SPS.length), SPS);
  const o = 8 + SPS.length;
  assert.equal(c[o], 1); // one PPS
  assert.equal(c.readUInt16BE(o + 1), PPS.length);
  assert.deepEqual(c.subarray(o + 3), PPS);
});

test("toAvccAccessUnit length-prefixes each NAL", () => {
  const au = toAvccAccessUnit([IDR, SLICE]);
  assert.equal(au.readUInt32BE(0), IDR.length);
  assert.deepEqual(au.subarray(4, 4 + IDR.length), IDR);
  const o = 4 + IDR.length;
  assert.equal(au.readUInt32BE(o), SLICE.length);
  assert.deepEqual(au.subarray(o + 4), SLICE);
});

test("frameChunk writes [len][tag][payload] with len covering the tag", () => {
  const c = frameChunk(0x02, Buffer.from([1, 2, 3]));
  assert.equal(c.readUInt32BE(0), 4);
  assert.equal(c[4], 0x02);
  assert.deepEqual(c.subarray(5), Buffer.from([1, 2, 3]));
});

test("emits description once SPS+PPS seen, then keyframe and delta", () => {
  const p = new AnnexBToAvcc();
  const events = [...p.push(annexb(SPS, PPS, IDR, SLICE)), ...p.flush()];
  assert.deepEqual(
    events.map((e) => e.type),
    ["description", "keyframe", "delta"],
  );
  assert.deepEqual(events[0]!.payload, buildAvcC(SPS, PPS));
  assert.deepEqual(events[1]!.payload, toAvccAccessUnit([IDR]));
  assert.deepEqual(events[2]!.payload, toAvccAccessUnit([SLICE]));
});

test("SPS/PPS are consumed into the description, never forwarded inline", () => {
  const p = new AnnexBToAvcc();
  const events = [...p.push(annexb(SPS, PPS, IDR)), ...p.flush()];
  const key = events.find((e) => e.type === "keyframe")!;
  assert.deepEqual(key.payload, toAvccAccessUnit([IDR]));
});

test("access units before the description are dropped, not mis-tagged", () => {
  const p = new AnnexBToAvcc();
  // IDR arriving before any parameter set is undecodable.
  const events = [...p.push(annexb(IDR, SPS, PPS, IDR)), ...p.flush()];
  assert.deepEqual(
    events.map((e) => e.type),
    ["description", "keyframe"],
  );
});

test("a repeated identical SPS/PPS does not re-emit the description", () => {
  const p = new AnnexBToAvcc();
  const first = p.push(annexb(SPS, PPS, IDR));
  const second = p.push(annexb(SPS, PPS, SLICE));
  assert.equal(first.filter((e) => e.type === "description").length, 1);
  assert.equal(second.filter((e) => e.type === "description").length, 0);
});

test("a changed SPS re-emits the description", () => {
  const p = new AnnexBToAvcc();
  p.push(annexb(SPS, PPS, IDR));
  const SPS2 = nal(7, 0x64, 0x00, 0x1f, 0xac, 0xd9);
  const out = p.push(annexb(SPS2, PPS, IDR));
  assert.equal(out.filter((e) => e.type === "description").length, 1);
  assert.equal(out.find((e) => e.type === "description")!.payload[3], 0x1f);
});

test("3-byte and 4-byte start codes both split correctly", () => {
  const p = new AnnexBToAvcc();
  const stream = Buffer.concat([SC4, SPS, SC3, PPS, SC3, IDR, SC4, SLICE]);
  const events = [...p.push(stream), ...p.flush()];
  assert.deepEqual(
    events.map((e) => e.type),
    ["description", "keyframe", "delta"],
  );
});

test("byte-at-a-time delivery produces identical events to one big push", () => {
  const stream = annexb(SPS, PPS, IDR, SLICE, SLICE);
  const whole = new AnnexBToAvcc();
  const expected = [...whole.push(stream), ...whole.flush()];

  const drip = new AnnexBToAvcc();
  const got = [];
  for (const byte of stream) got.push(...drip.push(Buffer.from([byte])));
  got.push(...drip.flush());

  assert.deepEqual(
    got.map((e) => e.type),
    expected.map((e) => e.type),
  );
  for (let i = 0; i < expected.length; i++) assert.deepEqual(got[i]!.payload, expected[i]!.payload);
});

test("split exactly inside a start code still finds the boundary", () => {
  const stream = annexb(SPS, PPS, IDR, SLICE);
  for (let cut = 1; cut < stream.length; cut++) {
    const p = new AnnexBToAvcc();
    const events = [...p.push(stream.subarray(0, cut)), ...p.push(stream.subarray(cut)), ...p.flush()];
    assert.deepEqual(
      events.map((e) => e.type),
      ["description", "keyframe", "delta"],
      `cut at ${cut}`,
    );
  }
});

test("a NAL payload containing 00 00 01 is not split (emulation prevention holds)", () => {
  // Real encoders escape this as 00 00 03 01; assert we pass such bytes through.
  const escaped = nal(1, 0x00, 0x00, 0x03, 0x01, 0xff);
  const p = new AnnexBToAvcc();
  const events = [...p.push(annexb(SPS, PPS, IDR, escaped)), ...p.flush()];
  const delta = events.filter((e) => e.type === "delta");
  assert.equal(delta.length, 1);
  assert.deepEqual(delta[0]!.payload, toAvccAccessUnit([escaped]));
});

test("reset clears parameter sets so a new segment re-sends its description", () => {
  const p = new AnnexBToAvcc();
  p.push(annexb(SPS, PPS, IDR));
  p.reset();
  const out = p.push(annexb(SPS, PPS, IDR));
  assert.equal(out.filter((e) => e.type === "description").length, 1);
});

test("non-VCL NALs ride along in the access unit, AUD is dropped", () => {
  const SEI = nal(6, 0x01, 0x02);
  const AUD = nal(9, 0xf0);
  const p = new AnnexBToAvcc();
  const events = [...p.push(annexb(SPS, PPS, AUD, SEI, IDR)), ...p.flush()];
  const key = events.find((e) => e.type === "keyframe")!;
  assert.deepEqual(key.payload, toAvccAccessUnit([SEI, IDR]));
});
