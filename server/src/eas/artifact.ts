import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { makeDefaultExec, type Exec } from "../devices/android.ts";
import { resolveAndroidEnv } from "../devices/toolEnv.ts";
import { paths } from "../paths.ts";
import { EasError, UUID_RE, artifactKind, type EasBuild } from "./client.ts";

// ---------------------------------------------------------------------------
// An EAS build's artifact on this Mac: downloaded once into a cache keyed by
// build id, and vetted before any device is touched. Artifacts are untrusted
// input: only the two files an .ipa needs are extracted, into a fresh temp
// directory, and a simulator archive is listed before it is unpacked.
// ---------------------------------------------------------------------------

const DOWNLOAD_IDLE_MS = 60_000;

const downloading = new Map<string, Promise<{ path: string; cached: boolean }>>();
const extracting = new Map<string, Promise<SimulatorApp>>();

/**
 * Stream the artifact to a `.part` file of this call's own, renamed only once complete, so a file
 * at the final name is always whole. Aborted after `idleMs` with no bytes, not after a total: APKs
 * run to hundreds of MB. No credential is sent: artifact URLs are pre-authorised, and a redirect
 * can land on a storage host that must never see the Expo token.
 */
export async function downloadArtifact(
  b: Pick<EasBuild, "id" | "artifacts">,
  opts: { cacheDir?: string; fetchImpl?: typeof fetch; idleMs?: number; onProgress?: (got: number, total: number) => void } = {},
): Promise<{ path: string; cached: boolean }> {
  if (!UUID_RE.test(b.id)) throw new EasError(`unexpected EAS build id ${JSON.stringify(b.id)}`);
  const raw = b.artifacts?.buildUrl;
  if (!raw) throw new EasError(`EAS build ${b.id} has no artifact`, "the build may have expired or failed to upload; pick another build");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EasError(`EAS build ${b.id} has an artifact URL that does not parse`);
  }
  if (url.protocol !== "https:") throw new EasError(`refusing a non-https artifact URL for EAS build ${b.id}`);
  const name = basename(url.pathname);
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(name) || name.startsWith(".")) throw new EasError(`refusing an artifact named ${JSON.stringify(name)}`);
  const dir = join(opts.cacheDir ?? paths.easCache(), b.id);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, name);
  if (existsSync(dest) && statSync(dest).size > 0) return { path: dest, cached: true };
  const inFlight = downloading.get(dest);
  if (inFlight) return inFlight;
  const run = fetchArtifact(b.id, url, dest, opts).finally(() => downloading.delete(dest));
  downloading.set(dest, run);
  return run;
}

async function fetchArtifact(
  id: string,
  url: URL,
  dest: string,
  opts: { fetchImpl?: typeof fetch; idleMs?: number; onProgress?: (got: number, total: number) => void },
): Promise<{ path: string; cached: boolean }> {
  const dir = dirname(dest);
  const idleMs = opts.idleMs ?? DOWNLOAD_IDLE_MS;
  // Another process's download refreshes its .part's mtime with every chunk and is aborted after idleMs without one.
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".part")) continue;
    const st = statSync(join(dir, f), { throwIfNoEntry: false });
    if (st && Date.now() - st.mtimeMs > 2 * idleMs) rmSync(join(dir, f), { force: true });
  }

  const ctl = new AbortController();
  let idle = setTimeout(() => ctl.abort(), idleMs);
  const part = `${dest}.${process.pid}.${Math.random().toString(36).slice(2)}.part`;
  try {
    const res = await (opts.fetchImpl ?? fetch)(url.toString(), { redirect: "follow", signal: ctl.signal });
    if (!res.ok || !res.body) throw new EasError(`downloading EAS build ${id} failed: HTTP ${res.status}`, "the artifact link may have expired; try again, or pick a newer build");
    const expected = Number(res.headers.get("content-length") ?? NaN);
    let got = 0;
    const body = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);
    body.on("data", (chunk: Buffer) => {
      got += chunk.length;
      clearTimeout(idle);
      idle = setTimeout(() => ctl.abort(), idleMs);
      opts.onProgress?.(got, expected);
    });
    await pipeline(body, createWriteStream(part));
    if (got === 0) throw new EasError(`downloading EAS build ${id} failed: empty body`);
    if (Number.isFinite(expected) && got !== expected) throw new EasError(`downloading EAS build ${id} failed: got ${got} of ${expected} bytes`, "try again");
  } catch (e) {
    rmSync(part, { force: true });
    if (ctl.signal.aborted) throw new EasError(`downloading EAS build ${id} stalled: no data for ${Math.round(idleMs / 1000)}s`, "check this Mac's network, then try again");
    throw e;
  } finally {
    clearTimeout(idle);
  }
  renameSync(part, dest);
  return { path: dest, cached: false };
}

/** The `.aab` refusal, in one place: a store bundle cannot be installed on a device. */
export function requireKind(b: Pick<EasBuild, "id" | "buildProfile" | "artifacts">, want: "apk" | "ipa" | "simulator"): void {
  const kind = artifactKind(b);
  if (kind === want) return;
  const profile = b.buildProfile ? `profile "${b.buildProfile}"` : "its profile";
  if (kind === "aab") {
    throw new EasError(
      `EAS build ${b.id} (${profile}) is a store .aab, which cannot be installed on a device`,
      `build an internal APK instead: in eas.json give ${profile} "distribution": "internal" and "android": {"buildType": "apk"}, run eas build, then preview that build`,
      "eas_wrong_artifact",
    );
  }
  const what = { apk: "an Android .apk", ipa: "an iOS device .ipa (internal distribution)", simulator: "an iOS simulator build (.tar.gz)" }[want];
  throw new EasError(`EAS build ${b.id} (${profile}) is ${kind === "unknown" ? "an artifact deckhand does not recognise" : `a ${kind} artifact`}, not ${what}`, "pick a build of a profile that produces one", "eas_wrong_artifact");
}

// --- APK ----------------------------------------------------------------------------

export interface ApkBadging {
  pkg: string;
  versionCode: string | null;
  versionName: string | null;
}

export function parseBadging(out: string): ApkBadging {
  const line = out.split("\n").find((l) => l.startsWith("package:")) ?? "";
  const pkg = /name='([^']+)'/.exec(line)?.[1];
  if (!pkg) throw new EasError("aapt2 badging has no package line — this does not look like an APK");
  return { pkg, versionCode: /versionCode='(\d+)'/.exec(line)?.[1] ?? null, versionName: /versionName='([^']*)'/.exec(line)?.[1] ?? null };
}

/** The newest build-tools' aapt2, or null. */
export function findAapt2(androidHome = resolveAndroidEnv().ANDROID_HOME): string | null {
  let versions: string[];
  try {
    versions = readdirSync(join(androidHome, "build-tools")).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch {
    return null;
  }
  for (const v of versions.reverse()) {
    const bin = join(androidHome, "build-tools", v, "aapt2");
    if (existsSync(bin)) return bin;
  }
  return null;
}

export async function apkBadging(apk: string, exec: Exec = makeDefaultExec(), aapt2: string | null = findAapt2()): Promise<ApkBadging> {
  if (!aapt2) throw new EasError("aapt2 is not installed, so deckhand cannot check which app an APK is", "install Android build-tools (`sdkmanager \"build-tools;35.0.0\"`)");
  const res = await exec(aapt2, ["dump", "badging", apk], { timeoutMs: 60_000 });
  if (res.code !== 0) throw new EasError(`aapt2 could not read ${basename(apk)}: ${res.stderr.trim().slice(0, 200)}`);
  return parseBadging(res.stdout.toString());
}

/** Refuse an APK that is not the registered app, before any device sees it. */
export function vetApk(b: ApkBadging, expected: string, buildId: string): void {
  if (b.pkg !== expected) {
    throw new EasError(
      `EAS build ${buildId} is package ${b.pkg}, but this app is registered as ${expected} — refusing to install it`,
      "pick a build of this app, or fix the app's bundleId if the registration is wrong",
      "eas_wrong_app",
    );
  }
}

// --- IPA ----------------------------------------------------------------------------

export interface IpaInfo {
  bundleId: string;
  version: string | null;
  buildVersion: string | null;
  schemes: string[];
  teamId: string | null;
  provisionedDevices: string[];
  /** An enterprise profile: no device list, any device. */
  provisionsAllDevices: boolean;
  profileExpires: string | null;
}

/** The XML plist inside a `.mobileprovision`: a CMS envelope around plain-text XML. */
export function provisioningPlistXml(bytes: Uint8Array): string {
  const text = Buffer.from(bytes).toString("latin1");
  const start = text.indexOf("<?xml");
  const end = text.indexOf("</plist>", start);
  if (start < 0 || end < 0) throw new EasError("no plist inside the .ipa's provisioning profile");
  return text.slice(start, end + "</plist>".length);
}

export function parseProvisioning(xml: string): Pick<IpaInfo, "teamId" | "provisionedDevices" | "provisionsAllDevices" | "profileExpires"> {
  const arrayAfter = (key: string): string[] => {
    const m = new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`).exec(xml);
    return m ? [...m[1]!.matchAll(/<string>([^<]*)<\/string>/g)].map((x) => x[1]!) : [];
  };
  return {
    teamId: arrayAfter("TeamIdentifier")[0] ?? null,
    provisionedDevices: arrayAfter("ProvisionedDevices"),
    provisionsAllDevices: /<key>ProvisionsAllDevices<\/key>\s*<true\/>/.test(xml),
    profileExpires: /<key>ExpirationDate<\/key>\s*<date>([^<]*)<\/date>/.exec(xml)?.[1] ?? null,
  };
}

export function profileIncludes(info: Pick<IpaInfo, "provisionedDevices" | "provisionsAllDevices">, udid: string): boolean {
  return info.provisionsAllDevices || info.provisionedDevices.some((d) => d.toLowerCase() === udid.toLowerCase());
}

/** `Payload/<Name>.app` — exactly one, or the archive is refused. */
export function appDirFromListing(listing: string): string {
  const dirs = new Set<string>();
  for (const line of listing.split("\n")) {
    const m = /^(Payload\/[^/]+\.app)\//.exec(line.trim());
    if (m) dirs.add(m[1]!);
  }
  if (dirs.size !== 1) throw new EasError(`expected one Payload/*.app in the .ipa, found ${dirs.size}`);
  return [...dirs][0]!;
}

/** Reads only Info.plist and embedded.mobileprovision, extracted by exact name into a fresh temp dir. */
export async function inspectIpa(ipa: string, exec: Exec = makeDefaultExec()): Promise<IpaInfo> {
  const list = await exec("unzip", ["-Z1", ipa], { timeoutMs: 60_000 });
  if (list.code !== 0) throw new EasError(`unzip could not list ${basename(ipa)}: ${list.stderr.trim().slice(0, 200)}`);
  const app = appDirFromListing(list.stdout.toString());
  const dir = mkdtempSync(join(tmpdir(), "deckhand-ipa-"));
  try {
    const want = [`${app}/Info.plist`, `${app}/embedded.mobileprovision`];
    const x = await exec("unzip", ["-o", "-q", ipa, ...want, "-d", dir], { timeoutMs: 60_000 });
    if (x.code !== 0) throw new EasError(`unzip could not extract Info.plist and embedded.mobileprovision: ${x.stderr.trim().slice(0, 200)}`);
    const plist = await readPlist(join(dir, want[0]!), exec);
    if (!plist.CFBundleIdentifier) throw new EasError("the .ipa's Info.plist has no CFBundleIdentifier");
    const prov = parseProvisioning(provisioningPlistXml(readFileSync(join(dir, want[1]!))));
    return {
      bundleId: plist.CFBundleIdentifier,
      version: plist.CFBundleShortVersionString ?? null,
      buildVersion: plist.CFBundleVersion ?? null,
      schemes: (plist.CFBundleURLTypes ?? []).flatMap((t) => t.CFBundleURLSchemes ?? []),
      ...prov,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Refuse an .ipa that is not the registered app, or that the phone's UDID cannot run. */
export function vetIpa(info: IpaInfo, expectedBundleId: string, udid: string, buildId: string): void {
  if (info.bundleId !== expectedBundleId) {
    throw new EasError(`EAS build ${buildId} is ${info.bundleId}, but this app is registered as ${expectedBundleId} — refusing to install it`, "pick a build of this app", "eas_wrong_app");
  }
  if (!profileIncludes(info, udid)) {
    throw new EasError(
      `EAS build ${buildId}'s provisioning profile (team ${info.teamId ?? "?"}, ${info.provisionedDevices.length} devices) does not list this iPhone (${udid})`,
      "register the phone with EAS (`eas device:create` on the team that builds this app), then rebuild — a build only runs on the phones its profile lists",
      "eas_not_provisioned",
    );
  }
}

// --- iOS simulator archive -------------------------------------------------------------

interface InfoPlist {
  CFBundleIdentifier?: string;
  CFBundleShortVersionString?: string;
  CFBundleVersion?: string;
  CFBundleURLTypes?: { CFBundleURLSchemes?: string[] }[];
}

async function readPlist(file: string, exec: Exec): Promise<InfoPlist> {
  const json = await exec("plutil", ["-convert", "json", "-o", "-", file], { timeoutMs: 30_000 });
  if (json.code !== 0) throw new EasError(`plutil could not read ${basename(file)}: ${json.stderr.trim().slice(0, 200)}`);
  try {
    return JSON.parse(json.stdout.toString()) as InfoPlist;
  } catch {
    throw new EasError(`${basename(file)} is not a readable plist`);
  }
}

/** The one top-level `<Name>.app` in a simulator archive listing; refuses absolute or `..` paths. */
export function simulatorAppFromListing(listing: string): string {
  const apps = new Set<string>();
  for (const raw of listing.split("\n")) {
    const entry = raw.trim().replace(/^\.\//, "");
    if (!entry) continue;
    if (entry.startsWith("/") || entry.split("/").includes("..")) throw new EasError(`the simulator archive has an unsafe path: ${JSON.stringify(entry.slice(0, 120))}`);
    const top = entry.split("/")[0]!;
    if (top.endsWith(".app")) apps.add(top);
    else if (top !== "" && !top.startsWith("._") && top !== "__MACOSX") throw new EasError(`the simulator archive holds ${JSON.stringify(top.slice(0, 80))} beside the app`);
  }
  if (apps.size !== 1) throw new EasError(`expected one .app in the simulator archive, found ${apps.size}`);
  return [...apps][0]!;
}

export interface SimulatorApp {
  appPath: string;
  bundleId: string;
  version: string | null;
  buildVersion: string | null;
  schemes: string[];
}

/** Unpack once beside the archive (a `.complete` marker says it finished) and read its Info.plist. */
export function extractSimulatorApp(archive: string, exec: Exec = makeDefaultExec()): Promise<SimulatorApp> {
  const inFlight = extracting.get(archive);
  if (inFlight) return inFlight;
  const run = unpackSimulatorApp(archive, exec).finally(() => extracting.delete(archive));
  extracting.set(archive, run);
  return run;
}

async function unpackSimulatorApp(archive: string, exec: Exec): Promise<SimulatorApp> {
  const list = await exec("tar", ["-tzf", archive], { timeoutMs: 120_000 });
  if (list.code !== 0) throw new EasError(`tar could not list ${basename(archive)}: ${list.stderr.trim().slice(0, 200)}`);
  const name = simulatorAppFromListing(list.stdout.toString());
  const out = join(archive.replace(/\.(tar\.gz|tgz)$/, ""), "unpacked");
  const marker = join(out, ".complete");
  if (!existsSync(marker)) {
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    const x = await exec("tar", ["-xzf", archive, "-C", out], { timeoutMs: 300_000 });
    if (x.code !== 0) {
      rmSync(out, { recursive: true, force: true });
      throw new EasError(`tar could not unpack ${basename(archive)}: ${x.stderr.trim().slice(0, 200)}`);
    }
    writeFileSync(marker, "");
  }
  const appPath = join(out, name);
  const plist = await readPlist(join(appPath, "Info.plist"), exec);
  if (!plist.CFBundleIdentifier) throw new EasError("the simulator app's Info.plist has no CFBundleIdentifier");
  return {
    appPath,
    bundleId: plist.CFBundleIdentifier,
    version: plist.CFBundleShortVersionString ?? null,
    buildVersion: plist.CFBundleVersion ?? null,
    schemes: (plist.CFBundleURLTypes ?? []).flatMap((t) => t.CFBundleURLSchemes ?? []),
  };
}
