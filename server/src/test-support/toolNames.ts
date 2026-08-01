/**
 * How the guardrails read the MCP tool registry out of `mcp/tools.ts`.
 *
 * Three checks are keyed on this one parse — every tool must be documented in PLAN
 * (docs.test.ts), every tool must be wrapped in `audited()` (invariants.test.ts, PLAN §11.2),
 * and no dead name may appear in agent-facing text. A tool the parse cannot see is exempt from
 * all three, and none of them fails: the other nineteen tools keep their sentinels green, so a
 * PARTIAL miss is silent. That is why the pattern lives in one file instead of being written
 * out twice, and why it is wider than the names currently in use.
 *
 * The narrow version — `"([a-z_]+)"` — missed `"ui2"` (a digit killed the whole match) and
 * `'ui'` (single quotes). `TOOL_CALL_ANY_RE` is the backstop for the form no regex can read:
 * a computed or template name. Compare the two counts and a computed name fails loudly rather
 * than quietly opting out.
 */

export const TOOL_CALL_RE = /server\.registerTool\(\s*(["'`])([A-Za-z0-9_]+)\1/g;
export const TOOL_CALL_ANY_RE = /server\.registerTool\(/g;
export const AUDITED_CALL_RE = /audited\(\s*(["'`])([A-Za-z0-9_]+)\1/g;

export function registeredTools(toolsSrc: string): string[] {
  return [...toolsSrc.matchAll(TOOL_CALL_RE)].map((m) => m[2]!);
}

export function registerToolCallCount(toolsSrc: string): number {
  return [...toolsSrc.matchAll(TOOL_CALL_ANY_RE)].length;
}

export function auditedTools(toolsSrc: string): Set<string> {
  return new Set([...toolsSrc.matchAll(AUDITED_CALL_RE)].map((m) => m[2]!));
}
