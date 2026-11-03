// ---------------------------------------------------------------------------
// WebDriverAgent REST client for a physical iPhone. Same rules as the SimDeck seam
// (testing-control.md): REST only, loopback only, no credential of any kind — WDA has no
// authentication, which is why it is only ever reached through deckhand's loopback-bound
// iproxy forward to a WDA bound to the phone's own loopback (devices/wdaRunner.ts).
// Observation (status, source, screenshot, activeAppInfo) is sessionless; a session is
// opened without a bundle id, so opening one launches nothing.
// ---------------------------------------------------------------------------

export class WdaError extends Error {
  constructor(
    message: string,
    public readonly status = 502,
  ) {
    super(message);
    this.name = "WdaError";
  }
}

export interface WdaStatus {
  ready: boolean;
  sessionId: string | null;
  iosVersion?: string;
  /** The phone's Wi-Fi address as WDA reports it — never where deckhand connects. */
  wifiIp?: string;
  build?: string;
}

export interface ActiveApp {
  bundleId?: string;
  name?: string;
  pid?: number;
}

export type PointerStep =
  | { type: "pointerMove"; duration: number; x: number; y: number }
  | { type: "pointerDown"; button: 0 }
  | { type: "pointerUp"; button: 0 }
  | { type: "pause"; duration: number };

export interface WdaClientOptions {
  /** `http://127.0.0.1:<port>` — anything but loopback is refused. */
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const PNG_MAGIC = 0x89504e47;

/** XCUIKeyboardKey values WDA types for the named keys `ui` accepts. */
const KEY_TEXT: Record<string, string> = {
  return: "\n",
  enter: "\n",
  tab: "\t",
  backspace: "\b",
  delete: "\u007f",
  escape: "\u001b",
  space: " ",
};

export function keyText(name: string): string | null {
  return KEY_TEXT[name.toLowerCase()] ?? null;
}

export class WdaClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: WdaClientOptions) {
    const u = new URL(opts.baseUrl);
    if (u.hostname !== "127.0.0.1" || u.protocol !== "http:") {
      throw new WdaError(`WDA is only reached over deckhand's loopback forward, not ${u.protocol}//${u.host}`, 400);
    }
    this.baseUrl = `http://127.0.0.1:${u.port}`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** null when nothing answers: the caller decides whether that is "not started" or "gone". */
  async status(timeoutMs = 5_000): Promise<WdaStatus | null> {
    let body: unknown;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/status`, { signal: AbortSignal.timeout(timeoutMs) });
      body = await res.json();
    } catch {
      return null;
    }
    const j = body as { sessionId?: string | null; value?: { ready?: boolean; os?: { version?: string }; ios?: { ip?: string }; build?: { version?: string } } };
    return {
      ready: j.value?.ready === true,
      sessionId: j.sessionId ?? null,
      ...(j.value?.os?.version ? { iosVersion: j.value.os.version } : {}),
      ...(j.value?.ios?.ip ? { wifiIp: j.value.ios.ip } : {}),
      ...(j.value?.build?.version ? { build: j.value.build.version } : {}),
    };
  }

  /** WDA's page source; seconds on a busy screen, hence the long timeout. */
  source(): Promise<unknown> {
    return this.request("GET", "/source?format=json", undefined, 60_000);
  }

  async activeAppInfo(): Promise<ActiveApp> {
    const v = (await this.request("GET", "/wda/activeAppInfo")) as Record<string, unknown> | null;
    return {
      ...(typeof v?.bundleId === "string" ? { bundleId: v.bundleId } : {}),
      ...(typeof v?.name === "string" ? { name: v.name } : {}),
      ...(typeof v?.pid === "number" ? { pid: v.pid } : {}),
    };
  }

  async screenshot(): Promise<Buffer> {
    const b64 = await this.request("GET", "/screenshot", undefined, 60_000);
    if (typeof b64 !== "string") throw new WdaError("WDA screenshot answered no image");
    const png = Buffer.from(b64, "base64");
    if (png.length < 8 || png.readUInt32BE(0) !== PNG_MAGIC) throw new WdaError(`WDA screenshot is not a PNG (${png.length} bytes)`);
    return png;
  }

  async windowSize(): Promise<{ width: number; height: number }> {
    const v = (await this.withSession((sid) => this.request("GET", `/session/${sid}/window/size`))) as { width?: unknown; height?: unknown } | null;
    if (typeof v?.width !== "number" || typeof v?.height !== "number" || v.width <= 0 || v.height <= 0) throw new WdaError("WDA reported no window size");
    return { width: v.width, height: v.height };
  }

  async pointer(steps: PointerStep[]): Promise<void> {
    await this.withSession((sid) =>
      this.request("POST", `/session/${sid}/actions`, {
        actions: [{ type: "pointer", id: "finger1", parameters: { pointerType: "touch" }, actions: steps }],
      }),
    );
  }

  /** A tap at a point, in points. */
  tap(x: number, y: number): Promise<void> {
    return this.pointer([
      { type: "pointerMove", duration: 0, x: Math.round(x), y: Math.round(y) },
      { type: "pointerDown", button: 0 },
      { type: "pause", duration: 60 },
      { type: "pointerUp", button: 0 },
    ]);
  }

  swipe(x1: number, y1: number, x2: number, y2: number, durationMs = 300): Promise<void> {
    return this.pointer([
      { type: "pointerMove", duration: 0, x: Math.round(x1), y: Math.round(y1) },
      { type: "pointerDown", button: 0 },
      { type: "pause", duration: 50 },
      { type: "pointerMove", duration: Math.max(50, Math.round(durationMs)), x: Math.round(x2), y: Math.round(y2) },
      { type: "pointerUp", button: 0 },
    ]);
  }

  /** Types into whatever has focus; WDA's keyboard path takes non-ASCII text as is. */
  async keys(text: string): Promise<void> {
    await this.withSession((sid) => this.request("POST", `/session/${sid}/wda/keys`, { value: [...text] }));
  }

  async dismissKeyboard(): Promise<void> {
    await this.withSession((sid) => this.request("POST", `/session/${sid}/wda/keyboard/dismiss`, { keyNames: ["Done", "Ferdig", "Return", "Retur"] }));
  }

  /** The live session, reused when WDA already holds one; created without a bundle id so it launches nothing. */
  async session(): Promise<string> {
    const st = await this.status();
    if (st?.sessionId) return st.sessionId;
    this.lastSessionId = undefined;
    const v = (await this.request("POST", "/session", { capabilities: { alwaysMatch: {} } })) as { sessionId?: string } | null;
    const id = v?.sessionId ?? this.lastSessionId;
    if (!id) throw new WdaError("WDA did not open a session");
    return id;
  }

  private lastSessionId: string | undefined;

  private async withSession<T>(fn: (sid: string) => Promise<T>): Promise<T> {
    const sid = await this.session();
    try {
      return await fn(sid);
    } catch (e) {
      if (!(e instanceof WdaError) || !/invalid session id|session .*(does not exist|not found)/i.test(e.message)) throw e;
      return fn(await this.session());
    }
  }

  private async request(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new WdaError(`WDA ${method} ${path.split("?")[0]} did not answer: ${(e as Error).message}`, 504);
    }
    const text = await res.text().catch(() => "");
    let json: { value?: unknown; sessionId?: string };
    try {
      json = JSON.parse(text) as { value?: unknown; sessionId?: string };
    } catch {
      throw new WdaError(`WDA ${method} ${path.split("?")[0]}: HTTP ${res.status}, not JSON`, res.ok ? 502 : res.status);
    }
    if (typeof json.sessionId === "string") this.lastSessionId = json.sessionId;
    const err = json.value as { error?: string; message?: string } | undefined;
    if (!res.ok || (err && typeof err === "object" && typeof err.error === "string")) {
      const why = `${err?.error ?? ""} ${(err?.message ?? "").split("\n")[0]!.slice(0, 200)}`.trim();
      throw new WdaError(`WDA ${method} ${path.split("?")[0]}: HTTP ${res.status}${why ? ` ${why}` : ""}`, res.ok ? 500 : res.status);
    }
    return json.value ?? null;
  }
}
