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
  /accessibility-tree`, `POST /action`, `POST /pasteboard` (the non-US iOS typing path),
  `GET /screenshot.png`, and `GET /accessibility-point` (which way a turned iOS device faces, see
  `orientation.ts`); adding another REST call is fine, and none of the four above ever is.
  → `control.test.ts` "names no /input, /control, /webrtc or /refresh endpoint" and
  `control.test.ts` "opens no WebSocket to SimDeck" — both source-text scans of every non-test
  `.ts` in this directory and everything under it — `control.test.ts:290` filters test files out,
  while the frontmatter above scopes every `.ts`, so a test file here is inside the RULE and
  outside the SCAN, and a fixture that names `/input` is yours to judge — with comments stripped,
  because the runtime check
  `control.test.ts` "never touches the input WebSocket / webrtc / refresh endpoints" sees only
  the methods it exercises, and a `new WebSocket(…)` never reaches the injected `fetch` at all,
  so no fake-fetch assertion can see the headline half of this rule.
- **Auth is the same-origin loopback allowance, so deckhand holds NO SimDeck token.** There is no
  secret here to leak, and that is a property to preserve rather than an accident. The POSTs carry
  a matching `Origin` plus `content-type: application/json` and nothing else; the GETs send no
  headers at all.
  → `control.test.ts` "sends no credential on any call — no Authorization, no cookie, no token"
  (every header on every request the exercised paths make) and `control.test.ts`
  "sends no credential to SimDeck" (the same recursive source scan, so a path nobody exercises is
  still covered).

**A phone is not SimDeck's.** SimDeck 0.2.0 resolves Android only as `android:<AVD name>` and
answers a phone's serial with "Android emulator `<serial>` is not running", so `describe`/`ui` on a
phone go to `adbControl.ts` behind the same `ControlBackend` interface, returning the tree in the
shape `screen.ts` reads. Its rules: the dump goes to stdout so nothing is left on the phone;
`input text` is ASCII-only, so non-ASCII is a 422 naming the characters, never a mangled string;
nothing that changes the phone (dark mode, power, volume) is pressed; and `openUrl` is addressed to
the registered app only. → `adbControl.test.ts` "refuses non-ASCII text with a clear error and
types nothing", "never changes a setting: no dark-mode toggle, no power or volume button"

**An iPhone is WDA's, and only inside the app.** `iphoneControl.ts` drives a physical iPhone over WebDriverAgent's REST on the Mac's loopback forward, with no token, the same rules as SimDeck. Every touch and keystroke first asks WDA which app is in front — again right before a touch that follows a wait or a scroll — and refuses unless it is the preview's registered bundle; `home`, hardware buttons, `openUrl` and `toggleAppearance` are refused outright, because each acts outside the app or changes a setting. Coordinates are WDA's points. The client refuses any base URL but `http://127.0.0.1`. These rules bind deckhand's own client and nothing else: WDA has no token, a simulator shares the Mac's loopback, and so while a preview holds the phone a simulator share holder can reach WDA directly — the adb server on `127.0.0.1:5037` likewise for an Android phone (PLAN §11 item 1). Never describe the in-app check or the phone PIN as a boundary around the phone; the only one deckhand draws is that WDA and its forward exist only while a preview holds the phone. → `wdaRunner.test.ts` "takes a phone's WDA and forward down once no preview holds it, and starts a fresh one for the next", `preview.test.ts` "installs the environment's EAS .ipa, starts syslog before a launch with -KEY value, and verifies the environment from the app log", `iphoneControl.test.ts` "never touches or types while another app is in front", `iphoneControl.test.ts` "asks again which app is in front after waiting or scrolling, before it touches", `iphoneControl.test.ts` "refuses home, hardware buttons, openUrl and appearance with a reason, sending nothing", `preview.test.ts` "drives describe/ui/screenshot through WDA, and refuses a touch while another app is in front"

Two facts about the daemon that no check in this repo can see, because it is not our process:

- **Never start SimDeck with `--bind 0.0.0.0`.** It binds loopback by default, and a LAN mode
  exists. Deckhand has never used it and must not: the surface at stake is tap, type and the
  accessibility tree of a booted device, with nothing in front of it. The nearest guardrail
  reads `.listen()` calls and `new WebSocketServer({ port })` in THIS repo, so a flag handed to
  a spawned daemon is invisible to it — which is why this rule is prose.
  → `invariants.test.ts` "binds every listening socket to loopback" (what it DOES cover; this
  bullet is the gap beside it)
- **`/api/health` hands SimDeck's own token to any loopback caller** — a `simdeck_token` cookie,
  and token-bearing URLs in the body. The simulator shares the host's loopback, which is the same
  reason serve-sim's `/exec` is patched out. Deckhand reads `res.ok` from that endpoint and
  nothing else; never read, store or forward what the response carries. Reading it is unguarded —
  the no-credential scan above would catch code that named `simdeck_token` or a cookie, and
  nothing catches code that pulls a token out of the JSON under some other name.
