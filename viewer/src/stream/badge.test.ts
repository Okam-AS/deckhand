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
    // `Function.length` only sees the positional spelling — a `platform` field
    // added to `opts` leaves it at 2 — so the likelier return of the switch is
    // the line below, not this one.
    assert.equal(streamBadge.length, 2, "a third POSITIONAL argument would be a platform switch creeping back in");
    // Excess-property checking covers the other spelling. It is enforced by
    // `npm run typecheck`, NOT by this run: tests run under tsx, which does not
    // typecheck. Once `opts` accepts a platform, the error disappears and the
    // unused @ts-expect-error is itself the failure.
    // @ts-expect-error - opts takes no platform, and must not learn to
    streamBadge("fallback", { ready: true, isThumb: false, platform: "android" });
  });

  it("shows the connecting pill before the first frame", () => {
    assert.equal(streamBadge("connecting", { ready: true, isThumb: false }), "Connecting…");
  });

  it("stays quiet on a device that is not ready, and on a thumbnail", () => {
    assert.equal(streamBadge("fallback", { ready: false, isThumb: false }), null, "the phase overlay owns a device that is still building");
    assert.equal(streamBadge("fallback", { ready: true, isThumb: true }), null, "a thumbnail is too small to carry a pill");
  });

  // "error" is `scheduleReconnect` giving up after MAX_RECOVERY tries: it sets the
  // status and returns without arming another timer, so nothing is retrying. The
  // pill used to read "Connecting…" — a stream that had stopped trying telling the
  // one person actually waiting on it that it hadn't.
  it("says the stream stopped once the player has given up, not that it is connecting", () => {
    assert.equal(streamBadge("error", { ready: true, isThumb: false }), "Stream stopped — reload");
  });

  it("suppresses the stopped pill in the same places as every other one", () => {
    // A thumbnail runs a real player (the stream effect is not gated on variant),
    // so it reaches "error" like any other frame.
    assert.equal(streamBadge("error", { ready: true, isThumb: true }), null);
    // The status outlives a device dropping back out of `ready` (a rebuild); the
    // phase overlay owns the frame then, and two verdicts at once is one too many.
    assert.equal(streamBadge("error", { ready: false, isThumb: false }), null);
  });
});
