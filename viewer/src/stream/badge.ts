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
 * Android helper started serving /stream.avcc (androidAdb.ts, which 404s it only
 * on an image whose encoder cannot run), and until this was removed a degraded
 * Android device looked identical to a healthy one.
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
  // not suggest otherwise. Only a fresh start() can move it — a reload, or the
  // frame going off screen and back — and neither resets `recovery`, so the next
  // failure gives up at once. Hence "reload", not "retrying".
  if (status === "error") return "Stream stopped — reload";
  return "Connecting…";
}
