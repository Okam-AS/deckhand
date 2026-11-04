import { readFileSync } from "node:fs";
import { paths } from "../paths.ts";
import type { TokenSource } from "./client.ts";

// Named secrets.ts on purpose: invariants.test.ts "keeps secrets out of the MCP surface" then
// refuses any import of it from mcp/.

export type ExpoTokenLookup = { state: "ok"; token: string } | { state: "missing" } | { state: "error"; message: string };

export const SET_EXPO_TOKEN =
  "The operator sets it on the deckhand machine: `deckhand secret set expo` (a read-only Expo robot token on stdin). No restart is needed.";

/** The file only: an EXPO_TOKEN in the server's environment is often a person's own, which this must never pick up. */
export function lookupExpoToken(file = paths.expoToken()): ExpoTokenLookup {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    return { state: "error", message: `${file} exists but could not be read (${(e as NodeJS.ErrnoException).code ?? "error"})` };
  }
  const token = text.trim();
  return token ? { state: "ok", token } : { state: "missing" };
}

/** Read on every request, so `deckhand secret set|rm expo` takes effect on the next one. */
export function expoTokenSource(lookup: () => ExpoTokenLookup = lookupExpoToken): TokenSource {
  return () => {
    const found = lookup();
    if (found.state === "ok") return { ok: true, token: found.token };
    if (found.state === "missing") return { ok: false, message: "no Expo token is configured on the deckhand machine, so it cannot read EAS builds", hint: SET_EXPO_TOKEN };
    return { ok: false, message: found.message, hint: SET_EXPO_TOKEN };
  };
}
