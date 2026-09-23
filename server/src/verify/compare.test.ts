import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diffImages } from "./compare.ts";
import type { Rgba } from "./png.ts";

function solid(w: number, h: number, rgb: [number, number, number]): Rgba {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...rgb, 255], i * 4);
  return { width: w, height: h, data };
}

function withPixel(img: Rgba, x: number, y: number, rgb: [number, number, number]): Rgba {
  const data = Buffer.from(img.data);
  data.set([...rgb, 255], (y * img.width + x) * 4);
  return { ...img, data };
}

describe("diffImages", () => {
  const base = solid(4, 2, [255, 255, 255]);

  it("reports nothing changed for identical images", () => {
    const d = diffImages(base, solid(4, 2, [255, 255, 255]));
    assert.equal(d.changedPixels, 0);
    assert.equal(d.ratio, 0);
    assert.equal(d.totalPixels, 8);
  });

  it("counts changed pixels as a ratio of the whole screen and marks them red", () => {
    const d = diffImages(base, withPixel(withPixel(base, 1, 0, [0, 0, 0]), 3, 1, [200, 0, 0]));
    assert.equal(d.changedPixels, 2);
    assert.equal(d.ratio, 0.25);
    assert.deepEqual([...d.image!.data.subarray(4, 8)], [255, 0, 0, 255]);
    assert.notDeepEqual([...d.image!.data.subarray(0, 4)], [255, 0, 0, 255]);
  });

  it("ignores a change below the perceptual threshold, as pixelmatch does", () => {
    const d = diffImages(base, withPixel(base, 0, 0, [250, 250, 250]));
    assert.equal(d.changedPixels, 0);
    assert.equal(diffImages(base, withPixel(base, 0, 0, [250, 250, 250]), 0).changedPixels, 1);
  });

  it("calls a size change a full change and draws no diff", () => {
    const d = diffImages(base, solid(2, 4, [255, 255, 255]));
    assert.equal(d.sizeMismatch, true);
    assert.equal(d.ratio, 1);
    assert.equal(d.image, null);
  });
});
