# SimDeck notes — STREAMING historical; CONTROL adopted 2026-07-17

> **Update 2026-07-17 — SimDeck's *control/inspection* layer is now adopted** as the
> backend for the `describe`/`ui` MCP tools and agent-driven testing (see PLAN §6
> amendment and `server/src/testing/`). The rejection below applies to SimDeck's **video
> transport only** (WebRTC/TURN can't cross deckhand's HTTP-only tunnel). Its control is
> decoupled from video: deckhand drives **REST only** (`/action`, `/accessibility-tree`,
> `/screenshot.png`) on a device it already booted, never the input WS / webrtc / refresh
> (which start the private display bridge). deckhand keeps serve-sim / adb-screencap for
> the human video. Everything under "What SimDeck provides" is now a live integration
> reference, not just history — but the **streaming/display** sections remain rejected.

> **Superseded 2026-07-09 (streaming only).** Deckhand does **not** use SimDeck for video. The streaming layer is
> serve-sim (iOS) + scrcpy (Android, Phase 2) over plain WebSocket/HTTP — see PLAN.md §2/§8
> and `serve-sim-notes.md`. SimDeck was rejected because: (a) it removed its
> H.264-over-WebSocket transport in v0.1.31 (2026-06-04, PR #76), leaving only WebRTC,
> which cannot reach a mini behind an HTTP-only tunnel without paid/operated TURN relay
> infrastructure; (b) its display bridge rides private CoreSimulator APIs (fragile against
> new Xcode releases, unfixable if pinned); (c) much of the predecessor project's
> operational scar tissue (display-heal ladder, daemon port cleanup, token discovery) was
> SimDeck-specific pathology. Kept only as context for those decisions and as a map of a
> full-featured device-layer API. Do not implement against anything in this file.

SimDeck — https://github.com/NativeScript/SimDeck (open source, npm package `simdeck`) —
was the previously planned device layer. These notes summarize it as of 2026-07 (v0.1.x
line). Authoritative docs: https://simdeck.sh and `docs/` in the SimDeck repo.

## What SimDeck provides (that Deckhand must NOT rebuild)

- **Streaming**: native H.264 for iOS simulators (VideoToolbox hardware or x264 software)
  and Android emulators (gRPC `streamScreenshot` / `-share-vid` shared display surface,
  encoded on the Mac). Browser delivery via WebRTC; encoder pauses automatically when no
  visible viewer remains.
- **Input**: touch/multiTouch/key/button/home/rotation over an input WebSocket
  (JSON, camelCase, normalized 0..1 coords) plus REST actions (`tap`, `touch-sequence`,
  `type`, `button`, `openUrl`, …). Raw `scroll` is rejected by design — use touch drags.
- **App management**: install (`.app` path / uploaded `.ipa`/`.apk`), uninstall, launch.
- **`describe`**: real-time accessibility/view-tree snapshot in a token-efficient format
  built for agents — sources: framework inspector (NativeScript/RN/Flutter plugins) →
  Swift in-app agent (UIKit/SwiftUI) → native accessibility fallback. This powers
  Deckhand's `describe` MCP tool directly.
- **Android emulator boot ownership**: SimDeck boots AVDs (`-qt-hide-window`, `-gpu host`,
  per-AVD `-grpc` port) and exposes the adb serial in its simulator objects.
- **Profiling** (CPU/memory/network/hangs), camera simulation, device-bezel chrome assets,
  `simdeck/test` JS test harness — available later, not needed for Deckhand v1.
- **Browser client** (`packages/client`, React 19): the reference implementation for
  stream setup and input handling. URL params include `simdeckToken`, `stream`,
  `iceServers`/`iceUsername`/`iceCredential`.

## Daemon & auth

- Start: `simdeck daemon start --port 4310 --bind 127.0.0.1 --video-codec software
  --stream-quality balanced --local-stream-fps 60`; status via `simdeck daemon status` /
  `simdeck service status`; also `simdeck -a` registers login autostart (Deckhand manages
  its own launchd instead).
- Binds loopback by default. LAN mode exists (`--bind 0.0.0.0` + pairing codes) — Deckhand
  does **not** use it; everything goes through Deckhand's authenticated proxy.
- API auth: `X-SimDeck-Token: <token>` or `Authorization: Bearer <token>`. Loopback
  browser sessions get the token automatically; the token can be discovered from
  `/api/health` (Set-Cookie `simdeck_token` / `?simdeckToken=` URLs in the body).

## REST/WS surface used by Deckhand (see `docs/api/rest.md` in the SimDeck repo)

- Server: `GET /api/health`, `GET /api/metrics`, `GET/POST /api/stream-quality`.
- Devices: `GET /api/simulators`, `GET /api/simulators/create-options`,
  `POST /api/simulators` (create), `POST /api/simulators/{udid}/boot | /shutdown`.
  Android ids look like `android:<avdName>`; booted objects expose `android.serial` and
  `privateDisplay.{displayReady, displayWidth, displayHeight, rotationQuarterTurns}`.
- Apps: `POST /api/simulators/{udid}/install {appPath}`, `/uninstall {bundleId}`,
  launch/openUrl via `POST /api/simulators/{udid}/action`
  (`{action: "launch", bundleId}` / `{action: "openUrl", url}`).
- Live video: `POST /api/simulators/{udid}/webrtc/offer` (SDP offer→answer, with
  `streamConfig: {profile, fps, videoCodec}`), `GET /api/simulators/{udid}/input`
  (input/control WS; alias `/control`), `POST /api/simulators/{udid}/refresh`
  (fresh frame/keyframe).
- UI state: describe endpoint(s) — check `docs/api/rest.md` §"UI state and inspection"
  for the exact path and the token-efficient format flag.

## Video pipeline facts that matter

- Stream-quality profiles: `full, smooth, balanced, economy, low, tiny, ci-software`
  (`tiny` is what SimDeck's own PR previews use; `balanced` is a good default for
  Deckhand viewers). Android long-edge is capped (960 px at `balanced`).
- Codec: `--video-codec auto|hardware|software`. In `auto`, one active stream gets the
  hardware encoder and additional concurrent streams fall back to software — relevant for
  multi-device previews. The predecessor project hard-required `software` for reliability
  under load; start with `software`, revisit after testing 3+ concurrent streams.
- Encoding starts on demand (visible viewer / frame subscriber) and pauses when all
  viewers are hidden — the browser reports page/canvas visibility upstream, so Deckhand's
  viewer must forward those signals (or streams will not pause → wasted CPU).

## The CI / tunnel / password pattern (design inspiration for Deckhand's share links)

SimDeck's GitHub Actions integration (`actions/run-{ios,android}-comment-session`,
`docs/guide/github-actions.md`) already serves **remote, password-gated, tunneled viewer
sessions**, proving the whole delivery path works over plain HTTPS:

1. `cloudflared tunnel --url http://127.0.0.1:4310 --protocol http2` (ephemeral
   trycloudflare.com hostname; Deckhand uses a **named** tunnel instead).
2. Public URL = `<tunnel>?simdeckToken=<token>` — the SimDeck browser client, authenticated
   via query token. **Correction to an earlier assumption:** the tunnel carries the client
   assets, the SDP signaling, and the control WS — but **not** the WebRTC media. Media rides
   ICE/TURN out-of-band. Latest SimDeck is WebRTC-only (raw H.264-over-WebSocket was removed
   in v0.1.31, 2026-06-04, PR #76). **Deckhand's decision (locked): WebRTC + TURN relay over
   TCP/TLS 443** (see PLAN.md §9), which is the only way media reaches a browser when the
   mini has no inbound path, and is what passes locked-down networks.
3. Optional password gating via a stateless Cloudflare Worker
   (`packages/ci-proxy-worker`): the posted link is
   `https://ci.simdeck.sh/?redirect=<base64url-payload>`; with a password configured, the
   daemon token inside the payload is **encrypted with the password**, so decoding the URL
   alone grants nothing. Deckhand implements its own share gate server-side instead, but
   the encrypt-token-with-password idea is worth remembering.
4. Sessions live for a keepalive window (default 1800 s) then self-terminate — same idea
   as Deckhand's idle reaper.

## Differences: how Deckhand uses SimDeck vs how SimDeck is normally used

| Normal SimDeck | Deckhand |
|---|---|
| Developer's own Mac, IDE-adjacent, one user | Shared Mac mini, many users, driven by MCP |
| Browser client served by SimDeck itself | Deckhand's own viewer; SimDeck client is reference code |
| Token in browser via loopback/pairing/query | SimDeck token held server-side only; viewers pass through Deckhand's scoped, share-authorized proxy |
| App built elsewhere (or CI artifact) | Deckhand builds branch/PR from source on the mini |
| CI sessions are ephemeral (≤35 min runner) | Previews persist until stopped/idle-reaped |
