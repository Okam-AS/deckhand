import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildCache, buildCacheKey, fileFingerprint, nativeFingerprint } from "./buildCache.ts";

const root = mkdtempSync(join(tmpdir(), "verify-cache-"));
after(() => rmSync(root, { recursive: true, force: true }));

function project(name: string): string {
  const repo = join(root, name);
  const app = join(repo, "apps", "mobile");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(app, "src"), { recursive: true });
  writeFileSync(join(repo, "pnpm-lock.yaml"), "lock: 1\n");
  writeFileSync(join(app, "package.json"), '{"dependencies":{"expo":"1"}}');
  writeFileSync(join(app, "app.json"), '{"expo":{"slug":"m"}}');
  writeFileSync(join(app, "src", "screen.tsx"), "export const a = 1;");
  return app;
}

describe("the build cache key", () => {
  it("ignores a JS-only change and follows native inputs, including the workspace lockfile", () => {
    const app = project("fp");
    const before = fileFingerprint(app);
    writeFileSync(join(app, "src", "screen.tsx"), "export const a = 2;");
    assert.equal(fileFingerprint(app), before, "a JS edit must reuse the binary");
    writeFileSync(join(app, "app.json"), '{"expo":{"slug":"m","ios":{"bundleIdentifier":"x"}}}');
    const afterConfig = fileFingerprint(app);
    assert.notEqual(afterConfig, before);
    writeFileSync(join(root, "fp", "pnpm-lock.yaml"), "lock: 2\n");
    assert.notEqual(fileFingerprint(app), afterConfig, "the lockfile at the repo root is a native input");
  });

  it("prefers the project's own expo fingerprint and falls back to files when it is missing", async () => {
    const app = project("runner");
    assert.deepEqual(await nativeFingerprint(app, {}, async () => "abc"), { hash: "abc", source: "expo" });
    const fallback = await nativeFingerprint(app, {}, async () => null);
    assert.deepEqual(fallback, { hash: fileFingerprint(app), source: "files" });
  });

  it("keys on the app, the bundle id and the fingerprint", () => {
    const fp = { hash: "h1", source: "expo" as const };
    const k = buildCacheKey({ appId: "a", bundleId: "b", platform: "ios-simulator", fingerprint: fp });
    assert.match(k, /^[0-9a-f]{32}$/);
    assert.equal(k, buildCacheKey({ appId: "a", bundleId: "b", platform: "ios-simulator", fingerprint: { ...fp } }));
    assert.notEqual(k, buildCacheKey({ appId: "a", bundleId: "b", platform: "ios-simulator", fingerprint: { hash: "h2", source: "expo" } }));
    assert.notEqual(k, buildCacheKey({ appId: "a", bundleId: "c", platform: "ios-simulator", fingerprint: fp }));
    assert.notEqual(k, buildCacheKey({ appId: "z", bundleId: "b", platform: "ios-simulator", fingerprint: fp }));
    assert.notEqual(k, buildCacheKey({ appId: "a", bundleId: "b", platform: "ios-simulator", fingerprint: { hash: "h1", source: "files" } }));
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
    assert.ok(hit?.endsWith("Mobile.app"));
    assert.equal(readFileSync(join(hit!, "Info.plist"), "utf8"), "one");
  });

  it("keeps only the most recently used builds", () => {
    const dir = join(root, "c2");
    const cache = new BuildCache(dir, 2);
    cache.store("old", builtApp("old"), {});
    cache.store("mid", builtApp("mid"), {});
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(dir, "old"), past, past);
    utimesSync(join(dir, "mid"), new Date(Date.now() - 30_000), new Date(Date.now() - 30_000));
    cache.lookup("old");
    cache.store("new", builtApp("new"), {});
    assert.ok(existsSync(join(dir, "old")), "a hit refreshes an entry");
    assert.ok(existsSync(join(dir, "new")));
    assert.ok(!existsSync(join(dir, "mid")));
  });
});
