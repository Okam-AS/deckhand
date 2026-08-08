---
paths:
  - "landing/**/*.tsx"
  - "landing/**/*.ts"
  - "landing/**/*.css"
  - "landing/index.html"
  - "landing/public/**"
---

The public landing page. It shows the product, so what it depicts is a claim about the product.

- **Never depict invented app UI.** A fake screenshot — mocked-up buttons, lists, nav bars, rows
  of placeholder text standing in for someone's app — is the thing banned here. Two earlier
  landing designs did it, and the fabricated UI read as an unfinished placeholder rather than as
  a product.

  A device outline is NOT the prohibition, and the rule used to say "device skeletons", which
  reads as an instruction to delete the page's own hero. `landing/public/deckhand-hero.png`
  ships three device frames deliberately: what is inside them is an abstract wash, and the claim
  the picture makes — one machine, several devices, at once — is one deckhand actually keeps.
  The test is what a viewer would take away as a factual claim, not whether a rectangle has
  rounded corners.

  What the page shows in words is deckhand's real orchestration: a build
  reused across devices, each device booting, installing and reaching a stream, against concrete
  device labels (`iPhone 17 Pro · iOS 26`, `Pixel 7 · API 29`). The wording is prose, not the raw
  `DEVICE_PHASES` ids from `server/src/state.ts` — do not "restore" those into marketing copy; the
  claim to keep true is that the states depicted are ones deckhand really goes through.
- **Never put iOS, Android and web behind mutually exclusive tabs.** The platform tabs in the
  earlier device lab were removed for saying the opposite of what deckhand does: one request names
  several targets and they come up together, while tabs claim they are modes you choose between.
  → `final-presentation.test.ts` "final presentation removes layered and placeholder V2 selectors"
  guards the class names those designs used, not the prohibition itself — it will not catch the
  same idea rebuilt under new selectors, which is why the rule is written here.
