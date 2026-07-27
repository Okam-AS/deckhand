/**
 * Incremental MJPEG (`multipart/x-mixed-replace`) parser for serve-sim's
 * `/stream.mjpeg` fallback.
 *
 * Vendored from serve-sim (Apache-2.0, © Evan Bacon):
 * https://github.com/EvanBacon/serve-sim (packages/serve-sim/src/client/utils/mjpeg-frame-parser.ts)
 *
 * Amortised append + in-place compaction: a tunnel splits each ~256KB frame
 * into many small reads; a rebuild-per-chunk parser is O(bytes²) and freezes
 * the tab.
 */
export interface MjpegFrameParser {
  push(value: Uint8Array): void;
}

export function createMjpegFrameParser(emit: (jpeg: Uint8Array) => void): MjpegFrameParser {
  let buffer = new Uint8Array(64 * 1024);
  let len = 0;
  let start = 0;
  const HEADER_WINDOW = 1024;
  const decoder = new TextDecoder("latin1");

  const append = (value: Uint8Array) => {
    if (len + value.length > buffer.length) {
      if (start > 0) {
        buffer.copyWithin(0, start, len);
        len -= start;
        start = 0;
      }
      if (len + value.length > buffer.length) {
        let cap = buffer.length;
        while (cap < len + value.length) cap *= 2;
        const grown = new Uint8Array(cap);
        grown.set(buffer.subarray(0, len));
        buffer = grown;
      }
    }
    buffer.set(value, len);
    len += value.length;
  };

  const findHeaderEnd = (from: number): number => {
    const end = Math.min(len - 4, from + HEADER_WINDOW);
    for (let i = from; i <= end; i++) {
      if (buffer[i] === 0x0d && buffer[i + 1] === 0x0a && buffer[i + 2] === 0x0d && buffer[i + 3] === 0x0a) return i;
    }
    return -1;
  };

  const contentLength = (from: number, to: number): number | null => {
    const header = decoder.decode(buffer.subarray(from, to));
    const m = /content-length:\s*(\d+)/i.exec(header);
    return m ? Number(m[1]) : null;
  };

  let markerScanFrom = 0;
  const scanJpeg = (from: number): { s: number; e: number } | null => {
    let s = -1;
    for (let i = from; i < len - 1; i++) {
      if (buffer[i] === 0xff && buffer[i + 1] === 0xd8) {
        s = i;
        break;
      }
    }
    if (s === -1) return null;
    for (let i = Math.max(s + 2, markerScanFrom); i < len - 1; i++) {
      if (buffer[i] === 0xff && buffer[i + 1] === 0xd9) {
        markerScanFrom = 0;
        return { s, e: i + 2 };
      }
    }
    markerScanFrom = Math.max(s + 2, len - 1);
    return null;
  };

  const drain = () => {
    while (start < len) {
      const headerEnd = findHeaderEnd(start);
      if (headerEnd >= 0) {
        const frameLen = contentLength(start, headerEnd);
        if (frameLen != null && frameLen > 0) {
          const jpegStart = headerEnd + 4;
          const jpegEnd = jpegStart + frameLen;
          if (len < jpegEnd) break;
          emit(buffer.subarray(jpegStart, jpegEnd));
          start = jpegEnd;
          continue;
        }
      } else if (len - start <= HEADER_WINDOW) {
        break;
      }
      const fr = scanJpeg(start);
      if (!fr) break;
      emit(buffer.subarray(fr.s, fr.e));
      start = fr.e;
    }
    if (start > 0) {
      if (start < len) buffer.copyWithin(0, start, len);
      len -= start;
      markerScanFrom = markerScanFrom > start ? markerScanFrom - start : 0;
      start = 0;
    }
  };

  return {
    push(value: Uint8Array) {
      if (value.length === 0) return;
      append(value);
      drain();
    },
  };
}
