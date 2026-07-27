import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { METRO_PORT } from "./recipes.ts";

// ---------------------------------------------------------------------------
// Metro / Expo dev-server lifecycle. One server per app on a fixed port
// (8081), reused across previews, keyed by an env signature so a preview with
// changed env restarts it. NEVER pass `--clear` (full re-bundle races startup).
// Env forces CI + loopback packager host (learnings §3).
// ---------------------------------------------------------------------------

function envSignature(env: Record<string, string>): string {
  const stable = Object.keys(env)
    .sort()
    .map((k) => `${k}=${env[k]}`)
    .join("\n");
  return createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

interface RunningMetro {
  appId: string;
  sig: string;
  child: ChildProcess;
  manifestUrl: string;
}

export interface MetroHandle {
  manifestUrl: string;
}

async function metroHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const body = await res.text();
    return body.includes("packager-status:running");
  } catch {
    return false;
  }
}

/** Manages the single Metro dev-server (Phase 1: one app at a time on 8081). */
export class MetroManager {
  private current: RunningMetro | null = null;
  constructor(private readonly port: number = METRO_PORT) {}

  private baseEnv(appEnv: Record<string, string>): Record<string, string> {
    // NOTE: do NOT set CI=1 here. Verified on-device (Expo SDK 57): CI mode puts
    // Metro in a non-interactive path that never binds the dev server on 8081,
    // so the app can't load JS. CI=1 belongs on the *build* steps, not Metro.
    return {
      ...process.env,
      ...appEnv,
      REACT_NATIVE_PACKAGER_HOSTNAME: "127.0.0.1",
    } as Record<string, string>;
  }

  /** Ensure a Metro is running for this app+env; reuse if the signature matches and it's healthy. */
  async ensure(appId: string, worktreePath: string, appEnv: Record<string, string>): Promise<MetroHandle> {
    const sig = envSignature(appEnv);
    if (this.current && this.current.appId === appId && this.current.sig === sig && (await metroHealthy(this.port))) {
      return { manifestUrl: this.current.manifestUrl };
    }
    await this.stop();

    // NOTE: no `--localhost` — verified on-device it binds Metro to IPv6 `::1`
    // only, so the 127.0.0.1 readiness check and the app's
    // REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1 connection both fail. Default
    // binding covers 127.0.0.1.
    const child = spawn(
      "npx",
      ["expo", "start", "--dev-client", "--port", String(this.port)],
      { cwd: worktreePath, env: this.baseEnv(appEnv), detached: true, stdio: "ignore" },
    );
    const manifestUrl = `http://127.0.0.1:${this.port}`;
    this.current = { appId, sig, child, manifestUrl };

    // Wait for readiness (up to ~60s).
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (await metroHealthy(this.port)) return { manifestUrl };
      await new Promise((r) => setTimeout(r, 500));
    }
    await this.stop();
    throw new Error(`Metro did not become ready on port ${this.port} within 60s`);
  }

  async stop(): Promise<void> {
    const cur = this.current;
    this.current = null;
    if (!cur?.child.pid) return;
    try {
      process.kill(-cur.child.pid, "SIGTERM");
    } catch {
      try {
        cur.child.kill("SIGTERM");
      } catch {
        // gone
      }
    }
  }
}
