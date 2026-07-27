import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "./paths.ts";

/** One append-only audit record. `args` is a compact summary — never secrets. */
export interface AuditEntry {
  ts: string; // ISO 8601
  actor: string; // token name
  tool: string;
  args?: Record<string, unknown>;
  result: "ok" | "error";
  error?: string;
}

/**
 * Append-only JSONL audit log. Every MCP tool call is recorded. Writes are
 * synchronous appends (one line per entry) so a crash never loses a flushed
 * record and concurrent callers can't interleave partial lines.
 */
export class AuditLog {
  constructor(private readonly file: string = paths.audit()) {}

  record(entry: Omit<AuditEntry, "ts"> & { ts?: string }): void {
    const line: AuditEntry = { ts: entry.ts ?? new Date().toISOString(), ...entry };
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, JSON.stringify(line) + "\n");
    } catch {
      // The audit log is a diagnostic side-channel; never let a logging
      // failure break the tool call it is recording.
    }
  }
}

const SENSITIVE_KEY = /token|password|secret|key|credential|^pin$/i;

/**
 * Redact obviously-sensitive keys from a tool's args before auditing. Recurses
 * into nested objects so e.g. `share.pin` is masked too (a share PIN travels
 * through MCP by the owner's choice, but must never land in the audit log).
 */
export function summarizeArgs(args: unknown): Record<string, unknown> | undefined {
  if (args == null || typeof args !== "object" || Array.isArray(args)) return undefined;
  return redactObject(args as Record<string, unknown>);
}

function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEY.test(k)) {
      out[k] = "[redacted]";
    } else if (v != null && typeof v === "object" && !Array.isArray(v)) {
      out[k] = redactObject(v as Record<string, unknown>);
    } else if (typeof v === "string" && v.length > 200) {
      out[k] = v.slice(0, 200) + "…";
    } else {
      out[k] = v;
    }
  }
  return out;
}
