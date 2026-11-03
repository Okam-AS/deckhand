// A WebDriverAgent stand-in for tests: answers the REST surface wdaClient.ts uses and records every
// request. Not a test file itself so several suites can share it; it holds no network code.

export interface WdaCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface FakeWdaState {
  sessionId: string | null;
  bundleId: string;
  /** Raw WDA source `value`; a function lets a test change the screen between reads. */
  source: unknown | (() => unknown);
  window: { width: number; height: number };
  wifiIp?: string;
  /** path → [status, value]: the next request to that path answers this once. */
  failOnce: Map<string, [number, unknown]>;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

export function fakeWda(over: Partial<FakeWdaState> = {}): { fetch: typeof fetch; calls: WdaCall[]; state: FakeWdaState } {
  const state: FakeWdaState = {
    sessionId: null,
    bundleId: "com.example.app",
    source: { type: "Application", label: "Demo", isVisible: "1", rect: { x: 0, y: 0, width: 390, height: 844 }, children: [] },
    window: { width: 390, height: 844 },
    failOnce: new Map(),
    ...over,
  };
  const calls: WdaCall[] = [];
  const answer = (status: number, value: unknown, extra: Record<string, unknown> = {}) =>
    new Response(JSON.stringify({ value, sessionId: state.sessionId, ...extra }), { status, headers: { "content-type": "application/json" } });
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname + url.search;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push({ method, path, headers, ...(body !== undefined ? { body } : {}) });
    const failure = state.failOnce.get(url.pathname);
    if (failure) {
      state.failOnce.delete(url.pathname);
      return answer(failure[0], failure[1]);
    }
    if (path === "/status") return answer(200, { ready: true, os: { version: "27.0.1" }, ios: { ip: state.wifiIp ?? "192.168.1.20" }, build: { version: "9.0.0" } });
    if (path === "/source?format=json") return answer(200, typeof state.source === "function" ? (state.source as () => unknown)() : state.source);
    if (path === "/wda/activeAppInfo") return answer(200, { bundleId: state.bundleId, name: "", pid: 4242 });
    if (path === "/screenshot") return answer(200, PNG.toString("base64"));
    if (path === "/session" && method === "POST") {
      state.sessionId = "S1";
      return answer(200, { sessionId: "S1", capabilities: {} });
    }
    const m = /^\/session\/([^/]+)\/(.*)$/.exec(url.pathname);
    if (m) {
      if (m[1] !== state.sessionId) return answer(404, { error: "invalid session id", message: "Session does not exist" });
      if (m[2] === "window/size") return answer(200, state.window);
      if (m[2] === "actions" || m[2] === "wda/keys" || m[2] === "wda/keyboard/dismiss") return answer(200, null);
    }
    return answer(404, { error: "unknown command", message: `${method} ${path}` });
  }) as typeof fetch;
  return { fetch: impl, calls, state };
}

/** A visible WDA node with sensible defaults. */
export function wdaNode(o: Record<string, unknown>): Record<string, unknown> {
  return { isVisible: "1", isEnabled: "1", isAccessible: "1", rect: { x: 10, y: 100, width: 100, height: 40 }, ...o };
}

/** The pointer moves of every W3C actions call, as [x, y] per move. */
export function pointerMoves(calls: WdaCall[]): [number, number][][] {
  return calls
    .filter((c) => c.path.endsWith("/actions"))
    .map((c) => {
      const steps = (c.body as { actions: { actions: { type: string; x?: number; y?: number }[] }[] }).actions[0]!.actions;
      return steps.filter((s) => s.type === "pointerMove").map((s) => [s.x!, s.y!] as [number, number]);
    });
}
