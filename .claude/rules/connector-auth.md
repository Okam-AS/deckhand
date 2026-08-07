---
paths:
  - "server/src/oauth/**/*.ts"
  - "server/src/auth.ts"
---

Who may drive this Mac. The premise every rule here rests on: **the connector URL is public**.
A connector added in a Claude team or Enterprise organisation is visible to everyone in it, so
nothing may depend on that URL staying private. It used to — the credential was a path segment
in it, which handed the whole organisation a working connector.

So the URL decides nothing and there is no list of who may connect. **The operator mints a
pairing code at the machine and the visitor types it in.** `deckhand pair` mints;
`/oauth/authorize` asks. The secret is a person's hand on their own Mac, which is the one
secret a shared URL cannot leak.

Hardest rules:

- **The credential is a header, never a path segment or a query parameter.** URLs get pasted
  into shared connector settings, screenshots and logs; `Authorization` does not. → `invariants.test.ts` "puts no credential in an MCP route path", and `mcp/server.test.ts` "refuses the legacy /mcp/<token> URL even when the token is valid"
- **The public half of pairing proves nothing; the deciding half needs `tokens.yaml`.** Both are
  reachable through the tunnel, so being loopback protects neither. If the approve endpoint ever
  stopped authenticating, the URL would approve its own request. An OAuth grant deliberately
  cannot approve either — one connector waving the next one through turns a single approval into
  a standing one. → `invariants.test.ts` "puts no approval path outside the credential the machine holds"
- **The operator MINTS; the browser types.** The other direction — park the request, let the
  operator approve it from a list — reads friendlier and collapses under load: parking is
  unauthenticated, so a stranger parks faster than a person can walk to the Mac, and the
  operator's own request is gone before they read its code. Nothing incoming is stored now, so
  there is nothing to flood. → `oauth/pairing.test.ts`
- **The code is single-use and replaced on re-mint, and the guess budget belongs to the SOURCE,
  not to the code.** Guessing is the only move a stranger has left, and ~4.8e8 possibilities is
  only strong while it is bounded — but burning the CODE on wrong guesses hands every stranger a
  way to shred every code the operator mints, as fast as they can loop. → `oauth/pairing.test.ts` "leaves the code usable by the person the operator is actually talking to"
- **The page says WHO is connecting.** A code proves the operator meant to connect something; it
  does not say what. Registration is unauthenticated and any https redirect is accepted, so
  without the client name and redirect host on the page, a stranger can hand the operator a link
  to this very page on their own trusted hostname and collect the grant.
- **A client mid-flow is not evictable.** The registry cap is otherwise a weapon: register past
  it and the client currently completing a pairing is evicted, so its token exchange fails
  `invalid_client` after the code was already spent — repeatable, so pairing never completes.
- **Mint after claim, once.** `/oauth/authorize`'s POST is the only place an authorization code
  is minted, and it sits behind `pairing.claim`. A second mint is a second way in. → `oauth/router.test.ts` "mints only after the pairing code has been spent"
- **The code lives in memory, never on disk.** It is worth minutes, and a code that survived a
  restart would outlive the person who asked for it. It is also why `deckhand pair` talks to the
  running server rather than writing a file.
- **`/oauth/register` is unauthenticated, so everything it writes needs a ceiling.** RFC 7591
  registration has no credential to check — a client does not have one yet. Registering grants
  nothing, but each one is a row on disk, and this machine needs its free space for simulators
  and builds. → `oauth/router.test.ts` "caps registered clients, and never evicts one that holds a live grant"
- **Never redirect an error to a `redirect_uri` you have not matched against the registered set.** Doing so makes `/oauth/authorize` an open redirector and hands `state` to whoever supplied the URI. → `oauth/router.test.ts` "never redirects an error to an unregistered redirect_uri"
- **A code is single-use even when redemption fails.** Deleting it only on success leaves an observed code open to verifier guessing. → `oauth/router.test.ts` "rejects a code redeemed with the wrong verifier, and burns it in the process"

Revocation is `deckhand revoke <client-id>`, keyed by client because a client is what was
approved — revoking one connector must not disturb another the same person authorized
separately. It takes effect on that client's next call, with no restart: a restart tears down
every booted simulator on the machine, so it can never be the price of taking access away.

Tokens on disk are sha256 hashes only (`oauth.json`, mode 0600), compared with
`timingSafeEqual` against every entry with no early return — same shape as `auth.ts`, for the
same reason.
