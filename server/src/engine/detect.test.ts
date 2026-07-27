import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectAppType,
  detectFromRepo,
  detectWebFramework,
  webHostingMode,
  expoBundleId,
  expoSlug,
  nativescriptBundleId,
  expoDevClientUrl,
} from "./detect.ts";

/** A read/hasEntry pair backed by an in-memory file map (paths → contents). */
function repoFrom(files: Record<string, string>) {
  const read = async (p: string): Promise<string | null> => files[p] ?? null;
  const hasEntry = async (p: string): Promise<boolean> => Object.keys(files).some((k) => k === p || k.startsWith(`${p}/`));
  return { read, hasEntry };
}

describe("detectFromRepo", () => {
  it("detects a NativeScript app + its bundle id from git-object reads", async () => {
    const { read, hasEntry } = repoFrom({
      "package.json": JSON.stringify({ dependencies: { "@nativescript/core": "^8" } }),
      "nativescript.config.ts": "export default { id: 'no.okam.admin', appPath: 'app' } as any;",
    });
    assert.deepEqual(await detectFromRepo(read, hasEntry), { type: "nativescript", bundleId: "no.okam.admin" });
  });

  it("detects an Expo app + iOS bundle id from app.json", async () => {
    const { read, hasEntry } = repoFrom({
      "package.json": JSON.stringify({ dependencies: { expo: "~51.0.0" } }),
      "app.json": JSON.stringify({ expo: { slug: "demo", ios: { bundleIdentifier: "com.demo.app" } } }),
    });
    assert.deepEqual(await detectFromRepo(read, hasEntry), { type: "expo", bundleId: "com.demo.app" });
  });

  it("returns nulls when nothing identifies the app (caller asks for type)", async () => {
    const { read, hasEntry } = repoFrom({ "readme.md": "# hi" });
    assert.deepEqual(await detectFromRepo(read, hasEntry), { type: null, bundleId: null });
  });
});

describe("detectAppType", () => {
  const base = { hasNativescriptConfig: false, hasIosDir: false, hasAndroidDir: false };

  it("detects expo", () => {
    assert.equal(
      detectAppType({ ...base, packageJson: { dependencies: { expo: "~51.0.0", "react-native": "0.74" } } }),
      "expo",
    );
  });

  it("detects nativescript before react-native (more specific wins)", () => {
    assert.equal(
      detectAppType({
        ...base,
        packageJson: { dependencies: { "@nativescript/core": "8", "react-native": "0.74" } },
        hasNativescriptConfig: true,
      }),
      "nativescript",
    );
    assert.equal(
      detectAppType({ ...base, packageJson: { dependencies: { nativescript: "8" } } }),
      "nativescript",
    );
  });

  it("detects bare react-native by dep or native dirs", () => {
    assert.equal(
      detectAppType({ ...base, packageJson: { dependencies: { "react-native": "0.74" } } }),
      "react-native",
    );
    assert.equal(detectAppType({ ...base, packageJson: { dependencies: {} }, hasIosDir: true }), "react-native");
  });

  it("detects a Vite frontend as web", () => {
    assert.equal(detectAppType({ ...base, packageJson: { devDependencies: { vite: "^5" } } }), "web");
    assert.equal(
      detectAppType({ ...base, packageJson: { dependencies: { react: "18" }, devDependencies: { vite: "^5" } } }),
      "web",
    );
  });

  it("detects Nuxt and Next as web too", () => {
    assert.equal(detectAppType({ ...base, packageJson: { dependencies: { nuxt: "^2.14.11" } } }), "web");
    assert.equal(detectAppType({ ...base, packageJson: { dependencies: { next: "14" } } }), "web");
  });

  it("never lets web steal a mobile project that also pulls in vite", () => {
    // Expo/RN win even with vite present — web is checked last.
    assert.equal(
      detectAppType({ ...base, packageJson: { dependencies: { expo: "~51" }, devDependencies: { vite: "^5" } } }),
      "expo",
    );
    assert.equal(
      detectAppType({ ...base, packageJson: { dependencies: { "react-native": "0.74" }, devDependencies: { vite: "^5" } } }),
      "react-native",
    );
  });

  it("returns null when nothing matches", () => {
    assert.equal(detectAppType({ ...base, packageJson: { dependencies: { lodash: "4" } } }), null);
    assert.equal(detectAppType({ ...base, packageJson: null }), null);
  });
});

describe("web framework + hosting mode", () => {
  it("classifies the web framework from deps (nuxt/next win over vite)", () => {
    assert.equal(detectWebFramework({ dependencies: { nuxt: "^2.14.11" }, devDependencies: { vite: "^5" } }), "nuxt");
    assert.equal(detectWebFramework({ dependencies: { next: "14" } }), "next");
    assert.equal(detectWebFramework({ devDependencies: { vite: "^5" } }), "vite");
    assert.equal(detectWebFramework({ dependencies: { lodash: "4" } }), null);
  });

  it("hosts Vite (and undetected) path-based, and Nuxt/Next/static on a subdomain", () => {
    assert.equal(webHostingMode("vite"), "path");
    assert.equal(webHostingMode("nuxt"), "subdomain");
    assert.equal(webHostingMode("next"), "subdomain");
    assert.equal(webHostingMode("static"), "subdomain");
    assert.equal(webHostingMode(null), "path"); // undetected → safe Vite-style path default
  });
});

describe("bundle id / slug", () => {
  it("reads expo bundle id from nested and flat config", () => {
    assert.equal(expoBundleId({ expo: { ios: { bundleIdentifier: "com.a.b" } } }, "ios"), "com.a.b");
    assert.equal(expoBundleId({ ios: { bundleIdentifier: "com.flat.b" } }, "ios"), "com.flat.b");
    assert.equal(expoBundleId({ expo: { android: { package: "com.a.b" } } }, "android"), "com.a.b");
    assert.equal(expoBundleId(null, "ios"), null);
    assert.equal(expoBundleId({ expo: {} }, "ios"), null);
  });

  it("reads expo slug", () => {
    assert.equal(expoSlug({ expo: { slug: "my-app" } }), "my-app");
    assert.equal(expoSlug({ slug: "flat" }), "flat");
    assert.equal(expoSlug(null), null);
  });

  it("reads nativescript id", () => {
    assert.equal(nativescriptBundleId({ id: "org.ns.app" }), "org.ns.app");
    assert.equal(nativescriptBundleId(null), null);
  });
});

describe("expoDevClientUrl", () => {
  it("builds a dev-client deep link with the metro url and disableOnboarding", () => {
    const url = expoDevClientUrl("my-app", "http://127.0.0.1:8081");
    assert.match(url, /^exp\+my-app:\/\/expo-development-client\//);
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("url"), "http://127.0.0.1:8081");
    assert.equal(parsed.searchParams.get("disableOnboarding"), "1");
  });
});
