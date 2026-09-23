import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { decodePng, encodePng, rotateCcw, type Rgba } from "./png.ts";

function image(w: number, h: number, px: (x: number, y: number) => [number, number, number, number]): Rgba {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(px(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
}

/** Re-encode an RGB image cycling through all five scanline filters, the way real encoders do. */
function filteredRgbPng(img: Rgba): Buffer {
  const bpp = 3;
  const stride = img.width * bpp;
  const rows: Buffer[] = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < img.height; y++) {
    const line = Buffer.alloc(stride);
    for (let x = 0; x < img.width; x++) for (let c = 0; c < 3; c++) line[x * 3 + c] = img.data[(y * img.width + x) * 4 + c]!;
    const f = y % 5;
    const outRow = Buffer.alloc(stride + 1);
    outRow[0] = f;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const pred = [0, a, b, (a + b) >> 1, paeth][f]!;
      outRow[i + 1] = (line[i]! - pred) & 0xff;
    }
    rows.push(outRow);
    prev = line;
  }
  const png = encodePng(img);
  const ihdrEnd = 8 + 25;
  const ihdr = Buffer.from(png.subarray(0, ihdrEnd));
  ihdr[8 + 8 + 9] = 2;
  ihdr.writeUInt32BE(crc32(ihdr.subarray(12, 29)), 29);
  const body = deflateSync(Buffer.concat(rows));
  const idat = Buffer.alloc(12 + body.length);
  idat.writeUInt32BE(body.length, 0);
  idat.write("IDAT", 4, "latin1");
  body.copy(idat, 8);
  idat.writeUInt32BE(crc32(idat.subarray(4, 8 + body.length)), 8 + body.length);
  return Buffer.concat([ihdr, idat, png.subarray(png.length - 12)]);
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

describe("png", () => {
  const gradient = image(7, 11, (x, y) => [x * 30, y * 20, (x * y) % 256, 255]);

  it("round-trips RGBA through encode and decode", () => {
    const img = image(5, 3, (x, y) => [x * 50, y * 80, 7, 100 + x]);
    assert.deepEqual(decodePng(encodePng(img)), img);
  });

  it("undoes every scanline filter on an RGB image", () => {
    assert.deepEqual(decodePng(filteredRgbPng(gradient)), gradient);
  });

  it("refuses what it cannot read rather than returning a wrong image", () => {
    assert.throws(() => decodePng(Buffer.from("not a png")), /not a PNG/);
  });

  it("rotates counter-clockwise by quarter turns", () => {
    const img = image(3, 2, (x, y) => [x, y, 0, 255]);
    const ccw = rotateCcw(img, 1);
    assert.equal(ccw.width, 2);
    assert.equal(ccw.height, 3);
    const at = (r: Rgba, x: number, y: number) => [...r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 2)];
    assert.deepEqual(at(ccw, 0, 0), [2, 0], "the top-right corner becomes the top-left");
    assert.deepEqual(at(rotateCcw(img, 3), 0, 0), [0, 1], "the bottom-left corner becomes the top-left");
    assert.deepEqual(at(rotateCcw(img, 2), 0, 0), [2, 1]);
    assert.deepEqual(rotateCcw(rotateCcw(img, 1), 3), img);
    assert.equal(rotateCcw(img, 4), img);
  });
});
