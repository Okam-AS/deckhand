import { useEffect, useRef, useState } from "react";
import type { SpecialKey } from "./stream/input.ts";
import { XIcon } from "./icons.tsx";

/**
 * The on-screen typing bar. Lived inside MobileChrome until a phone in LANDSCAPE
 * crossed the 700px layout breakpoint and lost its keyboard button entirely —
 * the device-frame chrome above that width never had one, because it assumed a
 * real keyboard. Extracted so both chromes can offer it.
 */
export function TypeBar({ onText, onKey, onClose }: { onText: (text: string) => string[]; onKey: (name: SpecialKey) => void; onClose: () => void }) {
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
