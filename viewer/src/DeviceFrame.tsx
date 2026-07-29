import { useEffect, useRef, useState } from "react";
import { DevicePlayer, type PlayerStatus } from "./stream/player.ts";
import { DeviceInput, ORIENTATION_CYCLE, type SpecialKey } from "./stream/input.ts";
import { deviceBase, deviceWsUrl, phaseBadge, phaseLabel, repoName, type ShareDevice, type ShareTestRun } from "./api.ts";
import { CollapseIcon, ExpandIcon, HomeIcon, KeyboardIcon, RotateIcon } from "./icons.tsx";
import { TestRunControl } from "./TestRunPopover.tsx";

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
  repo: string;
  branch: string;
  variant?: DeviceVariant;
  /** In focus mode, clicking a thumbnail promotes it to the focused device. */
  onSelect?: () => void;
  /** Expose home/rotate to app-level chrome while the stream is live (null on teardown). */
  registerControls?: (id: string, api: DeviceControls | null) => void;
  /** Report the cumulative rotation (deg) so app-level chrome can spin its icons to match. */
  onRotationChange?: (deviceId: string, deg: number) => void;
  /** The agent's live test run — shown as a control-row button (spinning border while running). */
  testRun?: ShareTestRun;
}

// iPhone Safari has no element fullscreen; there we hide the button (the mobile
// layout is already edge-to-edge) instead of faking it with a broken CSS mode.
const fullscreenSupported = typeof document !== "undefined" && Boolean(document.fullscreenEnabled);

/** One live device: canvas + player + touch input, with a calm building overlay. */
export function DeviceFrame({ shareId, device, repo, branch, variant = "grid", onSelect, registerControls, onRotationChange, testRun }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLElement>(null); // the whole card is the fullscreen target
  const inputRef = useRef<DeviceInput | null>(null); // control buttons ride the same HID ws as touch
  const orientationRef = useRef(0); // index into ORIENTATION_CYCLE
  const orientedRef = useRef(false); // seed orientation from the first frame's aspect (once)
  const [rotationDeg, setRotationDeg] = useState(0); // cumulative — rotates the control icons with the device
  const [status, setStatus] = useState<PlayerStatus>("connecting");
  // Click-to-type: while the canvas has keyboard focus, keystrokes go to the sim.
  const [kbLive, setKbLive] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
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
    onRotationChange?.(device.deviceId, rotationDeg);
  }, [rotationDeg, device.deviceId, onRotationChange]);

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
    player.start();
    input.start();
    registerControls?.(device.deviceId, {
      home: pressHome,
      rotate,
      typeText: (text) => inputRef.current?.sendText(text) ?? [...text],
      key: (name) => void inputRef.current?.sendKey(name),
    });

    // Pause decoding when off-screen or the tab is hidden (learnings §2).
    const io = new IntersectionObserver((entries) => player.setActive(entries[0]!.isIntersecting), { threshold: 0.05 });
    io.observe(canvas);
    const onVis = () => player.setActive(!document.hidden);
    document.addEventListener("visibilitychange", onVis);

    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      registerControls?.(device.deviceId, null);
      inputRef.current = null;
      input.dispose();
      player.dispose();
    };
  }, [ready, shareId, device.deviceId]);

  return (
    <figure
      className={`device device--${variant}`}
      ref={frameRef}
      data-device-id={device.deviceId}
      {...(isThumb
        ? { onClick: onSelect, role: "button", tabIndex: 0, title: `Focus ${device.label}`, "aria-label": `Focus ${device.label}` }
        : {})}
    >
      {/* Control row sits just above the sim — never over its screen. Hidden on
          thumbnails. Icon-only buttons: Home · Rotate · Fullscreen. */}
      {!isThumb && (
        <div className="device-topbar" style={{ "--icon-rot": `${rotationDeg}deg` } as React.CSSProperties}>
          {kbLive && (
            <span className="kb-chip" title="Keystrokes go to this device">
              <KeyboardIcon size={15} />
            </span>
          )}
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
          {testRun && <TestRunControl testRun={testRun} placement="topbar" />}
        </div>
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
      {isThumb ? (
        <figcaption className="thumb-cap">{device.label.split(" · ")[0]}</figcaption>
      ) : (
        <figcaption>
          <span className="cap-model">{device.label}</span>
          <span className="cap-repo">
            {repoName(repo)}
            {branch ? <span className="cap-branch"> · {branch}</span> : null}
          </span>
        </figcaption>
      )}
    </figure>
  );
}

