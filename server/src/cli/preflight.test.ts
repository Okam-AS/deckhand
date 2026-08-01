import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkPrereqs, humanOnlySteps, formatPrereqs, blocking, type Probe } from "./preflight.ts";

/**
 * Getting "who can fix this" wrong is the failure this module exists to prevent.
 *
 * An agent handed a repo URL and nothing else will run whatever it is told to. Classify a
 * browser login as agent-fixable and it blocks forever on a prompt nobody sees; classify a
 * `brew install` as human-only and it asks the user to do something it could have done.
 */

const probe = (over: Partial<Probe> = {}): Probe => ({
  which: () => true,
  run: () => ({ code: 0, out: "" }),
  nodeMajor: 22,
  env: {},
  ...over,
});

const byName = (p: Probe, name: string) => checkPrereqs(p).find((c) => c.name.startsWith(name))!;

describe("who can fix what", () => {
  it("says the agent can install cloudflared", () => {
    const c = byName(probe({ which: (cmd) => cmd !== "cloudflared" }), "cloudflared");
    assert.equal(c.ok, false);
    assert.equal(c.fix?.who, "agent");
    assert.match(c.fix!.how, /brew install cloudflared/);
  });

  it("says only a human can install Xcode", () => {
    // App Store, ~10 GB, an Apple ID, and a licence acceptance that needs sudo. An agent
    // claiming to do this would simply be lying.
    const c = byName(probe({ which: (cmd) => cmd !== "xcodebuild" }), "Xcode");
    assert.equal(c.fix?.who, "human");
    assert.match(c.fix!.how, /App Store/);
    assert.match(c.fix!.how, /I cannot/, "and it says so plainly");
  });

  it("says only a human can change the default Node", () => {
    const c = byName(probe({ nodeMajor: 18 }), "node");
    assert.equal(c.ok, false);
    assert.equal(c.fix?.who, "human", "changing the machine's default Node is not deckhand's call");
  });

  it("treats a missing Android SDK as a warning, not a blocker", () => {
    // An iOS-only deckhand is a legitimate, working install. Failing setup over it would
    // stop people who never wanted Android.
    const p = probe({ which: (cmd) => !["adb", "emulator"].includes(cmd) });
    const c = byName(p, "Android");
    assert.equal(c.ok, false);
    assert.equal(c.optional, true);
    assert.deepEqual(blocking(checkPrereqs(p)), [], "nothing here blocks setup");
    assert.equal(c.fix?.who, "agent", "but the agent CAN install it if asked");
  });

  it("accepts an Android SDK reached only through ANDROID_HOME", () => {
    // A common install has the SDK present but not on PATH.
    const p = probe({ which: () => false, env: { ANDROID_HOME: "/opt/android" } });
    assert.equal(byName(p, "Android").ok, true);
  });
});

describe("the NEEDS YOU list", () => {
  it("names the browser login when cloudflared is not authenticated", () => {
    const steps = humanOnlySteps(probe({ run: () => ({ code: 1, out: "cert.pem missing" }) }), { hostnameGiven: true });
    assert.equal(steps.length, 1);
    assert.match(steps[0]!, /cloudflared tunnel login/);
    assert.match(steps[0]!, /browser/, "so the agent does not sit waiting on it");
  });

  it("is silent about login once authenticated", () => {
    assert.deepEqual(humanOnlySteps(probe(), { hostnameGiven: true }), []);
  });

  it("asks for the hostname, because only the user knows their domain", () => {
    const steps = humanOnlySteps(probe(), { hostnameGiven: false });
    assert.match(steps.join(" "), /--hostname/);
  });
});

describe("the report an agent relays", () => {
  it("marks each line with who is responsible", () => {
    const p = probe({ which: (cmd) => cmd !== "cloudflared", nodeMajor: 18 });
    const out = formatPrereqs(checkPrereqs(p), humanOnlySteps(p, { hostnameGiven: false }));
    assert.match(out, /fix: brew install cloudflared/, "agent-fixable reads as an instruction to run");
    assert.match(out, /you: Install Node 22/, "human-only reads as a request");
    assert.match(out, /NEEDS YOU/);
  });

  it("does not shout about optional things that are present", () => {
    assert.doesNotMatch(formatPrereqs(checkPrereqs(probe()), []), /NEEDS YOU|✗|⚠/);
  });
});
