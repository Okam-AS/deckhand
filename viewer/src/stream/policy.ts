// ---------------------------------------------------------------------------
// The decisions inside DevicePlayer, as pure functions.
//
// `player.ts` is 466 lines and was entirely untested, because every rule in it
// was tangled with a `VideoDecoder`, a canvas and a live socket — and none of
// those exist under `node --test`. But the rules themselves are arithmetic over
// a few numbers, and they are the part that is subtle: each one was calibrated
// against measured behaviour on real hardware, and each one, wrong, produces a
// reconnect loop rather than an error.
//
// Same move as `computeStage()` in panes.ts: extracting the decision IS the
// testability. This module holds no state and touches no DOM.
// ---------------------------------------------------------------------------

/** Longest quiet gap seen on a live stream with a blinking caret is ~430 ms. */
export const STALL_MS = 600;
/** Feeds further apart than this are organic activity, not the connection-opening GOP replay. */
export const ORGANIC_GAP_MS = 500;
/** Queue depth must stay over MAX_DECODE_QUEUE this long before it counts as latency drift. */
export const BACKLOG_MS = 1500;
export const MAX_DECODE_QUEUE = 2;
/** Bounded, so a stream that cannot recover stops trying rather than reconnecting forever. */
export const MAX_RECOVERY = 8;

/**
 * May this chunk be fed to the decoder?
 *
 * The IDR gate, from the learnings doc: feeding deltas before the first keyframe
 * produces a decoder error on some builds and silent garbage on others.
 */
export function acceptsChunk(sawKeyframe: boolean, isKey: boolean): boolean {
  return isKey || sawKeyframe;
}

export type BacklogState = { since: number | null };

/**
 * Decide what a decode queue depth means, and carry the "how long" state.
 *
 * Sustained-only, and that is the whole subtlety. Tripping on instantaneous depth
 * caused a reconnect → GOP replay → spike → reconnect loop at 3-4 Hz on phones:
 * the replay burst legitimately spikes the queue, so reacting to the spike
 * re-triggers the very thing that caused it.
 *
 * A reconnect, not a decoder reset: serve-sim sends ONE keyframe per connection
 * and no mid-stream IDR, so a bare reset would gate forever on a keyframe that
 * never comes and freeze the stream for good.
 */
export function backlogVerdict(
  queueSize: number,
  now: number,
  state: BacklogState,
): { reconnect: boolean; state: BacklogState } {
  if (queueSize <= MAX_DECODE_QUEUE) return { reconnect: false, state: { since: null } };
  if (state.since === null) return { reconnect: false, state: { since: now } };
  if (now - state.since > BACKLOG_MS) return { reconnect: true, state: { since: null } };
  return { reconnect: false, state };
}

/**
 * Was this feed organic activity rather than part of the opening replay burst?
 *
 * Only an organic feed may arm the stall self-heal. A pure replay always ends with
 * one frame held inside Safari's decoder, so healing on it would reconnect →
 * replay → hold again, forever, on a screen nobody is touching.
 */
export function isOrganicFeed(lastFeedAt: number, now: number): boolean {
  return lastFeedAt !== 0 && now - lastFeedAt > ORGANIC_GAP_MS;
}

/**
 * Should an idle stream be reconnected to shake loose frames the decoder owes?
 *
 * The change-driven encoder sends nothing while the screen is still, and a decoder
 * that holds output until more input arrives (Safari ignores `optimizeForLatency`)
 * therefore keeps the last typed character invisible indefinitely. Reconnecting
 * repaints from the fresh seed in ~250 ms.
 */
export function shouldHealStall(opts: {
  fed: number;
  delivered: number;
  organicFeed: boolean;
  quietMs: number;
}): boolean {
  return opts.organicFeed && opts.fed > opts.delivered && opts.quietMs >= STALL_MS;
}

/** Recovery is bounded: past MAX_RECOVERY, report and stop rather than loop. */
export function mayRecover(attempts: number): boolean {
  return attempts < MAX_RECOVERY;
}
