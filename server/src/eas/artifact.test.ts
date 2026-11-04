import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecResult } from "../devices/android.ts";
import {
  appDirFromListing,
  downloadArtifact,
  extractSimulatorApp,
  inspectIpa,
  parseBadging,
  parseProvisioning,
  requireKind,
  simulatorAppFromListing,
  vetApk,
  vetIpa,
  type IpaInfo,
} from "./artifact.ts";
import { EasError } from "./client.ts";

const ID = "9a14f495-ad71-4e37-9648-b51a4620cea5";
const URL_ = "https://storage.example/artifacts/app-e2e.apk";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "deckhand-eas-"));
}

function serve(bytes: Buffer, opts: { length?: number; stallAfter?: number } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(ctl) {
        const upto = opts.stallAfter ?? bytes.length;
        ctl.enqueue(bytes.subarray(0, upto));
        if (upto >= bytes.length) ctl.close();
        else signal?.addEventListener("abort", () => ctl.error(new Error("aborted")));
      },
    });
    return new Response(body, { status: 200, headers: { "content-length": String(opts.length ?? bytes.length) } });
  };
  return { calls, fetchImpl };
}

describe("downloadArtifact", () => {
  it("streams to a .part, renames when whole, sends no credential, and reuses the file next time", async () => {
    const dir = tmp();
    try {
      const { calls, fetchImpl } = serve(Buffer.from("apk-bytes"));
      const first = await downloadArtifact({ id: ID, artifacts: { buildUrl: URL_ } }, { cacheDir: dir, fetchImpl });
      assert.equal(first.cached, false);
      assert.equal(first.path, join(dir, ID, "app-e2e.apk"));
      assert.equal(readFileSync(first.path, "utf8"), "apk-bytes");
      assert.deepEqual(readdirSync(join(dir, ID)), ["app-e2e.apk"]);
      assert.equal(new Headers(calls[0]!.init.headers).get("authorization"), null);
      const again = await downloadArtifact({ id: ID, artifacts: { buildUrl: URL_ } }, { cacheDir: dir, fetchImpl });
      assert.deepEqual([again.cached, calls.length], [true, 1]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never hands out a partial file when two downloads of one build overlap", async () => {
    const dir = tmp();
    try {
      let calls = 0;
      const slow: typeof fetch = async () => {
        calls++;
        let i = 0;
        const body = new ReadableStream<Uint8Array>({
          async pull(ctl) {
            if (i === 10) return ctl.close();
            await new Promise((r) => setTimeout(r, 5));
            ctl.enqueue(new Uint8Array(100).fill(65 + i++));
          },
        });
        return new Response(body, { status: 200, headers: { "content-length": "1000" } });
      };
      mkdirSync(join(dir, ID), { recursive: true });
      const foreign = join(dir, ID, "app-e2e.apk.4242.other.part");
      writeFileSync(foreign, "another process, mid-download");
      const abandoned = join(dir, ID, "app-e2e.apk.1.dead.part");
      writeFileSync(abandoned, "a crashed download");
      utimesSync(abandoned, new Date(0), new Date(0));
      const a = downloadArtifact({ id: ID, artifacts: { buildUrl: URL_ } }, { cacheDir: dir, fetchImpl: slow });
      await new Promise((r) => setTimeout(r, 20));
      const b = downloadArtifact({ id: ID, artifacts: { buildUrl: URL_ } }, { cacheDir: dir, fetchImpl: slow });
      const [ra, rb] = await Promise.all([a, b]);
      assert.equal(readFileSync(ra.path).length, 1000);
      assert.equal(readFileSync(rb.path).length, 1000);
      assert.equal(calls, 1, "one download per build at a time");
      assert.ok(existsSync(foreign), "a .part another process is still writing was deleted");
      assert.equal(existsSync(abandoned), false, "a .part nobody has written to for twice the idle window is left behind");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps nothing when fewer bytes arrive than content-length promised", async () => {
    const dir = tmp();
    try {
      const { fetchImpl } = serve(Buffer.from("short"), { length: 99 });
      await assert.rejects(downloadArtifact({ id: ID, artifacts: { buildUrl: URL_ } }, { cacheDir: dir, fetchImpl }), /got 5 of 99 bytes/);
      assert.deepEqual(readdirSync(join(dir, ID)), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives up when no data arrives for the idle window, however long the whole takes", async () => {
    const dir = tmp();
    try {
      const { fetchImpl } = serve(Buffer.from("0123456789"), { stallAfter: 4 });
      await assert.rejects(downloadArtifact({ id: ID, artifacts: { buildUrl: URL_ } }, { cacheDir: dir, fetchImpl, idleMs: 50 }), (e: unknown) => e instanceof EasError && /stalled/.test(e.message));
      assert.deepEqual(readdirSync(join(dir, ID)), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a build id that is not a UUID, a non-https URL and an odd file name before writing anything", async () => {
    const dir = tmp();
    try {
      const { calls, fetchImpl } = serve(Buffer.from("x"));
      await assert.rejects(downloadArtifact({ id: "../../etc", artifacts: { buildUrl: URL_ } }, { cacheDir: dir, fetchImpl }));
      await assert.rejects(downloadArtifact({ id: ID, artifacts: { buildUrl: "http://storage.example/a.apk" } }, { cacheDir: dir, fetchImpl }), /non-https/);
      await assert.rejects(downloadArtifact({ id: ID, artifacts: { buildUrl: "https://storage.example/.hidden" } }, { cacheDir: dir, fetchImpl }), /refusing an artifact named/);
      assert.equal(calls.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("artifact vetting", () => {
  const b = (url: string) => ({ id: ID, buildProfile: "preview", artifacts: { buildUrl: url } });

  it("refuses a store .aab with the eas.json change that makes an APK", () => {
    assert.throws(() => requireKind(b("https://x/app.aab"), "apk"), (e: unknown) => e instanceof EasError && e.code === "eas_wrong_artifact" && /buildType.*apk/.test(e.hint ?? ""));
    assert.doesNotThrow(() => requireKind(b("https://x/app.apk"), "apk"));
    assert.throws(() => requireKind(b("https://x/app.ipa"), "simulator"), /not an iOS simulator build/);
  });

  it("reads an APK's package and version from aapt2 badging, and refuses another app's", () => {
    const badge = parseBadging("package: name='no.example.app' versionCode='7' versionName='3.61.0' platformBuildVersionName='16'\nsdkVersion:'29'\n");
    assert.deepEqual(badge, { pkg: "no.example.app", versionCode: "7", versionName: "3.61.0" });
    assert.doesNotThrow(() => vetApk(badge, "no.example.app", ID));
    assert.throws(() => vetApk(badge, "no.example.other", ID), (e: unknown) => e instanceof EasError && e.code === "eas_wrong_app");
  });

  const ipa = (over: Partial<IpaInfo> = {}): IpaInfo => ({
    bundleId: "no.example.app",
    version: "1.0",
    buildVersion: "5",
    schemes: ["exp+example"],
    teamId: "TEAM1",
    provisionedDevices: ["00008110-000A1B2C3D4E5F60"],
    provisionsAllDevices: false,
    profileExpires: null,
    ...over,
  });

  it("lets an .ipa near an iPhone only when the profile lists it (any case) or all devices, and names the fix otherwise", () => {
    assert.doesNotThrow(() => vetIpa(ipa(), "no.example.app", "00008110-000a1b2c3d4e5f60", ID));
    assert.doesNotThrow(() => vetIpa(ipa({ provisionedDevices: [], provisionsAllDevices: true }), "no.example.app", "X", ID));
    assert.throws(() => vetIpa(ipa(), "no.example.app", "OTHER-UDID", ID), (e: unknown) => e instanceof EasError && e.code === "eas_not_provisioned" && /register the phone with EAS.*rebuild/.test(e.hint ?? ""));
    assert.throws(() => vetIpa(ipa(), "no.example.other", "00008110-000A1B2C3D4E5F60", ID), (e: unknown) => e instanceof EasError && e.code === "eas_wrong_app");
  });

  it("reads team, devices, all-devices and expiry out of a provisioning plist", () => {
    const xml = `<?xml version="1.0"?><plist><dict><key>ExpirationDate</key><date>2027-01-01T00:00:00Z</date><key>ProvisionedDevices</key><array><string>A</string><string>B</string></array><key>TeamIdentifier</key><array><string>T1</string></array></dict></plist>`;
    assert.deepEqual(parseProvisioning(xml), { teamId: "T1", provisionedDevices: ["A", "B"], provisionsAllDevices: false, profileExpires: "2027-01-01T00:00:00Z" });
    assert.equal(parseProvisioning("<key>ProvisionsAllDevices</key><true/>").provisionsAllDevices, true);
  });

  it("wants exactly one Payload/*.app in an .ipa, and extracts only its two files", async () => {
    assert.equal(appDirFromListing("Payload/\nPayload/App.app/\nPayload/App.app/Info.plist\n"), "Payload/App.app");
    assert.throws(() => appDirFromListing("Payload/A.app/x\nPayload/B.app/y\n"), /found 2/);
    const seen: string[][] = [];
    const exec: Exec = async (cmd, args) => {
      seen.push([cmd, ...args]);
      if (cmd === "unzip" && args[0] === "-Z1") return ok("Payload/App.app/Info.plist\nPayload/App.app/embedded.mobileprovision\nPayload/App.app/App\n");
      if (cmd === "unzip") {
        const dest = args[args.indexOf("-d") + 1]!;
        mkdirSync(join(dest, "Payload/App.app"), { recursive: true });
        writeFileSync(join(dest, "Payload/App.app/embedded.mobileprovision"), Buffer.concat([Buffer.from([0x30, 0x82]), Buffer.from("<?xml?><plist><key>TeamIdentifier</key><array><string>T1</string></array></plist>"), Buffer.from([0])]));
        return ok("");
      }
      return ok(JSON.stringify({ CFBundleIdentifier: "no.example.app", CFBundleVersion: "5", CFBundleURLTypes: [{ CFBundleURLSchemes: ["exp+example"] }] }));
    };
    const info = await inspectIpa("/cache/x.ipa", exec);
    assert.deepEqual([info.bundleId, info.buildVersion, info.teamId, info.schemes], ["no.example.app", "5", "T1", ["exp+example"]]);
    const extract = seen.find((c) => c[0] === "unzip" && c[1] === "-o")!;
    assert.deepEqual(extract.slice(4, 6), ["Payload/App.app/Info.plist", "Payload/App.app/embedded.mobileprovision"]);
    assert.ok(!existsSync(extract[extract.indexOf("-d") + 1]!), "the temp dir is removed");
  });
});

function ok(stdout: string): ExecResult {
  return { code: 0, stdout: Buffer.from(stdout), stderr: "" };
}

describe("the iOS simulator archive", () => {
  it("wants one top-level .app and refuses absolute or parent paths", () => {
    assert.equal(simulatorAppFromListing("./App.app/\n./App.app/Info.plist\n"), "App.app");
    assert.throws(() => simulatorAppFromListing("App.app/x\n../evil\n"), /unsafe path/);
    assert.throws(() => simulatorAppFromListing("/etc/passwd\n"), /unsafe path/);
    assert.throws(() => simulatorAppFromListing("A.app/x\nB.app/y\n"), /found 2/);
    assert.throws(() => simulatorAppFromListing("App.app/x\nscript.sh\n"), /beside the app/);
  });

  it("unpacks once beside the archive, however many ask at once, and reads the bundle id", async () => {
    const dir = tmp();
    try {
      const src = join(dir, "src");
      mkdirSync(join(src, "App.app"), { recursive: true });
      writeFileSync(join(src, "App.app", "Info.plist"), "plist");
      const archive = join(dir, "build.tar.gz");
      execFileSync("tar", ["-czf", archive, "-C", src, "App.app"]);
      let untars = 0;
      const exec: Exec = async (cmd, args) => {
        if (cmd === "plutil") return ok(JSON.stringify({ CFBundleIdentifier: "no.example.app", CFBundleVersion: "9" }));
        if (args[0] === "-xzf") untars++;
        try {
          return ok(execFileSync(cmd, args).toString());
        } catch (e) {
          return { code: 1, stdout: Buffer.from(""), stderr: String(e) };
        }
      };
      const [a, overlapping] = await Promise.all([extractSimulatorApp(archive, exec), extractSimulatorApp(archive, exec)]);
      const b = await extractSimulatorApp(archive, exec);
      assert.equal(a.appPath, join(dir, "build", "unpacked", "App.app"));
      assert.equal(overlapping.appPath, a.appPath);
      assert.deepEqual([b.bundleId, b.buildVersion, untars], ["no.example.app", "9", 1], "two overlapping unpacks each wiped the other's directory");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
