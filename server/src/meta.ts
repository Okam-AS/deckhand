/**
 * Static identity of this server. Kept trivial and dependency-free so it can be
 * imported anywhere (MCP server info, the /health endpoint) without pulling in
 * config or side effects. The version a human cares about is the COMMIT, which
 * `version.ts` reports; this constant is only the protocol-level identity.
 */
export const DECKHAND_NAME = "deckhand" as const;
export const DECKHAND_VERSION = "0.0.0" as const;

export interface ServerInfo {
  name: string;
  version: string;
}

export function serverInfo(): ServerInfo {
  return { name: DECKHAND_NAME, version: DECKHAND_VERSION };
}
