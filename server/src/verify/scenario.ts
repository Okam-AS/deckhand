import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Selector } from "../testing/control.ts";

export type Orientation = "portrait" | "landscape";

export interface DeviceShape {
  model: string;
  runtime: string;
  orientation: Orientation;
}

export const DEFAULT_DEVICE: DeviceShape = {
  model: "iPad (9th generation)",
  runtime: "iOS 26.5",
  orientation: "landscape",
};

/** `visible`: on screen now (the default). `present`: anywhere in the tree, scrolled away or not. `absent`: nowhere in the tree. */
export type AssertMode = "visible" | "present" | "absent";

export type ScrollDirection = "up" | "down" | "left" | "right";

export type Step =
  | { action: "openUrl"; url: string }
  | { action: "tap"; selector: Selector }
  | { action: "type"; text: string }
  | { action: "scroll"; direction: ScrollDirection }
  | { action: "scrollUntilVisible"; selector: Selector }
  | { action: "waitFor"; selector: Selector; absent: boolean; timeoutMs?: number }
  | { action: "assert"; selector: Selector; mode: AssertMode }
  | { action: "sleep"; ms: number }
  | { action: "screenshot"; name: string };

export interface Scenario {
  name: string;
  device: DeviceShape;
  env: Record<string, string>;
  /** Wait for this before the first step instead of waiting for the screen to settle. */
  ready?: Selector;
  steps: Step[];
}

/** One problem in a scenario. `step` is 1-based, null for a top-level field; `field` is the path inside it. */
export interface Diagnostic {
  step: number | null;
  field: string;
  message: string;
  allowed?: string;
}

export class ScenarioError extends Error {
  constructor(readonly diagnostics: Diagnostic[]) {
    super(diagnostics.map(formatDiagnostic).join("; "));
    this.name = "ScenarioError";
  }
}

export function formatDiagnostic(d: Diagnostic): string {
  const where = d.step == null ? d.field : `step ${d.step} (${d.field})`;
  return `${where}: ${d.message}${d.allowed ? ` — allowed: ${d.allowed}` : ""}`;
}

export const SELECTOR_FORMS = '"#id", "id=…", "text=…", "label=…", "value=…", or { id | text | label | value: "…", index?: n, regex?: true }';
const WAIT_FORMS = `a selector, or { selector: <selector> | absent: <selector>, timeoutMs?: n }`;
const ASSERT_FORMS = `a selector (on screen), or exactly one of { visible | present | absent: <selector> }`;

const SELECTOR_KEYS = ["id", "text", "label", "value"] as const;
const SELECTOR_OBJECT_KEYS = new Set<string>([...SELECTOR_KEYS, "index", "regex"]);
const STRING_SELECTOR = /^(id|text|label|value)=(.+)$/s;

type Report = (field: string, message: string, allowed?: string) => void;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function show(v: unknown): string {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

/** Strict: a string that is not `#id` or `<id|text|label|value>=…` is refused, never read as text. */
function readSelector(v: unknown, field: string, report: Report): Selector | undefined {
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return report(field, "empty selector", SELECTOR_FORMS), undefined;
    if (t.startsWith("{") || t.startsWith("[")) {
      return report(field, `${show(v)} is JSON/YAML written inside a string; write the object itself, not a quoted string`, SELECTOR_FORMS), undefined;
    }
    if (v.startsWith("#")) {
      if (v.length === 1 || /\s/.test(v)) return report(field, `${show(v)} is not an id: "#" takes an id with no spaces`, SELECTOR_FORMS), undefined;
      return { id: v.slice(1) };
    }
    const m = STRING_SELECTOR.exec(v);
    if (m) return { [m[1]!]: m[2]! } as Selector;
    const prefix = /^([A-Za-z_][\w-]*)=/.exec(v);
    if (prefix && (SELECTOR_KEYS as readonly string[]).includes(prefix[1]!)) return report(field, `"${prefix[1]}=" needs a value after it`, SELECTOR_FORMS), undefined;
    if (prefix) return report(field, `unknown selector prefix "${prefix[1]}="`, SELECTOR_FORMS), undefined;
    return report(field, `${show(v)} has no selector prefix; bare text is refused — did you mean "text=${v}"?`, SELECTOR_FORMS), undefined;
  }
  if (isPlainObject(v)) {
    const unknown = Object.keys(v).filter((k) => !SELECTOR_OBJECT_KEYS.has(k));
    if (unknown.length) return report(field, `unknown selector key(s) ${unknown.join(", ")}`, SELECTOR_FORMS), undefined;
    let ok = true;
    for (const k of SELECTOR_KEYS) {
      if (k in v && (typeof v[k] !== "string" || !(v[k] as string).trim())) {
        report(`${field}.${k}`, "must be a non-empty string");
        ok = false;
      }
    }
    if ("index" in v && !(Number.isInteger(v.index) && (v.index as number) >= 0)) {
      report(`${field}.index`, "must be a whole number, 0 or more");
      ok = false;
    }
    if ("regex" in v && typeof v.regex !== "boolean") {
      report(`${field}.regex`, "must be true or false");
      ok = false;
    }
    if (!SELECTOR_KEYS.some((k) => k in v)) {
      report(field, "a selector object needs id, text, label or value", SELECTOR_FORMS);
      ok = false;
    }
    return ok ? (v as Selector) : undefined;
  }
  return report(field, `expected a selector, got ${show(v)}`, SELECTOR_FORMS), undefined;
}

/** An object whose keys are all selector keys is a selector; one whose keys are all `options` is that form. */
function objectForm(v: unknown, options: string[]): "selector" | "options" | "neither" {
  if (!isPlainObject(v)) return "selector";
  const keys = Object.keys(v);
  if (keys.length && keys.every((k) => options.includes(k))) return "options";
  if (keys.length && keys.every((k) => SELECTOR_OBJECT_KEYS.has(k))) return "selector";
  return keys.some((k) => options.includes(k)) ? "options" : "neither";
}

function extraKeys(v: Record<string, unknown>, allowed: string[], field: string, report: Report, forms: string): boolean {
  const extra = Object.keys(v).filter((k) => !allowed.includes(k));
  if (extra.length) report(field, `unknown key(s) ${extra.join(", ")}`, forms);
  return extra.length === 0;
}

export const STEP_ACTIONS = ["openUrl", "tap", "type", "scroll", "scrollUntilVisible", "waitFor", "assert", "assertNot", "sleep", "screenshot"] as const;
type StepKey = (typeof STEP_ACTIONS)[number];

function parseStep(raw: unknown, i: number, out: Diagnostic[]): Step | undefined {
  const n = i + 1;
  const report: Report = (field, message, allowed) => void out.push({ step: n, field, message, ...(allowed ? { allowed } : {}) });
  if (!isPlainObject(raw)) return report("step", `expected an object like { tap: "#id" }, got ${show(raw)}`), undefined;
  const keys = Object.keys(raw);
  if (keys.length !== 1) {
    return report("step", `one action per step, got ${keys.length ? keys.join(", ") : "none"}`, STEP_ACTIONS.join(", ")), undefined;
  }
  const key = keys[0]!;
  if (!(STEP_ACTIONS as readonly string[]).includes(key)) return report(key, `unknown action "${key}"`, STEP_ACTIONS.join(", ")), undefined;
  const v = raw[key];
  switch (key as StepKey) {
    case "openUrl":
      if (typeof v !== "string" || !v.trim()) return report(key, "must be a non-empty URL string"), undefined;
      return { action: "openUrl", url: v };
    case "type":
      if (typeof v !== "string") return report(key, `must be a string, got ${show(v)}`), undefined;
      return { action: "type", text: v };
    case "scroll":
      if (v !== "up" && v !== "down" && v !== "left" && v !== "right") return report(key, `unknown direction ${show(v)}`, "up, down, left, right"), undefined;
      return { action: "scroll", direction: v };
    case "sleep":
      if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 60_000) return report(key, `must be whole milliseconds from 0 to 60000, got ${show(v)}`), undefined;
      return { action: "sleep", ms: v as number };
    case "screenshot":
      if (typeof v !== "string" || !NAME_RE.test(v)) return report(key, `screenshot names are file names: letters, digits, . _ - (got ${show(v)})`), undefined;
      return { action: "screenshot", name: v };
    case "tap":
    case "scrollUntilVisible": {
      const selector = readSelector(v, key, report);
      return selector && { action: key as "tap" | "scrollUntilVisible", selector };
    }
    case "assertNot": {
      const selector = readSelector(v, key, report);
      return selector && { action: "assert", selector, mode: "absent" };
    }
    case "waitFor": {
      const form = objectForm(v, ["selector", "absent", "timeoutMs"]);
      if (form === "selector") {
        const selector = readSelector(v, key, report);
        return selector && { action: "waitFor", selector, absent: false };
      }
      const o = v as Record<string, unknown>;
      if (!extraKeys(o, ["selector", "absent", "timeoutMs"], key, report, WAIT_FORMS)) return undefined;
      if (("selector" in o) === ("absent" in o)) return report(key, "takes exactly one of selector or absent", WAIT_FORMS), undefined;
      if ("timeoutMs" in o && !(Number.isInteger(o.timeoutMs) && (o.timeoutMs as number) > 0)) {
        return report(`${key}.timeoutMs`, `must be a positive whole number of milliseconds, got ${show(o.timeoutMs)}`), undefined;
      }
      const which = "selector" in o ? "selector" : "absent";
      const selector = readSelector(o[which], `${key}.${which}`, report);
      return selector && { action: "waitFor", selector, absent: which === "absent", timeoutMs: o.timeoutMs as number | undefined };
    }
    case "assert": {
      const modes = ["visible", "present", "absent"] as const;
      const form = objectForm(v, [...modes]);
      if (form === "selector") {
        const selector = readSelector(v, key, report);
        return selector && { action: "assert", selector, mode: "visible" };
      }
      const o = v as Record<string, unknown>;
      if (!extraKeys(o, [...modes], key, report, ASSERT_FORMS)) return undefined;
      const given = modes.filter((m) => m in o);
      if (given.length !== 1) return report(key, `takes exactly one of visible, present or absent, got ${given.join(", ") || "none"}`, ASSERT_FORMS), undefined;
      const mode = given[0]!;
      const selector = readSelector(o[mode], `${key}.${mode}`, report);
      return selector && { action: "assert", selector, mode };
    }
  }
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const scenarioSchema = z
  .object({
    name: z.string().min(1).optional(),
    device: z
      .object({
        model: z.string().min(1).optional(),
        runtime: z.string().min(1).optional(),
        orientation: z.enum(["portrait", "landscape"]).optional(),
      })
      .strict()
      .optional(),
    env: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    ready: z.unknown().optional(),
    steps: z.array(z.unknown()).min(1),
  })
  .strict();

/** Parse a scenario from JSON or YAML text (YAML is a superset, so one parser reads both). Throws every problem at once. */
export function parseScenario(text: string, fallbackName = "scenario"): Scenario {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new ScenarioError([{ step: null, field: "scenario", message: `not valid JSON or YAML: ${e instanceof Error ? e.message : String(e)}` }]);
  }
  const out: Diagnostic[] = [];
  const parsed = scenarioSchema.safeParse(raw);
  if (!parsed.success) {
    for (const x of parsed.error.issues) out.push({ step: null, field: x.path.join(".") || "scenario", message: x.message });
  }
  const top = isPlainObject(raw) ? raw : {};
  const ready = top.ready === undefined ? undefined : readSelector(top.ready, "ready", (field, message, allowed) => void out.push({ step: null, field, message, ...(allowed ? { allowed } : {}) }));
  const steps = (Array.isArray(top.steps) ? top.steps : []).map((st, i) => parseStep(st, i, out));
  const shots = new Set<string>();
  steps.forEach((st, i) => {
    if (st?.action !== "screenshot") return;
    if (shots.has(st.name)) out.push({ step: i + 1, field: "screenshot", message: `screenshot "${st.name}" is taken twice; names become file names` });
    shots.add(st.name);
  });
  if (out.length || !parsed.success) throw new ScenarioError(out);
  const s = parsed.data;
  return {
    name: s.name ?? fallbackName,
    device: { ...DEFAULT_DEVICE, ...s.device },
    env: Object.fromEntries(Object.entries(s.env ?? {}).map(([k, v]) => [k, String(v)])),
    ready,
    steps: steps as Step[],
  };
}

/** `deckhand verify --lint`: every problem in one pass, nothing built. */
export function lintScenario(text: string): { ok: boolean; steps: number; diagnostics: Diagnostic[] } {
  try {
    return { ok: true, steps: parseScenario(text).steps.length, diagnostics: [] };
  } catch (e) {
    if (e instanceof ScenarioError) return { ok: false, steps: 0, diagnostics: e.diagnostics };
    throw e;
  }
}
