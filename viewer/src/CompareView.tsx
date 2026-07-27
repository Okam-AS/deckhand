import { useState } from "react";
import { DeviceFrame } from "./DeviceFrame.tsx";
import { repoName, type ShareLedgerScreen, type ShareState } from "./api.ts";

/**
 * The compare view: the REFERENCE app (the oracle to match) and the WORKING app
 * (the one being built) side by side, with the agent-maintained parity checklist
 * above. Both panes reuse DeviceFrame verbatim — each points at its own share, so
 * all video/input rides the existing per-share proxy (no new streaming code).
 * Shown when the working share's state carries `pairedWith`. (Migration is one
 * preset of compare — reference = the source app.)
 */
export function CompareView({ shareId, state }: { shareId: string; state: ShareState }) {
  // The reference pane may be absent (reference not live yet) — then it's just
  // the working pane plus the checklist, and there's nothing to show/hide.
  const paired = state.pairedWith;
  const [showRef, setShowRef] = useState(true);
  const screens = state.ledger?.screens ?? [];
  const refShown = !!paired && showRef;

  return (
    <>
      <main className="app app--mig">
        {screens.length > 0 && <Ledger screens={screens} />}
        <div className={`mig-cols ${refShown ? "" : "mig-cols--solo"}`}>
          {refShown && (
            <section className="mig-col">
              <header className="mig-col-head">
                <span className="mig-col-tag mig-col-tag--source">Reference</span>
                <span className="mig-col-meta">
                  {repoName(paired.repo)} · {paired.ref}
                </span>
              </header>
              <div className="mig-col-stage">
                {paired.devices.map((d) => (
                  <DeviceFrame key={`s-${d.deviceId}`} shareId={paired.shareId} device={d} repo={paired.repo} branch={paired.ref} variant="grid" />
                ))}
              </div>
            </section>
          )}
          <section className="mig-col">
            <header className="mig-col-head">
              <span className="mig-col-tag mig-col-tag--target">Working</span>
              <span className="mig-col-meta">
                {repoName(state.repo)} · {state.ref}
              </span>
              {paired && (
                <button type="button" className="mig-toggle" onClick={() => setShowRef((v) => !v)}>
                  {showRef ? "Hide reference" : "Show reference"}
                </button>
              )}
            </header>
            <div className="mig-col-stage">
              {state.devices.map((d) => (
                <DeviceFrame key={`t-${d.deviceId}`} shareId={shareId} device={d} repo={state.repo} branch={state.ref} variant="grid" testRun={state.testRun} />
              ))}
            </div>
          </section>
        </div>
      </main>
      <aside className="brand" aria-label="Deckhand">
        <span className="brand-name">Deckhand</span>
      </aside>
    </>
  );
}

// Verdicts, worst-signal-first for the dot row. `matches`/`adjusted` are both
// "done" (adjusted = a deliberate, accepted difference); `regression` is the only
// one that flags a problem. Legacy migration-ledger statuses still render.
const STATUS_ORDER = ["regression", "doing", "matches", "adjusted", "pending", "differs", "in-progress", "not-started"] as const;
const DONE = new Set(["matches", "adjusted"]);

function Ledger({ screens }: { screens: ShareLedgerScreen[] }) {
  const [open, setOpen] = useState(false);
  const done = screens.filter((s) => DONE.has(s.status)).length;
  const counts: Record<string, number> = {};
  for (const s of screens) counts[s.status] = (counts[s.status] ?? 0) + 1;

  return (
    <div className={`mig-ledger ${open ? "open" : ""}`}>
      <button type="button" className="mig-ledger-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="mig-ledger-title">Compare progress</span>
        <span className="mig-ledger-count">
          {done}/{screens.length} done
        </span>
        <span className="mig-ledger-dots" aria-hidden>
          {STATUS_ORDER.filter((st) => counts[st]).map((st) => (
            <span key={st} className={`mig-dot mig-dot--${st}`} title={`${st}: ${counts[st]}`}>
              {counts[st]}
            </span>
          ))}
        </span>
      </button>
      {open && (
        <ol className="mig-ledger-list">
          {screens.map((s, i) => (
            <li key={i} className={`mig-screen mig-screen--${s.status}`}>
              <span className="mig-screen-ico" aria-hidden />
              <span className="mig-screen-body">
                <span className="mig-screen-name">{s.name}</span>
                {s.note && <span className="mig-screen-note">{s.note}</span>}
              </span>
              <span className="mig-screen-status">{s.status}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
