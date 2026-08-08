import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { METRO_PORT_RANGE } from "./recipes.ts";

// ---------------------------------------------------------------------------
// Metro / Expo dev-server lifecycle. One server per app, reused across previews
// and keyed by an env signature so a preview with changed env restarts it.
// NEVER pass `--clear` (full re-bundle races startup). Env forces the loopback
// packager host (learnings §3).
//
// The port is ALLOCATED, not fixed. It used to be hard-coded to 8081 and
// readiness was "something answers /status with packager-status:running" — but
// every Metro answers that. A developer's own `expo start` on 8081 (a different
// project entirely) therefore passed the health check, and deckhand handed the
// dev client `http://127.0.0.1:8081`: the previewed app's NATIVE shell loaded a
// FOREIGN JS bundle, silently, with the viewer still captioned as the previewed
// repo. Observed 2026-07-28. So: pick a port nothing is listening on, and after
// startup verify the listener is OUR process group before trusting it.
// ---------------------------------------------------------------------------

/** Reuse key: same app, same checkout, same env = same dev server. */
function metroKey(appId: string, worktreePath: string, sig: string): string {
  return `${appId}\n${worktreePath}\n${sig}`;
}

function envSignature(env: Record<string, string>): string {
  const stable = Object.keys(env)
    .sort()
    .map((k) => `${k}=${env[k]}`)
    .join("\n");
  return createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

interface RunningMetro {
  appId: string;
  /** When it was spawned — see stopLocked's recycled-pid guard. */
  startedAt: number;
  /**
   * The checkout this Metro serves. Part of the reuse key, not decoration: one
   * app can have two live previews at different refs, and keying on app+env
   * alone handed the second one the FIRST checkout's bundle — the same
   * foreign-bundle failure the port-ownership checks above exist to prevent,
   * only with deckhand as the intruder, so no pgid check can catch it. A
   * different checkout gets its OWN server on its own port; the first one keeps
   * running, because its preview is still live. → `metro.test.ts` "starts a
   * second server for a second checkout of the same app".
   */
  worktreePath: string;
  sig: string;
  child: ChildProcess;
  port: number;
  manifestUrl: string;
}

export interface MetroHandle {
  port: number;
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

function bindable(port: number, host?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    const done = () => srv.close(() => resolve(true));
    if (host) srv.listen(port, host, done);
    else srv.listen(port, done);
  });
}

/**
 * True when nothing is listening on the port, on EITHER stack.
 *
 * Both probes are needed. Expo/Metro binds the IPv6 wildcard (`*:8081`), and on
 * macOS a 127.0.0.1-only bind SUCCEEDS alongside it — so the loopback probe
 * alone reported a busy 8081 as free (observed 2026-07-28: deckhand picked 8081
 * out from under a developer's own `expo start` and only the ownership check
 * caught it). The hostless listen binds dual-stack and collides properly.
 */
async function portFree(port: number): Promise<boolean> {
  return (await bindable(port)) && (await bindable(port, "127.0.0.1"));
}

/**
 * The process group of whatever is listening on `port`, or null when nothing is
 * (or when it can't be determined). Metro's listener is a grandchild of the
 * `npx` we spawn, so identity is checked by process GROUP, not pid: a detached
 * spawn makes our child the group leader and every descendant inherits it.
 */
function listenerPgid(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("lsof", ["-nP", "-tiTCP:" + port, "-sTCP:LISTEN"], { timeout: 5_000 }, (err, out) => {
      const pid = Number(String(out ?? "").trim().split("\n")[0]);
      if (err || !Number.isFinite(pid) || pid <= 0) return resolve(null);
      execFile("ps", ["-o", "pgid=", "-p", String(pid)], { timeout: 5_000 }, (e2, out2) => {
        const pgid = Number(String(out2 ?? "").trim());
        resolve(e2 || !Number.isFinite(pgid) ? null : pgid);
      });
    });
  });
}

export interface MetroManagerOptions {
  /** Ports to try, inclusive. Defaults to METRO_PORT_RANGE. */
  portRange?: [number, number];
  spawnFn?: typeof spawn;
  /** Test seams. */
  portFreeImpl?: (port: number) => Promise<boolean>;
  listenerPgidImpl?: (port: number) => Promise<number | null>;
  healthyImpl?: (port: number) => Promise<boolean>;
  pidAliveImpl?: (pid: number) => boolean;
  killImpl?: (pid: number, sig: NodeJS.Signals) => void;
  /** How long `stop` waits for the port after SIGTERM, then after SIGKILL. */
  stopWaitMs?: [number, number];
}

/** Whether a pid still exists (signal 0 probes without delivering anything). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Env var stamped on every Metro deckhand spawns, so a restart can find its own. */
export const METRO_MARKER_ENV = "DECKHAND_METRO";

export class MetroManager {
  /**
   * One Metro per (app, checkout, env), NOT one in total.
   *
   * A single slot meant the second Expo preview that needed Metro killed the
   * first one's dev server: two live previews of one app at different refs is a
   * supported flow (`findReusable` never reuses across refs), so is a second app,
   * and an extra pane boots under a synthetic app id and then
   * boots the working app. The victim stayed `ready` in the viewer with a dead
   * bundle URL — nothing failed, the app just could not reload. Ports are
   * allocated per instance out of the same range.
   */
  private readonly running = new Map<string, RunningMetro>();

  /**
   * Pids this manager owns RIGHT NOW, so the boot reap can spare them.
   *
   * The orphan sweep runs after the HTTP port is bound (a second `deckhand
   * serve` has to lose on EADDRINUSE first), so an agent's start_preview can
   * already have spawned a child by the time it runs — and that child carries
   * the same env marker the sweep hunts for. Without this the server kills its
   * own brand-new bundler and leaves the preview `ready` with nothing serving.
   */
  livePids(): number[] {
    return [...this.running.values()]
      .map((r) => r.child.pid)
      .filter((pid): pid is number => typeof pid === "number");
  }
  private readonly range: [number, number];
  private readonly spawnFn: typeof spawn;
  private readonly portFreeImpl: (port: number) => Promise<boolean>;
  private readonly listenerPgidImpl: (port: number) => Promise<number | null>;
  private readonly healthyImpl: (port: number) => Promise<boolean>;
  private readonly pidAliveImpl: (pid: number) => boolean;
  private readonly killImpl: (pid: number, sig: NodeJS.Signals) => void;
  private readonly stopWaitMs: [number, number];

  constructor(opts: MetroManagerOptions = {}) {
    this.killImpl = opts.killImpl ?? ((pid, sig) => process.kill(pid, sig));
    this.stopWaitMs = opts.stopWaitMs ?? [5_000, 3_000];
    this.range = opts.portRange ?? METRO_PORT_RANGE;
    this.spawnFn = opts.spawnFn ?? spawn;
    this.portFreeImpl = opts.portFreeImpl ?? portFree;
    this.listenerPgidImpl = opts.listenerPgidImpl ?? listenerPgid;
    this.healthyImpl = opts.healthyImpl ?? metroHealthy;
    this.pidAliveImpl = opts.pidAliveImpl ?? pidAlive;
  }

  private baseEnv(appEnv: Record<string, string>): Record<string, string> {
    // NOTE: do NOT set CI=1 here. Verified on-device (Expo SDK 57): CI mode puts
    // Metro in a non-interactive path that never binds the dev server, so the
    // app can't load JS. CI=1 belongs on the *build* steps, not Metro.
    return {
      ...process.env,
      ...appEnv,
      REACT_NATIVE_PACKAGER_HOSTNAME: "127.0.0.1",
      // A marker so a LATER deckhand can recognise this process as its own.
      // Metro is spawned detached, so it outlives the server — and nothing could
      // tell a leaked one from the developer's own `expo start`, because the
      // argv is identical. Nineteen server restarts left nineteen Metros holding
      // the whole 8081-8099 range, after which every preview failed with "no
      // free Metro port". Deliberately in the ENV rather than argv: expo would
      // reject an unknown flag, and cwd is the developer's own checkout for a
      // local preview, so neither can carry the mark.
      [METRO_MARKER_ENV]: "1",
    } as Record<string, string>;
  }

  /** The first port in the range with no listener, or null when all are taken. */
  private async freePort(): Promise<number | null> {
    for (let port = this.range[0]; port <= this.range[1]; port++) {
      if (await this.portFreeImpl(port)) return port;
    }
    return null;
  }

  /**
   * Serialize everything that touches `this.running`.
   *
   * `ensure` reads `this.running`, then awaits (`healthyImpl`, `stop`,
   * `freePort`) before writing it — and PreviewEngine.launch calls it
   * CONCURRENTLY, once per device, from its install-many `Promise.all`. Two
   * callers that both missed the same key would each pick a different free port, both
   * spawn, and the second would overwrite the first: an orphaned Metro nothing
   * ever kills, holding a port out of the range forever. (Under the old fixed
   * port they collided on bind and the loser simply died.)
   */
  private chain: Promise<unknown> = Promise.resolve();

  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  /**
   * The port of a Metro already running for this app, or null. Read-only — it
   * never starts one, so a periodic caller can ask cheaply.
   */
  portForApp(appId: string): number | null {
    for (const cur of this.running.values()) if (cur.appId === appId) return cur.port;
    return null;
  }

  /** Ensure a Metro is running for this app+env; reuse if the signature matches and it's healthy. */
  ensure(appId: string, worktreePath: string, appEnv: Record<string, string>): Promise<MetroHandle> {
    return this.lock(() => this.ensureLocked(appId, worktreePath, appEnv));
  }

  private async ensureLocked(
    appId: string,
    worktreePath: string,
    appEnv: Record<string, string>,
  ): Promise<MetroHandle> {
    const sig = envSignature(appEnv);
    const key = metroKey(appId, worktreePath, sig);
    const cur = this.running.get(key);
    if (cur && (await this.healthyImpl(cur.port))) {
      // Ours when it started; re-verify, since a crash frees the port for anyone.
      if (await this.ownsPort(cur.port, cur.child.pid, true)) return { port: cur.port, manifestUrl: cur.manifestUrl };
    }
    if (cur) await this.stopLocked(key);
    // Same app + same checkout, different env: that server can never be reused
    // again, so reclaim its port instead of leaving it running beside the new
    // one. Other checkouts and other apps are left alone — they have their own
    // live previews.
    for (const [k, m] of this.running) {
      if (m.appId === appId && m.worktreePath === worktreePath) await this.stopLocked(k);
    }

    const port = await this.freePort();
    if (port == null) {
      throw new Error(
        `no free Metro port in ${this.range[0]}-${this.range[1]} — another dev server is using all of them; ` +
          `stop a running \`expo start\` / \`react-native start\` on this machine and try again`,
      );
    }

    // NOTE: no `--localhost` — verified on-device it binds Metro to IPv6 `::1`
    // only, so the 127.0.0.1 readiness check and the app's
    // REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1 connection both fail. Default
    // binding covers 127.0.0.1.
    const child = this.spawnFn(
      "npx",
      ["expo", "start", "--dev-client", "--port", String(port)],
      { cwd: worktreePath, env: this.baseEnv(appEnv), detached: true, stdio: "ignore" },
    );
    const manifestUrl = `http://127.0.0.1:${port}`;
    this.running.set(key, { appId, worktreePath, sig, child, port, manifestUrl, startedAt: Date.now() });

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (await this.healthyImpl(port)) {
        // Healthy is not enough: any Metro answers /status the same way. If the
        // listener isn't in our process group, someone else grabbed the port in
        // the gap — serving it would load THEIR bundle into this app's shell.
        if (await this.ownsPort(port, child.pid)) return { port, manifestUrl };
        await this.stopLocked(key);
        throw new Error(
          `port ${port} is serving a Metro that deckhand did not start — another Expo/React Native ` +
            `dev server on this machine claimed it; stop it and start the preview again`,
        );
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    await this.stopLocked(key);
    throw new Error(`Metro did not become ready on port ${port} within 60s`);
  }

  /**
   * Whether the listener on `port` belongs to the process group we spawned.
   *
   * `reuse` distinguishes the two callers when the probe is inconclusive (null =
   * no lsof, or a race). Just after spawning, the port was verified free seconds
   * earlier, so ours is overwhelmingly the likely owner. On the reuse path that
   * argument is gone — minutes or hours have passed — and the failure it has to
   * catch is precisely "our Metro died and someone else's `expo start` took the
   * port", which would serve THEIR bundle into this app's shell. So there we
   * fall back to whether our own process is still alive, which is exactly the
   * condition that case turns on, rather than assuming ownership.
   */
  private async ownsPort(port: number, childPid: number | undefined, reuse = false): Promise<boolean> {
    if (!childPid) return false;
    const pgid = await this.listenerPgidImpl(port);
    if (pgid != null) return pgid === childPid;
    return reuse ? this.pidAliveImpl(childPid) : true;
  }

  /** Stop every Metro this manager started (server shutdown). */
  stop(): Promise<void> {
    return this.lock(async () => {
      for (const key of [...this.running.keys()]) await this.stopLocked(key);
    });
  }

  /**
   * Stop every Metro belonging to `appId`.
   *
   * Teardown has to be app-scoped: a blind `stop()` from one preview's teardown
   * would pull the dev server out from under another app's live preview. Nothing
   * called `stop()` at all before, which is how a Metro survived every
   * `stop_preview` and quietly kept its port for the rest of the server's life.
   * The caller (`stopMetroIfUnused`) only calls this once no preview of the app
   * is left, so stopping all of the app's servers is right.
   */
  stopApp(appId: string): Promise<void> {
    return this.lock(async () => {
      for (const [key, m] of [...this.running]) if (m.appId === appId) await this.stopLocked(key);
    });
  }

  /**
   * Kill the running Metro and WAIT for its port to come back.
   *
   * Firing SIGTERM and returning immediately was a slow port leak: a Metro that
   * ignores or outlives the signal keeps listening, `freePort()` skips past it
   * on the next allocation, and after enough app/env restarts the whole
   * 8081-8099 range is spoken for by processes nothing owns any more — every
   * Expo preview then fails with "no free Metro port" until the machine is
   * rebooted. So escalate to SIGKILL and only give up once the port is
   * genuinely unreclaimable.
   *
   * Signals go to a process GROUP, so ownership is checked before every one of
   * them — an entry in `this.running` can hold a child that died hours ago (exactly the case
   * `ownsPort(reuse)` exists to catch) whose pid the OS may since have recycled
   * onto an unrelated job. Two independent proofs of ownership are accepted:
   * our direct child is still running, or the listener on our port is still in
   * our process group. The second one carries the escalation: `npx` has no
   * SIGTERM handler and dies instantly, while the Metro GRANDCHILD that
   * actually holds the port installs one and can hang on a simulator's
   * dev-client websocket — so "child exited" is the normal state at the moment
   * SIGKILL is needed, and gating on child liveness alone leaked the port every
   * time. A listener that belongs to someone ELSE is never waited on: killing
   * our group cannot free it, and `ensureLocked` throws right after this.
   */
  private async stopLocked(key: string): Promise<void> {
    const cur = this.running.get(key);
    this.running.delete(key);
    const pid = cur?.child.pid;
    if (!cur || !pid) return;
    const childAlive = () => cur.child.exitCode == null && cur.child.signalCode == null && this.pidAliveImpl(pid);
    const listener = () => this.listenerPgidImpl(cur.port);
    // `null` from `listener()` is ambiguous: nothing is listening YET, or lsof
    // failed. On the readiness-timeout path the grandchild may be seconds away
    // from binding, and returning here would leak that port for the life of the
    // server — so a young entry is signalled on the strength of its age, while
    // an old one with a dead child is left alone (its pid may since have been
    // recycled onto something unrelated).
    if (!childAlive() && (await listener()) !== pid && Date.now() - cur.startedAt > 120_000) return;
    const signal = (sig: NodeJS.Signals) => {
      try {
        // Negative pid = the whole detached group: Metro's listener is a
        // grandchild of the `npx` we spawned, so signalling the child alone
        // leaves the actual port holder running.
        this.killImpl(-pid, sig);
      } catch {
        try {
          cur.child.kill(sig);
        } catch {
          // gone
        }
      }
    };
    signal("SIGTERM");
    const afterTerm = await listener();
    if (afterTerm != null && afterTerm !== pid) return; // someone else's port
    if (await this.waitForPort(cur.port, this.stopWaitMs[0])) return;
    // Still listening. Escalate only against a group we can still prove is
    // ours: the port's listener is in it, or (lsof said nothing) our own child
    // is still running.
    const holder = await listener();
    if (holder !== pid && !(holder == null && childAlive())) return;
    signal("SIGKILL");
    await this.waitForPort(cur.port, this.stopWaitMs[1]);
  }

  /** Poll until nothing is listening on `port`, or the budget runs out. */
  private async waitForPort(port: number, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await this.portFreeImpl(port)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
