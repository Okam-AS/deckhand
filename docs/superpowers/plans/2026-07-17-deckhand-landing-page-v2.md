# Deckhand Landing Page V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing Deckhand landing page into a proof-led V2 centered on “Your code. Always on your machine.”

**Architecture:** Keep the existing React/Vite marketing workspace and static content model. Extract the new interactive product theatre and device-lab stage into focused components, keep verified commercial/product facts in `content.ts`, and use pure state helpers so behavior can be tested without adding a browser-testing dependency.

**Tech Stack:** React 19, TypeScript 5.7, Vite 6, Node test runner, CSS

## Global Constraints

- The central slogan is exactly `Your code. Always on your machine.`
- Deckhand is described as a fully local device tester owned and run on the developer's Mac.
- The remote backend is described only as API-key validation.
- Source, builds, devices, previews, and streams remain on the developer's Mac.
- Keep the existing warm technical brand, generated hero artwork, and dependency set.
- Do not fabricate customers, metrics, screenshots, guarantees, or performance claims.
- Preserve keyboard access, visible focus, reduced-motion behavior, and support down to 320 px.
- Trial requests open the verified `ainfrastructure/deckhand` GitHub new-issue composer and do not submit anything automatically.

---

### Task 1: Reshape the verified content model

**Files:**
- Modify: `landing/src/content.ts`
- Modify: `landing/src/content.test.ts`

**Interfaces:**
- Produces: `productFacts.slogan`, `productFacts.localOwnership`, `proofFacts`, `theatreStates`, `paidPricingPlans`, `trialOffer`, and `buildTrialRequestHref(plan: string): string`
- Consumes: Existing pricing and platform types

- [ ] **Step 1: Write failing content tests**

Update `landing/src/content.test.ts` to require the V2 slogan, local-ownership copy, three paid plans, universal trial offer, four proof facts, three theatre states, and a GitHub issue-composer URL:

```ts
assert.equal(productFacts.slogan, "Your code. Always on your machine.");
assert.equal(productFacts.localOwnership, "Your machine · your tester · your code.");
assert.equal(trialOffer.amount, "14 days free");
assert.deepEqual(paidPricingPlans.map((plan) => plan.name), ["Solo", "Team", "Lifetime"]);
assert.equal(proofFacts.length, 4);
assert.deepEqual(theatreStates.map((state) => state.id), ["request", "devices", "share"]);
assert.match(buildTrialRequestHref("Team"), /^https:\/\/github\.com\/ainfrastructure\/deckhand\/issues\/new\?/);
assert.match(buildTrialRequestHref("Team"), /Team/);
```

- [ ] **Step 2: Run the content tests and verify failure**

Run:

```bash
npm run test --workspace @deckhand/landing
```

Expected: FAIL because the V2 exports do not exist.

- [ ] **Step 3: Implement the V2 content model**

In `landing/src/content.ts`:

- Remove Trial from `PricingPlan["name"]`.
- Rename `pricingPlans` to `paidPricingPlans`.
- Add a `TrialOffer` object with `amount: "14 days free"`.
- Add typed `ProofFact` and `TheatreState` arrays.
- Extend `productFacts` with the exact slogan and local-ownership label.
- Add:

```ts
export function buildTrialRequestHref(plan: string): string {
  const query = new URLSearchParams({
    title: `Trial access request · ${plan}`,
    body: `I'd like to request Deckhand trial access for the ${plan} plan.`,
  });
  return `https://github.com/ainfrastructure/deckhand/issues/new?${query.toString()}`;
}
```

- [ ] **Step 4: Run content tests and typecheck**

Run:

```bash
npm run test --workspace @deckhand/landing
npm run typecheck --workspace @deckhand/landing
```

Expected: PASS.

- [ ] **Step 5: Commit the content model**

```bash
git add landing/src/content.ts landing/src/content.test.ts
git commit -m "feat(landing): define local-first v2 content"
```

---

### Task 2: Build the hero product theatre and proof strip

**Files:**
- Create: `landing/src/ProductTheatre.tsx`
- Create: `landing/src/ProofStrip.tsx`
- Create: `landing/src/product-theatre.test.ts`
- Modify: `landing/src/App.tsx`
- Modify: `landing/src/global.css`

**Interfaces:**
- Consumes: `TheatreState[]`, `ProofFact[]`, and `productFacts` from `content.ts`
- Produces: `ProductTheatre({ states }: { states: readonly TheatreState[] })` and `ProofStrip({ facts }: { facts: readonly ProofFact[] })`

- [ ] **Step 1: Write failing static-markup tests**

Use `renderToStaticMarkup` and `createElement` in `product-theatre.test.ts` to verify:

```ts
const theatre = renderToStaticMarkup(createElement(ProductTheatre, { states: theatreStates }));
assert.match(theatre, /Open onboarding on iOS \+ Android/);
assert.match(theatre, /iOS ready/);
assert.match(theatre, /Android ready/);
assert.match(theatre, /Web ready/);
assert.match(theatre, /Stable share link/);

const proof = renderToStaticMarkup(createElement(ProofStrip, { facts: proofFacts }));
assert.match(proof, /Fully local tester/);
assert.match(proof, /Build once per platform/);
```

- [ ] **Step 2: Run the component test and verify failure**

Run:

```bash
npm run test --workspace @deckhand/landing
```

Expected: FAIL because the components do not exist.

- [ ] **Step 3: Implement the components**

`ProductTheatre` renders the existing generated image as atmosphere plus a semantic
viewer panel containing all three deterministic states. Use CSS animation delays to
emphasize one state at a time while leaving all content in the DOM.

`ProofStrip` renders a four-item list with a status dot, label, and description.

Update `Hero` in `App.tsx` to use:

```tsx
<div className="eyebrow"><SparkIcon />The fully local device tester for coding agents</div>
<h1>Your code. <span>Always on your machine.</span></h1>
<p className="hero-promise">Your app. Any device. One prompt.</p>
<ProductTheatre states={theatreStates} />
```

Render `<ProofStrip facts={proofFacts} />` immediately after `<Hero />`.

- [ ] **Step 4: Style and verify the hero**

Add CSS for `.hero-promise`, `.product-theatre`, `.theatre-viewer`, `.theatre-state`,
`.theatre-device-row`, and `.proof-strip`. The animation must be disabled under
`prefers-reduced-motion` and the last state must remain visible.

Run:

```bash
npm run test --workspace @deckhand/landing
npm run typecheck --workspace @deckhand/landing
```

Expected: PASS.

- [ ] **Step 5: Commit the hero**

```bash
git add landing/src/ProductTheatre.tsx landing/src/ProofStrip.tsx landing/src/product-theatre.test.ts landing/src/App.tsx landing/src/global.css
git commit -m "feat(landing): add local-first product theatre"
```

---

### Task 3: Strengthen workflow and architecture ownership

**Files:**
- Create: `landing/src/app-v2.test.ts`
- Modify: `landing/src/App.tsx`
- Modify: `landing/src/global.css`

**Interfaces:**
- Consumes: `productFacts.localOwnership` and existing workflow steps
- Produces: A visual request-to-share signal and dominant local architecture boundary

- [ ] **Step 1: Add failing copy assertions**

Render `App` with `renderToStaticMarkup` in a new test and assert:

```ts
assert.match(markup, /Agent request/);
assert.match(markup, /Local MCP server/);
assert.match(markup, /Device previews/);
assert.match(markup, /Stable share link/);
assert.match(markup, /Your machine · your tester · your code/);
assert.match(markup, /backend validates your API key/);
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm run test --workspace @deckhand/landing
```

Expected: FAIL on the new V2 workflow and architecture copy.

- [ ] **Step 3: Implement workflow and architecture updates**

Add a semantic ordered `.workflow-signal` list with the four exact nodes. Update
`LocalFirst` so the cloud card is compact, the local card uses
`productFacts.localOwnership`, and the explanatory sentence reads:

```text
The backend validates your API key; source, builds, devices, previews, and streams remain on your Mac.
```

- [ ] **Step 4: Run tests and typecheck**

Run:

```bash
npm run test --workspace @deckhand/landing
npm run typecheck --workspace @deckhand/landing
```

Expected: PASS.

- [ ] **Step 5: Commit workflow and architecture**

```bash
git add landing/src/app-v2.test.ts landing/src/App.tsx landing/src/global.css
git commit -m "feat(landing): emphasize local ownership flow"
```

---

### Task 4: Replace platform cards with a unified device-lab stage

**Files:**
- Create: `landing/src/DeviceLabStage.tsx`
- Create: `landing/src/device-lab.test.ts`
- Modify: `landing/src/App.tsx`
- Modify: `landing/src/global.css`

**Interfaces:**
- Consumes: `Platform[]` from `content.ts`
- Produces: `type DeviceFilter = "all" | Platform["id"]`, `getVisiblePlatformIds(filter, platforms): Platform["id"][]`, and `DeviceLabStage`

- [ ] **Step 1: Write failing state-helper tests**

Verify:

```ts
assert.deepEqual(getVisiblePlatformIds("all", platforms), ["ios", "android", "web"]);
assert.deepEqual(getVisiblePlatformIds("ios", platforms), ["ios"]);
assert.deepEqual(getVisiblePlatformIds("android", platforms), ["android"]);
assert.deepEqual(getVisiblePlatformIds("web", platforms), ["web"]);
```

Render static markup and assert that the control uses `role="tablist"` and all three
platform status strings are present.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm run test --workspace @deckhand/landing
```

Expected: FAIL because `DeviceLabStage` and its helper do not exist.

- [ ] **Step 3: Implement the stage**

Use local React state for the selected filter. Render four buttons (`All devices`,
`iOS`, `Android`, `Web`) with `aria-selected`. Keep every device in the DOM and use
`data-active` plus CSS to emphasize matching frames. Do not hide non-selected content
from assistive technology.

Replace `PlatformGrid` with `DeviceLabStage`.

- [ ] **Step 4: Style and verify**

Create one shared panel with phone, Android, and browser frames, truthful status labels,
and a compact filter control. Under 480 px, show the selected device prominently and
reduce the others without horizontal overflow.

Run:

```bash
npm run test --workspace @deckhand/landing
npm run typecheck --workspace @deckhand/landing
```

Expected: PASS.

- [ ] **Step 5: Commit the stage**

```bash
git add landing/src/DeviceLabStage.tsx landing/src/device-lab.test.ts landing/src/App.tsx landing/src/global.css
git commit -m "feat(landing): unify device lab presentation"
```

---

### Task 5: Simplify pricing and create an honest conversion path

**Files:**
- Modify: `landing/src/App.tsx`
- Modify: `landing/src/global.css`
- Modify: `landing/src/app-v2.test.ts`

**Interfaces:**
- Consumes: `trialOffer`, `paidPricingPlans`, and `buildTrialRequestHref`
- Produces: A universal trial banner, three pricing cards, and direct request actions

- [ ] **Step 1: Write failing markup assertions**

Assert that the rendered app has one `14 days free` trial banner, exactly three pricing
card headings, a `Request a trial key` final action, and GitHub issue URLs containing
the selected plan.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm run test --workspace @deckhand/landing
```

Expected: FAIL because pricing still renders four equal cards and in-page CTA loops.

- [ ] **Step 3: Implement pricing V2**

Render `TrialBanner` above a three-card grid. Use `buildTrialRequestHref(plan.name)` for
each plan action, `target="_blank"`, and `rel="noreferrer"`. Update the header, hero, and
final CTA to request trial access through the same helper. Add nearby text:

```text
Trial access is currently provisioned directly.
```

- [ ] **Step 4: Run tests and typecheck**

Run:

```bash
npm run test --workspace @deckhand/landing
npm run typecheck --workspace @deckhand/landing
```

Expected: PASS.

- [ ] **Step 5: Commit pricing**

```bash
git add landing/src/App.tsx landing/src/global.css landing/src/app-v2.test.ts
git commit -m "feat(landing): simplify trial and pricing flow"
```

---

### Task 6: Finish responsive polish and verify the launch candidate

**Files:**
- Modify: `landing/src/global.css`
- Modify: `landing/src/App.tsx` only if browser inspection finds a semantic defect

**Interfaces:**
- Consumes: All V2 sections
- Produces: A visually finished, responsive, accessible V2

- [ ] **Step 1: Run automated verification**

Run:

```bash
npm run test --workspace @deckhand/landing
npm run typecheck --workspace @deckhand/landing
npm run build --workspace @deckhand/landing
npm test
npm run typecheck
npm run build
```

Expected: all commands PASS.

- [ ] **Step 2: Inspect desktop and responsive layouts**

Open the local Vite page and inspect at large desktop, 960 px, 720 px, 390 px, and
320 px. Check hero hierarchy, theatre readability, proof-strip rhythm, workflow signal,
device controls, pricing, final CTA, and footer.

- [ ] **Step 3: Verify interaction and accessibility**

Use keyboard navigation through the header, device filter, pricing actions, and final
CTA. Confirm visible focus, truthful external-action labels, reduced-motion static
state, no console errors, and no horizontal overflow.

- [ ] **Step 4: Apply only evidence-driven polish**

Adjust spacing, type scale, stage proportions, and breakpoints in `global.css` based on
the rendered defects found in Steps 2–3. Do not add new sections or claims.

- [ ] **Step 5: Re-run final verification**

Run:

```bash
npm run test --workspace @deckhand/landing
npm run typecheck --workspace @deckhand/landing
npm run build --workspace @deckhand/landing
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: PASS with a clean diff check.

- [ ] **Step 6: Commit the launch candidate**

```bash
git add landing/src/App.tsx landing/src/global.css
git commit -m "fix(landing): polish v2 responsive presentation"
```
