---
paths:
  - "landing/**/*.tsx"
  - "landing/**/*.ts"
  - "landing/**/*.css"
---

The public landing page. It shows the product, so what it depicts is a claim about the product.

- **Never depict invented app content, fake screenshots or device skeletons.** Two earlier landing
  designs did, and the fabricated UI read as an unfinished placeholder rather than as a product.
  What the page shows instead is deckhand's real orchestration states — `building`, `booting`,
  `installing-app`, `ready` — and concrete device labels.
- **Never put iOS, Android and web behind mutually exclusive tabs.** The platform tabs in the
  earlier device lab were removed for saying the opposite of what deckhand does: one request names
  several targets and they come up together, while tabs claim they are modes you choose between.
  → `final-presentation.test.ts` "final presentation removes layered and placeholder V2 selectors"
  guards the class names those designs used, not the prohibition itself — it will not catch the
  same idea rebuilt under new selectors, which is why the rule is written here.
