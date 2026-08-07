---
paths:
  - "server/src/share/**/*.ts"
---

The public surface. Everything reaches deckhand through here, and the two worst bugs in this repo's history were both on this path.

Hardest rules:

- **Express dispatches string routes case-insensitively.** A gate regex without the `i` flag let `/Dev/` and `/RESTART` reach a locked share's stream and rebuild with **no PIN**. → `invariants.test.ts` "gates the share proxy's route matcher case-insensitively" — and note that check reads every matching line with comments stripped, because writing the pattern in a comment used to satisfy it.
- **Panes are content-keyed, so two pages can legitimately share one.** Unlock minting is therefore **forward only**: a pane never mints for the page holding it. The reverse direction was justified by a comment that a later change made false, and the result was a holder of page B's PIN getting a valid cookie for page A, with A's shareId disclosed. If you add a direction, ask what test fails when it is wrong.
- **The proxy forwards only `stream.avcc`, `stream.mjpeg`, `ws` and `ax`** under a device — never the helper's other routes. The helper is reachable from inside the simulator, which shares the host's loopback.
- **A PIN never rides the URL.** Unlock is a POST to `/__deck/unlock` (or `/s/:shareId/unlock`), and the cookie it sets is the only credential the proxy reads. An earlier design accepted `?password=` on the WS upgrade and stripped it before proxying — the stripping worked, and it was still the wrong shape: a share URL gets pasted into chat, bookmarks and screenshots, and a query parameter is part of the URL. There is nothing to strip if nothing is accepted.
- **Never repeat a share PIN in chat or a tool response.**

Comments here state preconditions. When you change something, re-read the ones you did **not** touch — the dangerous comment is the one nobody edited.
