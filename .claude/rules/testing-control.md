---
paths:
  - "server/src/testing/**/*.ts"
---

The SimDeck control seam: `describe` and `ui` drive a third-party daemon running on this machine.
SimDeck's **video** transport was evaluated and rejected (PLAN §2) and stays rejected — what was
adopted is its control and inspection REST surface, nothing else.

Hardest rules, each with the check that enforces it:

- **REST only.** Never the `/input` or `/control` WebSocket, `/webrtc/offer`, or `/refresh` —
  those start the private CoreSimulator display and encoder session, which is the fragile path
  the video rejection was about. What deckhand calls today is `GET /api/health`, `GET
  /accessibility-tree`, `POST /action`, `POST /pasteboard` (the non-US iOS typing path) and
  `GET /screenshot.png`; adding a sixth REST call is fine, and none of the four above ever is.
  → `control.test.ts` "names no /input, /control, /webrtc or /refresh endpoint" and
  `control.test.ts` "opens no WebSocket to SimDeck" — both source-text scans of this directory
  with comments stripped, because the runtime check
  `control.test.ts` "never touches the input WebSocket / webrtc / refresh endpoints" sees only
  the methods it exercises, and a `new WebSocket(…)` never reaches the injected `fetch` at all,
  so no fake-fetch assertion can see the headline half of this rule.
- **Auth is the same-origin loopback allowance, so deckhand holds NO SimDeck token.** There is no
  secret here to leak, and that is a property to preserve rather than an accident. The POSTs carry
  a matching `Origin` and nothing else; the GETs send no headers at all.
  → `control.test.ts` "sends no credential on any call — no Authorization, no cookie, no token"
  (every header on every request the exercised paths make) and `control.test.ts`
  "sends no credential to SimDeck" (the same directory's source, so a path nobody exercises is
  still covered).

Two facts about the daemon that no check in this repo can see, because it is not our process:

- **Never start SimDeck with `--bind 0.0.0.0`.** It binds loopback by default, and a LAN mode
  exists. Deckhand has never used it and must not: the surface at stake is tap, type and the
  accessibility tree of a booted device, with nothing in front of it. The loopback guardrail
  (`invariants.test.ts` "binds every listening socket to loopback") reads `.listen()` calls and
  `new WebSocketServer({ port })` in THIS repo — a flag handed to a spawned daemon is invisible
  to it.
- **`/api/health` hands SimDeck's own token to any loopback caller** — a `simdeck_token` cookie,
  and token-bearing URLs in the body. The simulator shares the host's loopback, which is the same
  reason serve-sim's `/exec` is patched out. Deckhand reads `res.ok` from that endpoint and
  nothing else; never read, store or forward what the response carries. Reading it is unguarded —
  the no-credential scan above would catch code that named `simdeck_token` or a cookie, and
  nothing catches code that pulls a token out of the JSON under some other name.
