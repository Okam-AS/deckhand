import { useCallback, useRef, useState } from "react";
import { DeviceFrame, type DeviceControls } from "./DeviceFrame.tsx";
import { DevicePicker } from "./DevicePicker.tsx";
import { MobileChrome } from "./MobileChrome.tsx";
import { ProgressBar } from "./ProgressBar.tsx";
import { repoName, type ShareDevice, type ShareLedgerScreen, type ShareState } from "./api.ts";
import { useIsMobile } from "./useIsMobile.ts";

/**
 * The compare view: the REFERENCE app (the oracle to match) and the WORKING app
 * (the one being built) side by side, with the agent-maintained parity checklist
 * above. Both panes reuse DeviceFrame verbatim — each points at its own share, so
 * all video/input rides the existing per-share proxy (no new streaming code).
 * Shown when the working share's state carries `pairedWith`. (Migration is one
 * preset of compare — reference = the source app.)
 *
 * On a phone there's no room for two devices side by side (they'd each be a
 * squished sliver), so mobile shows ONE device with a Reference⇄Working switch.
 * Desktop keeps both, sized by height so each keeps its true aspect ratio.
 *
 * A pane can hold several devices (an iOS sim AND an Android emulator). Stacking
 * them down the column made each one tiny and pushed the second below the fold,
 * so a pane shows ONE device and picks it with the same DevicePicker button +
 * popover the single-preview stage uses (single-select mode). Non-shown devices
 * stay mounted with `hidden`: their video stream is dropped, but the input
 * socket, canvas contents and aspect/rotation state survive the switch.
 */
export function CompareView({ shareId, state }: { shareId: string; state: ShareState }) {
  // The reference pane may be absent (reference not live yet) — then it's just
  // the working pane plus the checklist, and there's nothing to show/hide.
  const paired = state.pairedWith;
  const [showRef, setShowRef] = useState(true);
  const [mobileSide, setMobileSide] = useState<"reference" | "working">("working");
  const isMobile = useIsMobile();
  const screens = state.ledger?.screens ?? [];
  const refShown = !!paired && showRef;
  const workLabel = state.paneLabel ?? "Working";
  const refLabel = paired?.label ?? "Reference";

  // Home/rotate/keyboard for the mobile dock. The two panes are DIFFERENT shares, so both can
  // hand out the same deviceId ("ios-0" on each) — hence a map per side rather than one keyed
  // by deviceId, which would let the reference pane's controls answer for the working pane.
  const controls = useRef({ reference: new Map<string, DeviceControls>(), working: new Map<string, DeviceControls>() });
  const [rotations, setRotations] = useState<Record<string, number>>({});
  // The device each pane is showing. One entry per SIDE, not per deviceId — the two
  // panes are different shares and can both call their first device "ios-0".
  const [paneDevice, setPaneDevice] = useState<{ reference: string | null; working: string | null }>({
    reference: null,
    working: null,
  });
  const pickDevice = (side: "reference" | "working", devices: ShareDevice[]) =>
    devices.some((d) => d.deviceId === paneDevice[side]) ? paneDevice[side]! : (devices[0]?.deviceId ?? "");
  const refDevice = pickDevice("reference", paired?.devices ?? []);
  const workDevice = pickDevice("working", state.devices);
  const chooseDevice = (side: "reference" | "working", id: string) =>
    setPaneDevice((p) => (p[side] === id ? p : { ...p, [side]: id }));
  const registerRef = useCallback((id: string, api: DeviceControls | null) => {
    if (api) controls.current.reference.set(id, api);
    else controls.current.reference.delete(id);
  }, []);
  const registerWork = useCallback((id: string, api: DeviceControls | null) => {
    if (api) controls.current.working.set(id, api);
    else controls.current.working.delete(id);
  }, []);
  const rotatedRef = useCallback(
    (id: string, deg: number) => setRotations((r) => (r[`reference:${id}`] === deg ? r : { ...r, [`reference:${id}`]: deg })),
    [],
  );
  const rotatedWork = useCallback(
    (id: string, deg: number) => setRotations((r) => (r[`working:${id}`] === deg ? r : { ...r, [`working:${id}`]: deg })),
    [],
  );

  // The dock drives whichever pane is actually on screen.
  const dockSide = paired && isMobile ? mobileSide : "working";
  const dockDevices = dockSide === "reference" && paired ? paired.devices : state.devices;
  const dockFocus = dockSide === "reference" ? refDevice : workDevice;
  const dock = (
    <MobileChrome
      devices={dockDevices}
      focusId={dockFocus}
      onFocus={(id) => chooseDevice(dockSide, id)}
      onHome={() => controls.current[dockSide].get(dockFocus)?.home()}
      onRotate={() => controls.current[dockSide].get(dockFocus)?.rotate()}
      onText={(text) => controls.current[dockSide].get(dockFocus)?.typeText(text) ?? [...text]}
      onKey={(name) => controls.current[dockSide].get(dockFocus)?.key(name)}
      rotation={rotations[`${dockSide}:${dockFocus}`] ?? 0}
      repo={dockSide === "reference" && paired ? paired.repo : state.repo}
      refName={dockSide === "reference" && paired ? paired.ref : state.ref}
      source={state.source}
    />
  );

  // Whether each pane is off screen right now. Pane-level hiding uses wrapper
  // `div[hidden]`, which changes no prop on the frames inside — it must be
  // folded into each frame's own `hidden` (the observer ignores zero-area
  // reports, so it cannot restart a stream on unhide).
  const refPaneOff = !!paired && (isMobile ? mobileSide !== "reference" : !showRef);
  const workPaneOff = isMobile && !!paired && mobileSide !== "working";

  const refPane = paired && (
    <section className="mig-col">
      <header className="mig-col-head">
        <span className="mig-col-tag mig-col-tag--source">{refLabel}</span>
        <span className="mig-col-meta">
          {repoName(paired.repo)} · {paired.ref}
        </span>
      </header>
      <div className="mig-col-stage">
        {paired.devices.map((d) => (
          <DeviceFrame
            key={`s-${d.deviceId}`}
            shareId={paired.shareId}
            device={d}
            repo={paired.repo}
            branch={paired.ref}
            variant="grid"
            registerControls={registerRef}
            onRotationChange={rotatedRef}
            hidden={refPaneOff || d.deviceId !== refDevice}
            topbarLead={
              <PaneDevicePicker devices={paired.devices} active={refDevice} onPick={(id) => chooseDevice("reference", id)} />
            }
          />
        ))}
      </div>
    </section>
  );

  const workPane = (
    <section className="mig-col">
      <header className="mig-col-head">
        <span className="mig-col-tag mig-col-tag--target">{workLabel}</span>
        <span className="mig-col-meta">
          {repoName(state.repo)} · {state.ref}
        </span>
        {paired && !isMobile && (
          <button type="button" className="mig-toggle" onClick={() => setShowRef((v) => !v)}>
            {showRef ? `Hide ${refLabel.toLowerCase()}` : `Show ${refLabel.toLowerCase()}`}
          </button>
        )}
      </header>
      <div className="mig-col-stage">
        {state.devices.map((d) => (
          <DeviceFrame
            key={`t-${d.deviceId}`}
            shareId={shareId}
            device={d}
            repo={state.repo}
            branch={state.ref}
            variant="grid"
            registerControls={registerWork}
            onRotationChange={rotatedWork}
            hidden={workPaneOff || d.deviceId !== workDevice}
            topbarLead={
              <PaneDevicePicker devices={state.devices} active={workDevice} onPick={(id) => chooseDevice("working", id)} />
            }
          />
        ))}
      </div>
    </section>
  );

  // Mobile with a reference available: one device at a time + a segmented switch.
  if (isMobile && paired) {
    return (
      <>
        <main className="app app--mig app--mig-mobile">
          <ProgressBar testRun={state.testRun} screens={screens} />
          <div className="mig-switch" role="tablist" aria-label="Which app to view">
            <button
              type="button"
              role="tab"
              aria-selected={mobileSide === "reference"}
              className={`mig-switch-btn ${mobileSide === "reference" ? "is-active" : ""}`}
              onClick={() => setMobileSide("reference")}
            >
              {refLabel}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mobileSide === "working"}
              className={`mig-switch-btn ${mobileSide === "working" ? "is-active" : ""}`}
              onClick={() => setMobileSide("working")}
            >
              {workLabel}
            </button>
          </div>
          <div className="mig-cols mig-cols--solo">
            <div hidden={mobileSide !== "reference"}>{refPane}</div>
            <div hidden={mobileSide !== "working"}>{workPane}</div>
          </div>
        </main>
        {dock}
      </>
    );
  }

  return (
    <>
      {/* This branch also serves a phone whose reference is missing (paused or
          still booting) — it needs the mobile sizing or the 78vh desktop device
          rule overflows behind the dock. */}
      <main className={`app app--mig ${isMobile ? "app--mig-mobile" : ""}`}>
        <ProgressBar testRun={state.testRun} screens={screens} />
        <div className={`mig-cols ${refShown ? "" : "mig-cols--solo"}`}>
          {/* Hidden rather than unmounted, same as the mobile panes — showing it
              again keeps the canvas, input socket and device choice. */}
          {paired && <div hidden={!refShown}>{refPane}</div>}
          {workPane}
        </div>
      </main>
      {/* A compare with no reference pane is still one device on a phone, and it needs the same
          controls — the wordmark is desktop-only chrome, not a substitute for them. */}
      {isMobile ? (
        dock
      ) : (
        <aside className="brand" aria-label="Deckhand">
          <span className="brand-name">Deckhand</span>
        </aside>
      )}
    </>
  );
}

/**
 * Which device this pane is showing: DevicePicker in single-select compact mode,
 * so it's the same switch-device icon button + popover the mobile dock already
 * uses, sitting in the control row beside Home/Rotate/Fullscreen. Absent with one
 * device — there's nothing to pick, and the figcaption already names it.
 */
function PaneDevicePicker({ devices, active, onPick }: { devices: ShareDevice[]; active: string; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  if (devices.length < 2) return null;
  return (
    <DevicePicker
      devices={devices}
      visible={new Set([active])}
      shownCount={1}
      onToggle={onPick}
      open={open}
      onOpenChange={setOpen}
      select="single"
      inline
      compact
    />
  );
}

