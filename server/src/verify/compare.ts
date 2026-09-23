import type { Rgba } from "./png.ts";

export interface PixelDiff {
  changedPixels: number;
  totalPixels: number;
  /** changedPixels / totalPixels; 1 when the sizes differ, since nothing lines up. */
  ratio: number;
  sizeMismatch: boolean;
  /** Unchanged pixels faded to grey, changed ones red. Null on a size mismatch. */
  image: Rgba | null;
}

/** pixelmatch's default: a YIQ distance above 10% of the maximum counts as changed. */
export const DEFAULT_THRESHOLD = 0.1;
const MAX_YIQ_DELTA = 35215;

function blendWhite(c: number, a: number): number {
  return 255 + ((c - 255) * a) / 255;
}

function yiqDelta(a: Buffer, b: Buffer, i: number): number {
  const r1 = blendWhite(a[i]!, a[i + 3]!);
  const g1 = blendWhite(a[i + 1]!, a[i + 3]!);
  const b1 = blendWhite(a[i + 2]!, a[i + 3]!);
  const r2 = blendWhite(b[i]!, b[i + 3]!);
  const g2 = blendWhite(b[i + 1]!, b[i + 3]!);
  const b2 = blendWhite(b[i + 2]!, b[i + 3]!);
  const y = (r1 - r2) * 0.29889531 + (g1 - g2) * 0.58662247 + (b1 - b2) * 0.11448223;
  const iq = (r1 - r2) * 0.59597799 - (g1 - g2) * 0.2741761 - (b1 - b2) * 0.32180189;
  const q = (r1 - r2) * 0.21147017 - (g1 - g2) * 0.52261711 + (b1 - b2) * 0.31114694;
  return 0.5053 * y * y + 0.299 * iq * iq + 0.1957 * q * q;
}

export function diffImages(a: Rgba, b: Rgba, threshold = DEFAULT_THRESHOLD): PixelDiff {
  const totalPixels = Math.max(a.width * a.height, b.width * b.height);
  if (a.width !== b.width || a.height !== b.height) {
    return { changedPixels: totalPixels, totalPixels, ratio: 1, sizeMismatch: true, image: null };
  }
  const limit = MAX_YIQ_DELTA * threshold * threshold;
  const out = Buffer.alloc(a.data.length);
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (yiqDelta(a.data, b.data, i) > limit) {
      changed++;
      out[i] = 255;
      out[i + 1] = 0;
      out[i + 2] = 0;
    } else {
      const grey = blendWhite(0.299 * a.data[i]! + 0.587 * a.data[i + 1]! + 0.114 * a.data[i + 2]!, 25);
      out[i] = out[i + 1] = out[i + 2] = grey;
    }
    out[i + 3] = 255;
  }
  return {
    changedPixels: changed,
    totalPixels,
    ratio: totalPixels ? changed / totalPixels : 0,
    sizeMismatch: false,
    image: { width: a.width, height: a.height, data: out },
  };
}
