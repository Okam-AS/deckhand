import type { AttachedStream, StreamDeviceRef, StreamingBackend } from "./backend.ts";

// ---------------------------------------------------------------------------
// Streaming backend router: dispatches by platform. iOS → serve-sim,
// Android → the adb backend (`screenrecord` H.264, `screencap` MJPEG fallback),
// web → the dev-server proxy backend. The engine, proxy, and MCP tools only ever
// see the StreamingBackend interface.
// ---------------------------------------------------------------------------

export class StreamingRouter implements StreamingBackend {
  constructor(
    private readonly ios: StreamingBackend,
    private readonly android: StreamingBackend,
    private readonly web: StreamingBackend,
  ) {}

  attach(device: StreamDeviceRef): Promise<AttachedStream> {
    return this.backendFor(device.platform).attach(device);
  }

  private backendFor(platform: StreamDeviceRef["platform"]): StreamingBackend {
    if (platform === "web") return this.web;
    if (platform === "android") return this.android;
    return this.ios;
  }

  async reapOrphans(keep?: ReadonlySet<string>): Promise<void> {
    await Promise.all([this.ios.reapOrphans(keep), this.android.reapOrphans(keep), this.web.reapOrphans(keep)]);
  }
}
