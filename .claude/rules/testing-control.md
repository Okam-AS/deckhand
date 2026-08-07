---
paths:
  - "server/src/testing/**/*.ts"
---

The SimDeck control seam: `describe` and `ui` drive a third-party daemon running on this machine.
SimDeck's **video** transport was evaluated and rejected (PLAN §2) and stays rejected — what was
adopted is its control and inspection REST surface, nothing else.

Hardest rules, each with the check that enforces it:

- **REST only.** `GET /accessibility-tree`, `POST /action`, `GET /screenshot.png`. Never the
  `/input` or `/control` WebSocket, `/webrtc/offer`, or `/refresh` — those start the private
  CoreSimulator display and encoder session, which is the fragile path the video rejection was
  about. → `control.test.ts` "never touches the input WebSocket / webrtc / refresh endpoints"
- **Auth is the same-origin loopback allowance, so deckhand holds NO SimDeck token.** There is no
  secret here to leak, and that is a property to preserve rather than an accident.
  → `control.test.ts` "translates tap to a normalized /action POST with a same-origin Origin header"

Two facts about the daemon that no check in this repo can see, because it is not our process:

- **Never start SimDeck with `--bind 0.0.0.0`.** It binds loopback by default, and a LAN mode
  exists. Deckhand has never used it and must not: the surface at stake is tap, type and the
  accessibility tree of a booted device, with nothing in front of it. The loopback guardrail
  (`invariants.test.ts` "binds every listening socket to loopback") reads `.listen()` calls in
  THIS repo — a flag handed to a spawned daemon is invisible to it.
- **`/api/health` hands SimDeck's own token to any loopback caller** — a `simdeck_token` cookie,
  and token-bearing URLs in the body. The simulator shares the host's loopback, which is the same
  reason serve-sim's `/exec` is patched out. Deckhand reads `res.ok` from that endpoint and
  nothing else; never read, store or forward what the response carries.
