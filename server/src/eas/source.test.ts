import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "../devices/android.ts";
import { EasClient, EasError, type EasBuild } from "./client.ts";
import { EasPreviews } from "./source.ts";
import { easBuild } from "../test-support/fakes.ts";

const PROJECT = "6ff82c98-0000-4000-8000-000000000001";
const token = () => ({ ok: true as const, token: "t" });

function client(over: Partial<Pick<EasClient, "build" | "latest">>): EasClient {
  const c = new EasClient(token, async () => new Response("{}", { status: 500 }));
  return Object.assign(c, over);
}

describe("EasPreviews", () => {
  it("refuses a named build for the wrong platform, an unfinished one, and a simulator build for a phone", async () => {
    const on = (b: EasBuild) => new EasPreviews(token, { client: client({ build: async () => b }) });
    await assert.rejects(on(easBuild({ platform: "IOS" })).resolve(PROJECT, "android", { buildId: "9a14f495" }), (e: unknown) => e instanceof EasError && e.code === "eas_wrong_artifact");
    await assert.rejects(on(easBuild({ status: "IN_PROGRESS" })).resolve(PROJECT, "android", { buildId: "9a14f495" }), (e: unknown) => e instanceof EasError && e.code === "eas_build_not_ready");
    await assert.rejects(on(easBuild({ platform: "IOS", isForIosSimulator: false })).resolve(PROJECT, "ios-simulator", { buildId: "9a14f495" }), /a device build/);
  });

  it("takes a profile's newest simulator build for a simulator, and names the eas build command when there is none", async () => {
    const asked: boolean[] = [];
    const p = new EasPreviews(token, {
      client: client({
        latest: async (_p, _profile, _platform, want) => {
          asked.push(want!(easBuild({ platform: "IOS", isForIosSimulator: true })), want!(easBuild({ platform: "IOS", isForIosSimulator: false })));
          return null;
        },
      }),
    });
    await assert.rejects(p.resolve(PROJECT, "ios-simulator", { profile: "sim" }), (e: unknown) => e instanceof EasError && /eas build --profile sim --platform ios/.test(e.hint ?? ""));
    assert.deepEqual(asked, [true, false]);
    await assert.rejects(p.resolve(PROJECT, "android", {}), (e: unknown) => e instanceof EasError && /easProfile/.test(e.hint ?? ""));
  });

  it("refuses an .aab before downloading anything, and an APK of another app after", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deckhand-eas-src-"));
    try {
      let fetched = 0;
      const fetchImpl: typeof fetch = async () => (fetched++, new Response("apk", { status: 200, headers: { "content-length": "3" } }));
      const exec: Exec = async () => ({ code: 0, stdout: Buffer.from("package: name='com.other.app' versionCode='1' versionName='1.0'\n"), stderr: "" });
      const p = new EasPreviews(token, { fetchImpl, cacheDir: dir, exec, aapt2: () => "/sdk/aapt2" });
      await assert.rejects(p.prepare(PROJECT, "android", easBuild({ artifacts: { buildUrl: "https://storage.example/app.aab" } }), "com.example.app", () => {}), /store \.aab/);
      assert.equal(fetched, 0);
      await assert.rejects(p.prepare(PROJECT, "android", easBuild(), "com.example.app", () => {}), (e: unknown) => e instanceof EasError && e.code === "eas_wrong_app");
      assert.equal(fetched, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
