import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { streamBadge } from "./badge.ts";

/**
 * `status === "fallback"` means the player left the WebCodecs/avcc path — the
 * 404 from a helper that cannot encode, the first-frame watchdog, a decode
 * error, or a browser with no WebCodecs at all. Every one of those is a real
 * degradation, on either platform: `DevicePlayer.start()` branches on
 * `isAvccSupported()` and there is no platform switch anywhere in the viewer,
 * so the badge must not have one either. It did, and it hid exactly the case
 * it exists to show.
 */
describe("streamBadge", () => {
  it("says nothing while the stream is healthy", () => {
    assert.equal(streamBadge("streaming", { ready: true, isThumb: false }), null);
  });

  it("reports a fallback on BOTH platforms — the pill takes no platform input at all", () => {
    const args = { ready: true, isThumb: false } as const;
    assert.equal(streamBadge("fallback", args), "Reduced quality");
    // The signature is the guard: there is no platform argument to special-case
    // with, so an Android device that dropped to MJPEG cannot look healthy.
    assert.equal(streamBadge.length, 2, "a third argument would be a platform switch creeping back in");
  });

  it("shows the connecting pill before the first frame", () => {
    assert.equal(streamBadge("connecting", { ready: true, isThumb: false }), "Connecting…");
  });

  it("stays quiet on a device that is not ready, and on a thumbnail", () => {
    assert.equal(streamBadge("fallback", { ready: false, isThumb: false }), null, "the phase overlay owns a device that is still building");
    assert.equal(streamBadge("fallback", { ready: true, isThumb: true }), null, "a thumbnail is too small to carry a pill");
  });
});
