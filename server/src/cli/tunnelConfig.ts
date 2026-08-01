import { parse as parseYaml, stringify as toYaml } from "yaml";

// ---------------------------------------------------------------------------
// The cloudflared config, edited by MERGING rather than by writing.
//
// `~/.cloudflared/config.yml` is not deckhand's file. A real machine had three ingress rules
// in it, one of them an unrelated backend on another port — so a setup command that generated
// this file from scratch would have silently deleted a service the operator runs. Same
// borrow-never-own rule as a developer's checkout: deckhand adds what it needs and touches
// nothing else.
//
// Kept pure and separate from the shelling-out so the part that can lose data is the part
// with tests.
// ---------------------------------------------------------------------------

export interface IngressRule {
  hostname?: string;
  service: string;
  [k: string]: unknown;
}

export interface TunnelConfig {
  tunnel?: string;
  "credentials-file"?: string;
  ingress?: IngressRule[];
  [k: string]: unknown;
}

/** The catch-all cloudflared requires as the LAST rule; without it the config is rejected. */
const CATCH_ALL: IngressRule = { service: "http_status:404" };

const isCatchAll = (r: IngressRule): boolean => r.hostname === undefined;

/**
 * Add deckhand's hostnames to an existing config, preserving everything else.
 *
 * - rules for OTHER hostnames are kept, in order, untouched
 * - a rule for one of our hostnames is updated in place rather than duplicated (a second rule
 *   for the same hostname is dead: cloudflared matches the first)
 * - the catch-all stays last, and is added when the file has none
 * - `tunnel` and `credentials-file` are only filled in when absent, so a config already
 *   pointing at a different tunnel is a decision the operator gets to keep
 */
export function mergeTunnelConfig(
  existing: TunnelConfig | null,
  opts: { tunnelId: string; credentialsFile: string; hostnames: string[]; port: number },
): TunnelConfig {
  const base: TunnelConfig = existing ? { ...existing } : {};
  base.tunnel ??= opts.tunnelId;
  base["credentials-file"] ??= opts.credentialsFile;

  const service = `http://127.0.0.1:${opts.port}`;
  const prior = Array.isArray(base.ingress) ? base.ingress : [];
  const kept = prior.filter((r) => !isCatchAll(r));
  const catchAll = prior.find(isCatchAll) ?? CATCH_ALL;

  const merged: IngressRule[] = [...kept];
  for (const hostname of opts.hostnames) {
    const at = merged.findIndex((r) => r.hostname === hostname);
    if (at >= 0) merged[at] = { ...merged[at], hostname, service };
    else merged.push({ hostname, service });
  }
  base.ingress = [...merged, catchAll];
  return base;
}

/** Render a merged config. Kept next to the merge so the round-trip is one unit. */
export function renderTunnelConfig(config: TunnelConfig): string {
  return toYaml(config);
}

/** Parse an existing config, or null when there is none / it is unreadable. */
export function parseTunnelConfig(text: string | null): TunnelConfig | null {
  if (!text) return null;
  try {
    const parsed = parseYaml(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as TunnelConfig) : null;
  } catch {
    return null;
  }
}

/**
 * The tunnel id for `name` in `cloudflared tunnel list` output, or null.
 *
 * Parsed rather than created blindly: a second tunnel with the same name is allowed by
 * cloudflared and is a mess to unpick — connections split between them at random.
 */
export function tunnelIdFor(listOutput: string, name: string): string | null {
  for (const line of listOutput.split("\n")) {
    const m = /^([0-9a-f-]{36})\s+(\S+)/i.exec(line.trim());
    if (m && m[2] === name) return m[1]!;
  }
  return null;
}

/** True when `cloudflared tunnel list` says we are not authenticated. */
export function needsLogin(listOutput: string, exitCode: number): boolean {
  if (exitCode === 0) return false;
  return /cert\.pem|not logged in|login|Cannot determine default origin certificate/i.test(listOutput);
}
