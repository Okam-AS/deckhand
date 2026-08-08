import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// One-time setup nonces (PLAN §6/§11 item 5). The agent guides the user to a
// `/setup/<nonce>` URL where they paste a credential directly into the mini —
// never through MCP or the chat. Nonces are 128-bit, single-use, short-TTL, and
// bound to a pending action. In-memory only: a restart invalidates outstanding
// links (acceptable — the agent just mints a fresh one).
// ---------------------------------------------------------------------------

export type SetupKind = "github-pat";

export interface PendingSetup {
  kind: SetupKind;
  /** Repo owner the credential is for (shown on the setup page). */
  owner?: string;
  createdMs: number;
  used: boolean;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;

export class SetupStore {
  private readonly pending = new Map<string, PendingSetup>();

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly now: () => number = () => Date.now(),
    private readonly genNonce: () => string = () => randomBytes(16).toString("base64url"),
  ) {}

  /** Mint a nonce for a pending credential-setup action. */
  mint(kind: SetupKind, owner?: string): string {
    this.prune();
    const nonce = this.genNonce();
    this.pending.set(nonce, { kind, owner, createdMs: this.now(), used: false });
    return nonce;
  }

  /** The pending entry if the nonce is live (exists, unused, unexpired), else null. */
  peek(nonce: string): PendingSetup | null {
    const e = this.pending.get(nonce);
    if (!e || e.used) return null;
    if (this.now() - e.createdMs > this.ttlMs) {
      this.pending.delete(nonce);
      return null;
    }
    return e;
  }

  /** Mark a live nonce used and return it; null if not live. Single-use. */
  consume(nonce: string): PendingSetup | null {
    const e = this.peek(nonce);
    if (!e) return null;
    e.used = true;
    return e;
  }

  private prune(): void {
    for (const [k, v] of this.pending) {
      if (this.now() - v.createdMs > this.ttlMs) this.pending.delete(k);
    }
  }
}
