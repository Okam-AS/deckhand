import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAvdList,
  parseSystemImages,
  selectSystemImage,
  serialForPort,
  bootCompleted,
  compactUiAutomatorXml,
  AndroidError,
  AndroidManager,
  type ExecResult,
} from "./android.ts";

/** An AndroidManager wired to a fake `adb` that dispatches on the shell verb. */
function fakeManager(reply: (args: string[]) => Partial<ExecResult>) {
  const calls: string[] = [];
  const exec = async (_cmd: string, args: string[]): Promise<ExecResult> => {
    calls.push(args.join(" "));
    const r = reply(args);
    return { code: r.code ?? 0, stdout: r.stdout ?? Buffer.from(""), stderr: r.stderr ?? "" };
  };
  return { mgr: new AndroidManager(exec), calls };
}
const buf = (s: string): Buffer => Buffer.from(s);

describe("AndroidManager.launch", () => {
  it("uses `am start` on the resolved activity and never falls back to monkey", async () => {
    const { mgr, calls } = fakeManager((args) => {
      if (args.includes("resolve-activity"))
        return { stdout: buf("priority=0 preferredOrder=0\nno.okam.store/com.tns.NativeScriptActivity\n") };
      if (args.includes("am") && args.includes("start"))
        return { stdout: buf("Starting: Intent { cmp=no.okam.store/com.tns.NativeScriptActivity }") };
      return {};
    });
    await mgr.launch("emulator-5554", "no.okam.store");
    assert.ok(calls.some((c) => c.includes("am start -n no.okam.store/com.tns.NativeScriptActivity")));
    assert.ok(!calls.some((c) => c.includes("monkey")), "must not fall back to monkey on am-start success");
  });

  it("does not fail when monkey exits non-zero but the app is running (SYS_KEYS quirk)", async () => {
    const { mgr } = fakeManager((args) => {
      if (args.includes("resolve-activity")) return { stdout: buf("No activity found") }; // force the fallback
      if (args.includes("monkey")) return { code: 251, stderr: "** SYS_KEYS has no physical keys" };
      if (args.includes("dumpsys")) return { stdout: buf("TaskRecord ... A=no.okam.store U=0 ...") };
      return {};
    });
    await mgr.launch("emulator-5554", "no.okam.store"); // resolves despite monkey's 251
  });

  it("throws only when the app is genuinely not in the activity stack", async () => {
    const { mgr } = fakeManager((args) => {
      if (args.includes("resolve-activity")) return { stdout: buf("No activity found") };
      if (args.includes("monkey")) return { code: 251, stderr: "boom" };
      if (args.includes("dumpsys")) return { stdout: buf("nothing relevant here") };
      return {};
    });
    await assert.rejects(() => mgr.launch("emulator-5554", "no.okam.store"), (e) => e instanceof AndroidError);
  });
});

describe("AndroidManager.findApk", () => {
  const withApk = (layout: string[]): { wt: string; apk: string } => {
    const wt = mkdtempSync(join(tmpdir(), "dh-apk-"));
    const dir = join(wt, ...layout, "app", "build", "outputs", "apk", "debug");
    mkdirSync(dir, { recursive: true });
    const apk = join(dir, "app-debug.apk");
    writeFileSync(apk, "x");
    return { wt, apk };
  };

  it("finds a NativeScript APK under platforms/android/…", async () => {
    const { wt, apk } = withApk(["platforms", "android"]);
    try {
      assert.equal(await new AndroidManager().findApk(wt), apk);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it("finds a RN/Expo APK under android/…", async () => {
    const { wt, apk } = withApk(["android"]);
    try {
      assert.equal(await new AndroidManager().findApk(wt), apk);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it("returns null when there's no APK", async () => {
    const wt = mkdtempSync(join(tmpdir(), "dh-apk-"));
    try {
      assert.equal(await new AndroidManager().findApk(wt), null);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe("parseAvdList", () => {
  it("extracts AVD names", () => {
    const out = [
      "Available Android Virtual Devices:",
      "    Name: Pixel_7_API_34",
      "  Device: pixel_7 (Google)",
      "---------",
      "    Name: Pixel_Tablet_API_35",
    ].join("\n");
    assert.deepEqual(parseAvdList(out), ["Pixel_7_API_34", "Pixel_Tablet_API_35"]);
  });
});

describe("parseSystemImages / selectSystemImage", () => {
  const listing = [
    "  system-images;android-34;google_apis;arm64-v8a | 1 | ...",
    "  system-images;android-34;google_apis;x86_64    | 1 | ...",
    "  system-images;android-35;google_apis;arm64-v8a | 1 | ...",
    "  platforms;android-34                            | 3 | ...",
  ].join("\n");

  it("parses installed system images", () => {
    const imgs = parseSystemImages(listing);
    assert.deepEqual(
      imgs.map((i) => i.api).sort(),
      [34, 34, 35],
    );
  });

  it("defaults to the newest API", () => {
    assert.equal(selectSystemImage(parseSystemImages(listing)).api, 35);
  });

  it("matches a requested API and prefers arm64", () => {
    const sel = selectSystemImage(parseSystemImages(listing), "34");
    assert.equal(sel.api, 34);
    assert.match(sel.pkg, /arm64/);
    assert.equal(selectSystemImage(parseSystemImages(listing), "android 34").api, 34);
  });

  it("errors on missing API or empty set", () => {
    assert.throws(() => selectSystemImage(parseSystemImages(listing), "99"), (e) => e instanceof AndroidError);
    assert.throws(() => selectSystemImage([]), (e) => e instanceof AndroidError);
  });

  // Minor platform releases ship as `android-36.1`. An integer-only parse
  // dropped them, which silently pinned machines to whatever older image they
  // also happened to have installed.
  describe("dotted API levels", () => {
    const dotted = [
      "  system-images;android-29;google_apis_playstore;arm64-v8a   | 9 | ...",
      "  system-images;android-36.1;google_apis_playstore;arm64-v8a | 4 | ...",
    ].join("\n");

    it("parses a minor platform release", () => {
      const imgs = parseSystemImages(dotted);
      assert.deepEqual(
        imgs.map((i) => i.api).sort((a, b) => a - b),
        [29, 36.1],
      );
      assert.match(imgs.find((i) => i.api === 36.1)!.pkg, /android-36\.1/);
    });

    it("picks the dotted image as newest rather than falling back to the older one", () => {
      assert.equal(selectSystemImage(parseSystemImages(dotted)).api, 36.1);
    });

    it("matches a dotted request exactly", () => {
      assert.equal(selectSystemImage(parseSystemImages(dotted), "36.1").api, 36.1);
      assert.equal(selectSystemImage(parseSystemImages(dotted), "android 36.1").api, 36.1);
    });

    it("matches a major-only request against its minor release", () => {
      assert.equal(selectSystemImage(parseSystemImages(dotted), "36").api, 36.1);
    });

    it("still rejects an API level that is not installed", () => {
      assert.throws(() => selectSystemImage(parseSystemImages(dotted), "31"), (e) => e instanceof AndroidError);
    });
  });
});

describe("serialForPort / bootCompleted", () => {
  it("builds a deterministic serial", () => {
    assert.equal(serialForPort(5554), "emulator-5554");
  });
  it("detects boot completion", () => {
    assert.equal(bootCompleted("1\n"), true);
    assert.equal(bootCompleted("0"), false);
    assert.equal(bootCompleted(""), false);
  });
});

describe("compactUiAutomatorXml", () => {
  it("keeps labeled / interactive nodes as a compact tree", () => {
    const xml =
      '<hierarchy><node class="android.widget.FrameLayout" bounds="[0,0][100,100]">' +
      '<node class="android.widget.TextView" text="Welcome" bounds="[10,10][90,30]"/>' +
      '<node class="android.widget.Button" content-desc="Continue" bounds="[10,40][90,60]"/>' +
      '<node class="android.view.View" bounds="[0,0][0,0]"/>' +
      "</node></hierarchy>";
    const out = compactUiAutomatorXml(xml);
    assert.match(out, /TextView "Welcome"/);
    assert.match(out, /Button "Continue"/);
    // The empty structural View is dropped.
    assert.doesNotMatch(out, /\bView\b/);
  });
});

describe("AndroidManager.bootEmulator", () => {
  // Deckhand streams the device over adb, so the emulator's own window is pure
  // overhead — and an expensive one: an idle pixel_7/API36 emulator measured
  // 227% CPU windowed against 34% with these flags. Both capture paths keep
  // working headless, so there is no reason to ever draw that window.
  it("boots headless on the host GPU", async () => {
    const launched: string[][] = [];
    const exec = async (cmd: string, args: string[]): Promise<ExecResult> => {
      if (cmd === "emulator") launched.push(args);
      // Report booted immediately so the wait loop resolves.
      return { code: 0, stdout: Buffer.from("1\n"), stderr: "" };
    };
    const mgr = new AndroidManager(exec);
    await mgr.bootEmulator("pixel_7", 5554);

    const args = launched[0];
    assert.ok(args, "emulator must be launched");
    assert.ok(args.includes("-no-window"), "must not draw the emulator window");
    // -gpu host renders via Metal; without it a headless emulator falls back to
    // a software rasteriser, which is what burned the CPU in the first place.
    assert.equal(args[args.indexOf("-gpu") + 1], "host");
  });
});
