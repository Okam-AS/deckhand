import { useEffect, useRef } from "react";
import type { ShareDevice } from "./api.ts";

export type ViewMode = "grid" | "focus";

interface Props {
  devices: ShareDevice[];
  visible: Set<string>;
  shownCount: number;
  mode: ViewMode;
  onMode: (mode: ViewMode) => void;
  onToggle: (id: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Top-center control: choose the layout mode and which devices are shown. */
export function DevicePicker({ devices, visible, shownCount, mode, onMode, onToggle, open, onOpenChange }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange]);

  return (
    <div className="picker" ref={ref}>
      <button
        type="button"
        className="picker-btn"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <GridIcon />
        <span className="picker-count">
          {shownCount}/{devices.length}
        </span>
        <ChevronIcon className={open ? "chev flip" : "chev"} />
      </button>

      <div className={`picker-menu ${open ? "open" : ""}`} role="menu">
        <div className="picker-section">Layout</div>
        <div className="seg" role="tablist" aria-label="View mode">
          <button
            type="button"
            className={`seg-btn ${mode === "grid" ? "on" : ""}`}
            role="tab"
            aria-selected={mode === "grid"}
            onClick={() => onMode("grid")}
          >
            Side by side
          </button>
          <button
            type="button"
            className={`seg-btn ${mode === "focus" ? "on" : ""}`}
            role="tab"
            aria-selected={mode === "focus"}
            onClick={() => onMode("focus")}
          >
            Focus
          </button>
        </div>

        <div className="picker-section">Devices</div>
        {devices.map((d) => {
          const on = visible.has(d.deviceId);
          const isLast = on && shownCount <= 1; // never hide the last one
          return (
            <button
              key={d.deviceId}
              type="button"
              className="picker-row"
              role="menuitemcheckbox"
              aria-checked={on}
              disabled={isLast}
              onClick={() => onToggle(d.deviceId)}
            >
              <span className="picker-label">{d.label}</span>
              <span className={`switch ${on ? "on" : ""}`} aria-hidden>
                <span className="knob" />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function GridIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
