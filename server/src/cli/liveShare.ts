export const LIVE_URL_PREFIX = "DECKHAND_LIVE_URL=";
const OPEN_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 10_000;

export interface LiveShareClientOptions {
  port: number;
  /** A tokens.yaml credential; null when the host has none. */
  token: string | null;
  appId: string;
  pid: number;
  log: (line: string) => void;
  fetchImpl?: typeof fetch;
}

/**
 * The verify run's side of `--share public`: asks the running server for a view-only share of the
 * run's simulator and revokes it at the end. Every failure is a warning; the run goes on unshared.
 */
export class LiveShareClient {
  private opening: Promise<string | null> | null = null;
  private shareId: string | null = null;
  private closed = false;
  private readonly fetch: typeof fetch;

  constructor(private readonly o: LiveShareClientOptions) {
    this.fetch = o.fetchImpl ?? fetch;
  }

  private get base(): string {
    return `http://127.0.0.1:${this.o.port}/admin/live-shares`;
  }

  open(udid: string): Promise<string | null> {
    this.opening ??= this.doOpen(udid);
    return this.opening;
  }

  private async doOpen(udid: string): Promise<string | null> {
    const warn = (why: string) => {
      this.o.log(`warning: --share: ${why}; continuing without a live share`);
      return null;
    };
    if (!this.o.token) return warn("no credential in tokens.yaml (`deckhand token add` mints one)");
    let res: Response;
    try {
      res = await this.fetch(this.base, {
        method: "POST",
        headers: { authorization: `Bearer ${this.o.token}`, "content-type": "application/json" },
        body: JSON.stringify({ udid, appId: this.o.appId, pid: this.o.pid }),
        signal: AbortSignal.timeout(OPEN_TIMEOUT_MS),
      });
    } catch {
      return warn(`the deckhand server is not answering on 127.0.0.1:${this.o.port}`);
    }
    const body = (await res.json().catch(() => ({}))) as { shareId?: string; url?: string; error?: string };
    if (res.status === 404 && !body.error) return warn("the running server has no live-share route; update and restart it");
    if (!res.ok || !body.shareId || !body.url) return warn(`the server refused (${res.status}${body.error ? `: ${body.error}` : ""})`);
    this.shareId = body.shareId;
    if (this.closed) {
      await this.close();
      return null;
    }
    this.o.log(`${LIVE_URL_PREFIX}${body.url}`);
    return body.url;
  }

  /** Revoke the share. Waits for an open still in flight, so a share can never outlive the run. */
  async close(): Promise<void> {
    this.closed = true;
    if (!this.shareId && this.opening) await this.opening.catch(() => null);
    const id = this.shareId;
    if (!id) return;
    this.shareId = null;
    try {
      await this.fetch(`${this.base}/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${this.o.token}` },
        signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS),
      });
    } catch {
      this.o.log("warning: --share: could not revoke the live share; the server drops it once this process exits");
    }
  }
}
