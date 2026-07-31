import { useState } from "react";
import { CheckIcon, XIcon } from "./icons.tsx";
import type { ShareLedgerScreen, ShareTestRun } from "./api.ts";

/**
 * The one place progress is reported: a collapsible bar at the top of every
 * view. It answers a single question for whoever opens the link — "what is
 * happening here, and is anything wrong?" — from two independent sources:
 *
 *   - the TEST RUN — one agent run happening now; steps go pending → running →
 *     passed/failed and it ends with a verdict. Ephemeral.
 *   - the CHECKLIST — one row per screen/flow with a durable verdict
 *     (done / adjusted / regression). Survives many runs; only meaningful
 *     when the page has something to compare against.
 *
 * The head is a sentence about the current state, not a label on a component:
 * a run in flight owns it (it's the thing actually changing) and the checklist
 * rides along as a secondary count; with no run, the checklist takes the head
 * and gets its full dot row. They stay separate sections when expanded, because the statuses
 * don't mean the same thing — "passed" is a step that ran, "done" is a screen
 * that agrees with the reference — so one merged list would read as rows lying
 * about what they are.
 *
 * This replaced a button in the device control row. A per-device control was the
 * wrong home: the run belongs to the share, not to one simulator, so in a compare
 * it appeared once per working device and never on the reference side.
 */
export function ProgressBar({ testRun, screens }: { testRun?: ShareTestRun; screens?: ShareLedgerScreen[] }) {
  const [open, setOpen] = useState(false);
  const rows = screens ?? [];
  const hasLedger = rows.length > 0;
  if (!testRun && !hasLedger) return null;

  const running = testRun?.status === "running";
  const runTotal = testRun?.steps.length ?? 0;
  const runDone = testRun?.steps.filter((s) => s.status === "passed" || s.status === "failed").length ?? 0;
  const checklistDone = rows.filter((s) => DONE.has(s.status)).length;

  // Worst signal wins the bar's accent, so "something is wrong" reads without
  // opening anything. A live run outranks it visually — the sweep already says
  // "in flight", and a verdict it hasn't reached yet shouldn't be pre-empted.
  const alarm = !running && (testRun?.status === "failed" || rows.some((s) => ALARM.has(s.status)));

  const counts: Record<string, number> = {};
  for (const s of rows) counts[s.status] = (counts[s.status] ?? 0) + 1;

  return (
    <div className={`pbar ${open ? "open" : ""} ${running ? "pbar--running" : ""} ${alarm ? "pbar--alarm" : ""}`}>
      <button type="button" className="pbar-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {testRun ? (
          <>
            {!running && (
              <span className={`pbar-verdict pbar-verdict--${testRun.status}`} aria-hidden>
                {testRun.status === "passed" ? <CheckIcon size={14} /> : <XIcon size={14} />}
              </span>
            )}
            <span className="pbar-title">{testRun.title}</span>
            <span className="pbar-count">{running ? `${runDone}/${runTotal}` : testRun.status}</span>
            {/* The checklist rides along as a secondary count — present, not competing. */}
            {hasLedger && (
              <span className="pbar-aside">
                Checklist {checklistDone}/{rows.length}
              </span>
            )}
          </>
        ) : (
          <>
            <span className="pbar-title">Checklist</span>
            <span className="pbar-count">
              {checklistDone}/{rows.length} done
            </span>
            {/* The full breakdown only when the checklist IS the story; alongside a run
                it would double the numbers competing for the same glance. */}
            <span className="pbar-dots" aria-hidden>
              {STATUS_ORDER.filter((st) => counts[st]).map((st) => (
                <span key={st} className={`mig-dot mig-dot--${st}`} title={`${st}: ${counts[st]}`}>
                  {counts[st]}
                </span>
              ))}
            </span>
          </>
        )}
        <span className={`pbar-chev ${open ? "flip" : ""}`} aria-hidden>
          <ChevronIcon />
        </span>
      </button>

      {open && (
        <div className="pbar-body">
          {testRun && (
            <section className="pbar-sect">
              {/* Sections are only labelled when both are present — a lone header
                  above its own steps is noise. */}
              {hasLedger && <h2 className="pbar-sect-head">Run · {testRun.title}</h2>}
              <ol className="pbar-steps">
                {testRun.steps.map((s, i) => (
                  // --i staggers the rise animation down the list (see .pbar.open .trun-step).
                  <li key={`${s.n}-${i}`} className={`trun-step trun-step--${s.status}`} style={{ "--i": i } as React.CSSProperties}>
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
                {runTotal === 0 && <li className="trun-empty">Preparing…</li>}
              </ol>
              {testRun.summary && <div className="trun-summary">{testRun.summary}</div>}
            </section>
          )}

          {hasLedger && (
            <section className="pbar-sect">
              {testRun && <h2 className="pbar-sect-head">Checklist</h2>}
              <ol className="mig-ledger-list">
                {rows.map((s, i) => (
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
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

// Verdicts, worst-signal-first for the dot row. `done`/`adjusted` are both
// "done" (adjusted = a deliberate, accepted difference); `regression` is the only
// one that flags a problem. Legacy migration-ledger statuses still render.
// "matches"/"differs"/"in-progress"/"not-started" come from deckhand.migration.yaml,
// whose vocabulary lives in the user's own repo and is deliberately left alone.
const STATUS_ORDER = ["regression", "doing", "done", "adjusted", "pending", "matches", "differs", "in-progress", "not-started"] as const;
const DONE = new Set(["done", "adjusted", "matches"]);
const ALARM = new Set(["regression", "differs"]);
