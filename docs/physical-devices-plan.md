# Physical devices and prebuilt EAS builds

**Status (2026-11-03): item 2 of the landing order, physical Android, is built** (see
"Landing order" below for what it settled and where it differs from this plan). Items 3–5 —
the EAS source and everything iPhone — are proposed, not built.

This document asks to reverse two locked decisions in PLAN §2,
"NO physical devices, either platform" and "Build strategy: … No CI artifacts", and lays out
how deckhand would then drive phones plugged into the Mac by cable and install builds that
EAS already made. Nothing here exists yet. Tool parameters, config keys and file names
below are proposals; PLAN and AGENTS change only in the PR that ships each piece.

It assumes `check` and `navigate`'s `see` (the screenshot-to-Jev work) have landed on `main`.

## Why now

PLAN §2 recorded why physical devices were dropped, and that analysis still holds. The
argument here is that each wall has since been walked around once, outside deckhand, on a
real phone:

- **"There is no public API to inject touch into a physical iPhone from a Mac. XCUITest can,
  but only through a test runner app deckhand would have to build, sign and install first."**
  The runner does not have to be built or signed here. WebDriverAgent (WDA, the XCUITest
  runner most iOS automation stands on) can be signed **once, on a developer's own machine**,
  copied to the Mac as a built Products folder, and started with
  `xcodebuild test-without-building`. That needs Xcode, but no Apple ID, certificate or
  profile in the Mac's keychain. PLAN §11 item 7 ("no personal credentials") still holds.
  One profile covers the phones listed in it and lasts a year.
- **"serve-sim is simulator-only, so streaming would need a new backend."** It does need a
  new backend, but not AVFoundation capture: WDA serves an MJPEG stream of the screen, and
  the viewer already plays MJPEG as its fallback.
- **"iOS building needs a developer certificate, a provisioning profile and a registered
  device UDID."** Still true, and this plan does not build for physical iPhones. It installs
  a signed internal-distribution `.ipa` that EAS already built. That is the second reversal.
- **Android "lacks device lifecycle".** That is still the whole job for Android: the
  streaming and input path is serial-based adb and does not care what the serial is.

A prototype outside deckhand drove a USB iPhone this way: read the accessibility tree, took
screenshots, read syslog, and checked installs with `devicectl`. Taps, typing and installs
on that iPhone have not been tested yet, so this plan treats them as the first thing PR 3
must show on hardware.

## What changes in the product

The one sentence still holds: a branch becomes a live, controllable device in a browser.
A plugged-in phone becomes one more kind of device, with three differences an agent and a
human can see:

1. **A phone is borrowed hardware, never created.** Deckhand never boots, wipes, erases,
   deletes or reaps one, and never changes a setting on it. Teardown means "stop driving
   it", not "delete it".
2. **A phone has one tenant.** A simulator can be minted for every caller; a phone cannot.
   Deckhand is the only thing that drives a cabled phone on this Mac, and a phone is in at
   most one live preview at a time.
3. **A phone runs a prebuilt app, or an Android build deckhand made itself.** A physical
   iPhone only ever gets an EAS-built `.ipa` signed for it.

Unchanged: one operator per install, no database, no webhooks, no scheduler. Something that
wants a phone tested every night calls deckhand over MCP, the same way an agent does today.

## Decisions to make

| # | Question | Proposed answer |
|---|---|---|
| D1 | Reverse "NO physical devices"? | Yes. Android first, then iPhone, each opt-in by plugging one in (Android) or by installing a pre-signed WDA (iPhone). |
| D2 | Reverse "No CI artifacts" for EAS? | Yes, as a third preview source next to `git` and `local`. The local build stays the default for simulators. |
| D3 | Who signs WDA? | Never this Mac. The operator signs it elsewhere and places the Products folder under the deckhand home. `doctor` reports its expiry and which UDIDs it covers. |
| D4 | Install conflicts (signature mismatch, downgrade) | Refuse with an actionable error by default ("never destroy what you did not create"). Open question: allow an uninstall when deckhand's own state shows deckhand installed that exact app on that phone. |
| D5 | Default share access for a phone | PIN, not public. A phone can hold accounts and make calls, and a share link controls the whole device, not just the app. |
| D6 | Android control for phones | Ask SimDeck first. If it cannot address a serial without an AVD name, use deckhand's existing adb path (`uiautomator dump`, `input`) behind the same control seam. |
| D7 | Where phones sit in `limits` | Outside `maxTotalDevices`. That cap protects the Mac's CPU and RAM from simulators; a phone costs neither. |

## Design

### Discovery and identity

- **Android:** `adb devices -l`, minus every `emulator-*` serial. The serial is the id.
- **iPhone:** `xcrun devicectl list devices` for paired, USB-connected phones, plus
  `ideviceinfo` for model and OS. The UDID is the id. A Wi-Fi-only pairing is not a target
  (see Security).
- `list_devices` gains a `physical` section, but **only listing phones deckhand can target
  now**, each with its blocker when it cannot: "not authorized for USB debugging",
  "Developer Mode off", "UI Automation off", "no WDA installed", "WDA profile does not list
  this phone", "locked". This is the line the deleted scanner did not have: an entry is a
  target, or it names the one action that makes it one.
- `start_preview` devices gain an `id` (serial or UDID) next to `platform`, plus a
  `physical: true` shorthand meaning "any free phone of this platform".

### Tenancy

- A phone has one live preview at most. A second `start_preview` naming it fails with
  `device_busy`, naming the preview and share that hold it, and saying how to free it
  (`stop_preview`, or the viewer).
- A **hold** lets a human take a phone off the market from the Mac (a new CLI verb,
  proposed as "deckhand phone hold"). A held phone is listed with who holds it and is never handed
  to a preview.
- Tenancy lives in `state.json` like share ids. "Ask adb, not your own bookkeeping" still
  applies: a phone that left adb or `devicectl` ends its preview's device with an error,
  not a silent `ready`.

### Lifecycle

The emulator-only paths in `server/src/devices/android.ts`, `server/src/engine/preview.ts`
and `server/src/engine/reaper.ts` branch on the device kind:

- **Boot:** skip. Wait for the phone to be awake and unlocked, check the blockers above, then
  carry on. There is no `-wipe-data`, AVD lease or port allocation.
- **Teardown:** stop the app (`am force-stop`, or `devicectl … process terminate`), remove
  deckhand's `adb reverse` rules, and release tenancy. Never `adb emu kill`, `deleteAvd`
  or `simctl delete`. Today `shutdown` reads "adb no longer knows the serial" as dead, which
  is wrong for a phone; that becomes a check that fails if a physical serial ever reaches it.
- **Reaper:** physical devices are outside its selection by construction, and a test fails
  if one ever enters it.
- **Metro:** an Android phone reaches the host over `adb reverse`, which deckhand already
  uses (`reverseMetroPorts`). `reassertAndroidReverse` keys on the emulator port today and
  must key on the serial. An iPhone running a dev client cannot reach the Mac's loopback over
  USB; for iPhones the dev-client path loads an EAS Update instead (see EAS source).

### Control (`describe`, `ui`, `navigate`, `check`)

The `ui` action list, `ref` model and settle rules stay exactly as they are; only the
backend behind `server/src/testing/control.ts` gains implementations:

- **Android phone:** SimDeck if D6 says it can, otherwise adb. Taps are in pixels, as the
  tree reports them. `input text` is ASCII-only, so typing æ, ø and å needs an IME-based
  path or a clear error, never a silent mangle.
- **iPhone:** a WDA client, REST only, on loopback only, with no token, matching the
  `testing-control.md` rules for SimDeck.
  - The tree comes from `/source?format=json` and is converted to deckhand's ref format.
  - Units are points, as WDA reports them; taps go back in points.
  - Taps are W3C pointer actions at the element centre, and typing goes through `/wda/keys`.
  - `back` uses the nav-bar back button, else a left-edge swipe; neither works on a modal,
    and `describe` says so.
- `navigate` and `check` need no change: they consume `describe` and screenshots. The egress
  rule is unchanged, so set the TypeSafe key only on a machine whose phones show test data.

### WDA on this Mac

- **Placement:** the operator copies a built, signed Products folder into the deckhand home.
  Deckhand never builds or signs it.
- **Loopback only:** stock WDA listens on every interface and has no authentication, so
  anyone on the phone's network can drive the phone. Deckhand never starts WDA from the
  original `.xctestrun`. It runs a copy with `USE_IP=127.0.0.1` set on every test target, so
  WDA binds only the phone's loopback (HTTP and MJPEG). The Mac reaches it through
  `iproxy -s 127.0.0.1`; without `-s`, iproxy listens on all interfaces.
- **Ownership:** the server owns one WDA runner and one `iproxy` per phone, as detached
  spawns stamped with deckhand's marker (the existing invariant). They restart on exit and
  are reaped by marker on boot. The `listen()` invariant cannot see iproxy's bind flag, so a
  unit test asserts the argv.
- **`doctor` checks:**
  - a WDA is present, and when its profile expires
  - which plugged-in UDIDs the profile does not list
  - that the phone's Wi-Fi address refuses the WDA port (a check from outside the phone)

### Streaming

- **Android phone:** the existing adb backend, `screenrecord` H.264 with `screencap` as the
  fallback. `sweepDeviceRecorders` assumes "a physical device is borrowed hardware we never
  stream, so a recorder there is always someone else's", and that premise becomes false. It
  must kill only recorders deckhand started (by marker or pid), never by process name. Hard
  rules on a phone: one recorder per device, and never reach for its encoder settings.
- **iPhone:** a new StreamingBackend in `streaming/`, serving WDA's MJPEG over the same
  scoped share proxy (video and input, nothing else). The viewer already plays MJPEG. Viewer
  touches become WDA pointer actions. Expect lower frame rate and more latency than a
  simulator; the viewer says "physical device" so nobody files that as a bug.

### Logs

The reserved `app` source finally captures something on phones: `logcat` filtered to the
app's pids for Android, and `idevicesyslog` started **before** launch for iPhones (it only
streams, it cannot read the past). Deckhand reports facts: lines, whether the process is
alive, and crash markers the OS writes. Judging whether a run "passed" stays with the caller,
the same line `navigate` keeps.

Two quirks to handle:
- Some phones have a wrong clock, and `logcat -T` filters on the phone's time, so measure the
  offset rather than set the clock.
- Syslog lines carry no year.

### EAS source

A third preview source next to `git` and `local`: start a preview from a build EAS already
made.

- **App registration:** an app gains an optional EAS project id. For a repo-backed app it can
  be read from the app config.
- **Selecting a build:** `start_preview` takes either an EAS build id, or a profile name and
  takes the newest finished build of it for the platform.
  - **Android:** an internal `.apk`. A store `.aab` is refused: it cannot be installed
    directly.
  - **iPhone:** an internal-distribution `.ipa`.
  - **Simulator:** the simulator `.tar.gz`, so a simulator can also skip the local build.
- **Credential:** a read-only Expo robot token, set on the machine like the TypeSafe key
  (`deckhand secret set` gains a second noun) and stored as a 0600 file. It never travels
  through MCP and never appears in argv, URLs or logs. It is sent to the Expo API only, never
  to the artifact download host: artifact URLs are pre-authorised. A robot token is not a
  personal credential, so §11 item 7 holds.
- **Download:** cached by build id under the deckhand home. Streamed to a `.part` file and
  renamed when complete, with an idle timeout rather than a total one (APKs run to hundreds
  of MB). `content-length` is checked.
- **Vetting before a device is touched:**
  - **APK:** `aapt2 dump badging` must name the app's package.
  - **IPA:** exactly one `Payload/*.app`. Only `Info.plist` and `embedded.mobileprovision`
    are extracted, into a fresh temp directory. The bundle id must match the app, and the
    profile must list this phone's UDID (or provision all devices). A phone the profile does
    not list gets an error naming the fix ("register the phone with EAS and rebuild"),
    before deckhand takes the phone.
- **Install:** `adb install -r`, or `devicectl device install app`. Skip the install when the
  same build is already on the phone, comparing the installed version with the artifact's own
  (EAS's reported build number can disagree with the APK's).
- **Dev clients:** an EAS dev-client build with an update channel loads the newest compatible
  EAS Update by relaunching with the dev-client deep link as payload. A dev client with no
  channel shows the dev launcher, and `describe` says so; it is packaging, not an app bug.
  For Android phones the local Metro path also works over `adb reverse`.

Pipeline: `prepareSource` fetches and vets the artifact, `buildGroup` skips `runBuildPlan`,
and the existing `installProduct`, `verifyInstalled`, `launch` and `attachAndReady` run
unchanged.

### Launching on the right backend

An app that switches environment by launch argument (for example a test backend) needs the
argument at launch. `start_preview` gains launch arguments: Android intent string extras,
iOS process arguments. Keys and values are allow-listed by pattern, because this is the one
place a caller's text reaches a process's arguments. Proving which backend the app talks to
is the caller's job (it can read `logs`).

## Security

- **WDA:** loopback-only and reached over USB, as above.
- **Phones on Wi-Fi:** keep test phones off shared Wi-Fi anyway. `doctor` probes the Wi-Fi
  address and reports "can't tell" rather than "safe" when it gets anything but a refusal:
  macOS Local Network privacy can block the probe itself.
- **Share links:** a link to a phone controls a real device that can call, buy and log in.
  The default access is PIN (D5), and `list_devices` says to sign phones in to test accounts
  only.
- **Egress:** `navigate` and `check` send screens to a third party. A phone is no exception
  to "only on a machine whose apps show test data".
- **Host hygiene:** §11 item 7 is unchanged. No Apple credentials and no personal tokens are
  on the Mac; the WDA Products folder and an Expo robot token are neither.

## Preparing a phone (goes in the runbook, not in code)

- **Android:** USB debugging authorised for this Mac, and "Stay awake while charging" on.
- **iPhone:**
  - paired and trusted
  - Developer Mode on
  - Settings → Developer → Enable UI Automation on
  - no passcode, Auto-Lock set to Never
  - not under someone else's MDM
  - registered with EAS on every team whose builds it should run, so their profiles list it
- `sudo xcodebuild -runFirstLaunch` once on the Mac.

## Verification

`npm run test:device` gains a phone column for each platform. The three columns are the same
as for simulators (attach, stream, describe), plus **input**, because a phone is where input
injection fails silently. With no phone plugged in, the column prints `?`, not a tick. No PR
in this plan is "tested" without that output pasted from a run with a phone attached.

## Landing order

One PR at a time, each landed before the next is opened (AGENTS.md):

1. **This document**, for the decisions D1–D7.
2. **Physical Android — built.** Discovery, tenancy and holds, lifecycle branches, control,
   the streaming ownership fix, the `app` log source, the phone column in `test:device`. What it
   settled, and where it differs from the text above:
   - **D6:** SimDeck cannot address a phone (it answers its serial with "Android emulator
     `<serial>` is not running"), so control is adb behind `ControlBackend`.
   - **D4 is reversed for the registered app, by the operator's rule:** on a signature mismatch
     or downgrade, deckhand uninstalls the preview's registered app and installs the build, and
     the `build` log records what it removed. It never touches another package
     (`RegisteredApp`). `start_preview` also takes `freshApp: "data" | "reinstall"`.
   - **Holds are not in `state.json`** but in `phone-holds.json`: the CLI writes holds while the
     server runs, and the server rewrites `state.json` from memory, which would drop them.
     Preview tenancy does live in `state.json`, as the persisted live previews.
   - **D5** is enforced as: a phone preview without `share` is refused with `needs_pin`; public
     only when the caller passes it explicitly, and the reply then warns it drives a whole phone.
   - The build is the app's own tool on the phone (`expo run:android --device <adb model>`),
     not `adb install -r`; deckhand's own install is the conflict path.
   - Found on hardware: Samsung's Android 13 `screenrecord` v1.3 refuses an unlimited recording,
     `wm size` reports an override size that `input` uses, and `adb exec-out` quotes each of
     several arguments.
3. **EAS source:** Android `.apk` and simulator `.tar.gz` first, then `.ipa` vetting. The
   token noun for `deckhand secret`, the download cache, launch arguments.
4. **Physical iPhone control:** WDA placement, loopback launcher and `iproxy`, `doctor`
   checks, the WDA control backend, `devicectl` install and launch from an EAS `.ipa`,
   syslog.
5. **Physical iPhone streaming:** the MJPEG backend and viewer input.

PLAN §2, §6 (`list_devices`, `start_preview`, `stop_device`, `screenshot`, `describe`,
`logs`), §7 (Devices, Device lifecycle), §8, §10 and §11, AGENTS ("Physical devices are OUT")
and the `list_devices` tool description change in the PR that makes each one true. Not before.
