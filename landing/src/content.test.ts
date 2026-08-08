import assert from "node:assert/strict";
import test from "node:test";
import * as content from "./content.ts";

test("v2 pricing keeps the approved commercial model with one universal trial", () => {
  assert.equal(content.trialOffer.amount, "14 days free");
  assert.deepEqual(
    content.paidPricingPlans.map(({ name, amount, cadence, detail }) => ({ name, amount, cadence, detail })),
    [
      {
        name: "Solo",
        amount: "NOK 300",
        cadence: "per month",
        detail: "One developer, up to two machines.",
      },
      {
        name: "Lifetime",
        amount: "NOK 10,000",
        cadence: "one-time",
        detail: "One purchase, up to two machines.",
      },
    ],
  );
});

// One operator per install is a constitutional line, not a product tier
// (CONSTITUTION.md "Who it is for"), so no plan may sell a shared one.
test("no plan sells a team, a seat or shared access", () => {
  const sold = JSON.stringify([content.paidPricingPlans, content.trialOffer, content.productFacts]);
  // Anchored: unanchored this also fired on "steam", "seated" and "unshared", and a check that
  // goes red on correct copy gets deleted rather than fixed.
  assert.doesNotMatch(sold, /\b(teams?|seats?|shared|colleagues?)\b/i);
});

test("local-first product claims stay precise", () => {
  assert.equal(content.productFacts.slogan, "Your code. Always on your machine.");
  assert.equal(content.productFacts.localOwnership, "Your machine · your tester · your code.");
  // There is no backend, no API key and no licence check: /mcp takes a bearer
  // credential and /oauth/authorize takes a pairing code minted by `deckhand pair`.
  assert.equal(content.productFacts.connectorRole, "Public by design");
  assert.equal(content.productFacts.pairingGate, "Pairing code");
  assert.equal(content.productFacts.localRole, "Builds, boots, controls, and streams on your Mac");
  assert.equal(content.productFacts.platforms, "iOS, Android, and web");
  assert.equal(content.proofFacts.length, 4);
  assert.deepEqual(
    content.runTargets.map(({ id, kind }) => ({ id, kind })),
    [
      { id: "ios", kind: "device" },
      { id: "android", kind: "device" },
      { id: "web", kind: "process" },
    ],
  );
});

test("trial requests use the verified GitHub issue composer", () => {
  const href = content.buildTrialRequestHref("Solo");
  assert.match(href, /^https:\/\/github\.com\/Okam-AS\/deckhand\/issues\/new\?/);
  assert.match(href, /Solo/);
});
