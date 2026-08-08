# serve-sim notes (iOS streaming backend)

serve-sim — https://github.com/EvanBacon/serve-sim (Apache-2.0, npm `serve-sim`, by Evan
Bacon / Expo) — is Deckhand's iOS streaming backend. Where a detail matters for
implementation, **read the source** in `node_modules/serve-sim` rather than trusting this
summary: the project moves, and the pin in `server/package.json` moves with it.

## What it is

> "`serve-sim` spawns a small Swift helper that captures the simulator's framebuffer via
> `simctl io`, exposes it as an MJPEG stream + WebSocket control channel, and serves a
> React preview UI on top. It works with any booted iOS Simulator — no Xcode plugin, no
> instrumentation in your app." — README

- **Explicitly built for our topology**: "host on a remote mac and tunnel anywhere".
- Full 60 FPS stream; codec `auto` = **H.264 when the browser can decode it (WebCodecs)**,
  `mjpeg` forces software JPEG (e.g. VMs without H.264 encode). Both ride **HTTP**, not a
  WebSocket (see the endpoint table below); the WebSocket carries input only. So: H.264
  primary, MJPEG fallback — no WebRTC, no TURN, no ICE anywhere in the codebase
  (verified: zero hits for webrtc/turn/stun/RTCPeerConnection outside the lockfile).
- Input: touch/gestures/keyboard forwarded over a WS control channel; swipe-home, pinch
  (option key), CMD+SHIFT+H, etc.
- **Accessibility tree** (`src/ax.ts`, `src/ax-shared.ts`) — feeds Deckhand's `describe`.
- Simulator logs forwarded to the browser; `serve-sim event-log` CLI. Deckhand does not use
  either — the `logs` tool serves deckhand's OWN captured streams, never serve-sim's.
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
  `serve-sim --kill [device]` manage running streams. Deckhand uses the kill form (`-k`) plus
  its own `lsof` over the helper port range, and never reads `--list`. That pair is
  `reapOrphans` in `server/src/streaming/serveSim.ts` — crash recovery, run once at boot from
  `server.ts`. The marker-based janitor cannot help here: serve-sim daemonizes itself, so a
  helper carries no env marker and the marker sweep cannot see it at all.

## CLI surface — serve-sim's own, NOT what Deckhand calls

Deckhand invokes exactly two forms: `--detach -p <port> <udid>` and `-k [udid]`
(`server/src/streaming/serveSim.ts`). Nothing else below is called from this repo.

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

## Endpoints & wire protocol

Verified against the pinned serve-sim source in `node_modules` — `server/package.json` holds
the exact version, and it has moved since these notes were first written, so read the source
before trusting a detail. Symbols are named rather than line-numbered: the line numbers here
were wrong within two minor versions.

Per-device helper routes are served under `{base}/helper/<udid>/` (in-process from a native
`DeviceSession`, dispatched in `middleware.ts`). The ones Deckhand uses:

| Path | Transport | Purpose |
|---|---|---|
| `/helper/<udid>/stream.avcc` | **chunked HTTP `fetch()` body** (NOT a WebSocket) | H.264 primary |
| `/helper/<udid>/stream.mjpeg` | HTTP `multipart/x-mixed-replace` | MJPEG fallback |
| `/helper/<udid>/ws` | WebSocket (binary frames) | HID input (touch/keyboard) |
| `/helper/<udid>/ax` | SSE | accessibility tree → `describe` |

The H.264 path is **`stream.avcc` over a long-lived chunked HTTP response**, not a
WebSocket — the only WebSocket here is `/ws`, and it carries input. The pinned serve-sim does
route `/stream.avcc`; whether it encodes on a given machine is a runtime answer, so the
viewer probes avcc and falls back to MJPEG on a 404 rather than deciding in advance.
Framing (`client/avcc-codec.ts`): repeating
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
`wsUrl = …/helper/<udid>/ws`. `rewriteStateForRequestHost` (`middleware.ts`) re-anchors
these to the request host and honors `x-forwarded-proto` → this is why the proxy MUST
forward `X-Forwarded-Proto: https` (Cloudflare terminates TLS) or the browser builds `ws://`
URLs and mixed-content-blocks them.

The HID `/ws` carries binary WebSocket frames straight to the native session (the upgrade
handler in `middleware.ts`); Deckhand's proxy passes them through opaquely (it need not decode
them). The exact touch/gesture payload encoding lives in the native addon + client — vendor
serve-sim's client input code rather than re-deriving it. `exec-ws.ts` is a **separate**
`/exec-ws` channel (shell exec + settings + SSE mux, token-gated) that Deckhand must **never**
expose through the tunnel/proxy.

### How Deckhand drives it

Deckhand spawns one **detached daemon per device** — `serve-sim --detach -p <port> <udid>`,
against a simulator it created and booted itself — parses the JSON the CLI prints for the
stream/input URLs, and reverse-proxies only those helper endpoints. Preview mode was not
taken: its device stream is lazy and browser-driven, so it never attaches to a headless
`simctl`-booted sim. The code and its reasoning are `server/src/streaming/serveSim.ts`; the
trap that `-p` is a request rather than an instruction is recorded once, in
`.claude/rules/streaming.md`, and is not repeated here.

**Only four subpaths** are exposed through the share proxy — `stream.avcc`, `stream.mjpeg`,
`ws` and `ax` (`PROXY_ALLOWED_SUBPATHS` in `server/src/streaming/backend.ts`). `ax` is the
accessibility SSE stream, so this is video, input AND inspection; what is never forwarded is
the preview UI, camera, exec and DevTools routes.

- **TLS/proxy note (critical for the tunnel)**: "When terminating TLS at a reverse proxy,
  forward `X-Forwarded-Proto` so the helper URLs use `https`/`wss` and avoid mixed-content
  blocks." cloudflared terminates TLS at Cloudflare's edge → Deckhand's proxy must forward
  this header.

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

Key property vs SimDeck's video design, which was rejected for video (SimDeck is still used,
control-only, for `describe`/`ui`): **no global daemon** — one small helper per
device, spawned/killed by Deckhand. A sick stream is fixed by killing and respawning one
process; there is no shared-daemon state to heal and no host-wide restart that can stampede
other previews.

## Risk notes

- Young project: the exact npm version is pinned in `server/package.json`, and
  `server/src/test-support/invariants.test.ts` fails the build on a range or on a patch file
  that no longer matches the pin — the pin is a security control, because `patch-package`
  strips serve-sim's `/exec` routes — which is what plain `deckhand doctor` checks about the
  vendored copy: that it is installed and that the patch is still applied. Helper spawn plus
  a first frame is the hardware pass, `deckhand doctor --device-only` (or `--smoke`). Apache-2.0 and small → vendor/fork is a real escape hatch.
- Rides `simctl io` (public interface) — materially safer against new Xcode/iOS-runtime
  releases than private-framework bridges, but still verify early on beta Xcode.
- iOS-only. Android is a separate backend behind the same `StreamingBackend` seam, and it is
  **adb-based**: on-device `screenrecord` repackaged to AVCC for H.264
  (`server/src/streaming/androidH264.ts`), with `screencap` MJPEG as the fallback
  (`server/src/streaming/androidAdb.ts`). scrcpy was evaluated for that role and **rejected**
  — its raw H.264 wire protocol is version-specific and needs on-device iteration that could
  not be validated at decision time (PLAN §8). Do not reach for it now; the seam is where a
  future scrcpy upgrade would go if anyone ever wanted one.
