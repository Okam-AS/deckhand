import type { Selector, UiAction } from "../testing/control.ts";
import { treeLabels } from "../testing/tree.ts";
import { devMenuOpen } from "../testing/devMenu.ts";
import { findAll, isVisible, pick, toNative, touchPoint, type Match } from "./geometry.ts";
import type { ScrollDirection, Step } from "./scenario.ts";

/**
 * The device surface a scenario drives. `screenshot` returns an upright PNG. `quarterTurns` is how far
 * the device is turned: SimDeck injects touches in the unrotated screen's coordinates and resolves a
 * selector against frames it does not rotate, so every touch is placed here, never by SimDeck.
 */
export interface VerifyControl {
  quarterTurns: number;
  action(a: UiAction): Promise<unknown>;
  describe(): Promise<unknown>;
  screenshot(): Promise<Buffer>;
}

export interface StepResult {
  action: string;
  ok: boolean;
  observed: string;
  ms: number;
}

export interface Artifacts {
  write(name: string, data: Buffer | string): void;
}

export interface Pace {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const realPace: Pace = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now };

export const DEFAULT_WAIT_MS = 15_000;
const MAX_SCROLLS = 20;

export function describeSelector(s: Selector): string {
  if (s.id) return `#${s.id}`;
  const [k, v] = Object.entries(s).find(([key]) => key !== "index" && key !== "regex") ?? ["?", "?"];
  return `${k}=${String(v)}${s.index != null ? `[${s.index}]` : ""}`;
}

export function stepLabel(step: Step): string {
  switch (step.action) {
    case "openUrl":
      return `openUrl ${step.url}`;
    case "type":
      return `type (${step.text.length} chars)`;
    case "scroll":
      return `scroll ${step.direction}`;
    case "sleep":
      return `sleep ${step.ms}`;
    case "screenshot":
      return `screenshot ${step.name}`;
    case "waitFor":
      return `waitFor${step.absent ? " absent" : ""} ${describeSelector(step.selector)}`;
    case "assert":
      return `assert${step.mode === "visible" ? "" : ` ${step.mode}`} ${describeSelector(step.selector)}`;
    default:
      return `${step.action} ${describeSelector(step.selector)}`;
  }
}

type Verdict = { ok: boolean; observed: string };

/** SimDeck answers some misses with 2xx and `ok: false` rather than an error status. */
function verdict(res: unknown): Verdict {
  if (res && typeof res === "object") {
    const r = res as Record<string, unknown>;
    const msg = [r.message, r.error, r.reason].find((x) => typeof x === "string" && x) as string | undefined;
    if (r.ok === false || r.passed === false || r.success === false) return { ok: false, observed: msg ?? "SimDeck reported ok:false" };
    const count = Array.isArray(r.matches) ? `${r.matches.length} match(es)` : undefined;
    return { ok: true, observed: msg ?? count ?? "ok" };
  }
  return { ok: true, observed: "ok" };
}

async function tapAt(control: VerifyControl, p: { x: number; y: number }): Promise<Verdict> {
  return verdict(await control.action({ type: "tap", x: round(p.x), y: round(p.y) }));
}

function round(n: number): number {
  return Math.round(Math.min(1, Math.max(0, n)) * 10_000) / 10_000;
}

/** A finger drag in the rotated UI's normalized coordinates, sent as the native swipe it is. */
async function drag(control: VerifyControl, from: [number, number], to: [number, number], durationMs = 350): Promise<void> {
  const a = toNative(from[0], from[1], control.quarterTurns);
  const b = toNative(to[0], to[1], control.quarterTurns);
  await control.action({ type: "swipe", startX: round(a.x), startY: round(a.y), endX: round(b.x), endY: round(b.y), durationMs });
}

/** Scrolling `down` reveals what is below: the finger moves up. */
async function scroll(control: VerifyControl, direction: ScrollDirection, at: [number, number] = [0.5, 0.5]): Promise<void> {
  const [u, v] = at;
  const d = 0.25;
  const moves: Record<ScrollDirection, [[number, number], [number, number]]> = {
    down: [[u, v + d], [u, v - d]],
    up: [[u, v - d], [u, v + d]],
    right: [[u + d, v], [u - d, v]],
    left: [[u - d, v], [u + d, v]],
  };
  await drag(control, ...moves[direction]);
}

async function waitForMatch(control: VerifyControl, s: Selector, timeoutMs: number, pace: Pace): Promise<Match | null> {
  const deadline = pace.now() + timeoutMs;
  for (;;) {
    const m = pick(findAll(await control.describe(), s), s);
    if (m || pace.now() >= deadline) return m;
    await pace.sleep(500);
  }
}

/**
 * The accessibility tree says nothing about the scroll view that clips an element, so an element
 * whose centre is barely inside the screen can still sit under a card's edge or fade. Visible is not
 * enough here: the match is brought towards the middle band, where no container edge reaches.
 */
const BAND: [number, number] = [0.15, 0.7];
const MAX_NUDGES = 2;

async function scrollUntilVisible(control: VerifyControl, s: Selector, pace: Pace): Promise<Verdict> {
  let lastY: number | null = null;
  let stuck = 0;
  let nudges = 0;
  for (let i = 0; i <= MAX_SCROLLS; i++) {
    const m = pick(findAll(await control.describe(), s), s);
    const scrolls = i - nudges;
    if (m && isVisible(m)) {
      const cy = (m.frame.y + m.frame.height / 2) / m.viewport.height;
      const moved = lastY === null || Math.abs(m.frame.y - lastY) >= 1;
      if ((cy >= BAND[0] && cy <= BAND[1]) || nudges >= MAX_NUDGES || (nudges > 0 && !moved)) {
        return { ok: true, observed: `visible after ${scrolls} scroll(s)${nudges ? ` and ${nudges} nudge(s) towards the middle` : ""}` };
      }
      lastY = m.frame.y;
      nudges++;
      const u = columnOf(m);
      const shift = Math.max(-0.4, Math.min(0.4, cy - 0.45));
      await drag(control, [u, 0.5 + shift / 2], [u, 0.5 - shift / 2], 900);
      await pace.sleep(800);
      continue;
    }
    if (i === MAX_SCROLLS) break;
    if (m) {
      stuck = lastY !== null && Math.abs(m.frame.y - lastY) < 1 ? stuck + 1 : 0;
      if (stuck >= 2) return { ok: false, observed: `${describeSelector(s)} is in the tree but scrolling does not move it into view` };
      lastY = m.frame.y;
      await scroll(control, m.frame.y + m.frame.height / 2 < 0 ? "up" : "down", [columnOf(m), 0.5]);
    } else {
      await scroll(control, "down");
    }
    await pace.sleep(600);
  }
  return { ok: false, observed: `${describeSelector(s)} not on screen after ${MAX_SCROLLS} scrolls` };
}

function columnOf(m: Match): number {
  return Math.min(0.95, Math.max(0.05, (m.frame.x + m.frame.width / 2) / m.viewport.width));
}

/**
 * iOS asks «Open in "<app>"?» the first time something outside the app opens its URL scheme — on a
 * fresh simulator, that is every scheme once. A user taps Open; so does verify, and nothing else.
 */
export async function confirmOpenPrompt(control: VerifyControl, pace: Pace = realPace, timeoutMs = 3000): Promise<boolean> {
  const deadline = pace.now() + timeoutMs;
  for (;;) {
    const tree = await control.describe().catch(() => null);
    const prompt = findAll(tree, { text: '^Open in [“"].*[”"]\\?$', regex: true }).find((m) => m.space === "native");
    const open = prompt ? findAll(tree, { label: "Open" }).find((m) => m.space === "native") : undefined;
    if (open) {
      await tapAt(control, touchPoint(open, control.quarterTurns));
      await pace.sleep(1000);
      return true;
    }
    if (pace.now() >= deadline) return false;
    await pace.sleep(400);
  }
}

async function runOne(step: Step, control: VerifyControl, out: Artifacts, pace: Pace): Promise<Verdict> {
  switch (step.action) {
    case "screenshot": {
      const png = await control.screenshot();
      out.write(`${step.name}.png`, png);
      const tree = await control.describe();
      out.write(`${step.name}.ax.json`, JSON.stringify(tree, null, 2));
      const note = devMenuOpen(tree) ? "; a dev menu is on screen (deckhand packaging, not the app)" : "";
      return { ok: true, observed: `${step.name}.png, ${treeLabels(tree).length} labels${note}` };
    }
    case "openUrl": {
      const v = verdict(await control.action({ type: "openUrl", url: step.url }));
      if (!v.ok) return v;
      return { ok: true, observed: (await confirmOpenPrompt(control, pace)) ? "confirmed the system's open prompt" : "ok" };
    }
    case "tap": {
      const m = await waitForMatch(control, step.selector, DEFAULT_WAIT_MS, pace);
      if (!m) return { ok: false, observed: `no element matches ${describeSelector(step.selector)}` };
      if (!isVisible(m)) return { ok: false, observed: `${describeSelector(step.selector)} is off screen; scrollUntilVisible first` };
      return tapAt(control, touchPoint(m, control.quarterTurns));
    }
    case "scroll":
      await scroll(control, step.direction);
      return { ok: true, observed: "ok" };
    case "scrollUntilVisible":
      return scrollUntilVisible(control, step.selector, pace);
    case "assert": {
      if (step.mode === "present") return verdict(await control.action({ type: "assert", selector: step.selector }));
      if (step.mode === "absent") return verdict(await control.action({ type: "assertNot", selector: step.selector }));
      const all = findAll(await control.describe(), step.selector);
      if (all.some(isVisible)) return { ok: true, observed: "visible" };
      return { ok: false, observed: all.length ? `${describeSelector(step.selector)} is in the tree but off screen` : `no element matches ${describeSelector(step.selector)}` };
    }
    case "type":
      return verdict(await control.action({ type: "type", text: step.text }));
    case "waitFor":
      return verdict(
        await control.action({ type: step.absent ? "waitForNot" : "waitFor", selector: step.selector, timeoutMs: step.timeoutMs ?? DEFAULT_WAIT_MS }),
      );
    case "sleep":
      await pace.sleep(step.ms);
      return { ok: true, observed: "ok" };
  }
}

/**
 * Run steps in order and stop at the first failure, leaving `failure.png` and `failure.ax.json`
 * behind: an agent reading result.json needs the screen it failed on, not the next step's error.
 */
export async function runSteps(
  steps: Step[],
  control: VerifyControl,
  out: Artifacts,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = realPace.sleep,
): Promise<{ passed: boolean; steps: StepResult[] }> {
  const pace: Pace = { now, sleep };
  const results: StepResult[] = [];
  for (const step of steps) {
    const t0 = now();
    let r: Verdict;
    try {
      r = await runOne(step, control, out, pace);
    } catch (e) {
      r = { ok: false, observed: e instanceof Error ? e.message : String(e) };
    }
    results.push({ action: stepLabel(step), ok: r.ok, observed: r.observed, ms: now() - t0 });
    if (!r.ok) {
      await captureFailure(control, out);
      return { passed: false, steps: results };
    }
  }
  return { passed: true, steps: results };
}

export async function captureFailure(control: VerifyControl, out: Artifacts): Promise<void> {
  await control.screenshot().then((png) => out.write("failure.png", png), () => {});
  await control.describe().then((tree) => out.write("failure.ax.json", JSON.stringify(tree, null, 2)), () => {});
}

const LOADING = /\b(bundling|loading from|downloading|connecting to)\b/i;

/**
 * Wait until the screen stops changing: the same labels on three polls in a row, none of them a
 * dev-client loading banner. An empty tree is not settled — the app has not drawn yet.
 */
export async function waitForSettle(
  control: VerifyControl,
  opts: { timeoutMs: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<{ settled: boolean; labels: number }> {
  const sleep = opts.sleep ?? realPace.sleep;
  const now = opts.now ?? Date.now;
  const deadline = now() + opts.timeoutMs;
  let last = "";
  let same = 0;
  let count = 0;
  while (now() < deadline) {
    const labels = treeLabels(await control.describe().catch(() => null));
    const sig = labels.join("\n");
    count = labels.length;
    if (labels.length && !labels.some((l) => LOADING.test(l)) && sig === last) {
      if (++same >= 2) return { settled: true, labels: count };
    } else same = 0;
    last = sig;
    await sleep(opts.intervalMs ?? 1000);
  }
  return { settled: false, labels: count };
}
