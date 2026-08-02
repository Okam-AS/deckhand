import { useCallback, useEffect, useRef, useState } from "react";
import { DevicePlayer, type PlayerStatus } from "./stream/player.ts";
import { DeviceInput, ORIENTATION_CYCLE, type SpecialKey } from "./stream/input.ts";
import { deviceBase, deviceWsUrl, phaseBadge, phaseLabel, repoName, type ShareDevice } from "./api.ts";
import { BranchIcon, CollapseIcon, ExpandIcon, HomeIcon, KeyboardIcon, PlatformGlyph, RepoGlyph, RotateIcon } from "./icons.tsx";
import { TypeBar } from "./TypeBar.tsx";

export type DeviceVariant = "grid" | "focus" | "thumb";

/** Actions the app-level chrome (mobile menu, type bar) can trigger on this device. */
export interface DeviceControls {
  home: () => void;
  rotate: () => void;
  /** Type a string; returns the characters that couldn't be sent (no US-HID mapping). */
  typeText: (text: string) => string[];
  key: (name: SpecialKey) => void;
}

interface Props {
  shareId: string;
  device: ShareDevice;
  /**
   * Identity of this frame on the page, for the control registry and the FLIP
   * map. Must be unique across SOURCES, not just devices: two apps on one page
   * both call their first device "ios-0", and keyed on that alone the registry
   * hands one source's Home button to the other's phone. Defaults to the
   * deviceId for a page with a single source.
   */
  paneKey?: string;
  repo: string;
  branch: string;
  variant?: DeviceVariant;
  /** In focus mode, clicking a thumbnail promotes it to the focused device. */
  onSelect?: () => void;
  /** Expose home/rotate to app-level chrome while the stream is live (null on teardown). */
  registerControls?: (id: string, api: DeviceControls | null) => void;
  /** Report the cumulative rotation (deg) so app-level chrome can spin its icons to match. */
  onRotationChange?: (paneKey: string, deg: number) => void;
  /**
   * Render but keep off screen. Used by the compare panes to show one device at a
   * time without unmounting the others, so switching back doesn't rebuild the
   * canvas, the input socket or the control registration — only the video stream
   * is dropped while hidden and restarted on the way back.
   */
  hidden?: boolean;
  /**
   * Extra control-row buttons, placed before Home. A compare pane puts its device
   * picker here so it sits with Home/Rotate/Fullscreen rather than floating above
   * the sim as a separate, larger control.
   */
  topbarLead?: React.ReactNode;
}

// iPhone Safari has no element fullscreen; there we hide the button (the mobile
// layout is already edge-to-edge) instead of faking it with a broken CSS mode.
const fullscreenSupported = typeof document !== "undefined" && Boolean(document.fullscreenEnabled);

/** One live device: canvas + player + touch input, with a calm building overlay. */
export function DeviceFrame({ shareId, device, paneKey, repo, branch, variant = "grid", onSelect, registerControls, onRotationChange, hidden, topbarLead }: Props) {
  // Identity for the registry/FLIP map; the stream paths still use the raw deviceId.
  const key = paneKey ?? device.deviceId;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLElement>(null); // the whole card is the fullscreen target
  const inputRef = useRef<DeviceInput | null>(null); // control buttons ride the same HID ws as touch
  // Streaming is gated on three independent signals, so they can't clobber each
  // other: `hidden` (a compare pane showing a different device), on-screen (the
  // IntersectionObserver), and tab visibility. setActive tears the stream DOWN,
  // so a single source getting this wrong leaves a permanently blank canvas.
  //
  // Deliberately NOT gated on layout (offsetParent / getBoundingClientRect):
  // that read is layout-engine dependent, and under the `container-type: size`
  // the mobile stage uses it withheld activation on phones while desktop — which
  // has no containment there — worked fine. `hidden` is the complete truth about
  // whether a frame should stream, because every ancestor that can hide one
  // folds its own visibility into that prop (see CompareView's refPaneOff).
  const playerRef = useRef<DevicePlayer | null>(null);
  const onScreenRef = useRef(true);
  // Seeded from the first render, so the stream effect below sees the right value
  // on mount — effects run in declaration order, before the `hidden` effect.
  const hiddenRef = useRef(!!hidden);
  const syncActive = useCallback(() => {
    playerRef.current?.setActive(onScreenRef.current && !hiddenRef.current && !document.hidden);
  }, []);
  const orientationRef = useRef(0); // index into ORIENTATION_CYCLE
  const orientedRef = useRef(false); // seed orientation from the first frame's aspect (once)
  const [rotationDeg, setRotationDeg] = useState(0); // cumulative — rotates the control icons with the device
  const [status, setStatus] = useState<PlayerStatus>("connecting");
  // Click-to-type: while the canvas has keyboard focus, keystrokes go to the sim.
  const [kbLive, setKbLive] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [typing, setTyping] = useState(false);
  // The frame auto-fits each device: default shape from the model name, then the
  // exact aspect from the first real frame (so an iPad never sits in a phone frame).
  const isTablet = /ipad|tablet/i.test(device.label);
  const isAndroid = /android/i.test(device.label);
  const [aspect, setAspect] = useState(isTablet ? "3 / 4" : "9 / 19.5");
  const ready = device.phase === "ready";
  const isThumb = variant === "thumb";
  // Android streams via multipart-PNG (adb-screencap) — that's its normal path,
  // not a degraded iOS H.264 fallback, so don't cry "Reduced quality" for it.
  const showBadge = ready && !isThumb && status !== "streaming" && !(isAndroid && status === "fallback");

  const [aw, ah] = aspect.split("/").map((s) => parseFloat(s));
  // Keep the corner subtle: a big radius clips real screen content (the status-bar
  // clock sits in the very corner). Small enough to soften, not eat content.
  const radius = aw && ah && aw / ah > 0.62 ? "14px" : "18px";

  // Track fullscreen for this device (Escape/native exit included).
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === frameRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Report rotation up so app-level chrome (the mobile dock) can spin its icons in sync.
  useEffect(() => {
    onRotationChange?.(key, rotationDeg);
  }, [rotationDeg, key, onRotationChange]);

  const toggleFullscreen = () => {
    const el = frameRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void el.requestFullscreen().catch(() => {});
  };

  const pressHome = () => inputRef.current?.sendButton("home");

  const rotate = () => {
    orientationRef.current = (orientationRef.current + 1) % ORIENTATION_CYCLE.length;
    // Two positions: portrait (0°) ↔ landscape (−90°). Match the actual position, don't accumulate.
    setRotationDeg(orientationRef.current === 0 ? 0 : -90);
    inputRef.current?.sendOrientation(ORIENTATION_CYCLE[orientationRef.current]!);
  };

  // Forward keystrokes while the canvas is focused. Browser/OS shortcuts
  // (anything with Cmd/Ctrl/Alt) are deliberately left alone.
  const SPECIAL: Record<string, SpecialKey> = {
    Enter: "return",
    Backspace: "backspace",
    Tab: "tab",
    Escape: "escape",
    Delete: "delete",
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: "up",
    ArrowDown: "down",
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const input = inputRef.current;
    if (!input) return;
    const special = SPECIAL[e.key];
    const handled = special ? input.sendKey(special) : e.key.length === 1 ? input.sendChar(e.key) : false;
    if (handled) e.preventDefault();
  };

  useEffect(() => {
    if (!ready || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const player = new DevicePlayer(canvas, deviceBase(shareId, device.deviceId), {
      onStatus: setStatus,
      onResize: (w, h) => {
        setAspect(`${w} / ${h}`);
        // Seed the control-icon rotation from the launch orientation (the device
        // only reports frame dimensions, so we can tell portrait from landscape —
        // not left/right — and default a landscape launch to landscape_left).
        if (!orientedRef.current) {
          orientedRef.current = true;
          if (w > h) {
            orientationRef.current = 1;
            setRotationDeg(-90);
          }
        }
      },
    });
    const input = new DeviceInput(canvas, deviceWsUrl(shareId, device.deviceId));
    inputRef.current = input;
    playerRef.current = player;
    // DevicePlayer is born with active=true, and setActive no-ops on equal
    // state — so a gated mount must be told setActive(false), not merely left
    // unstarted, or the later un-hide's setActive(true) is a no-op and the
    // frame stays blank forever. hiddenRef deliberately not in the dep list:
    // re-running this effect on a switch would rebuild both streams.
    if (onScreenRef.current && !hiddenRef.current && !document.hidden) player.start();
    else player.setActive(false);
    input.start();
    registerControls?.(key, {
      home: pressHome,
      rotate,
      typeText: (text) => inputRef.current?.sendText(text) ?? [...text],
      key: (name) => void inputRef.current?.sendKey(name),
    });

    // Drop the stream when off-screen or the tab is hidden (learnings §2). Both
    // feed syncActive rather than calling setActive directly — a hidden frame has
    // no box, so the observer reports "off screen" and would otherwise fight the
    // `hidden` gate below.
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[entries.length - 1]!;
        const box = e.boundingClientRect;
        // A zero-area box means this frame has no layout YET — it just came back
        // from display:none — not that it scrolled away. The observer's first
        // report after unhiding can still describe the hidden state, and honouring
        // it tore down the stream the `hidden` effect had just started: video
        // froze on one frame while input (a separate socket) kept working.
        if (box.width === 0 && box.height === 0) return;
        onScreenRef.current = e.isIntersecting;
        syncActive();
      },
      // threshold 0 (any pixel) rather than learnings §2's 0.05: the mobile panes
      // clip with overflow:hidden, so a sim that is mostly-but-not-entirely on
      // screen must keep streaming. Fully off screen still reads 0 and pauses.
      { threshold: 0 },
    );
    io.observe(canvas);
    // On return to the foreground, don't fabricate on-screen state (that revived
    // streams for frames genuinely scrolled away, and no threshold crossing ever
    // corrects it) — re-observe, which always delivers a fresh report.
    const onVis = () => {
      if (!document.hidden) {
        io.unobserve(canvas);
        io.observe(canvas);
      }
      syncActive();
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      registerControls?.(key, null);
      inputRef.current = null;
      playerRef.current = null;
      input.dispose();
      player.dispose();
    };
  }, [ready, shareId, device.deviceId, key, syncActive]);

  // Showing/hiding a frame (compare pane device switch) starts or drops its
  // stream directly — the observer can't, since it ignores zero-area reports.
  // onScreenRef needs no forcing here: the zero-area guard means hiding never
  // set it false, so a false value predates the hide and is still correct.
  useEffect(() => {
    hiddenRef.current = !!hidden;
    syncActive();
  }, [hidden, syncActive]);

  return (
    <figure
      className={`device device--${variant}`}
      ref={frameRef}
      hidden={hidden}
      data-device-id={key}
      {...(isThumb
        ? { onClick: onSelect, role: "button", tabIndex: 0, title: `Focus ${device.label}`, "aria-label": `Focus ${device.label}` }
        : {})}
    >
      {/* Controls sit BELOW the sim, centred — the same place the phone dock puts
          them, so the two chromes do not disagree about where the buttons live.
          Hidden on thumbnails. Home · Rotate · Keyboard · Fullscreen. */}
      {!isThumb && (
        <div className="device-controls" style={{ "--icon-rot": `${rotationDeg}deg` } as React.CSSProperties}>
          {kbLive && (
            <span className="kb-chip" title="Keystrokes go to this device">
              <KeyboardIcon size={15} />
            </span>
          )}
          {topbarLead}
          {ready && (
            <>
              <button
                type="button"
                className="ctrl-btn"
                onClick={pressHome}
                title="Home"
                aria-label="Press the device home button"
              >
                <HomeIcon />
              </button>
              <button
                type="button"
                className="ctrl-btn"
                onClick={rotate}
                title="Rotate"
                aria-label="Rotate the device 90 degrees"
              >
                <RotateIcon />
              </button>
              {/* Always offered. Typing into the focused canvas works with a real
                  keyboard, but it is invisible — the button is the only affordance
                  that says typing is possible at all, and it is also the path for
                  text a raw keydown cannot send. */}
              <button
                type="button"
                className="ctrl-btn"
                onClick={() => setTyping(true)}
                title="Keyboard"
                aria-label="Type with your keyboard"
              >
                <KeyboardIcon />
              </button>
              {/* What this pane IS lives here rather than in a caption under the
                  sim: the caption repeated the same three facts beneath every
                  device and pushed the frames apart, and on a page with several
                  sources it read as three near-identical labels. Same control the
                  phone dock already has, so there is one place to look. */}
              {/* Last on the row on purpose: it is the one control that changes the
                  whole layout rather than the device, so it sits at the edge and out
                  of the way of the ones used mid-flow. It never appears on mobile —
                  the whole topbar is display:none under 700px, the same breakpoint
                  useIsMobile uses — and it is absent on iPhone Safari regardless,
                  which has no element fullscreen. */}
              {fullscreenSupported && (
                <button
                  type="button"
                  className="ctrl-btn"
                  onClick={toggleFullscreen}
                  title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                  aria-label={isFullscreen ? "Exit fullscreen" : "Show this device fullscreen"}
                >
                  {isFullscreen ? <CollapseIcon /> : <ExpandIcon />}
                </button>
              )}
            </>
          )}
        </div>
      )}
      {typing && (
        <TypeBar
          onText={(text) => inputRef.current?.sendText(text) ?? [...text]}
          onKey={(name) => inputRef.current?.sendKey(name)}
          onClose={() => setTyping(false)}
        />
      )}
      <div
        className={`device-screen ${kbLive ? "kb-live" : ""}`}
        style={
          { "--device-aspect": aspect, "--device-radius": radius, "--dev-w": aw, "--dev-h": ah } as React.CSSProperties
        }
      >
        <canvas
          ref={canvasRef}
          className={ready ? "canvas ready" : "canvas hidden"}
          tabIndex={ready && !isThumb ? 0 : -1}
          onKeyDown={onKeyDown}
          onFocus={() => setKbLive(true)}
          onBlur={() => setKbLive(false)}
        />
        {!ready && (
          <div className={`overlay ${device.phase === "failed" ? "overlay-failed" : ""}`}>
            {device.phase !== "failed" && <span className="spinner" aria-hidden />}
            {/* Only "failed" keeps a centred headline — every other phase is
                named by the pill at the top of the frame, so the middle carries
                just the spinner and the live sub-step. */}
            {!isThumb && device.phase === "failed" && <p>{phaseLabel(device.phase, device.detail)}</p>}
            {/* Keyed by its text so React remounts it on change and the fade-in
                replays — the caption changes every few seconds and a hard swap
                reads as a flicker. */}
            {!isThumb && device.phase !== "failed" && device.step && (
              <p className="overlay-step" key={device.step}>
                {device.step}
              </p>
            )}
            {!isThumb && device.phase === "failed" && device.detail && (
              // The reason, not just the verdict — so the viewer can say what
              // broke (build error vs. a simulator that never booted) instead of
              // sending everyone to the logs to find out.
              <p className="overlay-reason">{device.detail}</p>
            )}
          </div>
        )}
        {/* One pill, two sources: the boot/build phase before the stream exists,
            then the streaming state once it does. Same chip either way, so the
            frame's status never jumps between two different affordances. */}
        {showBadge && <div className="badge">{status === "fallback" ? "Reduced quality" : "Connecting…"}</div>}
        {!ready && !isThumb && device.phase !== "failed" && <div className="badge">{phaseBadge(device.phase)}</div>}
      </div>
      {!isThumb && ready && (
        <dl className="device-facts">
          <div className="fact">
            {/* First, and marked with the platform's own glyph rather than the word
                "Device". It is the fact that DIFFERS between two frames, so it leads;
                repo and branch are the same under both and read as background. The
                label was generic scaffolding — the glyph says more in less space and
                separates the captions at a glance rather than on a read. The word
                survives for screen readers, which cannot see the difference. */}
            <dt className="fact-glyph">
              <span className="sr-only">Device</span>
              <PlatformGlyph platform={device.platform} />
            </dt>
            <dd>{device.label}</dd>
          </div>
          <div className="fact">
            <dt className="fact-glyph">
              <span className="sr-only">Repo</span>
              <RepoGlyph repo={repo} />
            </dt>
            <dd>{repoName(repo) || "—"}</dd>
          </div>
          <div className="fact">
            <dt className="fact-glyph">
              <span className="sr-only">Branch</span>
              <BranchIcon size={13} />
            </dt>
            <dd>{branch || "—"}</dd>
          </div>

        </dl>
      )}
      {isThumb ? (
        <figcaption className="thumb-cap">{device.label.split(" · ")[0]}</figcaption>
      ) : (
        null
      )}
    </figure>
  );
}

