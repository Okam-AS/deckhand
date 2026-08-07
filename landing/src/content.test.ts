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
        name: "Team",
        amount: "NOK 275",
        cadence: "per seat / month",
        detail: "Minimum two seats. Support included.",
      },
      {
        name: "Lifetime",
        amount: "NOK 10,000",
        cadence: "one-time",
        detail: "One API key, up to two machines.",
      },
    ],
  );
});

test("local-first product claims stay precise", () => {
  assert.equal(content.productFacts.slogan, "Your code. Always on your machine.");
  assert.equal(content.productFacts.localOwnership, "Your machine · your tester · your code.");
  assert.equal(content.productFacts.cloudRole, "Validates your API key");
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
  const href = content.buildTrialRequestHref("Team");
  assert.match(href, /^https:\/\/github\.com\/Okam-AS\/deckhand\/issues\/new\?/);
  assert.match(href, /Team/);
});
