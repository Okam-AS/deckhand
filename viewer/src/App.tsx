import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DeviceFrame, type DeviceControls } from "./DeviceFrame.tsx";
import { DevicePicker } from "./DevicePicker.tsx";
import { MobileChrome, type DockEntry } from "./MobileChrome.tsx";
import { WebFrame } from "./WebFrame.tsx";
import { PinGate } from "./PinGate.tsx";
import { ProgressBar } from "./ProgressBar.tsx";
import { computeStage, shortDeviceName, type StageGroup, stillUnlocked } from "./panes.ts";
import { fetchShareState, shareIdFromPath, type ShareState } from "./api.ts";
import { useIsMobile } from "./useIsMobile.ts";

export function App() {
  const shareId = shareIdFromPath();
  const [state, setState] = useState<ShareState | null>(null);
  const [gone, setGone] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Stage controls. Each is a small, independent choice the stage folds into a
  // layout (see computeStage) — no branch here decides what the page "is".
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [focusKey, setFocusKey] = useState<string | null>(null);
  // Width decides how many sources fit side by side (see MIN_PANE_WIDTH). Read
  // from the window rather than a media query: the threshold depends on how many
  // sources the page has, which no fixed breakpoint can express.
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window === "undefined" ? Infinity : window.innerWidth));
  const stageRef = useRef<HTMLElement>(null);
  const prevRects = useRef<Map<string, DOMRect>>(new Map());
  const isMobile = useIsMobile();
  // Live home/rotate handles per pane, registered by each mounted DeviceFrame so
  // the mobile dock can drive whichever pane is on screen. Keyed by PANE key, not
  // deviceId: two sources both call their first device "ios-0", and one map keyed
  // on that would let one app's dock buttons drive the other app's phone.
  const controls = useRef(new Map<string, DeviceControls>());
  const registerControls = useCallback((key: string, api: DeviceControls | null) => {
    if (api) controls.current.set(key, api);
    else controls.current.delete(key);
  }, []);
  const [rotations, setRotations] = useState<Record<string, number>>({});
  const handleRotation = useCallback(
    (key: string, deg: number) => setRotations((r) => (r[key] === deg ? r : { ...r, [key]: deg })),
    [],
  );

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

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
      if (s) {
        setState(s);
        // The server can go back to locked (a 12h cookie TTL, or a new PIN on a share
        // somebody already has open). The latch must follow it down, or the pad never
        // returns and the tab renders the content branch with no devices — blank, forever.
        setUnlocked((was) => stillUnlocked(was, Boolean(s.locked)));
      }
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

  // The whole layout, derived. Memoised on the inputs that actually change it, so
  // the 1.2s status poll doesn't rebuild pane objects and churn React keys.
  const stage = useMemo(
    () =>
      computeStage(state?.panes ?? [], {
        isMobile,
        viewportWidth,
        choices,
        focusKey: focusKey ?? undefined,
      }),
    [state?.panes, isMobile, viewportWidth, choices, focusKey],
  );

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
      // A hidden frame reports a zero-area box. Animating from one flings the
      // frame in from nowhere on the way back, so treat it as "no previous box".
      if (!before.width || !before.height || !after.width || !after.height) continue;
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
        onUnlocked={(fresh) => {
          // The unlock response carries the state, so there is nothing to ask for. It used to
          // POST /unlock, wait, then GET /state and wait again — two sequential round trips
          // for one action, ~230ms each through the tunnel, with the pad showing nothing in
          // between. Still set state BEFORE flipping unlocked, so the content branch never
          // renders without devices.
          if (fresh) {
            setState(fresh);
            setUnlocked(true);
            return;
          }
          // Older server, or a response without it: fall back to the second call rather than
          // rendering an empty stage.
          void fetchShareState(shareId).then((s) => {
            if (s && s !== "gone") setState(s);
            setUnlocked(true);
          });
        }}
      />
    );
  }

  // Unlocked, ready — and no devices yet. This is the first minute of a cold preview:
  // the worktree is being prepared and `simctl create` has not run, so shareState carries a
  // preview with zero devices. computeStage drops device-less panes, so the layout rendered
  // with nothing in it: a BLANK PAGE, for as long as the prep takes, immediately after
  // someone typed a PIN. Nothing on screen said the build had even started.
  //
  // Before the web branch, because a web preview has its pseudo-device from the start and
  // never lands here.
  if ((state.devices ?? []).length === 0 && (state.panes ?? []).every((p) => (p.devices ?? []).length === 0)) {
    return (
      <Centered>
        <span className="spinner" aria-hidden />
        {state.detail ?? "Preparing the preview — fetching the branch and starting the build."}
      </Centered>
    );
  }

  // Web preview: a single iframe of the running dev server, no device chrome.
  const devices = state.devices ?? [];
  if (devices.some((d) => d.platform === "web")) {
    const dev = devices[0]!;
    return (
      <>
        <main className="app app--web">
          <ProgressBar testRun={state.testRun} screens={state.ledger?.screens} />
          <section className="stage stage--web" ref={stageRef}>
            <WebFrame shareId={shareId} device={dev} repo={state.repo} branch={state.ref} />
          </section>
        </main>
      </>
    );
  }

  const { groups, panes, visible, multiSource } = stage;
  const shownCount = visible.size;
  // With one source and one device on screen the two layout modes are identical —
  // render at the normal size, never the enlarged focus size. Grouped columns are
  // sized by the column, so the modes don't apply there at all.
  // Always the grid. "Focus" was the other half of a layout choice that no longer exists:
  // computeStage shows everything that fits and exactly one device when it does not, so
  // there is nothing left for a mode to decide.
  const effectiveMode = "grid";
  // The enlarged pane in focus mode: the one the user clicked, when it is still
  // on screen. Taking the first visible pane instead meant clicking a thumbnail
  // set focusKey and changed nothing — focusKey only reached computeStage on
  // mobile, so focus mode was inert on the desktop it exists for.
  const focused = focusKey && visible.has(focusKey) ? focusKey : ([...visible][0] ?? "");
  const mobileFocus = isMobile ? focused : "";

  // The dock drives whichever pane is on screen; on desktop it isn't rendered.
  const dockEntries: DockEntry[] = panes.map((p) => ({
    key: p.key,
    label: p.device.label,
    ...(multiSource ? { group: groups.find((g) => g.shareId === p.shareId)?.label } : {}),
  }));
  const focusedGroup = groups.find((g) => g.panes.some((p) => p.key === mobileFocus));

  // Each column chooses on its own. Making the others follow spent a click every
  // time the guess was wrong, and which two things to compare is the user's call.
  const chooseInGroup = (group: StageGroup, key: string) =>
    setChoices((prev) => ({ ...prev, [group.shareId]: key }));

  return (
    <>
      <main
        className={`app ${!multiSource && panes.length > 1 && !isMobile ? "has-picker" : ""} ${multiSource ? "app--grouped" : ""} ${isMobile ? "app--mobile" : ""}`}
      >
        <ProgressBar testRun={state.testRun} screens={state.ledger?.screens} />
        <section className={`stage stage--${effectiveMode} ${multiSource ? "stage--grouped" : ""}`} ref={stageRef}>
          {groups.map((g) => (
            <section
              className={`pane-group ${g.self ? "pane-group--self" : ""} ${g.panes.some((p) => visible.has(p.key)) ? "" : "pane-group--off"}`}
              key={g.key}
            >
              {/* No column heading: the repo and branch live behind each frame's
                  (i) button now, so a heading would state them twice — once above
                  the sim and once inside it. */}
              <div className="pane-stage">
                {g.panes.map((p) => (
                  <DeviceFrame
                    key={p.key}
                    paneKey={p.key}
                    shareId={p.shareId}
                    device={p.device}
                    repo={g.repo}
                    branch={g.ref}
                    variant={effectiveMode === "grid" ? "grid" : p.key === focused ? "focus" : "thumb"}
                    onSelect={undefined}
                    hidden={!visible.has(p.key)}
                    registerControls={registerControls}
                    onRotationChange={handleRotation}
                    // With several sources each column shows one device, so the
                    // switch belongs in that column's control row — beside
                    // Home/Rotate rather than floating above the stage.
                    topbarLead={
                      multiSource && g.panes.length > 1 ? (
                        <GroupDevicePicker group={g} onPick={(key) => chooseInGroup(g, key)} />
                      ) : undefined
                    }
                  />
                ))}
              </div>
            </section>
          ))}
        </section>
      </main>

      {/* Fixed chrome lives OUTSIDE `.app` — its animated transform would otherwise
          become the containing block for these position:fixed elements. */}
      {isMobile ? (
        <MobileChrome
          entries={dockEntries}
          focusKey={mobileFocus}
          onFocus={setFocusKey}
          onHome={() => controls.current.get(mobileFocus)?.home()}
          onRotate={() => controls.current.get(mobileFocus)?.rotate()}
          onText={(text) => controls.current.get(mobileFocus)?.typeText(text) ?? [...text]}
          onKey={(name) => controls.current.get(mobileFocus)?.key(name)}
          rotation={rotations[mobileFocus] ?? 0}
          repo={focusedGroup?.repo ?? state.repo}
          refName={focusedGroup?.ref ?? state.ref}
          source={state.source}
        />
      ) : (
        <>
          {/* One source with several devices uses the SAME picker two sources use —
              compact, single-select, next to the frame. There is no separate
              layout mode any more: computeStage shows everything that fits and
              one device when it does not, so there was nothing left for a
              Side-by-side/Focus toggle to decide. */}
          {!multiSource && panes.length > 1 && shownCount === 1 && groups[0] && (
            <GroupDevicePicker group={groups[0]} onPick={(key) => setFocusKey(key)} />
          )}
        </>
      )}
    </>
  );
}

/**
 * Which device this column shows: DevicePicker in single-select compact mode, so
 * it's the same switch-device icon button + popover the mobile dock uses, sitting
 * in the control row beside Home/Rotate/Fullscreen.
 */
function GroupDevicePicker({ group, onPick }: { group: StageGroup; onPick: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  if (group.panes.length < 2) return null;
  return (
    <DevicePicker
      options={group.panes.map((p) => ({ key: p.key, label: shortDeviceName(p.device.label) }))}
      visible={new Set([group.activeKey])}
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

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="centered">
      <div className="centered-inner">{children}</div>
    </main>
  );
}
