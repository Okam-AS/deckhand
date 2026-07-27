import { createHash, timingSafeEqual } from "node:crypto";
import type { App, Role, TokenEntry } from "./config.ts";
import { repoOwner } from "./config.ts";

/**
 * Authenticated caller derived from a valid `/mcp/<token>` path segment.
 * `owners` (if present) restricts which apps this caller may touch.
 */
export interface Principal {
  name: string;
  role: Role;
  owners?: string[];
}

function sha256(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

/**
 * Constant-time token authenticator. Builds a sha256(token) → entry map at
 * construction, and looks a candidate up by hashing it and comparing against
 * every entry with `timingSafeEqual` (comparing hashes keeps it constant-time
 * even across differing token lengths). An unknown token returns null — the
 * caller turns that into a 404, indistinguishable from a wrong path.
 */
export class TokenAuthenticator {
  private readonly entries: { hash: Buffer; principal: Principal }[];

  constructor(tokens: TokenEntry[]) {
    this.entries = tokens.map((t) => ({
      hash: sha256(t.token),
      principal: { name: t.name, role: t.role, ...(t.owners ? { owners: t.owners } : {}) },
    }));
  }

  authenticate(candidate: string): Principal | null {
    if (typeof candidate !== "string" || candidate.length === 0) return null;
    const candidateHash = sha256(candidate);
    // Compare against every entry (no early return) so timing does not leak
    // which entry, if any, matched.
    let matched: Principal | null = null;
    for (const entry of this.entries) {
      if (timingSafeEqual(candidateHash, entry.hash)) matched = entry.principal;
    }
    return matched;
  }
}

export function isAdmin(p: Principal): boolean {
  return p.role === "admin";
}

/**
 * Whether a principal may act on a given app. Members with an `owners` scope
 * are restricted to apps whose repo owner is in that list; an unscoped
 * principal (or admin) may touch any app. Owner scopes are GitHub owners, so
 * a local-only app (no repo) is out of reach for scoped tokens.
 */
export function canAccessApp(p: Principal, app: App): boolean {
  if (!p.owners || p.owners.length === 0) return true;
  if (!app.repo) return false;
  return p.owners.includes(repoOwner(app.repo));
}

/** Filter a list of apps to the ones a principal may see/use. */
export function visibleApps(p: Principal, apps: App[]): App[] {
  return apps.filter((a) => canAccessApp(p, a));
}
