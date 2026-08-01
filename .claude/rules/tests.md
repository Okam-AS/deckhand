---
paths:
  - "server/src/**/*.test.ts"
  - "viewer/src/**/*.test.ts"
---

Two rules, both learned the expensive way.

**1. A new test must fail before it passes.** Write it, remove the fix, watch it fail, put the fix back. Every test in this repo added without that step turned out to assert nothing — including one that passed because a POSIX character class means something else in JavaScript, and a guardrail that matched its own marker's `export const` line after the stamp it checked for had been deleted.

Say in the commit message that you saw it fail. That sentence is the only evidence this step happened.

**2. Fakes are complete or they lie.** Use `test-support/fakes.ts`; never `as unknown as X` on an object literal. That form disables missing-property checking, so adding a method to a real class leaves every fake silently behind and the failure surfaces far from the cause. It has cost four bugs in one day, and once made the entire orphan sweep a no-op **that reported success**.

`fakes.ts` covers the six injected dependencies that are classes — `metro`, `devProcs`,
`simctl`, `android`, `worktrees`, `reaper` — and a guardrail fails any test file that
hand-rolls one of them instead. A one- or two-member interface (`audit`, `streaming`) is
still fine inline: the rule is not "never write this syntax", it is "do not hand-roll a
partial stand-in for a fourteen-method class when a complete one is a function call away". The pattern is `PublicOf<T>` — `keyof` on a class yields only public members, so a missing method is a compile error in `fakes.ts` instead of silence in eleven files.

Two known limits of that mechanism, so you do not over-trust it: method parameters are **bivariant**, so an override with a wrong-but-compatible signature still compiles; and optional members may be omitted entirely.

Also worth knowing here:

- `npm test` runs under `tsx`, which does **not** typecheck. A test asserting that something is a compile error proves nothing unless `npm run typecheck` runs too — `npm run ci` runs both.
- A test that exercises a branch which is switched off passes for the wrong reason. Check the fixture actually reaches the code.
- Cleanup belongs in `finally`. A test that starts a server and detaches after the assertions leaves it listening when the assertion fails, and `node --test` never exits — a regression hangs CI instead of reporting.
