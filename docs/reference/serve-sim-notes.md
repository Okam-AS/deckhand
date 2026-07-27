# serve-sim notes (iOS streaming backend)

serve-sim — https://github.com/EvanBacon/serve-sim (Apache-2.0, npm `serve-sim`, by Evan
Bacon / Expo) — is Deckhand's iOS streaming backend. These notes were verified against the
repo source on 2026-07-09. Where a detail matters for implementation, **read the source**
(paths given) rather than trusting this summary; the project is young and moves.

## What it is

> "`serve-sim` spawns a small Swift helper that captures the simulator's framebuffer via
> `simctl io`, exposes it as an MJPEG stream + WebSocket control channel, and serves a
> React preview UI on top. It works with any booted iOS Simulator — no Xcode plugin, no
> instrumentation in your app." — README

- **Explicitly built for our topology**: "host on a remote mac and tunnel anywhere".
- Full 60 FPS stream; codec `auto` = **H.264 when the browser can decode it (WebCodecs)**,
  `mjpeg` forces software JPEG (e.g. VMs without H.264 encode). So: H.264-over-WS primary,
  MJPEG-over-HTTP built-in fallback — no WebRTC, no TURN, no ICE anywhere in the codebase
  (verified: zero hits for webrtc/turn/stun/RTCPeerConnection outside the lockfile).
- Input: touch/gestures/keyboard forwarded over a WS control channel; swipe-home, pinch
  (option key), CMD+SHIFT+H, etc.
- **Accessibility tree** (`src/ax.ts`, `src/ax-shared.ts`) — feeds Deckhand's `describe`.
- Simulator logs forwarded to the browser; `serve-sim event-log` CLI — feeds `logs`.
- Extras we may use later: camera injection (file/webcam/placeholder), drag-drop media,
  rotate, ca-debug flags, memory-warning, DevTools proxying.
- Apple Watch, iPad, iOS supported.

## Requirements / constraints

- macOS + Xcode command line tools (`xcrun simctl`), Node 20+ (maintained LTS).
- **Apple Silicon (arm64) only** — the bundled `serve-sim-bin` Swift helper does not run on
  Intel. (Deckhand's runbook preflight must check `uname -m`.)
- The Swift helper is a standalone binary embedded in the npm package — no Xcode dependency
  at runtime beyond simctl.
- Helper state lives in `$TMPDIR/serve-sim/` (pid/port registry). `serve-sim --list` and
  `serve-sim --kill [device]` manage running streams — Deckhand's janitor uses these plus
  its own pid tracking to guarantee zero orphans.

## CLI surface (the parts Deckhand uses)

```
serve-sim [device...]                 Start preview server (default: localhost:3200)
serve-sim --no-preview [device...]    Stream in foreground without a preview server
  -p, --port <port>                   Starting port (preview 3200; helper default 3100)
  -d, --detach                        Spawn helper and exit (daemon mode)
  -q, --quiet                         JSON-only output
      --codec <auto|mjpeg>            auto = H.264 when browser can decode
      --list [device] / --kill [device]
serve-sim gesture '<json>' [-d udid]  Send a touch gesture
serve-sim button [name] [-d udid]     Button press (default: home)
serve-sim type <text> [-d udid]       Type text (US keyboard; --stdin / --file)
serve-sim rotate <orientation> [-d udid]
serve-sim event-log [-d udid]         Recent simulator events
```

Devices are addressed by name or UDID; Deckhand always uses the UDID of the sim it created.

## Endpoints & wire protocol (VERIFIED against source 2026-07-09, v0.1.34)

Per-device helper routes are served under `{base}/helper/<udid>/` (in-process from a native
`DeviceSession`; `middleware.ts:696-816`). The ones Deckhand uses:

| Path | Transport | Purpose |
|---|---|---|
| `/helper/<udid>/stream.avcc` | **chunked HTTP `fetch()` body** (NOT a WebSocket) | H.264 primary |
| `/helper/<udid>/stream.mjpeg` | HTTP `multipart/x-mixed-replace` | MJPEG fallback |
| `/helper/<udid>/ws` | WebSocket (binary frames) | HID input (touch/keyboard) |
| `/helper/<udid>/ax` | SSE | accessibility tree → `describe` |

**Correction to any earlier note:** the H.264 path is **`stream.avcc` over a long-lived
chunked HTTP response**, not a WebSocket. Framing (`client/avcc-codec.ts`): repeating
`[len:u32-be][tag:u8][payload]` where `len = payload.length + 1`. Tags: `0x01` description
(avcC SPS/PPS → decoder config), `0x02` keyframe (IDR), `0x03` delta (P-frame), `0x04` seed
(a JPEG painted before the first IDR decodes). Codec string from avcC bytes 1-3
(`avc1.<PP><LL><MM>`, fallback `avc1.42E01E`). This HTTP-stream design is deliberate and
tunnel-friendly — the code has explicit notes about port-forward tunnels splitting each
frame into many small reads (hence the amortised-append demuxer, which Deckhand vendors).

**AVCC→MJPEG fallback latch** (`client/avcc-fallback.ts`): the browser commits to AVCC when
WebCodecs exists, but if **no frame arrives within `AVCC_FRAME_TIMEOUT_MS = 4000`** (dead
endpoint / opaque cross-origin 404), or the decoder errors fatally mid-stream, fall back to
MJPEG for the session. A healthy helper paints its JPEG seed sub-second.

State shape (`state.ts`): `streamUrl = …/helper/<udid>/stream.mjpeg`,
`wsUrl = …/helper/<udid>/ws`. `rewriteStateForRequestHost` (`middleware.ts:426`) re-anchors
these to the request host and honors `x-forwarded-proto` → this is why the proxy MUST
forward `X-Forwarded-Proto: https` (Cloudflare terminates TLS) or the browser builds `ws://`
URLs and mixed-content-blocks them.

The HID `/ws` carries binary WebSocket frames straight to the native session
(`middleware.ts:804-816`); Deckhand's proxy passes them through opaquely (it need not decode
them). The exact touch/gesture payload encoding lives in the native addon + client — vendor
serve-sim's client input code rather than re-deriving it. `exec-ws.ts` is a **separate**
`/exec-ws` channel (shell exec + settings + SSE mux, token-gated) that Deckhand must **never**
expose through the tunnel/proxy.

### Embedding vs per-device spawn — Deckhand's choice

`simMiddleware(options)` (`middleware.ts:1235`) is a Node HTTP middleware that serves all the
routes above **in-process** via the native addon; `startDeviceInProcess(udid, port, base)`
(`middleware.ts:721`) boots a sim and registers it. So serve-sim's own model is now
in-process capture, not a separate helper daemon. Two integration options for Deckhand
(pick in Phase 1, revisit if the native addon proves unstable):

1. **Spawn `serve-sim <udid> -p <port> -q` per device** as a child process on a loopback
   port; Deckhand creates+boots the sim first (its own runtime choice), then points serve-sim
   at the udid (its boot is idempotent); reverse-proxy only `/helper/<udid>/{stream.avcc,
   stream.mjpeg,ws,ax}`. Deckhand owns the pid and reaps it; janitor uses `serve-sim
   --list`/`--kill` + a pid table for orphans. **Best process isolation** (a crashed capture
   kills one device, not Deckhand) — matches the "no global daemon" property. Preferred.
2. **Embed `simMiddleware` in Deckhand's Express server.** Fewer processes, but pulls
   serve-sim's whole surface (incl. `/exec`, grid api) into Deckhand's process and couples
   its stability to the native addon. Only if option 1 has problems.
- **Embedding API**: serve-sim exports middleware usable inside your own HTTP server, with
  a `proxyHelpers` option; you must wire the HTTP `upgrade` event yourself:
  `server.on("upgrade", (req, socket, head) => middleware.handleUpgrade(req, socket, head))`.
  README warns: with `proxyHelpers` but no `upgrade` wiring, video-over-HTTP still works but
  **simulator input and DevTools die** (their sockets never reach the proxy).
- **TLS/proxy note (critical for the tunnel)**: "When terminating TLS at a reverse proxy,
  forward `X-Forwarded-Proto` so the helper URLs use `https`/`wss` and avoid mixed-content
  blocks." cloudflared terminates TLS at Cloudflare's edge → Deckhand's proxy must forward
  this header.
- Two integration shapes for Deckhand (implementer picks in Phase 1):
  1. Spawn `serve-sim --no-preview -q -p <port> <udid>` per device and reverse-proxy the
     helper endpoints under `/s/:shareId/dev/:deviceId/*` (Deckhand owns the child pid —
     simplest lifecycle).
  2. Embed the middleware in Deckhand's express server and let it proxy helpers (fewer
     moving parts in the request path; lifecycle via the state file).
  Either way, **only** the video + input endpoints are exposed through the share proxy —
  never the preview UI, camera, exec, or DevTools routes.

## Client code to vendor (Apache-2.0, keep attribution)

In `packages/serve-sim/src/client/`:

- `avcc-codec.ts`, `avcc-fallback.ts` — H.264/avcC handling for the WebCodecs decode path.
- `utils/mjpeg-frame-parser.ts` — MJPEG fallback parsing.
- `utils/hid.ts` — pointer→simulator input encoding (compose with Deckhand's
  letterbox-correction + rAF throttling from the learnings doc).
- `utils/sim-endpoint.ts`, `utils/exec.ts` — endpoint/WS plumbing shapes.
- `client.tsx` / `Panel.tsx` — reference only; Deckhand ships its own calm viewer UI.

Do not invent a new wire format: speak exactly what the helper serves, and prefer vendoring
their parsing code over re-implementing it.

## Architecture (from README)

```
┌──────────────┐   simctl io   ┌─────────────────┐  MJPEG / WS  ┌─────────┐
│ iOS Simulator│ ────────────► │ serve-sim-bin   │ ───────────► │ Browser │
└──────────────┘   (Swift)     │ (per-device)    │              └─────────┘
                               └─────────────────┘
                                       ▲
                                  state file in
                                $TMPDIR/serve-sim/
                                       ▲
                               ┌──────────────────┐
                               │ serve-sim CLI /  │
                               │ middleware       │
                               └──────────────────┘
```

Key property vs the rejected SimDeck design: **no global daemon** — one small helper per
device, spawned/killed by Deckhand. A sick stream is fixed by killing and respawning one
process; there is no shared-daemon state to heal and no host-wide restart that can stampede
other previews.

## Risk notes

- Young project: pin the exact npm version in `config.yaml`; `deckhand doctor` verifies
  helper spawn + WS upgrade + first decoded frame on the pinned version. Apache-2.0 and
  small → vendor/fork is a real escape hatch.
- Rides `simctl io` (public interface) — materially safer against new Xcode/iOS-runtime
  releases than private-framework bridges, but still verify early on beta Xcode.
- iOS-only. Android is a separate backend (scrcpy-based, Phase 2) behind the same
  `StreamingBackend` seam.
