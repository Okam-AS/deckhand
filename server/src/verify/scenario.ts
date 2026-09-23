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

export type ScrollDirection = "up" | "down" | "left" | "right";

export type Step =
  | { action: "openUrl"; url: string }
  | { action: "tap"; selector: Selector }
  | { action: "type"; text: string }
  | { action: "scroll"; direction: ScrollDirection }
  | { action: "scrollUntilVisible"; selector: Selector }
  | { action: "waitFor"; selector: Selector; absent: boolean; timeoutMs?: number }
  | { action: "assert"; selector: Selector; absent: boolean }
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

export class ScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioError";
  }
}

const selectorObject = z
  .object({
    id: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    value: z.string().min(1).optional(),
    index: z.number().int().nonnegative().optional(),
    regex: z.boolean().optional(),
  })
  .strict()
  .refine((s) => s.id || s.text || s.label || s.value, { message: "a selector needs id, text, label or value" });

const selectorInput = z.union([z.string().min(1), selectorObject]);

/** `#id`, `text=…`, `label=…`, `value=…`, or bare text. */
export function parseSelector(input: z.infer<typeof selectorInput>): Selector {
  if (typeof input !== "string") return input;
  if (input.startsWith("#") && input.length > 1) return { id: input.slice(1) };
  const m = /^(text|label|value|id)=(.+)$/s.exec(input);
  if (m) return { [m[1]!]: m[2]! } as Selector;
  return { text: input };
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const waitObject = z
  .object({ selector: selectorInput.optional(), absent: selectorInput.optional(), timeoutMs: z.number().int().positive().optional() })
  .strict()
  .refine((w) => Boolean(w.selector) !== Boolean(w.absent), { message: "waitFor takes exactly one of selector or absent" });

const assertObject = z
  .object({ present: selectorInput.optional(), absent: selectorInput.optional() })
  .strict()
  .refine((a) => Boolean(a.present) !== Boolean(a.absent), { message: "assert takes exactly one of present or absent" });

const stepSchemas = {
  openUrl: z.string().min(1),
  tap: selectorInput,
  type: z.string(),
  scroll: z.enum(["up", "down", "left", "right"]),
  scrollUntilVisible: selectorInput,
  waitFor: z.union([selectorInput, waitObject]),
  assert: z.union([selectorInput, assertObject]),
  assertNot: selectorInput,
  sleep: z.number().int().nonnegative().max(60_000),
  screenshot: z.string().regex(NAME_RE, "screenshot names are file names: letters, digits, . _ -"),
} as const;

type StepKey = keyof typeof stepSchemas;

function isObjectWith(v: unknown, keys: string[]): boolean {
  return typeof v === "object" && v !== null && keys.some((k) => k in v);
}

function parseStep(raw: unknown, i: number): Step {
  const where = `step ${i + 1}`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ScenarioError(`${where}: expected an object like { tap: "#id" }`);
  const keys = Object.keys(raw);
  if (keys.length !== 1) throw new ScenarioError(`${where}: one action per step, got ${keys.length ? keys.join(", ") : "none"}`);
  const key = keys[0]!;
  if (!(key in stepSchemas)) {
    throw new ScenarioError(`${where}: unknown action "${key}" (known: ${Object.keys(stepSchemas).join(", ")})`);
  }
  const parsed = stepSchemas[key as StepKey].safeParse((raw as Record<string, unknown>)[key]);
  if (!parsed.success) throw new ScenarioError(`${where} (${key}): ${parsed.error.issues.map((x) => x.message).join("; ")}`);
  const v = parsed.data as never;
  switch (key as StepKey) {
    case "openUrl":
      return { action: "openUrl", url: v };
    case "tap":
      return { action: "tap", selector: parseSelector(v) };
    case "type":
      return { action: "type", text: v };
    case "scroll":
      return { action: "scroll", direction: v };
    case "scrollUntilVisible":
      return { action: "scrollUntilVisible", selector: parseSelector(v) };
    case "waitFor": {
      if (isObjectWith(v, ["selector", "absent"])) {
        const o = v as z.infer<typeof waitObject>;
        return { action: "waitFor", selector: parseSelector((o.selector ?? o.absent)!), absent: Boolean(o.absent), timeoutMs: o.timeoutMs };
      }
      return { action: "waitFor", selector: parseSelector(v), absent: false };
    }
    case "assert": {
      if (isObjectWith(v, ["present", "absent"])) {
        const o = v as z.infer<typeof assertObject>;
        return { action: "assert", selector: parseSelector((o.present ?? o.absent)!), absent: Boolean(o.absent) };
      }
      return { action: "assert", selector: parseSelector(v), absent: false };
    }
    case "assertNot":
      return { action: "assert", selector: parseSelector(v), absent: true };
    case "sleep":
      return { action: "sleep", ms: v };
    case "screenshot":
      return { action: "screenshot", name: v };
  }
}

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
    ready: selectorInput.optional(),
    steps: z.array(z.unknown()).min(1),
  })
  .strict();

/** Parse a scenario from JSON or YAML text (YAML is a superset, so one parser reads both). */
export function parseScenario(text: string, fallbackName = "scenario"): Scenario {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new ScenarioError(`not valid JSON or YAML: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = scenarioSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ScenarioError(parsed.error.issues.map((x) => `${x.path.join(".") || "scenario"}: ${x.message}`).join("; "));
  }
  const s = parsed.data;
  const steps = s.steps.map(parseStep);
  const shots = new Set<string>();
  for (const st of steps) {
    if (st.action !== "screenshot") continue;
    if (shots.has(st.name)) throw new ScenarioError(`screenshot "${st.name}" is taken twice; names become file names`);
    shots.add(st.name);
  }
  return {
    name: s.name ?? fallbackName,
    device: { ...DEFAULT_DEVICE, ...s.device },
    env: Object.fromEntries(Object.entries(s.env ?? {}).map(([k, v]) => [k, String(v)])),
    ready: s.ready ? parseSelector(s.ready) : undefined,
    steps,
  };
}
