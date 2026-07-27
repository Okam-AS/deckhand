import { randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync, renameSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { stringify as toYaml } from "yaml";
import { appSchema, tokenSchema, type App, type Role, type TokenEntry } from "../config.ts";
import { parseEnvFile } from "../secrets.ts";
import { paths } from "../paths.ts";

// ---------------------------------------------------------------------------
// Local-only config mutations for the `deckhand` CLI (token/app/env). Pure
// transforms are unit-tested; the writers do atomic, mode-guarded writes.
// ---------------------------------------------------------------------------

export function generateToken(): string {
  return randomBytes(32).toString("hex"); // 64 hex chars
}

/** Add a token entry; throws on duplicate name or invalid shape. */
export function addTokenEntry(
  tokens: TokenEntry[],
  input: { name: string; role: Role; owners?: string[] },
): { tokens: TokenEntry[]; created: TokenEntry } {
  if (tokens.some((t) => t.name === input.name)) throw new Error(`a token named "${input.name}" already exists`);
  const created = tokenSchema.parse({
    name: input.name,
    role: input.role,
    token: generateToken(),
    ...(input.owners && input.owners.length ? { owners: input.owners } : {}),
  });
  return { tokens: [...tokens, created], created };
}

/** Add an app entry (repo, local path, or both); throws on duplicate id or invalid shape. */
export function addAppEntry(apps: App[], input: Partial<App> & { id: string; type: App["type"] }): App[] {
  if (apps.some((a) => a.id === input.id)) throw new Error(`an app named "${input.id}" already exists`);
  const app = appSchema.parse(input);
  return [...apps, app];
}

/** Parse a KEY=VALUE assignment for `env set`. */
export function parseEnvAssignment(assignment: string): { key: string; value: string } {
  const eq = assignment.indexOf("=");
  if (eq <= 0) throw new Error(`expected KEY=VALUE, got "${assignment}"`);
  const key = assignment.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid env key "${key}"`);
  return { key, value: assignment.slice(eq + 1) };
}

// --- atomic writers --------------------------------------------------------

function atomicWrite(file: string, content: string, mode = 0o644): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, file);
}

export function writeTokens(tokens: TokenEntry[]): void {
  atomicWrite(paths.tokens(), toYaml({ tokens }), 0o600);
}

export function writeApps(apps: App[]): void {
  atomicWrite(paths.apps(), toYaml({ apps }), 0o644);
}

export function writeSecretEnv(appId: string, key: string, value: string): void {
  let env: Record<string, string> = {};
  try {
    env = parseEnvFile(readFileSync(paths.secretsEnv(appId), "utf8"));
  } catch {
    env = {};
  }
  env[key] = value;
  const body = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  atomicWrite(paths.secretsEnv(appId), body + "\n", 0o600);
}
