import { diffImages } from "../verify/compare.ts";
import { decodePng, type Rgba } from "../verify/png.ts";
import { JevError, type ChoiceAnswer, type JevChooser, type JevQuestion, type NoulAnswer } from "./jev.ts";
import { candidatesFor, mask, pngSize, readScreen, type ActionKind, type Candidate, type NavigateAction, type Rect } from "./screen.ts";

export type LoopAction = NavigateAction | { type: "type"; text: string };

export interface NavigateRequest {
  goal: string;
  maxSteps: number;
  /** One floor for every action kind, replacing the per-kind defaults. */
  minConfidence?: number;
  /** Values the caller supplies for typing. Only the NAMES reach the decider. */
  text: Record<string, string>;
  /** The device's UI language, e.g. "nb-NO", when known. */
  locale?: string | null;
}

export interface Egress {
  candidates: number;
  bytes: number;
}

export interface NavigateDeps {
  describe: () => Promise<unknown>;
  act: (action: LoopAction) => Promise<unknown>;
  jev: JevChooser;
  /** A screenshot, for telling a settled screen from one still moving. Absent: no settle wait. */
  frame?: () => Promise<Buffer>;
  /** Called with the size of every request BEFORE it is sent; throwing refuses the send. */
  onEgress?: (e: Egress) => void;
  now?: () => number;
}

export interface NavigateStep {
  n: number;
  chose: string;
  did: string;
  confidence: number;
  /** The confidence this kind of action needed. */
  needed: number;
  /** Jev's probability that the goal was already reached on the screen this step saw. */
  goalReached: number | null;
  alternatives: Array<{ option: string; p: number }>;
  candidates: number;
  /** false: the screen was still changing when the settle wait gave up. */
  settled: boolean;
  settleMs: number;
  describeMs: number;
  decideMs: number;
  actMs: number;
  estimatedTokens: number;
  inputTokens: number | null;
}

export type NavigateReason =
  | "low_confidence"
  | "stuck"
  | "repeating"
  | "done_disputed"
  | "empty_screen"
  | "screen_unstable"
  | "stale_tree"
  | "action_failed"
  | "describe_failed"
  | "decider_error"
  | "egress_refused";

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

/** A wrong tap costs one hand-back; a wrong `done` is a false report, so it needs more. */
export const DEFAULT_THRESHOLDS: Record<Exclude<ActionKind, "stuck">, number> = {
  tap: 0.5,
  reveal: 0.5,
  scroll: 0.4,
  back: 0.7,
  fill: 0.8,
  done: 0.8,
};
const DONE_DISPUTE_BELOW = 0.5;
/** A `done` under its threshold still stands when the independent goal check agrees strongly. */
const DONE_CORROBORATED = { confidence: 0.6, reached: 0.75 };
const FINAL_SCREEN_LINES = 80;
/** jev-1.13: 32k tokens for `state` plus the longest question. Kept under it with a margin. */
export const TOKEN_BUDGET = 28_000;
/** Checked against TypeSafe's billed input_tokens (live only, no test can): on large Norwegian screens the bill ran ~7% ABOVE chars/3, ~11% below chars/2.5. */
const CHARS_PER_TOKEN = 2.5;
const SETTLE_TIMEOUT_MS = 4_000;
const MAX_SCREEN_CHANGES = 2;
const STILL_RATIO = 0.002;
/** Of the tapped element's region: a list that shifted by a row changes most of it, a blinking caret almost none. */
const MOVED_RATIO = 0.05;
const STILL_MS = 300;

export function estimateTokens(v: unknown): number {
  return Math.ceil(JSON.stringify(v).length / CHARS_PER_TOKEN);
}

const NEXT_INSTRUCTIONS = {
  question: "Pick the single action that makes the most direct progress toward `goal` from the current `screen`.",
  rules: [
    "`screen` lists what is visible now, one element per line; each option names one element by its ref (e3, e4, …).",
    "Labels are in the app's UI language (`ui_language`), which can differ from the language of `goal`: match by meaning. Ids after # are often English.",
    "Pick done only when `screen` itself shows the goal reached, for example its heading names the page the goal asks for.",
    "When the element the goal needs is not on `screen`, pick scroll down; pick back when this screen is the wrong branch.",
    "`actions_taken` lists what was already done, oldest first; do not repeat one that did not help.",
  ],
};
const REACHED_INSTRUCTIONS = "Does `screen` show that `goal` has already been achieved?";

export async function navigate(req: NavigateRequest, deps: NavigateDeps): Promise<NavigateResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const textKeys = Object.keys(req.text);
  const goal = mask(req.goal);
  const steps: NavigateStep[] = [];
  const history: string[] = [];
  const tried = new Set<string>();
  let model: string | null = null;
  let finalScreen: string[] = [];
  let dropped = 0;
  let truncated = false;
  let inputTokens = 0;
  let changes = 0;
  let acted: { signature: string; shot: Buffer | null } | null = null;

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

  for (let n = 1; ; ) {
    const ts = now();
    const settle = await waitSettled(deps.frame, now);
    const settleMs = now() - ts;

    const t0 = now();
    let tree: unknown;
    try {
      tree = await deps.describe();
    } catch (e) {
      return finish("escalated", `describe failed: ${errMsg(e)}`, "describe_failed");
    }
    const describeMs = now() - t0;
    const screen = readScreen(tree, settle.shot ? pngSize(settle.shot) : null);
    finalScreen = screen.lines;
    if (screen.lines.length === 0) {
      return finish("escalated", "the accessibility tree has nothing readable on this screen, so there is nothing to choose from — take a screenshot", "empty_screen");
    }
    if (acted && acted.signature === screen.signature && acted.shot && settle.shot && !sameScreen(acted.shot, settle.shot, MOVED_RATIO)) {
      return finish(
        "escalated",
        "the screen changed but the accessibility tree did not, so describe is answering with the previous screen (Android's uiautomator cannot capture a screen that never goes idle) — take a screenshot",
        "stale_tree",
      );
    }

    const set = candidatesFor(screen, textKeys);
    dropped = Math.max(dropped, set.dropped);
    const fitted = fit(goal, req.locale ?? null, history, screen.lines, set.candidates);
    truncated ||= fitted.cut;
    const { state, questions, candidates } = fitted;

    const t1 = now();
    let next: ChoiceAnswer;
    let reached: number | null;
    let usage: number | null = null;
    try {
      deps.onEgress?.({ candidates: candidates.length, bytes: Buffer.byteLength(JSON.stringify({ state, questions })) });
    } catch (e) {
      return finish("escalated", `nothing was sent: ${errMsg(e)}`, "egress_refused");
    }
    try {
      const res = await deps.jev.ask(state, questions);
      model = res.model;
      usage = res.usage?.input_tokens ?? null;
      inputTokens += usage ?? 0;
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
    const needed = chosen && chosen.kind !== "stuck" ? (req.minConfidence ?? DEFAULT_THRESHOLDS[chosen.kind]) : 0;
    const step: NavigateStep = {
      n,
      chose: next.choice,
      did: chosen?.summary ?? next.choice,
      confidence: next.confidence,
      needed,
      goalReached: reached,
      alternatives: top(next.probabilities, 3),
      candidates: candidates.length,
      settled: settle.settled,
      settleMs,
      describeMs,
      decideMs,
      actMs: 0,
      estimatedTokens: fitted.tokens,
      inputTokens: usage,
    };
    steps.push(step);

    if (!chosen) return finish("escalated", `the decision model chose "${next.choice}", which is not one of the offered actions`, "decider_error");
    if (chosen.kind === "stuck") return finish("escalated", "the decision model found no listed action that moves toward the goal", "stuck");
    const corroborated = chosen.kind === "done" && req.minConfidence === undefined && reached !== null && reached >= DONE_CORROBORATED.reached && next.confidence >= DONE_CORROBORATED.confidence;
    if (next.confidence < needed && !corroborated) {
      return finish(
        "escalated",
        `confidence ${next.confidence.toFixed(2)} for "${chosen.summary}" is below the ${needed} a ${chosen.kind} needs — the top options were ${step.alternatives.map((x) => `${x.option} (${x.p.toFixed(2)})`).join(", ")}`,
        "low_confidence",
      );
    }
    if (chosen.kind === "done") {
      if (reached !== null && reached < DONE_DISPUTE_BELOW) {
        return finish("escalated", `the choice said done but the goal check disagrees (p=${reached.toFixed(2)})`, "done_disputed");
      }
      return finish("done", "the decision model judged the goal reached on the final screen");
    }
    if (n > req.maxSteps) {
      step.did = `not run, step limit reached: ${chosen.summary}`;
      break;
    }

    const attempt = `${screen.signature}\u0000${chosen.key}`;
    if (tried.has(attempt)) return finish("escalated", `it chose "${chosen.summary}" again on a screen it had already acted on — it is going in circles`, "repeating");

    if (chosen.target && settle.shot && deps.frame) {
      const before = await grab(deps.frame);
      if (!before || !sameRegion(settle.shot, before, chosen.target)) {
        step.did = `not run, the screen changed after it was read: ${chosen.summary}`;
        if (++changes > MAX_SCREEN_CHANGES) return finish("escalated", "the screen kept changing between reading it and acting on it", "screen_unstable");
        continue;
      }
    }
    changes = 0;
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
    acted = { signature: screen.signature, shot: settle.shot };
    n++;
  }
  return finish("limit", `stopped after ${req.maxSteps} actions without the goal judged reached`);
}

interface Fitted {
  state: { goal: string; ui_language?: string; actions_taken: string[]; screen: string[] };
  questions: Record<string, JevQuestion>;
  candidates: Candidate[];
  tokens: number;
  cut: boolean;
}

function build(goal: string, locale: string | null, history: string[], lines: string[], candidates: Candidate[]): Omit<Fitted, "cut"> {
  const state = { goal, ...(locale ? { ui_language: locale } : {}), actions_taken: [...history], screen: lines };
  const questions: Record<string, JevQuestion> = {
    next: { type: "choice", instructions: NEXT_INSTRUCTIONS, criteria: Object.fromEntries(candidates.map((c) => [c.key, null])) },
    reached: { type: "noul", instructions: REACHED_INSTRUCTIONS },
  };
  return { state, questions, candidates, tokens: estimateTokens(state) + estimateTokens(questions.next) };
}

/** Keep `state` plus the Choice under Jev's limit: drop screen lines from the bottom, then the options they named. */
function fit(goal: string, locale: string | null, history: string[], lines: string[], candidates: Candidate[]): Fitted {
  let b = build(goal, locale, history, lines, candidates);
  if (b.tokens <= TOKEN_BUDGET) return { ...b, cut: false };
  let kept = lines.length;
  while (kept > 1 && b.tokens > TOKEN_BUDGET) {
    kept = Math.floor(kept * 0.8);
    const shown = lines.slice(0, kept);
    const refs = new Set(shown.map((l) => l.split(" ", 1)[0]));
    const opts = candidates.filter((c) => c.kind !== "tap" && c.kind !== "fill" && c.kind !== "reveal" ? true : refs.has(refOf(c.key)));
    b = build(goal, locale, history, shown, opts);
  }
  return { ...b, cut: true };
}

function refOf(key: string): string {
  return key.match(/\b(e\d+)\b/)?.[1] ?? "";
}

/**
 * The tapped element's own pixels still match what was read. Its region, not the screen: a looping
 * illustration (Android Clock's Bedtime tab) changes ~3% of the screen forever.
 */
export function sameRegion(a: Buffer, b: Buffer, r: Rect): boolean {
  if (a.equals(b)) return true;
  try {
    const [x, y] = [decodePng(a), decodePng(b)];
    if (x.width !== y.width || x.height !== y.height) return false;
    return diffImages(crop(x, r), crop(y, r)).ratio < MOVED_RATIO;
  } catch {
    return false;
  }
}

function crop(img: Rgba, r: Rect): Rgba {
  const x0 = Math.max(0, Math.floor(r.x * img.width));
  const y0 = Math.max(0, Math.floor(r.y * img.height));
  const w = Math.max(1, Math.min(img.width - x0, Math.ceil(r.width * img.width)));
  const h = Math.max(1, Math.min(img.height - y0, Math.ceil(r.height * img.height)));
  const data = Buffer.alloc(w * h * 4);
  for (let row = 0; row < h; row++) img.data.copy(data, row * w * 4, ((y0 + row) * img.width + x0) * 4, ((y0 + row) * img.width + x0 + w) * 4);
  return { width: w, height: h, data };
}

async function grab(frame: () => Promise<Buffer>): Promise<Buffer | null> {
  try {
    return await frame();
  } catch {
    return null;
  }
}

/** Equal but for a blinking caret or a ticking clock: under `ratio` of the pixels differ. */
export function sameScreen(a: Buffer, b: Buffer, ratio = STILL_RATIO): boolean {
  if (a.equals(b)) return true;
  try {
    const d = diffImages(decodePng(a), decodePng(b));
    return !d.sizeMismatch && d.ratio < ratio;
  } catch {
    return false;
  }
}

/**
 * The screen has matched itself for STILL_MS: nothing is animating. A window, not two frames in a
 * row — a push transition starts after the tap returns, so two frames grabbed first read as still.
 * A failed screenshot settles nothing.
 */
async function waitSettled(frame: NavigateDeps["frame"], now: () => number): Promise<{ settled: boolean; shot: Buffer | null }> {
  if (!frame) return { settled: false, shot: null };
  const deadline = now() + SETTLE_TIMEOUT_MS;
  let last = await grab(frame);
  let stillSince = now();
  let matches = 0;
  while (last && now() < deadline) {
    const shot = await grab(frame);
    if (!shot) return { settled: false, shot: null };
    if (sameScreen(last, shot)) {
      matches++;
      if (matches >= 2 && now() - stillSince >= STILL_MS) return { settled: true, shot };
    } else {
      stillSince = now();
      matches = 0;
    }
    last = shot;
  }
  return { settled: false, shot: last };
}

async function runCandidate(c: Candidate, text: Record<string, string>, act: NavigateDeps["act"]): Promise<void> {
  for (const a of c.actions) await act(a);
  if (c.typeKey !== undefined) await act({ type: "type", text: text[c.typeKey] ?? "" });
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
