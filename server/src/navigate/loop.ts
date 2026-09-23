import type { UiAction } from "../testing/control.ts";
import { JevError, type ChoiceAnswer, type JevChooser, type NoulAnswer } from "./jev.ts";
import { candidatesFor, readScreen, type Candidate } from "./screen.ts";

export interface NavigateRequest {
  goal: string;
  maxSteps: number;
  minConfidence: number;
  /** Values the caller supplies for typing. Only the NAMES reach the decider. */
  text: Record<string, string>;
}

export interface NavigateDeps {
  describe: () => Promise<unknown>;
  act: (action: UiAction) => Promise<unknown>;
  jev: JevChooser;
  now?: () => number;
  /** Wait for the UI to settle after an action, before the next describe. */
  settle?: () => Promise<void>;
}

export interface NavigateStep {
  n: number;
  chose: string;
  did: string;
  confidence: number;
  /** Jev's probability that the goal was already reached on the screen this step saw. */
  goalReached: number | null;
  alternatives: Array<{ option: string; p: number }>;
  candidates: number;
  describeMs: number;
  decideMs: number;
  actMs: number;
}

export type NavigateReason =
  | "low_confidence"
  | "stuck"
  | "repeating"
  | "done_disputed"
  | "empty_screen"
  | "action_failed"
  | "describe_failed"
  | "decider_error";

export interface NavigateResult {
  outcome: "done" | "escalated" | "limit";
  reason?: NavigateReason;
  message: string;
  model: string | null;
  steps: NavigateStep[];
  totalMs: number;
  /** The last screen the loop saw, as the decider read it. */
  finalScreen: string[];
  candidatesDropped: number;
  stateTruncated: boolean;
  inputTokens: number;
}

// About 15k tokens at ~4 chars/token, leaving the rest of Jev's 32k state+question budget to a 255-option Choice.
const STATE_CHAR_BUDGET = 60_000;
const DONE_DISPUTE_BELOW = 0.5;
const FINAL_SCREEN_LINES = 80;

export async function navigate(req: NavigateRequest, deps: NavigateDeps): Promise<NavigateResult> {
  const now = deps.now ?? Date.now;
  const settle = deps.settle ?? (async () => {});
  const started = now();
  const textKeys = Object.keys(req.text);
  const steps: NavigateStep[] = [];
  const history: string[] = [];
  const tried = new Set<string>();
  let model: string | null = null;
  let finalScreen: string[] = [];
  let dropped = 0;
  let truncated = false;
  let inputTokens = 0;

  const finish = (outcome: NavigateResult["outcome"], message: string, reason?: NavigateReason): NavigateResult => ({
    outcome,
    ...(reason ? { reason } : {}),
    message,
    model,
    steps,
    totalMs: now() - started,
    finalScreen: finalScreen.slice(0, FINAL_SCREEN_LINES),
    candidatesDropped: dropped,
    stateTruncated: truncated,
    inputTokens,
  });

  for (let n = 1; ; n++) {
    const t0 = now();
    let tree: unknown;
    try {
      tree = await deps.describe();
    } catch (e) {
      return finish("escalated", `describe failed: ${errMsg(e)}`, "describe_failed");
    }
    const describeMs = now() - t0;
    const screen = readScreen(tree);
    finalScreen = screen.lines;
    if (screen.elements.length === 0) {
      return finish("escalated", "the accessibility tree has nothing readable on this screen, so there is nothing to choose from — take a screenshot", "empty_screen");
    }

    const { candidates, dropped: d } = candidatesFor(screen, textKeys);
    dropped = Math.max(dropped, d);
    const { lines, cut } = fitLines(screen.lines, STATE_CHAR_BUDGET - req.goal.length - history.join("").length);
    truncated ||= cut;

    const t1 = now();
    let next: ChoiceAnswer;
    let reached: number | null;
    try {
      const res = await deps.jev.ask(
        { goal: req.goal, history: [...history], screen: lines },
        {
          next: {
            type: "choice",
            instructions:
              "`screen` lists the elements of a mobile app screen, one per line. `history` lists the actions already taken, oldest first. " +
              "Pick the single next action that makes the most direct progress toward `goal`. Pick `done` only if `screen` already shows `goal` achieved.",
            criteria: Object.fromEntries(candidates.map((c) => [c.key, c.description])),
          },
          reached: { type: "noul", instructions: "Does `screen` show that `goal` has already been achieved?" },
        },
      );
      model = res.model;
      inputTokens += res.usage?.input_tokens ?? 0;
      const a = res.answers.next;
      if (!a || a.type !== "choice") throw new JevError("TypeSafe API answered without the `next` choice", null);
      next = a;
      const r = res.answers.reached as NoulAnswer | undefined;
      reached = r?.type === "noul" ? r.noul : null;
    } catch (e) {
      return finish("escalated", `the decision model failed: ${errMsg(e)}`, "decider_error");
    }
    const decideMs = now() - t1;

    const chosen = candidates.find((c) => c.key === next.choice);
    const step: NavigateStep = {
      n,
      chose: next.choice,
      did: chosen?.summary ?? next.choice,
      confidence: next.confidence,
      goalReached: reached,
      alternatives: top(next.probabilities, 3),
      candidates: candidates.length,
      describeMs,
      decideMs,
      actMs: 0,
    };
    steps.push(step);

    if (!chosen) return finish("escalated", `the decision model chose "${next.choice}", which is not one of the offered actions`, "decider_error");
    if (next.confidence < req.minConfidence) {
      return finish(
        "escalated",
        `confidence ${next.confidence.toFixed(2)} is below ${req.minConfidence} — the top options were ${step.alternatives.map((x) => `${x.option} (${x.p.toFixed(2)})`).join(", ")}`,
        "low_confidence",
      );
    }
    if (chosen.key === "done") {
      if (reached !== null && reached < DONE_DISPUTE_BELOW) {
        return finish("escalated", `the choice said done but the goal check disagrees (p=${reached.toFixed(2)})`, "done_disputed");
      }
      return finish("done", "the decision model judged the goal reached on the final screen");
    }
    if (chosen.key === "stuck") return finish("escalated", "the decision model found no listed action that moves toward the goal", "stuck");
    if (n > req.maxSteps) {
      step.did = `not run, step limit reached: ${chosen.summary}`;
      break;
    }

    const attempt = `${screen.signature}\u0000${chosen.key}`;
    if (tried.has(attempt)) return finish("escalated", `it chose "${chosen.summary}" again on a screen it had already acted on — it is going in circles`, "repeating");
    tried.add(attempt);

    const t2 = now();
    try {
      await runCandidate(chosen, req.text, deps.act);
    } catch (e) {
      step.actMs = now() - t2;
      return finish("escalated", `"${chosen.summary}" failed: ${errMsg(e)}`, "action_failed");
    }
    step.actMs = now() - t2;
    history.push(chosen.summary);
    await settle();
  }
  return finish("limit", `stopped after ${req.maxSteps} actions without the goal judged reached`);
}

async function runCandidate(c: Candidate, text: Record<string, string>, act: NavigateDeps["act"]): Promise<void> {
  for (const a of c.actions) await act(a);
  if (c.typeKey !== undefined) await act({ type: "type", text: text[c.typeKey] ?? "" });
}

function fitLines(lines: string[], budget: number): { lines: string[]; cut: boolean } {
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    used += lines[i]!.length + 1;
    if (used > budget) return { lines: lines.slice(0, i), cut: true };
  }
  return { lines, cut: false };
}

function top(p: Record<string, number>, k: number): Array<{ option: string; p: number }> {
  return Object.entries(p)
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([option, v]) => ({ option, p: Math.round(v * 1000) / 1000 }));
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
