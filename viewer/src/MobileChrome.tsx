import { useEffect, useRef, useState } from "react";
import type { ShareDevice, ShareTestRun } from "./api.ts";
import type { SpecialKey } from "./stream/input.ts";
import { CheckIcon, HomeIcon, InfoIcon, KeyboardIcon, RotateIcon, SwitchDeviceIcon, XIcon } from "./icons.tsx";
import { TestRunControl } from "./TestRunPopover.tsx";

interface Props {
  devices: ShareDevice[];
  focusId: string;
  onFocus: (id: string) => void;
  onHome: () => void;
  onRotate: () => void;
  /** Type a string on the focused device; returns the characters that couldn't be sent. */
  onText: (text: string) => string[];
  onKey: (name: SpecialKey) => void;
  /** Cumulative rotation (deg) of the focused device — spins the dock icons to match. */
  rotation: number;
  /** What the preview shows — for the info popover. */
  repo: string;
  refName: string;
  source?: "git" | "local";
  /** The agent's live test run — shown as a dock button (spinning border while running). */
  testRun?: ShareTestRun;
}

/**
 * Mobile chrome: no top strip — the sim gets the full height. Everything lives
 * in the bottom action dock: Device switch (only with several devices) ·
 * Home · Rotate · Keyboard · Info. The keyboard button swaps the dock for a
 * typing bar; switch/info open popovers above.
 */
export function MobileChrome(props: Props) {
  const { devices, focusId, onFocus, onHome, onRotate, onText, onKey, rotation } = props;
  const { repo, refName, source, testRun } = props;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const infoRef = useRef<HTMLDivElement>(null);
  const current = devices.find((d) => d.deviceId === focusId);

  useEffect(() => {
    if (!pickerOpen && !infoOpen) return;
    const onDoc = (e: PointerEvent) => {
      const t = e.target as Node;
      if (pickerRef.current?.contains(t) || infoRef.current?.contains(t)) return;
      setPickerOpen(false);
      setInfoOpen(false);
    };
    document.addEventListener("pointerdown", onDoc);
    return () => document.removeEventListener("pointerdown", onDoc);
  }, [pickerOpen, infoOpen]);

  return (
    <>
      {!typing && (
        <div className="mdock" style={{ "--icon-rot": `${rotation}deg` } as React.CSSProperties}>
          {devices.length > 1 && (
            <div className="minfo" ref={pickerRef}>
              <button
                type="button"
                className="dock-btn"
                onClick={() => {
                  setInfoOpen(false);
                  setPickerOpen((o) => !o);
                }}
                aria-expanded={pickerOpen}
                aria-haspopup="menu"
                title="Switch device"
                aria-label="Switch device"
              >
                <SwitchDeviceIcon size={19} />
              </button>
              <div className={`mmenu mmenu--up ${pickerOpen ? "open" : ""}`} role="menu">
                {devices.map((d) => (
                  <button
                    key={d.deviceId}
                    type="button"
                    className="picker-row mrow"
                    role="menuitemradio"
                    aria-checked={d.deviceId === focusId}
                    onClick={() => {
                      setPickerOpen(false);
                      onFocus(d.deviceId);
                    }}
                  >
                    <span className="picker-label">{d.label}</span>
                    {d.deviceId === focusId && (
                      <span className="mrow-check" aria-hidden>
                        <CheckIcon size={15} />
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
          <button type="button" className="dock-btn" onClick={onHome} title="Home" aria-label="Press the device home button">
            <HomeIcon size={19} />
          </button>
          <button type="button" className="dock-btn" onClick={onRotate} title="Rotate" aria-label="Rotate the device 90 degrees">
            <RotateIcon size={19} />
          </button>
          <button
            type="button"
            className="dock-btn"
            onClick={() => setTyping(true)}
            title="Keyboard"
            aria-label="Type with your keyboard"
          >
            <KeyboardIcon size={19} />
          </button>
          <div className="minfo" ref={infoRef}>
            <button
              type="button"
              className="dock-btn"
              onClick={() => {
                setPickerOpen(false);
                setInfoOpen((o) => !o);
              }}
              aria-expanded={infoOpen}
              aria-haspopup="dialog"
              title="Info"
              aria-label="What this preview shows"
            >
              <InfoIcon size={19} />
            </button>
            <div className={`mmenu mmenu--up ${infoOpen ? "open" : ""}`} role="dialog" aria-label="Preview info">
              <div className="info-row">
                <span className="info-key">Repo</span>
                <span className="info-val">{repo || "—"}</span>
              </div>
              <div className="info-row">
                <span className="info-key">{source === "local" ? "Source" : "Branch"}</span>
                <span className="info-val">{source === "local" ? "local working copy" : refName || "—"}</span>
              </div>
              <div className="info-row">
                <span className="info-key">Device</span>
                <span className="info-val">{current?.label ?? "—"}</span>
              </div>
            </div>
          </div>
          {testRun && <TestRunControl testRun={testRun} placement="dock" />}
        </div>
      )}

      {typing && <TypeBar onText={onText} onKey={onKey} onClose={() => setTyping(false)} />}
    </>
  );
}

/**
 * A slim bar with a real input, so the phone's own keyboard types into the
 * sim. Every edit is diffed against the previous value and forwarded
 * immediately (chars + backspaces); the field doubles as a local echo. To
 * delete text that was already in the sim's field before opening the bar,
 * backspacing past the start of the (empty) local input forwards the
 * backspace straight to the sim (see onKeyDown).
 * First tap the target field in the sim — focus inside the app is the app's.
 */
function TypeBar({ onText, onKey, onClose }: { onText: Props["onText"]; onKey: Props["onKey"]; onClose: () => void }) {
  const [value, setValue] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const prev = useRef("");
  const inputEl = useRef<HTMLInputElement>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [lift, setLift] = useState(0);

  useEffect(() => {
    inputEl.current?.focus();
  }, []);

  // Keep the bar above the phone's on-screen keyboard: iOS overlays the
  // keyboard without resizing the layout viewport, so fixed-bottom elements
  // must be lifted by the visual-viewport delta.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const measure = () => setLift(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    measure();
    vv.addEventListener("resize", measure);
    vv.addEventListener("scroll", measure);
    return () => {
      vv.removeEventListener("resize", measure);
      vv.removeEventListener("scroll", measure);
    };
  }, []);

  const flagSkipped = (skipped: string[]) => {
    if (!skipped.length) return;
    if (noteTimer.current) clearTimeout(noteTimer.current);
    setNote(`Can't send: ${[...new Set(skipped)].join(" ")} (US keys only)`);
    noteTimer.current = setTimeout(() => setNote(null), 3000);
  };

  const onInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value;
    const old = prev.current;
    let common = 0;
    while (common < old.length && common < next.length && old[common] === next[common]) common++;
    for (let i = 0; i < old.length - common; i++) onKey("backspace");
    const added = next.slice(common);
    if (added) flagSkipped(onText(added));
    prev.current = next;
    setValue(next);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onKey("return");
      return;
    }
    // Nothing local left to delete — forward the backspace to the sim anyway,
    // so pre-existing text can be deleted even without a prefill.
    if (e.key === "Backspace") {
      const el = inputEl.current;
      if (el && el.selectionStart === 0 && el.selectionEnd === 0) {
        e.preventDefault();
        onKey("backspace");
      }
    }
  };

  return (
    <div className="typebar" style={{ transform: lift ? `translateY(-${lift}px)` : undefined }}>
      <input
        ref={inputEl}
        value={value}
        onChange={onInput}
        onKeyDown={onKeyDown}
        placeholder="Type into the sim…"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        enterKeyHint="send"
        aria-label="Text to type into the device"
      />
      {note && <span className="typebar-note">{note}</span>}
      <button type="button" className="ctrl-btn" onClick={onClose} aria-label="Close keyboard bar">
        <XIcon size={16} />
      </button>
    </div>
  );
}
