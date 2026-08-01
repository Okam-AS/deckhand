import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  acceptsChunk,
  backlogVerdict,
  isOrganicFeed,
  shouldHealStall,
  mayRecover,
  BACKLOG_MS,
  ORGANIC_GAP_MS,
  STALL_MS,
  MAX_RECOVERY,
} from "./policy.ts";

/**
 * Every rule here was calibrated against measured behaviour on real hardware, and every one
 * of them, wrong, produces a RECONNECT LOOP rather than an error — the failure mode that
 * looks like "Android is slow" instead of like a bug.
 */

describe("acceptsChunk — the IDR gate", () => {
  it("drops deltas until the first keyframe, then accepts them", () => {
    assert.equal(acceptsChunk(false, false), false, "a delta before any keyframe is garbage in");
    assert.equal(acceptsChunk(false, true), true, "the keyframe itself always goes in");
    assert.equal(acceptsChunk(true, false), true);
  });
});

describe("backlogVerdict", () => {
  it("does not reconnect on an instantaneous spike", () => {
    // The bug this prevents: the connection-opening GOP replay legitimately spikes the queue,
    // so reacting to depth alone reconnects → replays → spikes again. Measured at 3-4 Hz on
    // phones, which reads as "the stream is broken" rather than "we are fighting ourselves".
    let state = { since: null as number | null };
    let v = backlogVerdict(9, 1_000, state);
    assert.equal(v.reconnect, false, "first sight of depth only starts the clock");
    state = v.state;
    v = backlogVerdict(9, 1_000 + BACKLOG_MS - 1, state);
    assert.equal(v.reconnect, false, "still inside the window");
  });

  it("reconnects once the depth is sustained past the window", () => {
    let state = { since: null as number | null };
    state = backlogVerdict(9, 1_000, state).state;
    const v = backlogVerdict(9, 1_000 + BACKLOG_MS + 1, state);
    assert.equal(v.reconnect, true, "sustained depth is real latency drift, not a replay burst");
    assert.equal(v.state.since, null, "and the clock resets, so it cannot fire twice on one event");
  });

  it("forgets the clock the moment the queue drains", () => {
    let state = backlogVerdict(9, 1_000, { since: null }).state;
    state = backlogVerdict(0, 1_500, state).state;
    assert.equal(state.since, null);
    // A later spike therefore has to earn the full window again, rather than inheriting time
    // from an unrelated one minutes ago.
    const v = backlogVerdict(9, 1_500 + BACKLOG_MS + 1, state);
    assert.equal(v.reconnect, false);
  });
});

describe("isOrganicFeed", () => {
  it("treats a contiguous burst as replay, and a feed after a quiet gap as activity", () => {
    assert.equal(isOrganicFeed(1_000, 1_000 + ORGANIC_GAP_MS - 1), false, "part of the opening burst");
    assert.equal(isOrganicFeed(1_000, 1_000 + ORGANIC_GAP_MS + 1), true, "somebody touched the screen");
  });

  it("never calls the very first feed organic", () => {
    // lastFeedAt === 0 means nothing has arrived yet. Calling that organic would arm the
    // stall self-heal on the opening replay, whose last frame Safari always holds — so it
    // would reconnect, replay, hold, forever, on an idle screen.
    assert.equal(isOrganicFeed(0, 9_999_999), false);
  });
});

describe("shouldHealStall", () => {
  const base = { fed: 10, delivered: 9, organicFeed: true, quietMs: STALL_MS };

  it("reconnects when an organic stream goes quiet owing frames", () => {
    assert.equal(shouldHealStall(base), true);
  });

  it("does nothing when the decoder owes nothing", () => {
    assert.equal(shouldHealStall({ ...base, delivered: 10 }), false, "everything fed has been painted");
  });

  it("does nothing on a replay-only stream, however long it is quiet", () => {
    assert.equal(shouldHealStall({ ...base, organicFeed: false, quietMs: 60_000 }), false);
  });

  it("waits out the quiet window", () => {
    // A blinking caret produces gaps up to ~430 ms. Firing below STALL_MS would reconnect a
    // perfectly healthy stream every time the cursor blinked.
    assert.equal(shouldHealStall({ ...base, quietMs: STALL_MS - 1 }), false);
  });
});

describe("mayRecover", () => {
  it("is bounded", () => {
    assert.equal(mayRecover(0), true);
    assert.equal(mayRecover(MAX_RECOVERY - 1), true);
    assert.equal(mayRecover(MAX_RECOVERY), false, "a stream that cannot recover must stop trying");
  });
});
