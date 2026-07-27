import { readFileSync } from "node:fs";
import { paths } from "./paths.ts";

/**
 * Parse a KEY=VALUE `.env` file (no interpolation, `#` comments, optional
 * surrounding quotes). Deliberately tiny — no dependency. Used only for
 * app secrets that are set on the mini via the CLI, never through MCP.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}

/** Load an app's secret env (mode-0600 file on the mini). Missing file → {}. */
export function loadSecretsEnv(appId: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(paths.secretsEnv(appId), "utf8"));
  } catch {
    return {};
  }
}
