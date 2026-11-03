import type { Exec } from "../devices/android.ts";
import { apkBadging, downloadArtifact, extractSimulatorApp, findAapt2, requireKind, vetApk } from "./artifact.ts";
import { EasClient, EasError, type EasBuild, type EasPlatform, type EasUpdate, type TokenSource } from "./client.ts";

// ---------------------------------------------------------------------------
// The EAS preview source as the engine sees it: pick a build, fetch it, vet it,
// and hand back a local path ready to install. Nothing here touches a device.
// ---------------------------------------------------------------------------

/** Which artifact a device can take. A physical iPhone (`ios-device`) is not wired yet. */
export type EasTarget = "android" | "ios-simulator";

export interface EasSelection {
  buildId?: string;
  profile?: string;
}

export interface PreparedBuild {
  build: EasBuild;
  target: EasTarget;
  projectId: string;
  /** The .apk, or the unpacked simulator .app. */
  installPath: string;
  cached: boolean;
  /** The artifact's own identity and version, read from it — not what EAS reports. */
  bundleId: string;
  versionName: string | null;
  versionCode: string | null;
  schemes: string[];
}

const PLATFORM: Record<EasTarget, EasPlatform> = { android: "ANDROID", "ios-simulator": "IOS" };

export class EasPreviews {
  constructor(
    private readonly token: TokenSource,
    private readonly opts: { fetchImpl?: typeof fetch; cacheDir?: string; exec?: Exec; aapt2?: () => string | null; client?: EasClient } = {},
  ) {}

  private client(): EasClient {
    return this.opts.client ?? new EasClient(this.token, this.opts.fetchImpl);
  }

  /** Whether a token is configured — checked before a preview is started, so the caller hears it at once. */
  ready(): { ok: true } | { ok: false; message: string; hint: string } {
    const t = this.token();
    return t.ok ? { ok: true } : { ok: false, message: t.message, hint: t.hint };
  }

  async resolve(projectId: string, target: EasTarget, sel: EasSelection): Promise<EasBuild> {
    const client = this.client();
    const platform = PLATFORM[target];
    const wantsSim = target === "ios-simulator";
    if (sel.buildId) {
      const b = await client.build(projectId, sel.buildId);
      if (!b) throw new EasError(`no EAS build "${sel.buildId}" in this app's EAS project`, "check the id on the build's expo.dev page, or pass eas.profile for the newest build of a profile", "eas_build_not_found");
      if (b.platform !== platform) throw new EasError(`EAS build ${b.id} is an ${b.platform} build, and this device is ${platform}`, "pick a build for this platform, or preview on a device of the build's platform", "eas_wrong_artifact");
      if (b.status !== "FINISHED") throw new EasError(`EAS build ${b.id} is ${b.status}, not finished`, "wait for it to finish, or pick a finished build", "eas_build_not_ready");
      if (platform === "IOS" && Boolean(b.isForIosSimulator) !== wantsSim) {
        throw new EasError(
          `EAS build ${b.id} is ${b.isForIosSimulator ? "a simulator build" : "a device build"}, and this device is ${wantsSim ? "a simulator" : "an iPhone"}`,
          wantsSim ? "pick a build of a profile with \"ios\": {\"simulator\": true}" : "pick an internal-distribution device build",
          "eas_wrong_artifact",
        );
      }
      return b;
    }
    if (!sel.profile) throw new EasError("no EAS build or profile was named, and the app's environment maps none for this platform", "pass eas.buildId or eas.profile, or add easProfile to the environment in apps.yaml", "bad_request");
    const b = await client.latest(projectId, sel.profile, platform, (x) => platform !== "IOS" || Boolean(x.isForIosSimulator) === wantsSim);
    if (!b) {
      throw new EasError(
        `EAS has no finished ${wantsSim ? "iOS simulator" : platform === "IOS" ? "iOS device" : "Android"} build of profile "${sel.profile}" among the newest 20`,
        `run \`eas build --profile ${sel.profile} --platform ${platform === "IOS" ? "ios" : "android"}\` first, or name a build with eas.buildId`,
        "eas_build_not_found",
      );
    }
    return b;
  }

  /** Download (once per build id) and vet against the registered app id, before any device sees it. */
  async prepare(projectId: string, target: EasTarget, build: EasBuild, expectedBundleId: string, onLog: (line: string) => void): Promise<PreparedBuild> {
    requireKind(build, target === "android" ? "apk" : "simulator");
    let shown = -1;
    const { path, cached } = await downloadArtifact(build, {
      cacheDir: this.opts.cacheDir,
      fetchImpl: this.opts.fetchImpl,
      onProgress: (got, total) => {
        const pct = Number.isFinite(total) && total > 0 ? Math.floor((got / total) * 4) * 25 : -1;
        if (pct > shown) onLog(`downloading EAS build ${build.id}: ${pct}% of ${Math.round(total / 1e6)} MB`);
        shown = Math.max(shown, pct);
      },
    });
    onLog(`EAS build ${build.id} (${build.buildProfile ?? "?"}, ${build.appVersion ?? "?"}, commit ${build.gitCommitHash?.slice(0, 8) ?? "?"}) ${cached ? "from the cache" : "downloaded"}`);
    if (target === "android") {
      const badge = await apkBadging(path, this.opts.exec, (this.opts.aapt2 ?? findAapt2)());
      vetApk(badge, expectedBundleId, build.id);
      return { build, target, projectId, installPath: path, cached, bundleId: badge.pkg, versionName: badge.versionName, versionCode: badge.versionCode, schemes: [] };
    }
    const app = await extractSimulatorApp(path, this.opts.exec);
    if (app.bundleId !== expectedBundleId) {
      throw new EasError(`EAS build ${build.id} is ${app.bundleId}, but this app is registered as ${expectedBundleId} — refusing to install it`, "pick a build of this app", "eas_wrong_app");
    }
    return { build, target, projectId, installPath: app.appPath, cached, bundleId: app.bundleId, versionName: app.version, versionCode: app.buildVersion, schemes: app.schemes };
  }

  latestUpdate(projectId: string, build: EasBuild): Promise<EasUpdate | null> {
    return this.client().latestUpdateFor(projectId, build);
  }

  projectSlug(projectId: string): Promise<string> {
    return this.client().projectSlug(projectId);
  }
}
