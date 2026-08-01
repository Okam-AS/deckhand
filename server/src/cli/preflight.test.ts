import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkPrereqs, humanInput, formatPrereqs, blocking, type Probe } from "./preflight.ts";

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

describe("errands versus questions", () => {
  // Treating these alike produced the wrong behaviour in the field: an agent handed a repo
  // URL filed a STATUS REPORT and quoted a paragraph of English at the user, when all it
  // needed to say was "which domain?". An errand needs a browser and stops you; a question
  // needs one word and does not.
  it("classifies the browser login as a BLOCKER, not a question", () => {
    const h = humanInput(probe({ run: () => ({ code: 1, out: "cert.pem missing" }) }), { hostnameGiven: true });
    assert.equal(h.blockers.length, 1);
    assert.match(h.blockers[0]!, /cloudflared tunnel login/);
    assert.match(h.blockers[0]!, /browser/, "so the agent does not sit waiting on it");
    assert.deepEqual(h.questions, [], "there is nothing to ask — it is an errand");
  });

  it("classifies the hostname as a QUESTION, not a blocker", () => {
    const h = humanInput(probe(), { hostnameGiven: false });
    assert.deepEqual(h.blockers, [], "nothing is broken; the agent is one answer from done");
    assert.equal(h.questions[0]?.flag, "--hostname");
    assert.match(h.questions[0]!.ask, /\?$/, "phrased as a question, because it is one");
    assert.equal(h.questions.find((q) => q.flag === "--web-host")?.optional, true);
  });

  it("has nothing to say once it has both", () => {
    const h = humanInput(probe(), { hostnameGiven: true });
    assert.deepEqual(h.blockers, []);
    assert.deepEqual(h.questions, []);
  });
});

describe("the report an agent relays", () => {
  it("marks each line with who is responsible", () => {
    const p = probe({ which: (cmd) => cmd !== "cloudflared", nodeMajor: 18 });
    const out = formatPrereqs(checkPrereqs(p), humanInput(p, { hostnameGiven: false }));
    assert.match(out, /fix: brew install cloudflared/, "agent-fixable reads as an instruction to run");
    assert.match(out, /you: Install Node 22/, "human-only reads as a request");
  });

  it("tells the agent to ask rather than to paste", () => {
    const p = probe();
    const out = formatPrereqs(checkPrereqs(p), humanInput(p, { hostnameGiven: false }));
    assert.match(out, /ASK THE USER/);
    assert.match(out, /Do NOT paste this report/, "the label is an instruction to whoever is reading it");
    assert.doesNotMatch(out, /BLOCKED/, "nothing is blocked — saying so would stop an agent that could continue");
  });

  it("does not shout when everything is present and answered", () => {
    const p = probe();
    assert.doesNotMatch(formatPrereqs(checkPrereqs(p), humanInput(p, { hostnameGiven: true })), /ASK|BLOCKED|✗|⚠/);
  });
});
