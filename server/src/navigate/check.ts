import type { JevChooser, JevQuestion, NoulAnswer } from "./jev.ts";
import { screenshotAsset } from "./loop.ts";

/**
 * `check`: does the screen look the way it should? One TypeSafe Jev request carrying the screenshot
 * (and, for parity, a reference screenshot), with one yes/no question per statement the caller makes,
 * plus a built-in "looks broken" question. Judging stays with the caller: this returns
 * probabilities and a three-way verdict, never a finding.
 */

/** A statement at or above this is reported as holding, at or below FAIL_AT as not holding; between is `unsure`. */
export const PASS_AT = 0.8;
export const FAIL_AT = 0.2;
export const MAX_CHECKS = 12;
/**
 * The built-in health questions fail at or above HEALTH_FAIL_AT and pass below HEALTH_PASS_BELOW.
 * Wider than a statement's band: one broad "looks broken?" read a normal list as broken (0.9 —
 * a card scrolling under the floating tab bar), so health is four narrow questions, and on six real
 * screens (2026-11-03) normal ones stayed ≤0.38 while the Expo dev menu read 0.99.
 */
export const HEALTH_FAIL_AT = 0.6;
export const HEALTH_PASS_BELOW = 0.5;
export const HEALTH: Record<string, string> = {
  health_error_screen: "Does `screenshot` show an error, crash or failure message instead of the app's normal content?",
  health_dev_overlay:
    "Does `screenshot` show a developer tool on top of the app: a dev menu, a red or yellow error box (React Native LogBox/redbox), a debugger or inspector overlay?",
  health_blank: "Is `screenshot` blank, a lone spinner, or a half-loaded page with large empty placeholders where content should be?",
  health_overlap:
    "In `screenshot`, do two pieces of text or two controls render on top of each other so that one is hard to read? Content scrolling underneath a floating tab bar, toolbar or the screen edge is normal and does not count.",
};

export type Verdict = "pass" | "fail" | "unsure";

export interface CheckRequest {
  /** name → a statement that should be true of the screen, e.g. {"price": "The Premium wash costs 325,-"}. */
  expect: Record<string, string>;
  /** Statements that should be FALSE of the screen; a high probability fails them. */
  expectNot?: Record<string, string>;
  /** The accessibility tree's minimised lines, when readable: helps with small text. */
  screenLines?: string[];
  locale?: string | null;
  /** Skip the built-in health questions (error screen, dev overlay, blank, overlap). */
  skipHealth?: boolean;
}

export interface CheckDeps {
  shot: Buffer;
  /** Another screenshot the screen should match (the reference app or device), when comparing. */
  reference?: Buffer | null;
  /** Which of the two frames was still changing when it was taken: the answer about it is one frame of a moving screen. */
  unsettled?: Array<"screenshot" | "reference">;
  jev: JevChooser;
  /** Called with the size of the request BEFORE it is sent; throwing refuses the send. */
  onEgress?: (e: { questions: number; bytes: number; images: number }) => void;
  now?: () => number;
}

export interface CheckItem {
  name: string;
  statement: string;
  /** Jev's probability that the statement is true of the screen. */
  p: number;
  /** Whether the caller expected it true (`expect`) or false (`expectNot`). */
  expected: boolean;
  verdict: Verdict;
  /** A built-in health question rather than one of the caller's statements. */
  health?: true;
}

export interface CheckResult {
  verdict: Verdict;
  items: CheckItem[];
  /** Present when a frame never settled; the overall verdict is then `unsure` whatever the items say. */
  unsettled?: Array<"screenshot" | "reference">;
  model: string;
  ms: number;
  inputTokens: number | null;
}

const MATCHES =
  "Does `screenshot` show the same screen as `reference`, with the same content in the same layout? Ignore the status bar (time, battery, signal), the device frame and small rendering differences such as fonts and anti-aliasing.";

function verdictFor(p: number, expected: boolean, health: boolean): Verdict {
  if (health) return p >= HEALTH_FAIL_AT ? "fail" : p < HEALTH_PASS_BELOW ? "pass" : "unsure";
  const q = expected ? p : 1 - p;
  return q >= PASS_AT ? "pass" : q <= FAIL_AT ? "fail" : "unsure";
}

export async function check(req: CheckRequest, deps: CheckDeps): Promise<CheckResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const shot = screenshotAsset(deps.shot);
  if (!shot) throw new Error("the screenshot could not be read or is under TypeSafe's 280 px minimum");
  const ref = deps.reference ? screenshotAsset(deps.reference) : null;
  if (deps.reference && !ref) throw new Error("the reference screenshot could not be read or is under TypeSafe's 280 px minimum");

  const state: Record<string, unknown> = {
    screenshot: shot.ref,
    ...(ref ? { reference: ref.ref } : {}),
    ...(req.locale ? { ui_language: req.locale } : {}),
    ...(req.screenLines?.length ? { accessibility_tree: req.screenLines } : {}),
  };
  const planned: Array<{ id: string; name: string; statement: string; expected: boolean; health?: true }> = [];
  let i = 0;
  for (const [name, statement] of Object.entries(req.expect)) planned.push({ id: `c${i++}`, name, statement, expected: true });
  for (const [name, statement] of Object.entries(req.expectNot ?? {})) planned.push({ id: `c${i++}`, name, statement, expected: false });
  if (ref) planned.push({ id: "matches_reference", name: "matches_reference", statement: MATCHES, expected: true });
  if (!req.skipHealth) for (const [id, statement] of Object.entries(HEALTH)) planned.push({ id, name: id, statement, expected: false, health: true });

  const questions: Record<string, JevQuestion> = Object.fromEntries(
    planned.map((c) => [
      c.id,
      {
        type: "noul",
        instructions:
          c.id === "matches_reference" || c.health
            ? c.statement
            : {
                question: "Is this statement true of `screenshot`?",
                statement: c.statement,
                rules: [
                  "Judge what `screenshot` shows; `accessibility_tree`, when present, lists the same screen's controls and can help read small text.",
                  "Labels are in the app's UI language (`ui_language`), which can differ from the statement's language: match by meaning.",
                ],
              },
      } satisfies JevQuestion,
    ]),
  );

  const assets = { ...shot.assets, ...(ref?.assets ?? {}) };
  deps.onEgress?.({ questions: planned.length, bytes: Buffer.byteLength(JSON.stringify({ state, questions, assets })), images: Object.keys(assets).length });
  const res = await deps.jev.ask(state, questions, assets);

  const items: CheckItem[] = planned.map((c) => {
    const a = res.answers[c.id] as NoulAnswer | undefined;
    if (!a || a.type !== "noul") throw new Error(`TypeSafe API answered without the "${c.name}" check`);
    const p = Math.round(a.noul * 1000) / 1000;
    return { name: c.name, statement: c.statement, p, expected: c.expected, verdict: verdictFor(p, c.expected, c.health === true), ...(c.health ? { health: true as const } : {}) };
  });
  const unsettled = deps.unsettled?.length ? deps.unsettled : undefined;
  const verdict: Verdict = unsettled
    ? "unsure"
    : items.some((x) => x.verdict === "fail")
      ? "fail"
      : items.some((x) => x.verdict === "unsure")
        ? "unsure"
        : "pass";
  return { verdict, items, ...(unsettled ? { unsettled } : {}), model: res.model, ms: now() - started, inputTokens: res.usage?.input_tokens ?? null };
}
