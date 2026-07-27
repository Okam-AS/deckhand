# Deckhand Landing Page V2 Design

## Goal

Elevate the existing Deckhand landing page from a polished product concept into a
credible, memorable product demonstration. V2 should preserve the current warm
technical identity while making the page feel like Deckhand is working in front of the
visitor.

The central promise is:

> Your code. Always on your machine.

Deckhand is presented as a fully local device tester for coding agents. The developer
owns and runs the tester on their own Mac; source checkouts, builds, simulator and
emulator control, browser previews, and streams remain there. The remote backend has
one deliberately narrow responsibility: validating the API key.

The success criterion is a balanced improvement across:

- Product credibility: visitors see how Deckhand behaves, not only what it claims.
- Visual impact: motion and composition make the workflow memorable.
- Conversion clarity: every primary action has one honest, concrete destination.

## Direction

Use a proof-led product story with restrained cinematic motion.

Keep the existing aubergine, cream, amber, coral, and sage palette; editorial serif and
rounded sans typography; tactile surfaces; generated hero artwork; and calm pacing.
Do not redesign the brand. V2 changes the evidence, sequencing, and conversion path.

## Hero Product Theatre

The hero remains a two-column composition on large screens. The left column retains:

- The kicker: "The fully local device tester for coding agents"
- The headline: "Your code. Always on your machine."
- The supporting product promise: "Your app. Any device. One prompt."
- A shorter supporting paragraph
- The primary trial action and secondary workflow action
- The factual trust line

The right column becomes a layered product theatre instead of a single static image:

1. The generated workstation artwork remains the atmospheric background.
2. A code-native Deckhand viewer panel sits over the image and uses the real viewer's
   visual language.
3. The panel cycles through three deterministic states:
   - A plain-English request is received.
   - iOS, Android, and web previews become ready.
   - A stable share link is returned.
4. The animation uses only opacity, transform, and status changes. It pauses on hover,
   keyboard focus, hidden tabs, and `prefers-reduced-motion`.
5. The final state remains fully understandable without animation.

The theatre must not fabricate customer applications, test results, or performance
numbers. Generic device surfaces and truthful Deckhand statuses are acceptable.

## Product Proof Strip

Add a compact proof strip directly below the hero. It contains four verified facts:

- Fully local tester owned and run on your Mac
- Builds once per platform
- Boots devices in parallel
- Returns stable share links

Each fact uses a small status indicator and one concise supporting line. This section
replaces generic social proof until genuine customers, usage data, or testimonials
exist.

## Workflow Story

Retain the three-step workflow, but connect the steps visually with one animated signal
line:

`Agent request → Local MCP server → Device previews → Share link`

The existing coding-agent prompt card becomes the active example. As each step enters
the viewport, the matching line in the prompt card changes state. The interaction must
remain informational and require no clicking.

## Local-First Architecture

Keep the current security section because it is the strongest explanatory section.
Refine it in two ways:

- Make the cloud boundary visually narrower and the local boundary visually dominant.
- Label the local boundary "Your machine · your tester · your code."
- Add one explicit sentence: "The backend validates your API key; source, builds,
  devices, previews, and streams remain on your Mac."

Do not claim end-to-end encryption, zero knowledge, or guarantees not established by
the project.

## Platform Presentation

Replace the three tall platform cards with one unified device-lab stage:

- A compact iPhone frame, Android frame, and browser frame share one panel.
- Each frame carries a truthful status from the existing content.
- A segmented control lets the visitor emphasize iOS, Android, web, or all devices.
- "All devices" is the default and works without JavaScript as a readable static view.

This shortens the page and makes multi-device orchestration the visual message instead
of presenting the platforms as three unrelated products.

## Pricing

Present the 14-day trial as a universal offer above the purchasing options rather than
as a fourth plan.

Use three purchase cards:

- Solo: NOK 300 per month, up to two machines
- Team: NOK 275 per seat per month, minimum two seats, support included
- Lifetime: NOK 10,000 once, one API key for up to two machines

Team remains recommended. The public-repository note remains explicitly exploratory.
No VAT, cancellation, renewal, or support-response claims may be invented.

Until signup and checkout exist, all trial and purchase actions open the verified
Deckhand GitHub repository's new-issue composer with "Trial access request" and the
selected plan prefilled in the title. The visitor still reviews and submits the request;
the page creates no external state by itself. The visible label remains action-oriented,
and nearby copy states that access is currently provisioned directly.

## Final Call to Action

The closing section uses:

> Give your coding agent a pair of hands.

Its primary action is "Request a trial key." Its secondary action is "Review the
architecture." This removes the current loop back to pricing and gives the visitor a
clear next step.

## Motion and Interaction

- Use a single shared motion rhythm: 180–240 ms for UI transitions and 600–800 ms for
  narrative reveals.
- Never animate all sections simultaneously.
- Avoid scroll hijacking, autoplay video, carousels, pointer-following effects, and
  continuous decorative motion.
- Preserve visible focus states and keyboard access.
- All motion resolves to a complete static presentation under reduced motion.

## Responsive Behavior

- At 960 px and below, the hero theatre moves below the copy.
- At 720 px and below, the proof strip becomes a two-column grid and pricing stacks.
- At 480 px and below, the device-lab stage emphasizes one device at a time while the
  segmented control remains accessible.
- Support 320 px without horizontal overflow.

## Components

Keep the existing Vite and React workspace. Add or extract only the following
presentational components:

- `ProductTheatre`
- `ProofStrip`
- `WorkflowSignal`
- `DeviceLabStage`
- `TrialBanner`

Static commercial and product facts remain in `landing/src/content.ts`. Components
receive typed content as props and contain no API calls.

## Verification

- Content tests verify pricing, trial wording, product facts, and contact destinations.
- Component tests verify the theatre's final state, device-lab controls, and accessible
  labels.
- Typecheck, landing build, repository tests, and production packaging remain green.
- Inspect large desktop, 960 px, 720 px, 390 px, and 320 px layouts.
- Verify keyboard navigation, reduced motion, paused animation behavior, no console
  errors, and no horizontal overflow.

## Out of Scope

- Account creation, API-key issuance, payment processing, or checkout
- Fabricated testimonials, customer logos, metrics, or application screenshots
- A new brand identity or replacement color system
- Video production requiring a live simulator or emulator session
- Changes to the Deckhand MCP server, viewer runtime, or share proxy
