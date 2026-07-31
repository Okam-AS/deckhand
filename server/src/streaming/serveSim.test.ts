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

describe("ServeSimBackend — surviving helpers", () => {
  const detachOk = async (_bin: string, args: string[]): Promise<string> => {
    const udid = args[args.length - 1]!;
    const port = args[args.indexOf("-p") + 1]!;
    return JSON.stringify({
      url: `http://127.0.0.1:${port}`,
      streamUrl: `http://127.0.0.1:${port}/helper/${udid}/stream.mjpeg`,
      wsUrl: `ws://127.0.0.1:${port}/helper/${udid}/ws`,
      port: Number(port),
      device: udid,
    });
  };

  it("never allocates a port a stale helper is still listening on", async () => {
    // The in-memory map is empty in a fresh process, but detached helpers from the previous
    // one are still alive. Allocating over one adopts a daemon bound to a simulator that no
    // longer exists — it answers, and serves that dead sim's last frame forever.
    const backend = new ServeSimBackend({
      portRange: [3100, 3102],
      detachImpl: detachOk,
      killImpl: async () => {},
      listenersImpl: async (port) => (port === 3100 ? [85527] : []),
      killPidImpl: () => {},
    });
    const stream = await backend.attach({ platform: "ios", udid: "NEW-UDID" } as never);
    assert.ok(stream.origin.endsWith(":3101"), `expected the occupied 3100 to be skipped, got ${stream.origin}`);
  });

  it("reapOrphans kills what `serve-sim -k` left behind", async () => {
    // `serve-sim -k` is a request, not a guarantee: a detached daemon that ignores it outlives
    // the server and gets adopted by the next one.
    const alive = new Set([3100, 3102]);
    const killed: number[] = [];
    const backend = new ServeSimBackend({
      portRange: [3100, 3102],
      detachImpl: detachOk,
      killImpl: async () => {}, // pretends to work, changes nothing — the real-world failure
      listenersImpl: async (port) => (alive.has(port) ? [9000 + port] : []),
      killPidImpl: (pid) => killed.push(pid),
    });
    await backend.reapOrphans();
    assert.deepEqual(killed.sort(), [12100, 12102], "every surviving listener in the range must be signalled");
  });

  it("a pid that dies between the scan and the signal is not an error", async () => {
    const backend = new ServeSimBackend({
      portRange: [3100, 3100],
      detachImpl: detachOk,
      killImpl: async () => {},
      listenersImpl: async () => [4242],
      killPidImpl: () => {
        throw new Error("ESRCH");
      },
    });
    await backend.reapOrphans(); // must not throw — the process is gone, which is the goal
  });
});
