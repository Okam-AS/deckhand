import { useEffect, useRef } from "react";
import { CheckIcon, SwitchDeviceIcon } from "./icons.tsx";

export type ViewMode = "grid" | "focus";

/**
 * One row in the picker, identified by an OPAQUE key.
 *
 * Deliberately not `ShareDevice`: a page can show several sources, and two of
 * them call their first device `ios-0`. Keying the picker on `deviceId` meant
 * callers converted pane keys in and out by hand — slicing the prefix off,
 * looking devices back up by an id that is not unique, and fabricating device
 * objects to smuggle keys through. The picker never needed to know what a device
 * is; it needs something to show and something to hand back.
 */
export interface PickerOption {
  key: string;
  label: string;
}

interface Props {
  options: PickerOption[];
  /** Keys currently on screen. */
  visible: Set<string>;
  shownCount: number;
  /** Layout section — omit both to hide it (a compare pane shows one device, so it has no layout choice). */
  mode?: ViewMode;
  onMode?: (mode: ViewMode) => void;
  onToggle: (id: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * "multi" (default): checkboxes, any subset visible — the single-preview stage.
   * "single": radios, exactly one — a compare pane, where two devices side by side
   * in one column would each be a sliver.
   */
  select?: "multi" | "single";
  /** Position in flow instead of fixed top-center (for a compare pane header). */
  inline?: boolean;
  /**
   * Render the trigger as an icon-only button matching the device control row
   * (Home/Rotate/Fullscreen), so a compare pane's device picker sits beside them
   * as a peer instead of floating above the sim as a second, larger affordance.
   */
  compact?: boolean;
}

/** Choose the layout mode and which devices are shown. */
export function DevicePicker({
  options,
  visible,
  shownCount,
  mode,
  onMode,
  onToggle,
  open,
  onOpenChange,
  select = "multi",
  inline = false,
  compact = false,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const single = select === "single";
  // In single mode the count is always "1/2" — useless. Name the device instead,
  // dropping the runtime ("iPhone 17 Pro · iOS 26.5" → "iPhone 17 Pro") to fit.
  const current = options.find((o) => visible.has(o.key)) ?? options[0];

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
    <div className={`picker ${inline ? "picker--inline" : ""} ${compact ? "picker--compact" : ""}`} ref={ref}>
      <button
        type="button"
        className={compact ? "ctrl-btn" : "picker-btn"}
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={single ? `Device: ${current?.label ?? "none"}` : undefined}
        title={compact ? (current?.label ?? "Choose device") : undefined}
      >
        {compact ? (
          <SwitchDeviceIcon size={18} />
        ) : (
          <>
            <GridIcon />
            <span className="picker-count">
              {single ? (current?.label.split(" · ")[0] ?? "—") : `${shownCount}/${options.length}`}
            </span>
            <ChevronIcon className={open ? "chev flip" : "chev"} />
          </>
        )}
      </button>

      <div className={`picker-menu ${open ? "open" : ""}`} role="menu">
        {mode && onMode && (
          <>
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
          </>
        )}

        <div className="picker-section">Devices</div>
        {options.map((d) => {
          const on = visible.has(d.key);
          // Multi: never hide the last one. Single: the chosen row is already the
          // answer, so clicking it again is a no-op rather than a disabled button.
          const isLast = on && shownCount <= 1;
          return (
            <button
              key={d.key}
              type="button"
              className="picker-row"
              role={single ? "menuitemradio" : "menuitemcheckbox"}
              aria-checked={on}
              disabled={!single && isLast}
              onClick={() => {
                if (single && on) return void onOpenChange(false);
                onToggle(d.key);
                if (single) onOpenChange(false);
              }}
            >
              <span className="picker-label">{d.label}</span>
              {single ? (
                // Same tick as MobileChrome's device menu — one shape for
                // "this is the device you're looking at", wherever you pick it.
                on && (
                  <span className="mrow-check" aria-hidden>
                    <CheckIcon size={15} />
                  </span>
                )
              ) : (
                <span className={`switch ${on ? "on" : ""}`} aria-hidden>
                  <span className="knob" />
                </span>
              )}
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
