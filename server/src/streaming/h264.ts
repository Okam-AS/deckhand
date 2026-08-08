/**
 * Annex-B → AVCC repackaging for the Android H.264 path.
 *
 * `adb exec-out screenrecord --output-format=h264` emits an Annex-B elementary
 * stream: NAL units separated by `00 00 01` / `00 00 00 01` start codes. The
 * viewer's WebCodecs decoder is configured in **avcC** mode (same as serve-sim
 * on iOS), which wants an `avcC` description box up front and then access units
 * whose NALs carry a 4-byte big-endian length prefix instead of a start code.
 *
 * This module is the translation, kept pure so it can be unit-tested without an
 * emulator: feed it stream bytes, get back `{description, keyframe, delta}`
 * events in the order the viewer's `AvccDemuxer` expects.
 */

/** NAL types we care about; everything else rides along inside the access unit. */
const NAL_SLICE_NON_IDR = 1;
const NAL_SLICE_IDR = 5;
const NAL_SPS = 7;
const NAL_PPS = 8;
const NAL_AUD = 9;

/**
 * Wire tags. Declared again in `viewer/src/stream/avcc.ts` — a separate build the server
 * cannot import — so the two are held together only by h264.test.ts "the AVCC wire tags
 * match the viewer's decoder exactly", which reads both files as source.
 */
export const AVCC_TAG_DESCRIPTION = 0x01;
export const AVCC_TAG_KEYFRAME = 0x02;
export const AVCC_TAG_DELTA = 0x03;
export const AVCC_TAG_SEED = 0x04;

export type H264Event =
  | { type: "description"; payload: Buffer }
  | { type: "keyframe"; payload: Buffer }
  | { type: "delta"; payload: Buffer };

const nalType = (nal: Buffer): number => (nal.length > 0 ? nal[0]! & 0x1f : -1);
const isVcl = (t: number): boolean => t === NAL_SLICE_NON_IDR || t === NAL_SLICE_IDR;

/**
 * Build an `avcC` decoder-configuration record from one SPS and one PPS
 * (both **including** their NAL header byte, as they arrive on the wire).
 * Profile/compatibility/level are lifted from SPS bytes 1..3 — the viewer's
 * `avcCodecString()` reads those same three bytes back out.
 */
export function buildAvcC(sps: Buffer, pps: Buffer): Buffer {
  if (sps.length < 4) throw new Error("SPS too short for avcC");
  const out = Buffer.alloc(11 + sps.length + pps.length);
  let o = 0;
  out[o++] = 1; // configurationVersion
  out[o++] = sps[1]!; // AVCProfileIndication
  out[o++] = sps[2]!; // profile_compatibility
  out[o++] = sps[3]!; // AVCLevelIndication
  out[o++] = 0xff; // 111111 reserved + lengthSizeMinusOne = 3 (4-byte lengths)
  out[o++] = 0xe1; // 111 reserved + numOfSequenceParameterSets = 1
  out.writeUInt16BE(sps.length, o);
  o += 2;
  sps.copy(out, o);
  o += sps.length;
  out[o++] = 1; // numOfPictureParameterSets
  out.writeUInt16BE(pps.length, o);
  o += 2;
  pps.copy(out, o);
  return out;
}

/** Length-prefix a set of NALs into one avcC-style access unit. */
export function toAvccAccessUnit(nals: Buffer[]): Buffer {
  const total = nals.reduce((n, nal) => n + 4 + nal.length, 0);
  const out = Buffer.alloc(total);
  let o = 0;
  for (const nal of nals) {
    out.writeUInt32BE(nal.length, o);
    o += 4;
    nal.copy(out, o);
    o += nal.length;
  }
  return out;
}

/** Frame one event for the wire: `[len:u32be][tag:u8][payload]`, len = payload + 1. */
export function frameChunk(tag: number, payload: Buffer): Buffer {
  const out = Buffer.alloc(5 + payload.length);
  out.writeUInt32BE(payload.length + 1, 0);
  out[4] = tag;
  payload.copy(out, 5);
  return out;
}

/**
 * Incremental Annex-B splitter + access-unit assembler.
 *
 * A NAL is only complete once the *next* start code shows up, so trailing bytes
 * stay buffered between pushes. Access-unit boundaries are taken at the first
 * VCL NAL after a VCL NAL already sits in the pending unit — screenrecord emits
 * one slice per picture, so this is exact for our input and degrades to
 * "slightly larger access units" rather than corruption if that ever changes.
 *
 * SPS/PPS are consumed into the avcC description rather than forwarded: they're
 * already in the decoder config, and re-sending them inline confuses some
 * WebCodecs implementations in avcC mode.
 */
export class AnnexBToAvcc {
  private buf: Buffer = Buffer.alloc(0);
  /** Payload offset of the NAL being accumulated; null before the first start code. */
  private openEnd: number | null = null;
  /** How far into `buf` findStartCode has already looked (never rescan). */
  private scanned = 0;
  private pending: Buffer[] = [];
  private pendingHasVcl = false;
  private pendingHasIdr = false;
  private sps: Buffer | null = null;
  private pps: Buffer | null = null;
  private sentDescription: Buffer | null = null;

  /** Feed raw Annex-B bytes; returns the events now complete, in order. */
  push(bytes: Buffer): H264Event[] {
    if (bytes.length > 0) this.buf = this.buf.length === 0 ? bytes : Buffer.concat([this.buf, bytes]);
    const events: H264Event[] = [];

    // `openEnd` is where the payload of the NAL currently being accumulated
    // begins; that payload runs to the next start code, which may not have
    // arrived yet. Null until the very first start code shows up.
    if (this.openEnd === null) {
      const first = this.findStartCode(this.scanned);
      if (first === null) {
        // A start code may straddle this read boundary — never rescan more
        // than the 3 bytes one could span.
        this.scanned = Math.max(0, this.buf.length - 3);
        return events;
      }
      this.openEnd = first.end;
      this.scanned = first.end;
    }

    for (;;) {
      const next = this.findStartCode(this.scanned);
      if (next === null) break;
      this.consumeNal(this.buf.subarray(this.openEnd, next.start), events);
      this.openEnd = next.end;
      this.scanned = next.end;
    }

    // The scan reached the end, so every index up to length-3 is examined.
    // Drop everything before the open NAL's payload and resume from the tail,
    // keeping a keyframe split across many reads linear rather than O(reads²).
    if (this.openEnd > 0) {
      this.buf = this.buf.subarray(this.openEnd);
      this.openEnd = 0;
    }
    this.scanned = Math.max(0, this.buf.length - 3);
    return events;
  }

  /**
   * Close out the stream: the trailing NAL has no following start code to
   * delimit it, so end-of-input is what completes it. Call when the
   * screenrecord segment exits, or its last access unit is silently lost.
   */
  flush(): H264Event[] {
    const events: H264Event[] = [];
    if (this.openEnd !== null && this.buf.length > this.openEnd) {
      this.consumeNal(this.buf.subarray(this.openEnd), events);
      this.buf = Buffer.alloc(0);
      this.openEnd = null;
      this.scanned = 0;
    }
    this.emitPending(events);
    return events;
  }

  /** The current avcC description, once SPS+PPS have both been seen. */
  description(): Buffer | null {
    return this.sentDescription;
  }

  /** Drop all state — used when a screenrecord segment is replaced. */
  reset(): void {
    this.buf = Buffer.alloc(0);
    this.openEnd = null;
    this.scanned = 0;
    this.pending = [];
    this.pendingHasVcl = false;
    this.pendingHasIdr = false;
    this.sps = null;
    this.pps = null;
    this.sentDescription = null;
  }

  /** Locate the next `00 00 01` / `00 00 00 01`, returning payload bounds. */
  private findStartCode(from: number): { start: number; end: number } | null {
    const b = this.buf;
    for (let i = from; i + 2 < b.length; i++) {
      if (b[i] !== 0 || b[i + 1] !== 0) continue;
      if (b[i + 2] === 1) return { start: i, end: i + 3 };
      if (b[i + 2] === 0 && i + 3 < b.length && b[i + 3] === 1) return { start: i, end: i + 4 };
    }
    return null;
  }

  private consumeNal(nal: Buffer, events: H264Event[]): void {
    if (nal.length === 0) return;
    const t = nalType(nal);

    if (t === NAL_SPS || t === NAL_PPS) {
      // Copy: `nal` is a view into a buffer we're about to drop.
      if (t === NAL_SPS) this.sps = Buffer.from(nal);
      else this.pps = Buffer.from(nal);
      this.maybeEmitDescription(events);
      return;
    }
    if (t === NAL_AUD) return; // access-unit delimiters carry nothing the decoder needs

    if (isVcl(t)) {
      if (this.pendingHasVcl) this.emitPending(events);
      this.pendingHasVcl = true;
      if (t === NAL_SLICE_IDR) this.pendingHasIdr = true;
    }
    this.pending.push(Buffer.from(nal));
  }

  private maybeEmitDescription(events: H264Event[]): void {
    if (!this.sps || !this.pps) return;
    const desc = buildAvcC(this.sps, this.pps);
    if (this.sentDescription && this.sentDescription.equals(desc)) return;
    // A parameter-set change invalidates the half-built access unit.
    this.pending = [];
    this.pendingHasVcl = false;
    this.pendingHasIdr = false;
    this.sentDescription = desc;
    events.push({ type: "description", payload: desc });
  }

  private emitPending(events: H264Event[]): void {
    if (this.pending.length === 0) return;
    // Nothing is decodable before the decoder is configured.
    if (this.sentDescription) {
      events.push({
        type: this.pendingHasIdr ? "keyframe" : "delta",
        payload: toAvccAccessUnit(this.pending),
      });
    }
    this.pending = [];
    this.pendingHasVcl = false;
    this.pendingHasIdr = false;
  }
}
