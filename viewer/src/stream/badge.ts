import type { PlayerStatus } from "./player.ts";

/**
 * The status pill over a live device: its text, or null for no pill.
 *
 * Pure, and separate from DeviceFrame, because the viewer has no DOM test setup
 * and this is the only shape a test can reach.
 *
 * It takes no platform, on purpose. `DevicePlayer.start()` branches on
 * `isAvccSupported()` and nothing in the viewer asks which platform a device is,
 * so "fallback" means the same degradation everywhere: WebCodecs is gone, or the
 * helper had no H.264 to give. This used to suppress the pill for Android on the
 * grounds that MJPEG was Android's normal path; it stopped being that when the
 * Android helper started serving /stream.avcc, and until this was removed a
 * degraded Android device looked identical to a healthy one.
 *
 * That 404 is not a verdict on the device: `serveAvcc` sends it whenever
 * `AvccSource.ready()` is false, which includes the whole backoff window after
 * any failed probe — and the commonest cause is another emulator holding the
 * host's single H.264 encoder, indistinguishable from a dead one from in there
 * (see `settle` in androidH264.ts). So the pill can be right that this device is
 * degraded now and wrong about why; it says "Reduced quality", which is true
 * either way, and claims nothing about the hardware.
 *
 * The four causes behind "fallback" are deliberately not told apart. The player
 * collapses them into one status, so splitting the copy is not a string change —
 * it needs a reason plumbed out of `DevicePlayer` first. Know that cost before
 * reaching for cause-specific wording; "Reduced quality" is true of all four.
 */
export function streamBadge(status: PlayerStatus, opts: { ready: boolean; isThumb: boolean }): string | null {
  if (!opts.ready || opts.isThumb || status === "streaming") return null;
  if (status === "fallback") return "Reduced quality";
  // "error" is scheduleReconnect having spent MAX_RECOVERY tries: it sets the
  // status and arms no further timer, so NOTHING is retrying and the pill must
  // not suggest otherwise. The budget is per DevicePlayer instance (`recovery`,
  // cleared only by streamIsHealthy() on a painted frame), which is why the pill
  // says reload: a reload builds a new player at 0. Going off screen and back
  // does not — setActive(false) tears the streams down but leaves `recovery`
  // spent, so that restart gets one shot and gives up on its first failure, and
  // only paints its way back to a full budget if it succeeds. Reload is the cure
  // that does not depend on the thing that just failed working. Untestable here:
  // the viewer has no DOM setup, so nothing pins this and it is a claim about
  // player.ts a reader must re-check there.
  if (status === "error") return "Stream stopped — reload";
  return "Connecting…";
}
