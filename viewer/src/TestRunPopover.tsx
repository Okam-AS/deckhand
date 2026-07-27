import { useEffect, useRef, useState } from "react";
import type { ShareTestRun } from "./api.ts";
import { CheckIcon, XIcon } from "./icons.tsx";

/**
 * The agent-driven test run, shown as ONE button that lives among the other
 * device controls (the bottom dock on mobile, the top control row on desktop).
 * While running, the button's border spins and it shows the step count (2/5);
 * when done it settles to ✓ (passed) or ✗ (failed) in the same green/red. Tap it
 * for the step popover — detail on demand, nothing when idle.
 */
export function TestRunControl({ testRun, placement }: { testRun: ShareTestRun; placement: "dock" | "topbar" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDoc);
    return () => document.removeEventListener("pointerdown", onDoc);
  }, [open]);

  const running = testRun.status === "running";
  const total = testRun.steps.length;
  const done = testRun.steps.filter((s) => s.status === "passed" || s.status === "failed").length;
  const btnBase = placement === "dock" ? "dock-btn" : "ctrl-btn";
  const iconSize = placement === "dock" ? 18 : 15;

  return (
    <div className={`trun trun--${placement} ${open ? "open" : ""}`} ref={ref}>
      <button
        type="button"
        className={`${btnBase} trun-btn trun-btn--${running ? "running" : testRun.status}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Test run: ${testRun.title} (${running ? `${done} of ${total} steps` : testRun.status})`}
        title={testRun.title}
      >
        {running ? (
          <span className="trun-count">
            {done}/{total}
          </span>
        ) : testRun.status === "passed" ? (
          <CheckIcon size={iconSize} />
        ) : (
          <XIcon size={iconSize} />
        )}
      </button>

      <div className={`trun-pop ${open ? "open" : ""}`} role="dialog" aria-label="Test steps">
        <div className="trun-head">{testRun.title}</div>
        <ol className="trun-steps">
          {testRun.steps.map((s, i) => (
            <li key={s.n} className={`trun-step trun-step--${s.status}`} style={{ "--i": i } as React.CSSProperties}>
              <span className="trun-step-ico" aria-hidden>
                {s.status === "running" ? (
                  <span className="spinner spinner--tr" />
                ) : s.status === "passed" ? (
                  <CheckIcon size={13} />
                ) : s.status === "failed" ? (
                  <XIcon size={13} />
                ) : (
                  <span className="trun-dot" />
                )}
              </span>
              <span className="trun-step-body">
                <span className="trun-step-label">{s.label}</span>
                {s.detail && <span className="trun-step-detail">{s.detail}</span>}
              </span>
            </li>
          ))}
          {total === 0 && <li className="trun-empty">Preparing…</li>}
        </ol>
        {testRun.summary && <div className="trun-summary">{testRun.summary}</div>}
      </div>
    </div>
  );
}
