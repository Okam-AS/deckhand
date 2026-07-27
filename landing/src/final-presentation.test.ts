import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("./global.css", import.meta.url), "utf8");

test("final presentation removes layered and placeholder V2 selectors", () => {
  assert.doesNotMatch(css, /\.theatre-viewer\b/);
  assert.doesNotMatch(css, /\.device-lab-controls\b/);
  assert.doesNotMatch(css, /\.device-preview-screen\b/);
  assert.match(css, /\.hero-art-caption\b/);
  assert.match(css, /\.run-console\b/);
  assert.match(css, /\.run-targets\b/);
});
