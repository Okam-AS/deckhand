import { createHash, timingSafeEqual } from "node:crypto";
import type { TokenEntry } from "./config.ts";

/**
 * Authenticated caller derived from a valid `/mcp/<token>` path segment.
 *
 * A name and nothing else: deckhand serves ONE operator's devices on ONE Mac,
 * so every token that authenticates is that operator's, and there is no second
 * party to hold a lesser one back from. The name exists for the audit trail —
 * which credential acted — not as an identity to authorize against.
 */
export interface Principal {
  name: string;
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
   * mints was invisible to the server it had just started — the connector 404'd and claude.ai
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
