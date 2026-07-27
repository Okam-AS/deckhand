# Deckhand Landing Page Design

## Goal

Create a distinctive English-language landing page that explains Deckhand in under a
minute and turns interested developers into trial users. The page should make the
local-first architecture feel simple: an API-key backend validates access, while the
Deckhand MCP server runs on the developer's own machine and controls local iOS
simulators, Android emulators, and web previews.

## Audience

The primary audience is mobile and web developers, technical founders, and small
product teams already using an MCP-capable coding agent. They understand pull requests,
simulators, and emulators, but should not need to know Deckhand's internal architecture.

## Positioning

Deckhand is the local device lab for coding agents.

The opening promise is:

> Your app. Any device. One prompt.

The supporting message explains that Deckhand boots, builds, and controls devices on
the developer's Mac, then returns a live browser link. The cloud component is limited
to API-key validation; application source, builds, and device control remain local.

## Visual Direction

Use a "Warm Technical" direction derived from the existing viewer:

- Deep aubergine and near-black backgrounds
- Cream typography with amber, coral, and muted sage accents
- Editorial serif display type paired with a clean rounded sans serif
- Thin technical lines, restrained glows, and tactile glass-like panels
- Generous negative space and a calm, premium rhythm
- Subtle motion that supports comprehension and respects reduced-motion preferences

The page must avoid generic blue SaaS gradients, stock photography, excessive glowing
orbs, fake customer logos, and fabricated testimonials or usage numbers.

## Generated Hero Visual

Generate one original raster hero asset with GPT Image. It should depict Deckhand's
functionality rather than a decorative mascot: a warm, cinematic developer workstation
as the local control center, with an iPhone simulator, Android emulator, and browser
preview represented as coordinated device surfaces. A restrained luminous path should
suggest one prompt flowing into several live devices.

The image must contain no words, logos, watermarks, or legible UI text. The site will
provide all accessible meaning in HTML. The composition should leave usable negative
space and blend naturally into the dark page background.

## Page Structure

### Header

A compact Deckhand wordmark, anchor links for Product, Security, and Pricing, plus a
primary "Start free" action. On narrow screens, retain the wordmark and primary action
without adding a complex menu.

### Hero

Use the headline "Your app. Any device. One prompt." followed by concise copy describing
the local MCP server and live preview link. Provide two actions:

- Primary: "Start 14-day trial"
- Secondary: "See how it works"

The generated product visual sits beside or below the copy depending on viewport width.
A small trust line states: "Runs on your Mac · iOS, Android & web · Shareable previews".

### Product Flow

Explain the product in three steps:

1. Ask your coding agent to open or test an app.
2. Deckhand builds locally and boots the selected devices.
3. Receive one live, controllable browser link.

An adjacent code-style prompt example should make the workflow concrete without
requiring an interactive demo.

### Local-First Security

Present the architecture as a product benefit. The API backend validates the key; the
MCP server, source checkout, builds, device control, and streams stay on the developer's
machine. Do not claim end-to-end encryption or other guarantees not established by the
project.

### Platform Coverage

Show iOS, Android, and web as three expressions of one workflow. Focus on parallel
previewing, agent-driven interaction, and shareable browser access.

### Pricing

Use four clear cards:

- Trial: free for 14 days
- Solo: NOK 300 per month, up to two machines
- Team: NOK 275 per seat per month, minimum two seats, support included
- Lifetime: NOK 10,000 once, one API key for up to two machines

The Team plan is visually recommended for collaborative buyers. Public-repository
pricing is not a launched offer; show it only as a restrained note: "Free access for
public repositories is being explored."

Prices are shown as NOK amounts. Do not invent VAT treatment, cancellation terms,
support response times, or feature restrictions.

### Final Call to Action and Footer

Repeat the trial action with a confident closing line. The footer contains only
essential product navigation and a concise local-first statement. Placeholder links
must use safe in-page anchors until real destinations exist.

## Interaction

- Smooth anchor navigation
- Subtle reveal and device-status motion
- Hover and keyboard focus states on every interactive element
- Pricing cards remain readable without hover
- Decorative animation stops when reduced motion is requested
- No carousel, modal, autoplay video, or fake checkout

The CTA may currently link to a local signup/API-key section or a clearly labelled
mailto/contact action. It must not imply a working purchase flow if none exists.

## Architecture

Create a separate `landing/` Vite + React workspace so the marketing page does not
alter the preview viewer's runtime or routing. Reuse the repository's existing React,
TypeScript, and Vite versions. Keep dependencies minimal and build the page from small
presentational components with static local data.

The generated hero image belongs under `landing/public/`. All other visual elements
should be accessible HTML/CSS or small inline SVG icons.

## Responsive and Accessible Behavior

- Fully usable from 320 px to large desktop widths
- Semantic heading hierarchy and landmark elements
- Visible focus rings and sufficient text contrast
- Buttons and links have descriptive accessible names
- Generated imagery is decorative when its meaning is already expressed in nearby text
- No horizontal overflow at supported widths

## Metadata

Set an English title and description suitable for sharing:

- Title: `Deckhand — Your app. Any device. One prompt.`
- Description: `Run iOS simulators, Android emulators, and web previews from your coding agent — securely on your own Mac.`

## Verification

Before delivery:

- Run the landing package typecheck and production build
- Run the repository test suite to ensure the viewer and server are unaffected
- Inspect desktop and mobile layouts in a real browser
- Check keyboard navigation and reduced-motion behavior
- Check for console errors, clipped content, broken assets, and horizontal overflow
- Iterate on the rendered page until the hierarchy, spacing, and hero composition feel
  finished

## Out of Scope

- Implementing the API-key backend
- Payments, checkout, account management, or email capture persistence
- A CMS, analytics platform, database, or customer dashboard
- Publishing unconfirmed public-repository pricing as a live offer
