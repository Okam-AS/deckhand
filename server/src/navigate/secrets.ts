import { readFileSync } from "node:fs";
import { paths } from "../paths.ts";
import { JevClient, type JevAccess, type JevProvider } from "./jev.ts";

// Named secrets.ts on purpose: invariants.test.ts "keeps secrets out of the MCP surface" then
// refuses any import of it from mcp/, which only ever sees a JevProvider.

export type KeyLookup = { state: "ok"; key: string } | { state: "missing" } | { state: "error"; message: string };

const ENABLE =
  "The operator enables it on the deckhand machine: `deckhand secret set typesafe` (paste the TypeSafe API key on stdin), " +
  "or set TYPESAFE_API_KEY in the server's environment. No restart is needed for the file. Until then, drive with `describe` + `ui`.";

export function lookupTypesafeKey(env: NodeJS.ProcessEnv = process.env, file = paths.typesafeKey()): KeyLookup {
  const fromEnv = env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) return { state: "ok", key: fromEnv };
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    return { state: "error", message: `${file} exists but could not be read (${(e as NodeJS.ErrnoException).code ?? "error"})` };
  }
  const key = text.trim();
  return key ? { state: "ok", key } : { state: "error", message: `${file} is empty` };
}

export function typesafeProvider(lookup: () => KeyLookup = lookupTypesafeKey, fetchImpl?: typeof fetch): JevProvider {
  return (): JevAccess => {
    const found = lookup();
    if (found.state === "ok") return { ok: true, client: new JevClient({ apiKey: found.key, fetchImpl }) };
    if (found.state === "missing") {
      return { ok: false, code: "navigate_disabled", message: "navigate is off: no TypeSafe API key is configured on the deckhand machine", hint: ENABLE };
    }
    return { ok: false, code: "navigate_key_unreadable", message: `navigate is off: ${found.message}`, hint: ENABLE };
  };
}
