import type { Selector, UiAction } from "../testing/control.ts";
import { treeLabels } from "../testing/tree.ts";
import { devMenuOpen } from "../testing/devMenu.ts";
import type { Step } from "./scenario.ts";

/** The device surface a scenario drives. `screenshot` returns an upright PNG. */
export interface VerifyControl {
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

export const DEFAULT_WAIT_MS = 15_000;

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
    case "assert":
      return `${step.action}${step.absent ? " absent" : ""} ${describeSelector(step.selector)}`;
    default:
      return `${step.action} ${describeSelector(step.selector)}`;
  }
}

/** SimDeck answers some misses with 2xx and `ok: false` rather than an error status. */
function verdict(res: unknown): { ok: boolean; observed: string } {
  if (res && typeof res === "object") {
    const r = res as Record<string, unknown>;
    const msg = [r.message, r.error, r.reason].find((x) => typeof x === "string" && x) as string | undefined;
    if (r.ok === false || r.passed === false || r.success === false) return { ok: false, observed: msg ?? "SimDeck reported ok:false" };
    const count = Array.isArray(r.matches) ? `${r.matches.length} match(es)` : undefined;
    return { ok: true, observed: msg ?? count ?? "ok" };
  }
  return { ok: true, observed: "ok" };
}

function toUiAction(step: Exclude<Step, { action: "screenshot" }>): UiAction {
  switch (step.action) {
    case "openUrl":
      return { type: "openUrl", url: step.url };
    case "tap":
      return { type: "tapElement", selector: step.selector, waitTimeoutMs: DEFAULT_WAIT_MS };
    case "type":
      return { type: "type", text: step.text };
    case "scroll":
      return { type: "gesture", preset: `scroll-${step.direction}` };
    case "scrollUntilVisible":
      return { type: "scrollUntilVisible", selector: step.selector };
    case "waitFor":
      return { type: step.absent ? "waitForNot" : "waitFor", selector: step.selector, timeoutMs: step.timeoutMs ?? DEFAULT_WAIT_MS };
    case "assert":
      return { type: step.absent ? "assertNot" : "assert", selector: step.selector };
    case "sleep":
      return { type: "sleep", ms: step.ms };
  }
}

async function runOne(step: Step, control: VerifyControl, out: Artifacts): Promise<{ ok: boolean; observed: string }> {
  if (step.action === "screenshot") {
    const png = await control.screenshot();
    out.write(`${step.name}.png`, png);
    const tree = await control.describe();
    out.write(`${step.name}.ax.json`, JSON.stringify(tree, null, 2));
    const note = devMenuOpen(tree) ? "; a dev menu is on screen (deckhand packaging, not the app)" : "";
    return { ok: true, observed: `${step.name}.png, ${treeLabels(tree).length} labels${note}` };
  }
  return verdict(await control.action(toUiAction(step)));
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
): Promise<{ passed: boolean; steps: StepResult[] }> {
  const results: StepResult[] = [];
  for (const step of steps) {
    const t0 = now();
    let r: { ok: boolean; observed: string };
    try {
      r = await runOne(step, control, out);
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
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
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
