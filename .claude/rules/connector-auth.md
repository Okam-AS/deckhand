---
paths:
  - "server/src/oauth/**/*.ts"
  - "server/src/auth.ts"
---

Who may drive this Mac. The premise every rule here rests on: **the connector URL is public**.
A connector added in a Claude team or Enterprise organisation is visible to everyone in it, so
nothing may depend on that URL staying private. It used to — the credential was a path segment
in it, which handed the whole organisation a working connector.

So the URL decides nothing and there is no list of who may connect. **The operator approves
each client, once, at the machine.** `/oauth/authorize` parks the request and shows a code;
`deckhand approve` matches that code and mints. The secret is a person's hand on their own
Mac, which is the one secret a shared URL cannot leak.

Hardest rules:

- **The credential is a header, never a path segment or a query parameter.** URLs get pasted
  into shared connector settings, screenshots and logs; `Authorization` does not. → `invariants.test.ts` "puts no credential in an MCP route path", and `mcp/server.test.ts` "refuses the legacy /mcp/<token> URL even when the token is valid"
- **The public half of pairing proves nothing; the deciding half needs `tokens.yaml`.** Both are
  reachable through the tunnel, so being loopback protects neither. If the approve endpoint ever
  stopped authenticating, the URL would approve its own request. An OAuth grant deliberately
  cannot approve either — one connector waving the next one through turns a single approval into
  a standing one. → `invariants.test.ts` "puts no approval path outside the credential the machine holds"
- **Authorize never mints.** A future edit that "just returns the code when there is one obvious
  client" hands a grant to whoever holds the URL — the exact thing parking exists to prevent.
  Enforced at the SOURCE level, because a runtime test only proves today's code parks. → `oauth/router.test.ts` "never mints a code from the public authorize endpoint"
- **Bare `deckhand approve` lists; it never approves.** Approving whatever happens to be waiting
  is the mistake the mechanism exists to prevent: the operator must match the code against their
  own browser, or a colleague's request is indistinguishable from theirs.
- **Refusing the overflow, never evicting.** The URL is public, so anyone holding it can make
  this Mac show a prompt. Evicting the oldest to make room would drop the request the operator
  is looking at — which is precisely when people start approving without reading. → `oauth/pairing.test.ts` "refuses the overflow rather than dropping a request the operator may be reading"
- **A parked request is memory, not disk.** Surviving a restart would let an approval outlive
  the browser that asked for it, so the operator would be approving something they can no longer
  see. It is also why `deckhand approve` talks to the running server instead of reading a file.
- **An approved request is claimed once.** `/oauth/resume` deletes as it reads, so a replay
  cannot deliver the same authorization code twice. → `oauth/pairing.test.ts` "hands an approved request over exactly once"
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
