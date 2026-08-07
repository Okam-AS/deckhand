import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PairingStore, MAX_PENDING, PENDING_TTL_MS } from "./pairing.ts";

const REQ = {
  clientId: "client-1",
  clientName: "Claude",
  redirectUri: "https://claude.ai/api/mcp/auth_callback",
  codeChallenge: "challenge",
};

/** A clock the test moves by hand: waiting five real minutes is not a test. */
function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe("requests waiting for the operator", () => {
  it("parks a request and shows a code, issuing nothing", () => {
    const store = new PairingStore();
    const parked = store.park(REQ)!;
    assert.ok(parked.id.length >= 32, "the poll handle must not be guessable");
    assert.match(parked.code, /^[A-Z0-9]{3}-[A-Z0-9]{3}$/);
    assert.equal(parked.status, "pending");
    assert.equal(parked.authCode, undefined, "nothing is minted by arriving");
    assert.deepEqual(store.poll(parked.id), { status: "pending" });
  });

  // The operator's list must not carry anything that would let a screenshot stand in for being
  // at the machine — the id is the browser's, and the challenge and redirect are the client's.
  it("shows the operator the code, the client and the wait — and nothing else", () => {
    const c = clock();
    const store = new PairingStore({ now: c.now });
    store.park(REQ);
    c.advance(3_000);
    const [waiting] = store.pending();
    assert.deepEqual(Object.keys(waiting!).sort(), ["clientName", "code", "waitingMs"]);
    assert.equal(waiting!.waitingMs, 3_000);
  });

  it("mints only on approval, and hands the browser the same request", () => {
    const store = new PairingStore();
    const parked = store.park(REQ)!;
    const approved = store.approve(parked.code, () => "auth-code-1");
    assert.equal(approved?.id, parked.id);
    assert.deepEqual(store.poll(parked.id), { status: "approved" }, "the poll never carries the code itself");
    assert.equal(store.take(parked.id)?.authCode, "auth-code-1");
  });

  it("approves case-insensitively, because the code is read off one screen and typed on another", () => {
    const store = new PairingStore();
    const parked = store.park(REQ)!;
    assert.ok(store.approve(parked.code.toLowerCase(), () => "auth-code-1"));
  });

  it("hands an approved request over exactly once", () => {
    const store = new PairingStore();
    const parked = store.park(REQ)!;
    store.approve(parked.code, () => "auth-code-1");
    assert.equal(store.take(parked.id)?.authCode, "auth-code-1");
    assert.equal(store.take(parked.id), null, "a replayed resume must not deliver the code again");
  });

  it("mints nothing twice for one approval", () => {
    const store = new PairingStore();
    const parked = store.park(REQ)!;
    let mints = 0;
    store.approve(parked.code, () => `code-${++mints}`);
    assert.equal(store.approve(parked.code, () => `code-${++mints}`), null, "it is no longer pending");
    assert.equal(mints, 1);
  });

  it("refuses a denied request without issuing anything", () => {
    const store = new PairingStore();
    const parked = store.park(REQ)!;
    assert.ok(store.deny(parked.code));
    assert.deepEqual(store.poll(parked.id), { status: "denied" });
    assert.equal(store.approve(parked.code, () => "nope"), null);
  });

  // The URL is public, so anyone holding it can make this Mac show a prompt. Dropping the
  // oldest to make room would remove the request the operator is looking at — which is exactly
  // when people start approving without reading.
  it("refuses the overflow rather than dropping a request the operator may be reading", () => {
    const store = new PairingStore();
    const first = store.park(REQ)!;
    for (let i = 1; i < MAX_PENDING; i++) assert.ok(store.park(REQ));
    assert.equal(store.park(REQ), null, "the request that does not fit is the one refused");
    assert.equal(store.pending().length, MAX_PENDING);
    assert.ok(
      store.pending().some((p) => p.code === first.code),
      "and the earliest one is still there",
    );
  });

  it("lets a lapsed request make room again", () => {
    const c = clock();
    const store = new PairingStore({ now: c.now });
    for (let i = 0; i < MAX_PENDING; i++) store.park(REQ);
    c.advance(PENDING_TTL_MS + 1);
    assert.ok(store.park(REQ), "expiry is what keeps a flood from being permanent");
  });

  it("expires a request rather than leaving it approvable", () => {
    const c = clock();
    const store = new PairingStore({ now: c.now });
    const parked = store.park(REQ)!;
    c.advance(PENDING_TTL_MS + 1);
    assert.deepEqual(store.poll(parked.id), { status: "expired" });
    assert.equal(store.approve(parked.code, () => "nope"), null, "an unattended screen is not a standing offer");
    assert.deepEqual(store.pending(), []);
  });

  it("reads an unknown id as expired rather than saying which it is", () => {
    assert.deepEqual(new PairingStore().poll("never-existed"), { status: "expired" });
  });

  // Two identical codes make "which one is mine" unanswerable, which is the code's entire job.
  it("never shows the same code twice at once, even when the source repeats itself", () => {
    let calls = 0;
    // Deterministic and colliding on purpose: the first two draws produce the same code.
    const pick = (n: number): number => {
      calls++;
      return calls <= 6 ? 0 : calls % n;
    };
    const store = new PairingStore({ pick });
    const a = store.park(REQ)!;
    const b = store.park(REQ)!;
    assert.notEqual(a.code, b.code);
  });
});
