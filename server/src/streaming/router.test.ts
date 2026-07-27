import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StreamingRouter } from "./router.ts";
import type { AttachedStream, StreamDeviceRef, StreamingBackend } from "./backend.ts";

function fakeBackend(tag: string, calls: string[]): StreamingBackend {
  return {
    attach: async (d: StreamDeviceRef) => {
      calls.push(`${tag}:${d.platform}`);
      return { origin: `http://${tag}`, helperBasePath: "/h", waitForFirstFrame: async () => true, describe: async () => "", detach: async () => {} } as AttachedStream;
    },
    reapOrphans: async () => {
      calls.push(`${tag}:reap`);
    },
  };
}

describe("StreamingRouter", () => {
  it("routes each platform to its backend (iOS / Android / web)", async () => {
    const calls: string[] = [];
    const router = new StreamingRouter(fakeBackend("ios", calls), fakeBackend("android", calls), fakeBackend("web", calls));

    const iosStream = await router.attach({ platform: "ios", udid: "U" });
    assert.equal(iosStream.origin, "http://ios");
    const andStream = await router.attach({ platform: "android", udid: "avd", serial: "emulator-5554" });
    assert.equal(andStream.origin, "http://android");
    const webStream = await router.attach({ platform: "web", udid: "", port: 5173, basePath: "/s/x/web" });
    assert.equal(webStream.origin, "http://web");

    assert.deepEqual(calls, ["ios:ios", "android:android", "web:web"]);
  });

  it("reaps orphans on every backend", async () => {
    const calls: string[] = [];
    const router = new StreamingRouter(fakeBackend("ios", calls), fakeBackend("android", calls), fakeBackend("web", calls));
    await router.reapOrphans();
    assert.ok(calls.includes("ios:reap"));
    assert.ok(calls.includes("android:reap"));
    assert.ok(calls.includes("web:reap"));
  });
});
