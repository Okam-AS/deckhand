import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { DeviceFrame, type DeviceControls } from "./DeviceFrame.tsx";
import { DevicePicker, type ViewMode } from "./DevicePicker.tsx";
import { MobileChrome } from "./MobileChrome.tsx";
import { WebFrame } from "./WebFrame.tsx";
import { PinGate } from "./PinGate.tsx";
import { CompareView } from "./CompareView.tsx";
import { fetchShareState, shareIdFromPath, type ShareState } from "./api.ts";
import { useIsMobile } from "./useIsMobile.ts";

export function App() {
  const shareId = shareIdFromPath();
  const [state, setState] = useState<ShareState | null>(null);
  const [gone, setGone] = useState(false);
  const [visible, setVisible] = useState<Set<string> | null>(null);
  const [mode, setMode] = useState<ViewMode>("grid");
  const [focusId, setFocusId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const stageRef = useRef<HTMLElement>(null);
  const prevRects = useRef<Map<string, DOMRect>>(new Map());
  const isMobile = useIsMobile();
  // Live home/rotate handles per device, registered by each mounted DeviceFrame
  // so the mobile menu can drive whichever device is on screen.
  const controls = useRef(new Map<string, DeviceControls>());
  const registerControls = useCallback((id: string, api: DeviceControls | null) => {
    if (api) controls.current.set(id, api);
    else controls.current.delete(id);
  }, []);
  // Per-device cumulative rotation (deg), so the mobile dock icons spin with the sim.
  const [rotations, setRotations] = useState<Record<string, number>>({});
  const handleRotation = useCallback(
    (id: string, deg: number) => setRotations((r) => (r[id] === deg ? r : { ...r, [id]: deg })),
    [],
  );

  useEffect(() => {
    if (!shareId) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const s = await fetchShareState(shareId);
      if (stop) return;
      if (s === "gone") {
        setGone(true);
        return;
      }
      if (s) setState(s);
      // When locked the state is minimal (no devices) — poll calmly (5s).
      const settled = s != null && (s.locked || (s.devices ?? []).every((d) => d.phase === "ready" || d.phase === "failed"));
      timer = setTimeout(poll, settled ? 5000 : 1200);
    };
    void poll();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [shareId]);

  useEffect(() => {
    // Only once unlocked — a locked state has no `devices` yet.
    if (state && !state.locked && visible === null) setVisible(new Set((state.devices ?? []).map((d) => d.deviceId)));
  }, [state, visible]);

  // FLIP: after each layout change, slide/zoom every device figure from its old
  // box to its new one. Runs every render; the >1px threshold no-ops on the
  // frequent status polls, so only real layout changes animate.
  useLayoutEffect(() => {
    const c = stageRef.current;
    if (!c) return;
    const nodes = Array.from(c.querySelectorAll<HTMLElement>("[data-device-id]"));
    const now = new Map<string, DOMRect>();
    for (const n of nodes) now.set(n.dataset.deviceId!, n.getBoundingClientRect());
    for (const n of nodes) {
      const id = n.dataset.deviceId!;
      const before = prevRects.current.get(id);
      const after = now.get(id)!;
      if (!before) continue;
      const dx = before.left - after.left;
      const dy = before.top - after.top;
      const sx = after.width ? before.width / after.width : 1;
      const sy = after.height ? before.height / after.height : 1;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) continue;
      n.style.transformOrigin = "top left";
      n.style.transition = "none";
      n.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
      requestAnimationFrame(() => {
        n.style.transition = "transform 0.42s cubic-bezier(0.16, 0.84, 0.34, 1)";
        n.style.transform = "";
      });
    }
    prevRects.current = now;
  });

  if (!shareId) return <Centered>Open a preview link to view a device.</Centered>;
  if (gone) {
    return (
      <Centered>
        <div className="ended">
          <p className="ended-title">This preview is paused</p>
          <p className="ended-body">
            Deckhand pauses a preview after a while with no one watching, to free the simulator. Ask your agent to start
            it again — this same link will come right back.
          </p>
        </div>
      </Centered>
    );
  }
  if (!state) {
    return (
      <Centered>
        <span className="spinner" aria-hidden /> Loading preview…
      </Centered>
    );
  }

  // PIN-protected and not yet unlocked → the pad, before any stream/iframe mounts.
  if (state.locked && !unlocked) {
    return (
      <PinGate
        shareId={shareId}
        pinLength={state.pinLength ?? 4}
        onUnlocked={() => {
          // Cookie is set — fetch the full state FIRST, then flip unlocked in the
          // same update so we never render the content branch without devices.
          void fetchShareState(shareId).then((s) => {
            if (s && s !== "gone") setState(s);
            setUnlocked(true);
          });
        }}
      />
    );
  }

  // Working preview in a compare session → the side-by-side compare view
  // (reference vs working + parity checklist). Both panes reuse DeviceFrame via
  // their own shareIds. Also taken when only the checklist is present (the
  // reference isn't live yet) so the ledger still shows. (Migration is one
  // preset — reference = the source app.)
  // `?solo` forces the plain single-device view even for a paired preview — a
  // diagnostic escape hatch to test the working device outside the compare DOM.
  const soloOverride = new URLSearchParams(location.search).has("solo");
  if (!soloOverride && (state.pairedWith || state.ledger)) return <CompareView shareId={shareId} state={state} />;

  const devices = state.devices ?? [];
  const isWeb = devices.some((d) => d.platform === "web");
  const vis = visible ?? new Set(devices.map((d) => d.deviceId));
  const multi = devices.length > 1;
  // Mobile shows exactly one device (the focused one) — several sims on a
  // phone screen help no one. The visibility set only applies on desktop.
  const mobileFocus =
    focusId && devices.some((d) => d.deviceId === focusId) ? focusId : (devices[0]?.deviceId ?? "");
  const shown = isMobile ? devices.filter((d) => d.deviceId === mobileFocus) : devices.filter((d) => vis.has(d.deviceId));
  // With a single shown device the two modes are identical — render it at the
  // normal side-by-side size, never the enlarged focus size.
  const effectiveMode: ViewMode = shown.length > 1 ? mode : "grid";
  const focus = focusId && vis.has(focusId) ? focusId : (shown[0]?.deviceId ?? null);

  const toggle = (id: string) =>
    setVisible((prev) => {
      const next = new Set(prev ?? devices.map((d) => d.deviceId));
      if (next.has(id)) {
        if (next.size <= 1) return next; // always keep at least one on screen
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

  // Web preview: a single iframe of the running dev server, no device chrome.
  if (isWeb) {
    const dev = devices[0]!;
    return (
      <>
        <main className="app app--web">
          <section className="stage stage--web" ref={stageRef}>
            <WebFrame shareId={shareId} device={dev} repo={state.repo} branch={state.ref} />
          </section>
        </main>
        <aside className="brand" aria-label="Deckhand">
          <span className="brand-name">Deckhand</span>
        </aside>
      </>
    );
  }

  return (
    <>
      <main className={`app ${multi && !isMobile ? "has-picker" : ""} ${isMobile ? "app--mobile" : ""}`}>
        <section className={`stage stage--${effectiveMode}`} ref={stageRef}>
          {shown.map((d) => {
            const variant = effectiveMode === "grid" ? "grid" : d.deviceId === focus ? "focus" : "thumb";
            return (
              <DeviceFrame
                key={d.deviceId}
                shareId={shareId}
                device={d}
                repo={state.repo}
                branch={state.ref}
                variant={variant}
                onSelect={variant === "thumb" ? () => setFocusId(d.deviceId) : undefined}
                registerControls={registerControls}
                onRotationChange={handleRotation}
                testRun={state.testRun}
              />
            );
          })}
        </section>
      </main>

      {/* Fixed chrome lives OUTSIDE `.app` — its animated transform would otherwise
          become the containing block for these position:fixed elements. */}
      {isMobile ? (
        <MobileChrome
          devices={devices}
          focusId={mobileFocus}
          onFocus={setFocusId}
          onHome={() => controls.current.get(mobileFocus)?.home()}
          onRotate={() => controls.current.get(mobileFocus)?.rotate()}
          onText={(text) => controls.current.get(mobileFocus)?.typeText(text) ?? [...text]}
          onKey={(name) => controls.current.get(mobileFocus)?.key(name)}
          rotation={rotations[mobileFocus] ?? 0}
          repo={state.repo}
          refName={state.ref}
          source={state.source}
          testRun={state.testRun}
        />
      ) : (
        <>
          {multi && (
            <DevicePicker
              devices={devices}
              visible={vis}
              shownCount={shown.length}
              mode={mode}
              onMode={setMode}
              onToggle={toggle}
              open={menuOpen}
              onOpenChange={setMenuOpen}
            />
          )}
          <aside className="brand" aria-label="Deckhand">
            <span className="brand-name">Deckhand</span>
          </aside>
        </>
      )}
    </>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="centered">
      <div className="centered-inner">{children}</div>
    </main>
  );
}
