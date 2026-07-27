/**
 * AVCC (H.264) wire parser for serve-sim's `/stream.avcc` endpoint.
 *
 * Vendored and lightly adapted from serve-sim (Apache-2.0, © Evan Bacon):
 * https://github.com/EvanBacon/serve-sim  (packages/serve-sim/src/client/avcc-codec.ts)
 *
 * Each chunk is a 4-byte big-endian length (covering tag + payload) then a
 * one-byte tag and the payload: `[len:u32-be][tag:u8][payload…]`, len =
 * payload.length + 1. Tags: 0x01 description (avcC), 0x02 keyframe (IDR),
 * 0x03 delta (P-frame), 0x04 seed (JPEG painted before the first IDR).
 */

export const AVCC_TAG_DESCRIPTION = 0x01;
export const AVCC_TAG_KEYFRAME = 0x02;
export const AVCC_TAG_DELTA = 0x03;
export const AVCC_TAG_SEED = 0x04;

export type AvccChunkType = "description" | "keyframe" | "delta" | "seed";

export interface AvccChunk {
  type: AvccChunkType;
  payload: Uint8Array;
}

const TAG_TO_TYPE: Record<number, AvccChunkType | undefined> = {
  [AVCC_TAG_DESCRIPTION]: "description",
  [AVCC_TAG_KEYFRAME]: "keyframe",
  [AVCC_TAG_DELTA]: "delta",
  [AVCC_TAG_SEED]: "seed",
};

/**
 * Stateful demuxer: feed each `Uint8Array` from the reader; returns the chunks
 * now fully buffered, retaining any trailing partial bytes. Uses an amortised
 * append buffer + in-place compaction — a tunnel splits each frame into many
 * small reads, and a rebuild-per-chunk approach is O(bytes²) and freezes the tab.
 */
export class AvccDemuxer {
  private buffer = new Uint8Array(64 * 1024);
  private len = 0;
  private start = 0;

  private append(bytes: Uint8Array): void {
    if (this.len + bytes.length > this.buffer.length) {
      if (this.start > 0) {
        this.buffer.copyWithin(0, this.start, this.len);
        this.len -= this.start;
        this.start = 0;
      }
      if (this.len + bytes.length > this.buffer.length) {
        let cap = this.buffer.length;
        while (cap < this.len + bytes.length) cap *= 2;
        const grown = new Uint8Array(cap);
        grown.set(this.buffer.subarray(0, this.len));
        this.buffer = grown;
      }
    }
    this.buffer.set(bytes, this.len);
    this.len += bytes.length;
  }

  push(bytes: Uint8Array): AvccChunk[] {
    if (bytes.length > 0) this.append(bytes);
    const chunks: AvccChunk[] = [];
    const buf = this.buffer;
    while (this.len - this.start >= 4) {
      const o = this.start;
      const length = ((buf[o]! << 24) | (buf[o + 1]! << 16) | (buf[o + 2]! << 8) | buf[o + 3]!) >>> 0;
      if (this.len - o - 4 < length) break;
      if (length < 1) {
        this.start += 4;
        continue;
      }
      const tag = buf[o + 4]!;
      const type = TAG_TO_TYPE[tag];
      if (type) chunks.push({ type, payload: buf.slice(o + 5, o + 4 + length) });
      this.start += 4 + length;
    }
    if (this.start > 0) {
      if (this.start < this.len) this.buffer.copyWithin(0, this.start, this.len);
      this.len -= this.start;
      this.start = 0;
    }
    return chunks;
  }

  reset(): void {
    this.len = 0;
    this.start = 0;
  }
}

/** WebCodecs codec string from an avcC blob, e.g. `avc1.640028`. */
export function avcCodecString(description: Uint8Array): string {
  if (description.length < 4) return "avc1.42E01E";
  const hex2 = (b: number) => b.toString(16).padStart(2, "0");
  return "avc1." + hex2(description[1]!) + hex2(description[2]!) + hex2(description[3]!);
}

/** True when the runtime can decode the AVCC stream (WebCodecs available). */
export function isAvccSupported(): boolean {
  return typeof globalThis !== "undefined" && typeof (globalThis as unknown as { VideoDecoder?: unknown }).VideoDecoder !== "undefined";
}
