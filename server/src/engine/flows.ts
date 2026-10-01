import { readFileSync } from "node:fs";
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
export function readFlow<T>(sourceDir: string | undefined, name: string, actionSchema: ZodType<T>): FlowLookup<T> {
  const file = sourceDir ? join(sourceDir, FLOWS_FILENAME) : FLOWS_FILENAME;
  let text: string;
  try {
    if (!sourceDir) throw Object.assign(new Error("no source dir"), { code: "ENOENT" });
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
    if (!doc || typeof doc.flows !== "object" || doc.flows === null || Array.isArray(doc.flows)) throw new Error("expected a top-level `flows:` map of name → list of actions");
    flows = doc.flows as Record<string, unknown>;
  } catch (e) {
    return { ok: false, code: "invalid_flows_file", message: `${file}: ${(e as Error).message}` };
  }
  const available = Object.keys(flows);
  if (!Object.hasOwn(flows, name)) {
    return { ok: false, code: "unknown_flow", message: `no flow "${name}" in ${FLOWS_FILENAME}`, available };
  }
  const steps = flows[name];
  if (!Array.isArray(steps) || steps.length === 0) {
    return { ok: false, code: "invalid_flows_file", message: `flow "${name}" must be a non-empty list of actions` };
  }
  const actions: T[] = [];
  for (const [i, step] of steps.entries()) {
    const r = actionSchema.safeParse(step);
    if (!r.success) return { ok: false, code: "invalid_flows_file", message: `flow "${name}" step ${i + 1}: ${r.error.issues.map((x) => `${x.path.join(".") || "action"} ${x.message}`).join("; ")}` };
    actions.push(r.data);
  }
  return { ok: true, actions };
}
