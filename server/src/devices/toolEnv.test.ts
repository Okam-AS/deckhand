import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { firstExisting, androidHomeCandidates, sdkPathDirs, resolveJavaHome } from "./toolEnv.ts";

describe("firstExisting", () => {
  it("returns the first candidate that exists", () => {
    const exists = (p: string) => p === "/b" || p === "/c";
    assert.equal(firstExisting(["/a", "/b", "/c"], exists), "/b");
    assert.equal(firstExisting(["/x"], exists), null);
  });
});

describe("androidHomeCandidates", () => {
  it("prefers ANDROID_HOME, then ANDROID_SDK_ROOT, then default locations", () => {
    const c = androidHomeCandidates({ ANDROID_HOME: "/opt/sdk", ANDROID_SDK_ROOT: "/opt/sdk2" }, "/Users/x");
    assert.equal(c[0], "/opt/sdk");
    assert.equal(c[1], "/opt/sdk2");
    assert.ok(c.some((p) => p.includes("Library/Android/sdk")));
  });

  it("omits unset env vars", () => {
    const c = androidHomeCandidates({}, "/Users/x");
    assert.ok(!c.includes(undefined as unknown as string));
    assert.ok(c[0]!.includes("/Users/x"));
  });
});

describe("sdkPathDirs", () => {
  it("includes platform-tools, emulator, and cmdline-tools", () => {
    const dirs = sdkPathDirs("/sdk");
    assert.deepEqual(dirs, [
      "/sdk/platform-tools",
      "/sdk/emulator",
      "/sdk/cmdline-tools/latest/bin",
      "/sdk/tools/bin",
    ]);
  });
});

describe("resolveJavaHome", () => {
  const exists = () => true;
  it("takes an existing JAVA_HOME as is", () => {
    assert.equal(resolveJavaHome({ JAVA_HOME: "/jdk" }, exists, () => "/other"), "/jdk");
  });

  it("falls back from 21 to 17 when the locator has no exact match", () => {
    const locate = (m: string) => (m === "17" ? "/jdk17" : undefined);
    assert.equal(resolveJavaHome({}, exists, locate), "/jdk17");
  });

  it("answers undefined rather than a non-LTS default JDK", () => {
    assert.equal(resolveJavaHome({}, exists, () => undefined), undefined);
  });
});
