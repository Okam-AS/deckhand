import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildCache, buildCacheKey, type CacheKeyInput } from "./buildCache.ts";

const root = mkdtempSync(join(tmpdir(), "verify-cache-"));
after(() => rmSync(root, { recursive: true, force: true }));

describe("the build cache key", () => {
  const base: CacheKeyInput = { appId: "a", bundleId: "b", fingerprint: "h1", xcode: "Xcode 26.6 Build version 17E", runtime: "iOS 26.5" };

  it("changes with every input that makes a simulator binary not interchangeable", () => {
    const k = buildCacheKey(base);
    assert.match(k, /^[0-9a-f]{32}$/);
    assert.equal(k, buildCacheKey({ ...base }));
    for (const change of [{ fingerprint: "h2" }, { bundleId: "c" }, { appId: "z" }, { xcode: "Xcode 27.0" }, { runtime: "iOS 27.0" }]) {
      assert.notEqual(buildCacheKey({ ...base, ...change }), k, JSON.stringify(change));
    }
  });
});

describe("BuildCache", () => {
  function builtApp(tag: string): string {
    const app = join(root, `built-${tag}`, "Mobile.app");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, "Info.plist"), tag);
    return app;
  }

  it("misses, then hits with a copy that survives the original build going away", () => {
    const cache = new BuildCache(join(root, "c1"));
    assert.equal(cache.lookup("k1"), null);
    const src = builtApp("one");
    cache.store("k1", src, { appId: "a" });
    rmSync(src, { recursive: true });
    const hit = cache.lookup("k1");
    assert.ok(hit?.app.endsWith("Mobile.app"));
    assert.equal(readFileSync(join(hit!.app, "Info.plist"), "utf8"), "one");
    hit!.done();
  });

  it("keeps the first store of a key when a second run stores it too, and leaves no temp dir", () => {
    const dir = join(root, "race");
    const cache = new BuildCache(dir);
    cache.store("k", builtApp("first"), {});
    cache.store("k", builtApp("second"), {});
    const hit = cache.lookup("k")!;
    assert.equal(readFileSync(join(hit.app, "Info.plist"), "utf8"), "first");
    hit.done();
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith(".tmp-")), []);
  });

  it("keeps only the most recently used builds, and never one being installed", () => {
    const dir = join(root, "c2");
    const cache = new BuildCache(dir, 2);
    cache.store("old", builtApp("old"), {});
    cache.store("mid", builtApp("mid"), {});
    const age = (k: string, ms: number) => utimesSync(join(dir, k), new Date(Date.now() - ms), new Date(Date.now() - ms));
    const inUse = cache.lookup("mid")!;
    age("mid", 30_000);
    age("old", 60_000);
    cache.lookup("old")!.done();
    cache.store("new", builtApp("new"), {});
    assert.ok(existsSync(join(dir, "old")), "a hit refreshes an entry");
    assert.ok(existsSync(join(dir, "new")));
    assert.ok(existsSync(join(dir, "mid")), "an entry being installed is not pruned");
    inUse.done();
    cache.store("newer", builtApp("newer"), {});
    assert.ok(!existsSync(join(dir, "mid")));
  });
});
