import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ZodType } from "zod";

export const FLOWS_FILENAME = "deckhand.flows.yaml";

export type FlowLookup<T> =
  | { ok: true; actions: T[] }
  | { ok: false; code: "no_flows_file" | "unknown_flow" | "invalid_flows_file"; message: string; available?: string[] };

/**
 * A named list of `ui` actions from the app's own checkout, replayed with no model in the loop.
 * Unlike the migration ledger, a missing or broken file is an error here: the caller asked for it.
 */
/** A flows file is a short list of actions; anything bigger is not one. */
const MAX_FLOWS_BYTES = 256 * 1024;

export function readFlow<T>(sourceDir: string | undefined, name: string, actionSchema: ZodType<T>, maxSteps: number): FlowLookup<T> {
  const file = sourceDir ? join(sourceDir, FLOWS_FILENAME) : FLOWS_FILENAME;
  let text: string;
  try {
    if (!sourceDir) throw Object.assign(new Error("no source dir"), { code: "ENOENT" });
    // A branch decides what is in its checkout: a link could point the read at any file on this Mac.
    const st = lstatSync(file);
    if (!st.isFile()) return { ok: false, code: "invalid_flows_file", message: `${FLOWS_FILENAME} must be a regular file, not a link` };
    if (st.size > MAX_FLOWS_BYTES) return { ok: false, code: "invalid_flows_file", message: `${FLOWS_FILENAME} is larger than ${MAX_FLOWS_BYTES} bytes` };
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, code: "no_flows_file", message: `this app has no ${FLOWS_FILENAME} in its checkout` };
    }
    return { ok: false, code: "invalid_flows_file", message: `${file} could not be read: ${(e as Error).message}` };
  }
  let flows: Record<string, unknown>;
  try {
    const doc = parseYaml(text) as { flows?: unknown } | null;
    if (!doc || typeof doc.flows !== "object" || doc.flows === null || Array.isArray(doc.flows)) {
      return { ok: false, code: "invalid_flows_file", message: `${FLOWS_FILENAME}: expected a top-level \`flows:\` map of name → list of actions` };
    }
    flows = doc.flows as Record<string, unknown>;
  } catch (e) {
    const at = (e as { linePos?: Array<{ line: number }> }).linePos?.[0]?.line;
    return { ok: false, code: "invalid_flows_file", message: `${FLOWS_FILENAME} is not valid YAML${at ? ` (line ${at})` : ""}` };
  }
  const available = Object.keys(flows);
  if (!Object.hasOwn(flows, name)) {
    return { ok: false, code: "unknown_flow", message: `no flow "${name}" in ${FLOWS_FILENAME}`, available };
  }
  const steps = flows[name];
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > maxSteps) {
    return { ok: false, code: "invalid_flows_file", message: `flow "${name}" must be a list of 1 to ${maxSteps} actions` };
  }
  const actions: T[] = [];
  for (const [i, step] of steps.entries()) {
    const r = actionSchema.safeParse(step);
    // The issue's code, not its message: zod's messages quote the value they received.
    if (!r.success) return { ok: false, code: "invalid_flows_file", message: `flow "${name}" step ${i + 1}: ${r.error.issues.map((x) => `${x.path.join(".") || "action"} is invalid (${x.code})`).join("; ")}` };
    actions.push(r.data);
  }
  return { ok: true, actions };
}
