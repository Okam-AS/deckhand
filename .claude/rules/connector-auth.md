---
paths:
  - "server/src/oauth/**/*.ts"
  - "server/src/auth.ts"
---

Who may drive this Mac. The premise every rule here rests on: **the connector URL is public**.
A connector added in a Claude team or Enterprise organisation is visible to everyone in it, so
nothing may depend on that URL staying private. It used to — the credential was a path segment
in it, which handed the whole organisation a working connector.

Hardest rules:

- **The credential is a header, never a path segment or a query parameter.** URLs get pasted
  into shared connector settings, screenshots and logs; `Authorization` does not. → `invariants.test.ts` "puts no credential in an MCP route path", and `mcp/server.test.ts` "refuses the legacy /mcp/<token> URL even when the token is valid"
- **Identity comes from the signed `Cf-Access-Jwt-Assertion`, never from `Cf-Access-Authenticated-User-Email`.** Anything that can reach the origin can set a header, and every process on this Mac shares loopback — including a simulator running a build we did not write. Enforced at the SOURCE level, repo-wide, because a runtime test only proves today's code ignores it. → `invariants.test.ts` "never reads Cloudflare's unsigned identity header"
- **`alg` is pinned to RS256 and `aud` to this application's tag.** Reading `alg` off the token is how `alg: none` works; skipping `aud` accepts an Access token minted for any other app on the same team. → `oauth/access.test.ts` "refuses alg=none and any alg other than RS256", "refuses an Access token minted for a different application on the same team"
- **An unconfigured Access application REFUSES; it never falls open.** This is the permissive-default class this repo has been bitten by repeatedly, and here the blast radius is every person holding the URL. → `oauth/router.test.ts` "refuses rather than falls open when no Access application is configured"
- **An empty allowlist means nobody.** Not "everybody", not "the default user". → `oauth/router.test.ts` "refuses an address Access proved but the allowlist does not carry, and mints no code"
- **The allowlist is checked on every MCP request AND the array is watched.** Both halves, or neither works: this shipped with a genuine per-request check reading an array loaded once at boot, so `deckhand allow rm` printed "starting with their next call" and did nothing until a restart — and a restart tears down every booted simulator on the machine, so it can never be the price of taking access away. → `invariants.test.ts` "watches tokens.yaml as well as apps.yaml" (covers config.yaml's allowlist too), and `connectorWatcher.test.ts` "adopts a removal without a restart, and mutates the array the server closed over"
- **`/oauth/register` is unauthenticated, so everything it writes needs a ceiling.** RFC 7591 registration has no credential to check — a client does not have one yet. Registering grants nothing, but each one is a row on disk, and this machine needs its free space for simulators and builds. → `oauth/router.test.ts` "caps registered clients, and never evicts one that holds a live grant"
- **Never redirect an error to a `redirect_uri` you have not matched against the registered set.** Doing so makes `/oauth/authorize` an open redirector and hands `state` to whoever supplied the URI. → `oauth/router.test.ts` "never redirects an error to an unregistered redirect_uri"
- **A code is single-use even when redemption fails.** Deleting it only on success leaves an observed code open to verifier guessing. → `oauth/router.test.ts` "rejects a code redeemed with the wrong verifier, and burns it in the process"

Access protects exactly one path — `<hostname>/oauth/authorize`. `/mcp`, `/oauth/token` and
`/oauth/register` are called by Claude's backend, which has no browser to follow a login
redirect, so covering them breaks the connector in a way that reads as "deckhand is broken".
`deckhand doctor`'s `connector auth` check is the only thing that says so out loud.

Tokens on disk are sha256 hashes only (`oauth.json`, mode 0600), compared with
`timingSafeEqual` against every entry with no early return — same shape as `auth.ts`, for the
same reason.
