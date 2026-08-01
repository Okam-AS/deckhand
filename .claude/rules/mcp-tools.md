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

A tool's `description` is a prompt. Say what the tool does, when to reach for it, and what the caller must do next — an empty-state `nextStep` is how a fresh agent gets a user from zero apps to a preview.
