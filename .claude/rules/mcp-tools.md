---
paths:
  - "server/src/mcp/**/*.ts"
---

The agent-facing surface. Every word here is read by a model as instructions, not documentation.

Hardest rules:

- **Register with a plain string literal.** A computed or template name is invisible to the parse in `test-support/toolNames.ts`, and an invisible tool is exempt from *every* check keyed on its name — audited, documented, ghost-name — none of which fail. → `docs.test.ts` "registers every tool under a name this file can read"
- **Wrap the handler in `audited()`.** PLAN §11.2 is a JSONL audit of every call; a tool added without it is invisible to the trail and nothing else notices. → `invariants.test.ts` "audits every registered MCP tool"
- **Document it in PLAN.** An undocumented tool is invisible to the next agent, who reaches for the one PLAN describes instead. → `docs.test.ts` "documents every registered MCP tool in PLAN"
- **No dead tool name may appear in any description.** A stale name in a description is not drift a human might skim past — it is an instruction the model follows. → `docs.test.ts` "keeps dead tool names out of agent-facing text"
- **Secrets never cross this surface.** `mcp/` may not import `secrets.ts`; the two write channels are the CLI and the one-time setup URL. → `invariants.test.ts` "keeps secrets out of the MCP surface"
- **Never echo a share PIN back.**

Two limits of those checks, so you do not read a green run as more than it is. Both were
found by mutation — the dead name was put back and nothing failed.

- The ghost-tool checks read **PLAN.md, AGENTS.md and `mcp/tools.ts`**. A dead tool name in
  a `.claude/rules/` file, in a skill, or in an agent-facing string somewhere else in
  `server/src` (`engine/preview.ts` writes `nextStep` too) is nobody's job but yours. They
  are not widened because those files legitimately name OAuth error codes and response
  fields that have a tool's shape, and a guardrail that fires on correct writing gets
  switched off rather than obeyed.
- A tool's `description` is checked for dead NAMES and dead PARAMETERS, not for being true.
  Nothing mechanical notices a description that describes last month's behaviour.

A tool's `description` is a prompt. Say what the tool does, when to reach for it, and what the caller must do next — an empty-state `nextStep` is how a fresh agent gets a user from zero apps to a preview.
