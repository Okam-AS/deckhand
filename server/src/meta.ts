/**
 * Static identity of this server. Kept trivial and dependency-free so it can be
 * imported anywhere (MCP server info, health endpoint, CLI --version) without
 * pulling in config or side effects.
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
