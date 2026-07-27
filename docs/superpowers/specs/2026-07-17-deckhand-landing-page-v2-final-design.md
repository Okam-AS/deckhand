# Deckhand Landing Page V2 Final Design

## Problem

Two V2 visuals undermine the product story:

- The hero stacks a workflow panel over generated workstation art, leaving neither visual with a clear role.
- The device lab uses platform tabs and generic app skeletons. The tabs imply that iOS, Android, and web are mutually exclusive modes, while Deckhand actually accepts one request and brings selected targets together. The skeletons are fabricated UI and read as placeholders.

## Chosen Direction: Local Run Console

The final design separates atmosphere from product proof.

### Hero

The generated workstation image is the only hero visual. It sits in a deliberate framed canvas with a compact caption rail below it. No product panel, card, or copy overlays the image. The caption identifies the scene as a local workspace and reinforces that source and native toolchains stay on the Mac.

### Product Proof

Replace the filterable device lab with a single full-width local run console based on Deckhand's real orchestration states:

1. One agent request names the app, ref, and requested targets.
2. The local MCP server builds once per platform.
3. iOS and Android devices boot and install in parallel.
4. A separate web dev-server row is shown as a local process, not as a simulator.
5. One stable viewer URL is returned.

The console must use concrete labels such as `iPhone 17 Pro · iOS 26`, `Pixel 7 · API 29`, `Vite · 127.0.0.1`, and real phases such as `building`, `booting`, `installing-app`, and `ready`. It must not depict invented app content, fake screenshots, platform tabs, or mutually exclusive selection.

## Visual Language

- Keep the existing dark aubergine, warm amber, coral, and sage palette.
- Use one restrained console shell with clear hierarchy rather than nested card sprawl.
- Use typography, status dots, rails, and monospace metadata to create credibility.
- Keep motion subtle and informational; reduced-motion users receive a static ready state.
- On mobile, the request, target rows, and output stack vertically without horizontal overflow.

## Copy

- Section kicker: `One request. Every selected target.`
- Section headline: `Your local test run, in one view.`
- Supporting copy explains build-once-per-platform and parallel boots.
- Console ownership label: `LOCAL · YOUR MAC`.
- Footer proof: `Source, builds, and device control never leave this machine.`

## Acceptance Criteria

- The hero image has no overlapping product panel.
- No platform tablist or filter remains.
- No generic app skeleton or fake screen remains.
- iOS and Android appear as simultaneous device targets.
- Web appears as a local dev-server process, not an emulator/device.
- The UI states build-once-per-platform, parallel device boots, and one stable viewer URL.
- Existing pricing, security, and trial behavior remain unchanged.
- Landing tests, typecheck, and production build pass.
- Desktop and mobile browser QA show no overlap, clipping, or horizontal overflow.

