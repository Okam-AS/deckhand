import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { App } from "../config.ts";
import { checkNavigateEgress } from "../cli/doctor.ts";
import { JevClient } from "./jev.ts";
import { navigate } from "./loop.ts";
import { egressApps, egressStatus } from "./egress.ts";

/**
 * Everything on this screen that must never reach TypeSafe. The screen mixes both backends'
 * shapes: iOS AX keys and an Android uiautomator EditText, whose `text` IS what was typed.
 */
const SECRETS = {
  typedIos: "ola.nordmann@example.com",
  typedAndroid: "kari.typed.value",
  password: "hunter2-Sup3rS3cret",
  paragraph: "Your order 7781 will be delivered to Storgata 1, 0155 Oslo on Monday between nine and noon.",
  email: "someone@firma.no",
  phone: "+47 912 34 567",
  nationalId: "01019912345",
  card: "4111 1111 1111 1111",
  cardDashed: "5500-0000-0000-0004",
};

const tree = {
  roots: [
    {
      role: "Application",
      frame: { x: 0, y: 0, width: 400, height: 800 },
      children: [
        { role: "Heading", label: "Checkout", frame: { x: 0, y: 40, width: 400, height: 40 } },
        { AXRole: "AXTextField", AXLabel: "Email", AXValue: SECRETS.typedIos, frame: { x: 0, y: 100, width: 400, height: 40 } },
        { type: "EditText", className: "android.widget.EditText", text: SECRETS.typedAndroid, AXLabel: SECRETS.typedAndroid, hint: "Name", frame: { x: 0, y: 150, width: 400, height: 40 } },
        { role: "SecureTextField", label: "Password", value: SECRETS.password, frame: { x: 0, y: 200, width: 400, height: 40 } },
        { type: "EditText", className: "android.widget.EditText", text: SECRETS.typedAndroid, AXLabel: SECRETS.typedAndroid, frame: { x: 0, y: 170, width: 400, height: 20 } },
        { type: "EditText", password: true, contentDescription: "PIN", text: SECRETS.password, frame: { x: 0, y: 250, width: 400, height: 40 } },
        { role: "StaticText", label: SECRETS.paragraph, frame: { x: 0, y: 300, width: 400, height: 80 } },
        { role: "Heading", label: SECRETS.paragraph, frame: { x: 0, y: 380, width: 400, height: 40 } },
        { role: "Button", label: `Contact ${SECRETS.email}`, frame: { x: 0, y: 430, width: 400, height: 40 } },
        { role: "Button", label: `Call ${SECRETS.phone}`, frame: { x: 0, y: 480, width: 400, height: 40 } },
        { role: "Cell", label: `Fødselsnummer ${SECRETS.nationalId}`, frame: { x: 0, y: 530, width: 400, height: 40 } },
        { role: "Cell", label: `Visa ${SECRETS.card}`, id: `card-${SECRETS.cardDashed}`, frame: { x: 0, y: 580, width: 400, height: 40 } },
        { role: "Button", label: "Pay", frame: { x: 0, y: 700, width: 400, height: 40 } },
      ],
    },
  ],
};

describe("what navigate sends to TypeSafe", () => {
  it("never carries a field value, a secure field, long static text or a masked pattern in the request body", async () => {
    const bodies: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      bodies.push(String(init?.body));
      const criteria = (JSON.parse(String(init?.body)) as { questions: { next: { criteria: Record<string, unknown> } } }).questions.next.criteria;
      const stuck = Object.keys(criteria).find((k) => k.startsWith("stuck"))!;
      return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { next: { type: "choice", choice: stuck, probabilities: { [stuck]: 1 }, confidence: 1 } } }), { status: 200 });
    };
    const r = await navigate(
      { goal: `Pay with the card ${SECRETS.card} and send the receipt to ${SECRETS.email}`, maxSteps: 3, text: { email: SECRETS.typedIos } },
      { describe: async () => tree, act: async () => {}, jev: new JevClient({ apiKey: "k", fetchImpl }) },
    );
    assert.equal(bodies.length, 1, r.message);
    const body = bodies[0]!;
    const digits = (s: string) => s.replace(/\D/g, "");
    for (const [name, secret] of Object.entries(SECRETS)) {
      assert.ok(!body.includes(secret), `${name} reached the request body`);
      if (digits(secret).length >= 6) assert.ok(!digits(body).includes(digits(secret)), `${name}'s digits reached the request body`);
    }
    assert.ok(!body.includes(SECRETS.paragraph.slice(0, 20)), "no part of a long text is sent, not even clipped");
    assert.ok(!body.includes("Password") && !body.includes("PIN"), "a secure field is sent as its role alone");
    for (const kept of ["Checkout", "Email", "Name", "Pay", "[email]", "[number]"]) assert.ok(body.includes(kept), `${kept} is what the decider needs`);
  });
});

describe("egress consent", () => {
  const app = (id: string, navigateEgress?: boolean): App => ({ id, path: "/x", type: "expo", defaultBranch: "main", env: {}, ...(navigateEgress ? { navigateEgress } : {}) });

  it("lists only the apps the operator enabled", () => {
    assert.deepEqual(egressApps([app("a"), app("b", true), app("c")]), ["b"]);
  });

  it("puts a doctor line on every install, a warning only while screens can leave the machine", () => {
    const off = checkNavigateEgress([app("a")], { state: "ok", key: "k" });
    assert.equal(off.name, "navigate egress");
    assert.ok(off.ok && !off.warn);
    assert.match(off.detail!, /off for every app/);
    const noKey = checkNavigateEgress([app("b", true)], { state: "missing" });
    assert.ok(!noKey.warn);
    assert.match(noKey.detail!, /b.*no TypeSafe key/);
    const on = checkNavigateEgress([app("a"), app("b", true)], { state: "ok", key: "k" });
    assert.ok(on.ok && on.warn);
    assert.match(on.detail!, /api\.typesafe\.ai.*for: b\b/);
    assert.equal(egressStatus([app("b", true)], { state: "error", message: "x" }).sending, false, "an unreadable key sends nothing");
  });
});
