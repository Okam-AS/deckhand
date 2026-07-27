# Deckhand Landing Page V2 Final Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the misleading layered hero and placeholder device lab with a product-faithful, premium local-run presentation.

**Architecture:** `ProductTheatre` becomes a single-image hero canvas with a caption rail. `DeviceLabStage` becomes a stateless orchestration console driven by explicit run data from `content.ts`; React renders the request, simultaneous mobile targets, web process, and stable output as one honest sequence.

**Tech Stack:** React 19, TypeScript, CSS, Node test runner, Vite

## Global Constraints

- Do not add dependencies.
- Do not depict fabricated app screens.
- Do not add platform filters or tabs.
- Web must be labeled as a local dev-server process, not a simulator.
- Preserve pricing, trial request links, security copy, and the generated hero asset.

---

### Task 1: Lock the Honest Product Markup

**Files:**
- Modify: `landing/src/product-theatre.test.ts`
- Modify: `landing/src/device-lab.test.ts`
- Modify: `landing/src/content.ts`
- Modify: `landing/src/ProductTheatre.tsx`
- Modify: `landing/src/DeviceLabStage.tsx`

**Interfaces:**
- Consumes: `platforms` and `theatreStates` from `content.ts` during the transition.
- Produces: `runTargets`, `RunTarget`, a non-overlapping `ProductTheatre`, and stateless `DeviceLabStage` markup.

- [ ] **Step 1: Write failing regression tests**

Assert that rendered markup has no `tablist`, no `device-preview-screen`, no `theatre-viewer`, and does contain `LOCAL · YOUR MAC`, simultaneous iOS/Android targets, `Local web process`, and `One stable viewer URL`.

- [ ] **Step 2: Verify the tests fail for the old implementation**

Run: `npm test --workspace @deckhand/landing`

Expected: the new negative assertions fail because the tabs, skeletons, and layered viewer still render.

- [ ] **Step 3: Implement the minimal semantic components**

Add typed run target data with `kind: "device" | "process"`, concrete target labels, phases, and proof. Render the hero asset with a caption rail and render one orchestration console with request, target, and output regions.

- [ ] **Step 4: Verify the semantic tests pass**

Run: `npm test --workspace @deckhand/landing`

Expected: all landing tests pass.

- [ ] **Step 5: Commit**

Run: `git add landing/src && git commit -m "feat(landing): replace placeholder device lab"`

### Task 2: Finish the Visual System

**Files:**
- Modify: `landing/src/global.css`

**Interfaces:**
- Consumes: class names introduced in Task 1.
- Produces: responsive hero canvas and local-run console at desktop and mobile breakpoints.

- [ ] **Step 1: Add a source-level CSS regression assertion**

Assert that obsolete selectors `.device-lab-controls`, `.device-preview-screen`, and `.theatre-viewer` are absent and new `.run-console`, `.run-targets`, and `.hero-art-caption` selectors exist.

- [ ] **Step 2: Verify the CSS assertion fails**

Run: `npm test --workspace @deckhand/landing`

Expected: failure reports obsolete selectors in `global.css`.

- [ ] **Step 3: Replace obsolete V2 CSS**

Build a standalone framed hero image, a horizontally structured orchestration console, concrete status rows, a stable URL output, and mobile stacking under `570px`. Remove old overlap, filter, skeleton, and theatre animation rules.

- [ ] **Step 4: Run automated verification**

Run: `npm test --workspace @deckhand/landing && npm run typecheck --workspace @deckhand/landing && npm run build --workspace @deckhand/landing`

Expected: zero test failures, zero type errors, and Vite build exit code 0.

- [ ] **Step 5: Commit**

Run: `git add landing/src/global.css landing/src/*.test.ts && git commit -m "style(landing): finish local run presentation"`

### Task 3: Browser QA and Polish

**Files:**
- Modify if required by observed defects: `landing/src/global.css`, `landing/src/*.tsx`

**Interfaces:**
- Consumes: the completed local page at `http://127.0.0.1:5173/`.
- Produces: a verified deliverable browser tab.

- [ ] **Step 1: Inspect desktop at the current browser viewport**

Reload the page, inspect hero and local-run section, and verify no overlap, clipping, placeholder screens, or tabs.

- [ ] **Step 2: Inspect mobile at 390 × 844**

Verify request, mobile targets, web process, and stable URL stack without horizontal overflow.

- [ ] **Step 3: Fix any observed defects and rerun automated checks**

Run: `npm test --workspace @deckhand/landing && npm run typecheck --workspace @deckhand/landing && npm run build --workspace @deckhand/landing`

Expected: all commands exit 0.

- [ ] **Step 4: Check console and finalize the page**

Verify no browser console errors and keep the corrected local landing-page tab as the deliverable.

