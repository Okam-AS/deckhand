import { randomBytes } from "node:crypto";
import express from "express";
import { bearerToken, type TokenAuthenticator } from "../auth.ts";
import type { AttachedStream, StreamDeviceRef } from "../streaming/backend.ts";
import type { SimDevice } from "../devices/ios.ts";
import { VERIFY_SIM_PREFIX } from "../verify/device.ts";

/** The one device id a live share exposes; the viewer addresses it like a preview's first iOS device. */
export const LIVE_DEVICE_ID = "ios-0";
const FIRST_FRAME_MS = 30_000;
const MAX_AGE_MS = 12 * 60 * 60_000;
const SWEEP_MS = 5_000;
const MAX_REVOKED = 1000;

export interface LiveShare {
  shareId: string;
  udid: string;
  label: string;
  appId: string;
  pid: number;
  createdAt: number;
  stream: AttachedStream;
}

export interface LiveShareDeps {
  attach: (device: StreamDeviceRef) => Promise<AttachedStream>;
  listDevices: () => Promise<SimDevice[]>;
  pidAlive?: (pid: number) => boolean;
  genShareId?: () => string;
  now?: () => number;
  firstFrameMs?: number;
}

export class LiveShareError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * View-only public shares of a `deckhand verify` simulator. Each lives only as long as the verify
 * process that asked for it: revoked on request, or swept once that pid is gone.
 */
export class LiveShareRegistry {
  private readonly shares = new Map<string, LiveShare>();
  private readonly revoked = new Set<string>();
  private readonly now: () => number;
  private readonly pidAlive: (pid: number) => boolean;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly d: LiveShareDeps) {
    this.now = d.now ?? Date.now;
    this.pidAlive = d.pidAlive ?? defaultPidAlive;
  }

  async create(req: { udid: string; appId: string; pid: number }): Promise<LiveShare> {
    const dev = (await this.d.listDevices()).find((x) => x.udid === req.udid);
    if (!dev || !dev.name.startsWith(VERIFY_SIM_PREFIX)) {
      throw new LiveShareError(403, `${req.udid} is not a ${VERIFY_SIM_PREFIX}… simulator; only a verify run's device can be shared this way`);
    }
    if (dev.state !== "Booted") throw new LiveShareError(409, `${dev.name} is not booted`);
    if (!this.pidAlive(req.pid)) throw new LiveShareError(400, `pid ${req.pid} is not running`);
    for (const s of this.shares.values()) if (s.udid === req.udid) await this.revoke(s.shareId);
    const stream = await this.d.attach({ platform: "ios", udid: req.udid });
    if (!(await stream.waitForFirstFrame(this.d.firstFrameMs ?? FIRST_FRAME_MS))) {
      await stream.detach().catch(() => {});
      throw new LiveShareError(504, `the stream of ${dev.name} produced no first frame`);
    }
    const share: LiveShare = {
      shareId: (this.d.genShareId ?? (() => randomBytes(18).toString("base64url")))(),
      udid: req.udid,
      label: dev.name,
      appId: req.appId,
      pid: req.pid,
      createdAt: this.now(),
      stream,
    };
    this.shares.set(share.shareId, share);
    return share;
  }

  async revoke(shareId: string): Promise<boolean> {
    const s = this.shares.get(shareId);
    if (!s) return false;
    this.shares.delete(shareId);
    this.revoked.add(shareId);
    if (this.revoked.size > MAX_REVOKED) this.revoked.delete(this.revoked.values().next().value!);
    await s.stream.detach().catch(() => {});
    return true;
  }

  /** A live share, or null; an owner that died or a share past its age cap reads as revoked. */
  find(shareId: string): LiveShare | null {
    const s = this.shares.get(shareId);
    if (!s) return null;
    if (this.expired(s)) {
      void this.revoke(shareId);
      return null;
    }
    return s;
  }

  /** A share this process revoked, so its link answers 410 rather than an ordinary viewer shell. */
  wasRevoked(shareId: string): boolean {
    if (this.shares.has(shareId)) this.find(shareId);
    return this.revoked.has(shareId);
  }

  private expired(s: LiveShare): boolean {
    return this.now() - s.createdAt > MAX_AGE_MS || !this.pidAlive(s.pid);
  }

  async sweep(): Promise<void> {
    for (const s of [...this.shares.values()]) if (this.expired(s)) await this.revoke(s.shareId);
  }

  startSweeper(everyMs = SWEEP_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep().catch(() => {}), everyMs);
    this.timer.unref?.();
  }
}

function isLoopback(ip: string | undefined): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

/**
 * `POST /admin/live-shares` {udid, appId, pid} → {shareId, url}; `DELETE /admin/live-shares/:shareId`.
 * Bearer-gated like /mcp, and refused when the request came through the tunnel: cloudflared connects
 * from loopback too, so the Cloudflare headers are the only sign a request is not from this machine.
 */
export function createLiveShareRouter(deps: { registry: LiveShareRegistry; auth: TokenAuthenticator; baseUrl: string }): express.Router {
  const router = express.Router();
  router.use((req, res, next) => {
    if (!isLoopback(req.ip) || req.headers["cf-connecting-ip"] != null || req.headers["cf-ray"] != null) {
      res.status(404).end();
      return;
    }
    const token = bearerToken(req.headers.authorization);
    if (!token || !deps.auth.authenticate(token)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  });
  router.post("/", express.json({ limit: "1kb" }), async (req, res) => {
    const b = req.body as { udid?: unknown; appId?: unknown; pid?: unknown };
    if (typeof b?.udid !== "string" || typeof b.appId !== "string" || !Number.isInteger(b.pid)) {
      res.status(400).json({ error: "body is {udid, appId, pid}" });
      return;
    }
    try {
      const s = await deps.registry.create({ udid: b.udid, appId: b.appId, pid: b.pid as number });
      res.status(201).json({ shareId: s.shareId, url: `${deps.baseUrl}/s/${s.shareId}` });
    } catch (e) {
      const status = e instanceof LiveShareError ? e.status : 502;
      res.status(status).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });
  router.delete("/:shareId", async (req, res) => {
    res.status((await deps.registry.revoke(req.params.shareId)) ? 204 : 404).end();
  });
  return router;
}
