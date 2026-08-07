# Hard-won implementation knowledge from auto-mate (predecessor project)

Deckhand's predecessor ("auto-mate") ran the same core loop — boot simulator, check out
branch/PR, build, install, stream to browser — in production long enough to accumulate
non-obvious lessons. This document distills them. File references point into the auto-mate
checkout (historically at `~/auto-mate/auto-mate`); the content below stands alone if that
checkout is gone.

**Do not port auto-mate code wholesale.** Port the *lessons*.

## 1. Driving the SimDeck daemon

- Auto-mate started the daemon with a long option string. Deckhand does not: it runs
  `simdeck -p <port>` (default 4310), which starts-or-reuses the local service and returns —
  see `server/src/testing/simdeck.ts`. On `EADDRINUSE`: `lsof -tiTCP:4310 -sTCP:LISTEN`, kill
  **only** PIDs whose command matches `simdeck`/`SimDeck` (SIGTERM→SIGKILL), clean both 4310
  and 4311, retry once.
- Readiness: poll `GET /api/health` every 250 ms, ≤15 s.
- Health gate before streaming: require software codec active, a stream-quality profile,
  and fps > 0. Auto-mate hard-required the **software (x264) encoder** for realtime
  previews — the hardware encoder stalled under multi-stream load. (SimDeck now handles
  hardware/software failover in `auto` mode; still verify under 3+ concurrent streams.)
- Cheap pre-flight worth copying: before showing a viewer, open the upstream stream WS
  with a 1.5 s timeout to confirm it upgrades; cache the verdict (60 s ok / 15 s fail).
- iOS: auto-mate created/booted sims itself via `simctl`; SimDeck merely attached display.
  Android: auto-mate let **SimDeck own boot** and read the adb serial back off SimDeck's
  simulator object. Deckhand does neither — it creates the AVD and boots the emulator itself
  via avdmanager/emulator/adb (`server/src/devices/android.ts`) on a fixed console port, so
  the serial is `emulator-<port>` and is derived rather than discovered. The durable lesson
  is only the negative one: never guess an adb serial.
- Useful simulator-object fields: `udid`, `platform` (`ios-simulator`|`android-emulator`),
  `isBooted`, `android.{avdName,serial,grpcPort}`,
  `privateDisplay.{displayReady,displayStatus,displayWidth,displayHeight,rotationQuarterTurns}`.

## 2. Browser streaming client

Auto-mate decoded H.264 with **WebCodecs `VideoDecoder`** onto a 2D canvas. That decode
model is what Deckhand kept; the wire format underneath it is not. Auto-mate's framing was
SimDeck's "SDH1" protocol, which was removed upstream and is deliberately **not** documented
here — nothing should be implemented against it. Deckhand vendors serve-sim's own parsing
instead (`viewer/src/stream/avcc.ts`, `viewer/src/stream/mjpeg.ts`).

The **client behaviors** below are the durable lessons. They are transport-agnostic — IDR
gating, monotonic timestamps, backlog reset, rAF single-frame paint, visibility gating,
bounded recovery, letterbox-corrected input — and apply directly to Deckhand's viewer.

### Client behaviors that made it reliable (transport-agnostic — port all of these)

1. **True-IDR gating**: don't feed deltas until a keyframe whose payload actually contains
   an IDR NAL (check Annex-B *and* 4/2/1-byte length-prefixed forms). While waiting, send
   `{type: "streamControl", forceKeyframe: true, snapshot: true}` upstream.
2. **Monotonic decode timestamps**: `ts = max(frameTs, prev + 1)`.
3. **Backlog reset**: if `decoder.decodeQueueSize > 2`, close the decoder and force a
   keyframe — catch up instead of drifting into latency.
4. **Decoder-config change mid-stream** (resolution/rotation) → re-enter keyframe wait.
5. **3 consecutive decode failures → fallback** (screenshot polling).
6. **Paint via rAF with a single pending frame**; `.close()` superseded VideoFrames
   immediately (prevents VideoFrame leaks and lag).
7. **IntersectionObserver (threshold 0.05) + visibilitychange** gate the stream — no decode
   when off-screen/backgrounded.
8. Watchdogs: first frame ≤2.5 s, display attach ≤4 s; bounded auto-recovery (≤8 attempts);
   server-side stream restarts throttled to 1/15 s.
9. **Android divergences**: skip iOS display-attach gating; reconnect the stream when the
   display key (W×H + rotationQuarterTurns) changes; tear down fully before recovery.
10. A single `disposed` flag guards every async callback from re-arming sockets/timers onto
    an unmounted component.

### Input encoding

- Normalized 0..1 coordinates with **letterbox/pillarbox correction** (canvas real aspect
  vs DOM box) — without it taps land offset whenever the frame doesn't fill the element.
- Realtime WS: `{type: "touch", x, y, phase: began|moved|ended|cancelled}`; moves throttled
  through rAF (only latest queued). Input WS reconnect ~350 ms.
- REST fallback when WS is closed: gesture distance < 0.015 → `POST /tap
  {x, y, normalized: true, durationMs}` (durationMs = clamp(gesture, 40, 800)); otherwise
  `POST /touch-sequence {events: [{x, y, phase, delayMsAfter}]}` with per-event delay
  clamp(total/(n−1), 16, 50).
- Never send raw `scroll` controls — use short touch drag sequences (SimulatorKit scroll
  packets can destabilize iOS runtimes; SimDeck rejects them anyway).

## 3. Build recipes (exact, battle-tested)

### Expo (dev-client) — detect: `expo` present in package.json dependencies

- Build+install: `npx expo run:ios --device "<udid>" --no-bundler`.
- Metro: `npx expo start --dev-client --localhost --port 8081`. **Never pass `--clear`** —
  wiping the cache forces a full ~18 MB re-bundle that races anything waiting on the app.
- Launch is a **deep link**, not `simctl launch`:
  `exp+<slug>://expo-development-client/?url=<metro-manifest-url>&disableOnboarding=1`
  opened via `simctl openurl` — after pre-approving the custom scheme with `PlistBuddy` in
  the sim's `schemeapproval.plist` (otherwise iOS shows a confirmation dialog nobody can
  click headlessly).
- Clean recovery: `rm -rf ios && npm install && (pod cache clean --all || true)`.

### Bare React Native iOS

- Guarded pods: `if [ -f ios/Podfile ] && ! cmp -s ios/Podfile.lock ios/Pods/Manifest.lock;
  then (cd ios && (bundle exec pod install || pod install)); fi`
- `npx react-native run-ios --udid "<udid>" --mode Release --no-packager`.
  **Release**, because Debug hangs on the "connect to Metro" screen headless; and
  **--no-packager**, because a busy port 8081 makes the RN CLI show an interactive
  "use 8082 instead?" prompt that hangs forever headless.

### NativeScript

- iOS: first pre-resolve SPM out-of-band (`ns prepare ios` +
  `xcodebuild -resolvePackageDependencies -disablePackageRepositoryCache
  -skipPackagePluginValidation`), then
  `ns run ios --no-hmr --no-watch --justlaunch --device "<udid>"`.
- Android: `ns run android --no-hmr --no-watch --justlaunch --device "<serial>"`.

### Cross-cutting

- xcodebuild-based flows: `xcodebuild … build` only compiles into DerivedData — you must
  `simctl install <udid> <path-to.app>` afterwards or launch fails.
- Dependency install: `[ -f package-lock.json ] && npm ci || npm install`; skip when a
  node_modules marker is newer than the newest of package.json/lockfiles.
- **Install verification**: poll the device, don't trust CLI exit codes —
  iOS `xcrun simctl get_app_container <udid> <bundleId>` every 5 s (in parallel with the
  installer process, so success is detected the moment the container appears);
  Android `adb -s <serial> shell pm path <packageId>`.
- **Boot/prep overlap**: `simctl bootstatus -b` costs ~40 s; run it concurrently with
  checkout + npm install + pod/SPM resolution. iOS only (Android prep needs the booted
  serial).
- **Env injection subtlety**: `EXPO_PUBLIC_*` values are inlined at Metro serve time for
  dev-client and at build time for Release — forward app env to the Metro process env
  *and* the native build env, or values silently disappear.
- Metro management: fixed port 8081, one server per app reused across runs, keyed by an
  env signature; restart only on env change or failed `GET /status`. Set
  `REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1`, `CI=1`.

## 4. Git / worktree mechanics

- Detached worktrees: `git worktree add --detach <path> <ref>`; refresh with
  `git reset --hard <ref>` + `git submodule update --init --recursive`.
- PR refs: `git fetch origin refs/pull/<N>/head:<local-ref> --force --prune` — works for
  fork PRs against the **base** repo; no fork access needed.
- **Local-first resolution**: before any network fetch, try `origin/<branch>`, `<branch>`,
  the PR ref, and HEAD in the base clone. If it resolves, build with zero network and zero
  token. Only remote-only refs mint a GitHub token.
- Token injection: ephemeral `GIT_ASKPASS` script (username `x-access-token`),
  `GIT_TERMINAL_PROMPT=0`, temp dir removed in `finally`. Lazy resolver for submodule
  tokens — only invoked when `.gitmodules` exists.
- Gotcha: `git remote get-url` lies under `insteadOf` rewrites — read raw
  `git config remote.origin.url` when checking repo identity.
- Concurrency: one install per worktree, guarded by a marker **set before the first
  `await`** (a marker set minutes into the pipeline leaves a race window).

## 5. Android specifics

- AVD creation: pick device profile + system image from available options, install images
  on demand (`yes | sdkmanager --licenses; sdkmanager "platforms;android-<api>" "<image>"`),
  then `avdmanager create avd --force --name <Name> --package <sysimg> --device <profile>`.
- Auto-mate booted and launched through SimDeck, polling ≤240 s for `isBooted &&
  android.serial`. Deckhand owns that itself: it starts the emulator on a fixed console
  port and waits on adb (`server/src/devices/android.ts`), so nothing has to be discovered
  from a daemon. What carried over unchanged is the ~240 s patience budget for a cold
  emulator, and `adb -s <serial> exec-out screencap -p` for a still frame.
- Tooling env is fiddly on macOS: resolve `JAVA_HOME` (Temurin 17/21 — reject broken
  Homebrew symlinks), `ANDROID_HOME`, and prepend
  `platform-tools`/`emulator`/`cmdline-tools/latest/bin` to PATH. Provide both an
  in-process env object and a shell-export variant for spawned bash.

## 6. Share links

- Share id: `crypto.randomBytes(18).toString("base64url")` (24-char URL-safe).
- Password: `scryptSync(password, salt16hex, 64)` + `timingSafeEqual` on equal-length
  buffers. (Consider explicit scrypt cost params; defaults are N=16384.)
- WS proxy authorization: share variants of the stream/input endpoints validate the share
  (+ password from the WS URL query) at upgrade time; the password is **stripped** from
  anything forwarded upstream. Unlock via POST (GET can't carry the gate).
- Proxy details: buffer up to ~16 client messages while the upstream WS is CONNECTING;
  mirror both directions; never forward close codes 1005/1006/1015 (use 1011).
- Elegant expiry trick: bind the share to the preview/lease id at creation and return
  410 Gone when the underlying device is re-leased — shares die on reuse without cron.

## 7. Reliability: display-heal ladder, warm pool, watchdogs

- **Display-heal ladder** (fixes the #1 "stream is black but device is booted" failure):
  if booted but display detached/not-ready, escalate cheapest-first, stopping when healthy:
  (a) SimDeck boot/attach call (sub-second), (b) single-device shutdown+boot,
  (c) SimDeck daemon restart — **rate-limited to 1/60 s globally** (it's host-wide;
  concurrent previews must not stampede it). Never hand out a "ready" device without a
  display-health check.
- **Warm pool**: pre-created+booted bare devices pay the ~40 s boot
  ahead of demand; adopt into a preview on request; erase back to bare on release so app A
  never leaks into preview B. Leases carried a token + TTL backstop, but the real reclaim
  signal was **heartbeat staleness** (bumped on observable progress), not TTL.
- **Idle watchdogs on spawned processes**: a general idle timeout (~6 min) plus
  stage-specific shorter ones (e.g. ~3 min for SPM "Resolve Package Graph", which stalls
  silently).
- **Disk budget tiers** (GiB free): watch 50 / pressure 35 / critical 20 — at critical,
  refuse new simulator work (HTTP 507 / structured MCP error). Janitor every 10 min + at
  boot: failed previews >2 h, orphan worktrees >1 h, DerivedData only under pressure,
  `xcrun simctl delete unavailable` at most once/24 h. Never delete active/busy items.

## 8. Top pitfalls (quick table)

| # | Pitfall | Consequence if ignored |
|---|---|---|
| 1 | Metro `--clear` | Full re-bundle races app startup |
| 2 | Bare RN Debug build headless | Hangs on Metro-connect screen |
| 3 | RN CLI with port 8081 busy | Interactive prompt hangs install |
| 4 | Trusting `xcodebuild build` | App never installed; launch fails |
| 5 | Trusting installer exit codes | Miss early success / late failure — poll the device |
| 6 | Serial `bootstatus` then prep | +40 s per cold preview |
| 7 | Keyframe flag without IDR check | WebCodecs decode errors on stream open |
| 8 | Unbounded decode queue | Latency drift into unusability |
| 9 | No letterbox correction on input | Taps land offset |
| 10 | Guessing adb serials | Wrong-device installs when >1 emulator |
| 11 | Global daemon restarts unthrottled | Concurrent previews kill each other's streams |
| 12 | `git remote get-url` + insteadOf | Wrong repo-identity decisions |
| 13 | Env only in launch args | `EXPO_PUBLIC_*` silently missing from bundle |
| 14 | No display-health gate on "ready" | Black-screen links handed to users |
