import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { basePathFromStreamUrl, ServeSimBackend } from "./serveSim.ts";

describe("basePathFromStreamUrl", () => {
  it("derives /helper/<udid> from a detach streamUrl", () => {
    assert.equal(
      basePathFromStreamUrl("http://127.0.0.1:3160/helper/ABC-123/stream.mjpeg"),
      "/helper/ABC-123",
    );
    assert.equal(basePathFromStreamUrl("http://127.0.0.1:3160/stream.mjpeg"), "");
    assert.equal(basePathFromStreamUrl("http://h/helper/x/stream.avcc"), "/helper/x");
  });
});

describe("ServeSimBackend.attach (detach flow)", () => {
  it("runs `serve-sim --detach`, parses the reported URLs, and exposes the /helper base", async () => {
    const calls: string[][] = [];
    const backend = new ServeSimBackend({
      portRange: [3100, 3110],
      detachImpl: async (_bin, args) => {
        calls.push(args);
        const udid = args[args.length - 1]!;
        const port = args[args.indexOf("-p") + 1]!;
        return JSON.stringify({
          url: `http://127.0.0.1:${port}`,
          streamUrl: `http://127.0.0.1:${port}/helper/${udid}/stream.mjpeg`,
          wsUrl: `ws://127.0.0.1:${port}/helper/${udid}/ws`,
          port: Number(port),
          device: udid,
        });
      },
      killImpl: async (_bin, args) => {
        calls.push(args);
      },
      fetchImpl: (async () => new Response(new Uint8Array(8192))) as unknown as typeof fetch,
    });

    const stream = await backend.attach({ platform: "ios", udid: "UDID-9" });
    assert.match(stream.helperBasePath, /^\/helper\/UDID-9$/);
    assert.ok(calls.some((a) => a[0] === "--detach" && a.includes("UDID-9")));
    assert.equal(await stream.waitForFirstFrame(2000), true);

    await stream.detach();
    assert.ok(calls.some((a) => a[0] === "-k" && a[1] === "UDID-9"));
  });
});
