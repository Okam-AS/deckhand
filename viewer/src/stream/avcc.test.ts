import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AvccDemuxer,
  avcCodecString,
  AVCC_TAG_DESCRIPTION,
  AVCC_TAG_KEYFRAME,
  AVCC_TAG_DELTA,
  AVCC_TAG_SEED,
} from "./avcc.ts";

/** Frame a chunk in the serve-sim wire format: [len:u32-be][tag][payload]. */
function frame(tag: number, payload: number[]): Uint8Array {
  const len = payload.length + 1;
  const out = new Uint8Array(4 + len);
  out[0] = (len >>> 24) & 0xff;
  out[1] = (len >>> 16) & 0xff;
  out[2] = (len >>> 8) & 0xff;
  out[3] = len & 0xff;
  out[4] = tag;
  out.set(payload, 5);
  return out;
}

describe("AvccDemuxer", () => {
  it("parses each tag type in one push", () => {
    const bytes = new Uint8Array([
      ...frame(AVCC_TAG_DESCRIPTION, [1, 0x64, 0x00, 0x28]),
      ...frame(AVCC_TAG_KEYFRAME, [10, 11, 12]),
      ...frame(AVCC_TAG_DELTA, [20]),
      ...frame(AVCC_TAG_SEED, [0xff, 0xd8]),
    ]);
    const chunks = new AvccDemuxer().push(bytes);
    assert.deepEqual(
      chunks.map((c) => c.type),
      ["description", "keyframe", "delta", "seed"],
    );
    assert.deepEqual([...chunks[1]!.payload], [10, 11, 12]);
  });

  it("reassembles a frame split across many small reads (tunnel behavior)", () => {
    const whole = frame(AVCC_TAG_KEYFRAME, [1, 2, 3, 4, 5, 6, 7, 8]);
    const demux = new AvccDemuxer();
    const chunks = [];
    for (const b of whole) chunks.push(...demux.push(new Uint8Array([b])));
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.type, "keyframe");
    assert.deepEqual([...chunks[0]!.payload], [1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("buffers a partial chunk until complete", () => {
    const whole = frame(AVCC_TAG_DELTA, [9, 9, 9]);
    const demux = new AvccDemuxer();
    assert.equal(demux.push(whole.subarray(0, 5)).length, 0); // header + tag only
    const done = demux.push(whole.subarray(5));
    assert.equal(done.length, 1);
    assert.deepEqual([...done[0]!.payload], [9, 9, 9]);
  });
});

describe("avcCodecString", () => {
  it("derives the codec from avcC bytes 1-3", () => {
    assert.equal(avcCodecString(new Uint8Array([1, 0x64, 0x00, 0x28])), "avc1.640028");
    assert.equal(avcCodecString(new Uint8Array([1, 2])), "avc1.42E01E"); // too short → fallback
  });
});
