# Deckhand Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a polished English-language Deckhand marketing site with original hero artwork, accurate product messaging, and the approved four-tier pricing.

**Architecture:** Add a standalone `landing/` React + Vite workspace so marketing code and assets cannot affect the existing preview viewer. Keep product and pricing facts in a typed data module, render them through focused presentational sections, and use one generated raster hero asset alongside code-native interface details.

**Tech Stack:** Node 22+, TypeScript 5.7, React 19, Vite 6, native `node:test`, CSS, GPT Image

## Global Constraints

- All customer-facing copy, metadata, labels, and generated visual direction are English.
- Preserve the existing warm Deckhand identity: aubergine backgrounds, cream type, and restrained amber, coral, and sage accents.
- The API backend validates the API key; source, builds, device control, and streams remain on the developer's machine.
- Show Trial as free for 14 days.
- Show Solo as NOK 300/month for up to two machines.
- Show Team as NOK 275/seat/month with a two-seat minimum and support included.
- Show Lifetime as NOK 10,000 once for one API key on up to two machines.
- Mention free access for public repositories only as an idea being explored.
- Do not invent VAT terms, cancellation terms, support SLAs, customer logos, testimonials, or usage statistics.
- Keep dependencies minimal and do not change existing viewer behavior.
- Support 320 px through large desktop widths, keyboard focus, semantic landmarks, and reduced motion.

---

### Task 1: Generate and validate the hero visual

**Files:**
- Create: `landing/public/deckhand-hero.png`

**Interfaces:**
- Consumes: The visual direction in `docs/superpowers/specs/2026-07-17-deckhand-landing-page-design.md`
- Produces: `/deckhand-hero.png`, a landscape raster image used by the hero component

- [ ] **Step 1: Generate the first hero artwork**

Use the built-in GPT Image tool with this exact brief:

```text
Use case: stylized-concept
Asset type: premium developer-tool landing page hero
Primary request: visualize Deckhand as a local control center that turns one coding-agent request into live previews across an iPhone simulator, an Android emulator, and a web browser
Scene/backdrop: an elegant dark developer workstation in an abstract warm technical space, with the Mac as the grounded central source and three coordinated device surfaces emerging around it
Style/medium: cinematic high-end 3D editorial illustration, refined and tactile rather than photorealistic
Composition/framing: wide landscape composition; product cluster weighted slightly right of center; generous quiet negative space; clear depth; no cropped devices
Lighting/mood: calm, capable, private, warm amber and coral edge light against deep aubergine shadows
Color palette: #241b20, #31242a, warm cream, amber, muted coral, tiny sage status accents
Materials/textures: dark anodized metal, soft glass, subtle paper grain, restrained translucent light paths
Constraints: depict a single request flowing from the local Mac into iOS, Android, and browser surfaces; UI screens may contain abstract shapes only; no people; no text; no letters; no logos; no brand marks; no watermark
Avoid: blue SaaS gradients, neon cyberpunk, floating crypto imagery, server racks, clouds, robots, hands, excessive glow, illegible fake text, generic stock-photo look
```

Expected: One polished landscape image with no visible text or logos.

- [ ] **Step 2: Inspect the generated image**

Open the generated result and verify:

- the Mac reads as the local control center;
- iPhone, Android, and browser surfaces are visually distinct;
- there is no legible text, watermark, or third-party branding;
- the palette can blend into `#241b20`;
- the composition remains readable when displayed at roughly 680 px wide.

Expected: Every check passes. If one check fails, make one targeted image edit and inspect again.

- [ ] **Step 3: Save the selected asset in the project**

Copy the final generated output to:

```text
landing/public/deckhand-hero.png
```

Run:

```bash
file landing/public/deckhand-hero.png
sips -g pixelWidth -g pixelHeight landing/public/deckhand-hero.png
```

Expected: A valid PNG with landscape dimensions and at least 1024 px width.

- [ ] **Step 4: Commit the asset**

```bash
git add landing/public/deckhand-hero.png
git commit -m "assets: add Deckhand landing hero"
```

### Task 2: Scaffold the isolated landing workspace and lock product facts

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `landing/package.json`
- Create: `landing/tsconfig.json`
- Create: `landing/vite.config.ts`
- Create: `landing/index.html`
- Create: `landing/src/main.tsx`
- Create: `landing/src/content.ts`
- Create: `landing/src/content.test.ts`

**Interfaces:**
- Consumes: Product facts from `README.md` and `PLAN.md`
- Produces: `pricingPlans`, `platforms`, and `workflowSteps` typed content arrays for `App.tsx`

- [ ] **Step 1: Write the failing product-content test**

Create `landing/src/content.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { pricingPlans, productFacts } from "./content.ts";

test("pricing matches the approved commercial model", () => {
  assert.deepEqual(
    pricingPlans.map(({ name, amount, cadence, detail }) => ({ name, amount, cadence, detail })),
    [
      { name: "Trial", amount: "Free", cadence: "for 14 days", detail: "Explore the complete local workflow before you commit." },
      { name: "Solo", amount: "NOK 300", cadence: "per month", detail: "One developer, up to two machines." },
      { name: "Team", amount: "NOK 275", cadence: "per seat / month", detail: "Minimum two seats. Support included." },
      { name: "Lifetime", amount: "NOK 10,000", cadence: "one-time", detail: "One API key, up to two machines." },
    ],
  );
});

test("local-first product claims stay precise", () => {
  assert.equal(productFacts.cloudRole, "Validates your API key");
  assert.equal(productFacts.localRole, "Builds, boots, controls, and streams on your Mac");
  assert.equal(productFacts.platforms, "iOS, Android, and web");
});
```

- [ ] **Step 2: Add the workspace scripts and run the test to verify failure**

Add `landing` to root `workspaces`, then create `landing/package.json` with:

```json
{
  "name": "@deckhand/landing",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "node --import tsx --test \"src/**/*.test.ts\"",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.4",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vite": "^6.0.5"
  }
}
```

Run:

```bash
npm install
npm run test --workspace @deckhand/landing
```

Expected: FAIL because `landing/src/content.ts` does not exist.

- [ ] **Step 3: Implement typed content and the Vite entry point**

Create `pricingPlans`, `productFacts`, `workflowSteps`, and `platforms` in
`landing/src/content.ts`. The values asserted above are exact. Add:

```ts
export interface PricingPlan {
  name: "Trial" | "Solo" | "Team" | "Lifetime";
  amount: string;
  cadence: string;
  detail: string;
  features: readonly string[];
  featured?: boolean;
  cta: string;
}
```

Create `landing/tsconfig.json` by extending `../tsconfig.base.json`, with DOM libraries,
`jsx: "react-jsx"`, `module: "ESNext"`, and `moduleResolution: "bundler"`. Create a standard
React Vite config, an English `index.html` with the approved title and description, and a
`main.tsx` that renders `<App />` inside `StrictMode`.

- [ ] **Step 4: Run the content test and typecheck**

Run:

```bash
npm run test --workspace @deckhand/landing
npm run typecheck --workspace @deckhand/landing
```

Expected: both commands pass.

- [ ] **Step 5: Commit the scaffold and content contract**

```bash
git add package.json package-lock.json landing
git commit -m "feat(landing): scaffold marketing workspace"
```

### Task 3: Build the complete responsive landing page

**Files:**
- Create: `landing/src/App.tsx`
- Create: `landing/src/icons.tsx`
- Create: `landing/src/global.css`

**Interfaces:**
- Consumes: `pricingPlans`, `productFacts`, `workflowSteps`, and `platforms` from `content.ts`
- Produces: The complete single-page site rendered by `main.tsx`

- [ ] **Step 1: Add a failing production-build check**

Run:

```bash
npm run build --workspace @deckhand/landing
```

Expected: FAIL because `main.tsx` imports the not-yet-created `App.tsx`.

- [ ] **Step 2: Implement the semantic page structure**

Build `App.tsx` with these landmarks and IDs:

```tsx
<>
  <a className="skip-link" href="#main">Skip to content</a>
  <Header />
  <main id="main">
    <Hero />
    <Workflow id="product" />
    <LocalFirst id="security" />
    <PlatformGrid />
    <Pricing id="pricing" />
    <FinalCta />
  </main>
  <Footer />
</>
```

Use the approved copy, the content arrays, `/deckhand-hero.png`, and only in-page links
for CTAs. The hero must contain:

```text
Local device infrastructure for coding agents
Your app. Any device. One prompt.
Deckhand lets your coding agent build, boot, and control iOS simulators, Android emulators, and web previews — securely on your own Mac.
```

The workflow prompt example must be:

```text
Test the onboarding flow on iOS 26 and Android 14. Then send me the live preview.
```

The local-first section must distinguish the API-key validation backend from the local
MCP server without claiming that no data ever crosses the share tunnel.

- [ ] **Step 3: Add focused, dependency-free icons**

Create `icons.tsx` with small accessible inline SVG components for Arrow, Check, Apple,
Android, Browser, Lock, Terminal, and Spark. Set decorative icons to `aria-hidden="true"`
and do not imitate third-party trademark artwork beyond simple platform cues.

- [ ] **Step 4: Implement the full visual system**

Create `global.css` with:

- warm Deckhand design tokens derived from the viewer;
- an editorial display face using a resilient local serif stack;
- a responsive two-column hero that stacks below 900 px;
- a framed hero image blended through a mask/gradient rather than shown as a plain rectangle;
- a lightweight animated signal path and status indicators;
- three-step workflow, local-first architecture panel, platform grid, and four pricing cards;
- a featured Team plan that remains readable without hover;
- visible `:focus-visible` states, 44 px minimum interactive targets, and a skip link;
- responsive breakpoints that eliminate horizontal overflow at 320 px;
- `@media (prefers-reduced-motion: reduce)` that disables decorative animation and smooth scrolling;
- no carousel, modal, or JavaScript-dependent animation.

- [ ] **Step 5: Run package verification**

Run:

```bash
npm run test --workspace @deckhand/landing
npm run typecheck --workspace @deckhand/landing
npm run build --workspace @deckhand/landing
```

Expected: all commands pass and `landing/dist/` contains `index.html`, bundled assets, and
`deckhand-hero.png`.

- [ ] **Step 6: Commit the page**

```bash
git add landing
git commit -m "feat(landing): build Deckhand marketing page"
```

### Task 4: Browser QA and whole-repository verification

**Files:**
- Modify: `landing/src/App.tsx` only if rendered copy or semantics need correction
- Modify: `landing/src/global.css` only if rendered layout needs correction
- Modify: `landing/public/deckhand-hero.png` only if the selected image fails in context

**Interfaces:**
- Consumes: The production-ready landing page from Task 3
- Produces: A visually inspected page with no known desktop/mobile regressions

- [ ] **Step 1: Start the landing dev server**

Run:

```bash
npm run dev --workspace @deckhand/landing -- --host 127.0.0.1
```

Expected: Vite reports a loopback URL and no startup errors.

- [ ] **Step 2: Inspect desktop rendering**

Open the page at 1440 × 1000 and inspect:

- hero hierarchy, generated image crop, and first-viewport balance;
- navigation and anchor targets;
- exact pricing values and Team minimum;
- local/cloud architecture wording;
- focus states, console errors, broken images, and overflow.

Expected: no clipping, broken assets, console errors, or accidental fake claims.

- [ ] **Step 3: Inspect mobile rendering**

Open the page at 390 × 844 and inspect the same items, plus:

- header fit;
- readable hero line breaks;
- single-column pricing order;
- 44 px tap targets;
- no horizontal scrolling.

Expected: no overlap or horizontal overflow.

- [ ] **Step 4: Iterate on the rendered result**

Make the smallest CSS or copy change for each observed issue, then repeat both viewport
checks. Continue until the page feels deliberate at both sizes.

- [ ] **Step 5: Run final verification from a clean command**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
git status --short
```

Expected: all repository tests, typechecks, and builds pass; `git diff --check` is silent;
only intended landing-page files are modified.

- [ ] **Step 6: Commit QA fixes**

```bash
git add landing package.json package-lock.json
git commit -m "fix(landing): polish responsive presentation"
```
