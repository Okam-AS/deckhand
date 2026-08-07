import { createHash, timingSafeEqual } from "node:crypto";
import type { TokenEntry } from "./config.ts";

/**
 * Authenticated caller behind an `Authorization: Bearer` credential.
 *
 * There is no authorization step past this point: deckhand serves ONE operator's
 * devices on ONE Mac, so anything that authenticates is that operator. What the
 * fields carry is the audit trail's answer to "which credential acted".
 *
 * `name` is all there is, because deckhand learns no more: an OAuth grant names the CLIENT the
 * operator approved, and a local tokens.yaml credential names itself. There is deliberately no
 * address field — nothing in the flow proves one, so carrying it would invite a check that
 * cannot hold.
 */
export interface Principal {
  name: string;
}

function sha256(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

/**
 * The `Authorization: Bearer <token>` value, or null.
 *
 * The scheme is matched case-insensitively because RFC 7235 says it is — and
 * because the share gate already paid for assuming otherwise (see the `i`-flag
 * guardrail in `test-support/`).
 */
export function bearerToken(header: string | undefined): string | null {
  if (typeof header !== "string") return null;
  const m = /^bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1]! : null;
}

/**
 * Constant-time token authenticator. Builds a sha256(token) → entry map at
 * construction, and looks a candidate up by hashing it and comparing against
 * every entry with `timingSafeEqual` (comparing hashes keeps it constant-time
 * even across differing token lengths). An unknown token returns null — the
 * caller turns that into a 401 carrying the pointer an MCP client needs to authorize.
 */
export class TokenAuthenticator {
  private entries: { hash: Buffer; principal: Principal }[];

  constructor(tokens: TokenEntry[]) {
    this.entries = TokenAuthenticator.digest(tokens);
  }

  private static digest(tokens: TokenEntry[]): { hash: Buffer; principal: Principal }[] {
    return tokens.map((t) => ({ hash: sha256(t.token), principal: { name: t.name } }));
  }

  /**
   * Swap the token set without replacing the authenticator.
   *
   * `createApp` closes over this instance, so a reload has to mutate rather than rebuild.
   * Used by `watchTokens`: tokens.yaml was read once at boot, which meant the token `setup`
   * mints was invisible to the server it had just started — the connector was refused and claude.ai
   * blamed OAuth.
   */
  replace(tokens: TokenEntry[]): void {
    this.entries = TokenAuthenticator.digest(tokens);
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
