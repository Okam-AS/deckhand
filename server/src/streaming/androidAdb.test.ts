import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseWmSize,
  normToPixels,
  classifyGesture,
  adbInputArgs,
  parseInputFrame,
  orientationToUserRotation,
  usageToKeycode,
  adbTypeCharArgs,
} from "./androidAdb.ts";

/** Encode a viewer HID frame: [tag:u8][JSON]. */
function frame(tag: number, payload: unknown): Buffer {
  return Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(payload))]);
}

describe("parseInputFrame", () => {
  it("decodes touch, button, and orientation frames", () => {
    assert.deepEqual(parseInputFrame(frame(0x03, { type: "begin", x: 0.5, y: 0.25 })), {
      kind: "touch",
      type: "begin",
      x: 0.5,
      y: 0.25,
    });
    assert.deepEqual(parseInputFrame(frame(0x04, { button: "home" })), { kind: "button", button: "home" });
    assert.deepEqual(parseInputFrame(frame(0x07, { orientation: "landscape_left" })), {
      kind: "orientation",
      orientation: "landscape_left",
    });
  });
  it("decodes key frames, with and without a char", () => {
    assert.deepEqual(parseInputFrame(frame(0x06, { type: "down", usage: 4, char: "a" })), {
      kind: "key",
      type: "down",
      usage: 4,
      char: "a",
    });
    assert.deepEqual(parseInputFrame(frame(0x06, { type: "down", usage: 42 })), { kind: "key", type: "down", usage: 42 });
    assert.deepEqual(parseInputFrame(frame(0x06, { type: "up", usage: 4 })), { kind: "key", type: "up", usage: 4 });
  });
  it("rejects junk: unknown tags, bad JSON, wrong shapes, short frames", () => {
    assert.equal(parseInputFrame(frame(0x05, { button: "home" })), null);
    assert.equal(parseInputFrame(Buffer.from([0x03, 0x7b])), null); // truncated JSON
    assert.equal(parseInputFrame(frame(0x03, { type: "hover", x: 0.5, y: 0.5 })), null);
    assert.equal(parseInputFrame(frame(0x03, { type: "begin", x: "0.5", y: 0.5 })), null);
    assert.equal(parseInputFrame(frame(0x04, {})), null);
    assert.equal(parseInputFrame(frame(0x06, { type: "hold", usage: 4 })), null);
    assert.equal(parseInputFrame(frame(0x06, { type: "down" })), null);
    assert.equal(parseInputFrame(Buffer.from([0x03])), null);
  });
});

describe("usageToKeycode", () => {
  it("maps special-key HID usages to Android keycodes; drops modifiers", () => {
    assert.equal(usageToKeycode(42), 67); // backspace → DEL
    assert.equal(usageToKeycode(40), 66); // return → ENTER
    assert.equal(usageToKeycode(80), 21); // left → DPAD_LEFT
    assert.equal(usageToKeycode(225), null); // shift modifier — no keyevent
    assert.equal(usageToKeycode(4), null); // a printable letter goes via input text, not here
  });
});

describe("adbTypeCharArgs", () => {
  it("types a plain char via input text", () => {
    assert.deepEqual(adbTypeCharArgs("a"), ["shell", "input text 'a'"]);
  });
  it("device-shell-quotes metacharacters so they stay literal", () => {
    assert.deepEqual(adbTypeCharArgs(";"), ["shell", "input text ';'"]);
    assert.deepEqual(adbTypeCharArgs("&"), ["shell", "input text '&'"]);
    assert.deepEqual(adbTypeCharArgs("'"), ["shell", "input text ''\\'''"]);
  });
  it("sends space as a keyevent, not input text", () => {
    assert.deepEqual(adbTypeCharArgs(" "), ["shell", "input", "keyevent", "62"]);
  });
});

describe("orientationToUserRotation", () => {
  it("maps serve-sim orientation names to Android surface rotations", () => {
    assert.equal(orientationToUserRotation("portrait"), 0);
    assert.equal(orientationToUserRotation("landscape_left"), 1);
    assert.equal(orientationToUserRotation("portrait_upside_down"), 2);
    assert.equal(orientationToUserRotation("landscape_right"), 3);
    assert.equal(orientationToUserRotation("sideways"), null);
  });
});

describe("parseWmSize", () => {
  it("parses adb wm size output", () => {
    assert.deepEqual(parseWmSize("Physical size: 1080x2340"), { w: 1080, h: 2340 });
    assert.deepEqual(parseWmSize("Override size: 720x1600\n"), { w: 720, h: 1600 });
    assert.equal(parseWmSize("garbage"), null);
  });
});

describe("normToPixels", () => {
  it("maps and clamps normalized coords to device pixels", () => {
    assert.deepEqual(normToPixels(0.5, 0.5, { w: 1000, h: 2000 }), { px: 500, py: 1000 });
    assert.deepEqual(normToPixels(-1, 2, { w: 1000, h: 2000 }), { px: 0, py: 2000 });
  });
});

describe("classifyGesture", () => {
  it("treats a tiny move as a tap", () => {
    const g = classifyGesture({ x: 0.5, y: 0.5 }, { x: 0.505, y: 0.5 }, 120);
    assert.equal(g.kind, "tap");
  });
  it("treats a larger move as a swipe with clamped duration", () => {
    const g = classifyGesture({ x: 0.2, y: 0.8 }, { x: 0.2, y: 0.2 }, 5000);
    assert.equal(g.kind, "swipe");
    if (g.kind === "swipe") assert.equal(g.durationMs, 1500);
  });
});

describe("adbInputArgs", () => {
  const size = { w: 1000, h: 2000 };
  it("builds a tap command", () => {
    assert.deepEqual(adbInputArgs({ kind: "tap", x: 0.5, y: 0.25 }, size), ["shell", "input", "tap", "500", "500"]);
  });
  it("builds a swipe command", () => {
    assert.deepEqual(adbInputArgs({ kind: "swipe", x1: 0.5, y1: 0.8, x2: 0.5, y2: 0.2, durationMs: 300 }, size), [
      "shell",
      "input",
      "swipe",
      "500",
      "1600",
      "500",
      "400",
      "300",
    ]);
  });
});
