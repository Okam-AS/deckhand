import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { defaultExec, type Exec } from "./ios.ts";

// ---------------------------------------------------------------------------
// Installing, launching and stopping the preview's app on a physical iPhone, with `devicectl`.
//
// A phone is borrowed hardware holding other people's apps. The operator's rule: install,
// update, uninstall and terminate apply ONLY to the bundle id registered for the preview.
// `IphoneApps` is built for one bundle id and refuses every other one, including an artifact
// that turns out to contain a different app.
// ---------------------------------------------------------------------------

export class IphoneAppError extends Error {
  constructor(
    message: string,
    public readonly code: "foreign_bundle" | "not_provisioned" | "install_conflict" | "bad_artifact" | "bad_launch_arg" | "devicectl_failed",
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "IphoneAppError";
  }
}

export interface ArtifactInfo {
  bundleId: string;
  version: string | null;
  buildVersion: string | null;
  /** CFBundleExecutable: the process name syslog lines carry. */
  executable: string | null;
  provisionedDevices: string[];
  provisionsAllDevices: boolean;
  profileExpires: string | null;
}

export interface InstalledApp {
  bundleId: string;
  version: string | null;
  bundleVersion: string | null;
  /** `file:///…/Name.app/` — the running executable lives under it. */
  url: string | null;
}

/** The plist inside a `.mobileprovision`: plain bytes in a DER CMS envelope, so no keychain is involved. */
export function provisioningPlistXml(bytes: Uint8Array): string | null {
  const text = Buffer.from(bytes).toString("latin1");
  const start = text.indexOf("<?xml");
  const end = text.indexOf("</plist>", start);
  return start < 0 || end < 0 ? null : text.slice(start, end + "</plist>".length);
}

export function parseProvisioning(xml: string): Pick<ArtifactInfo, "provisionedDevices" | "provisionsAllDevices" | "profileExpires"> {
  const devices = /<key>ProvisionedDevices<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)?.[1] ?? "";
  return {
    provisionedDevices: [...devices.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]!.trim()),
    provisionsAllDevices: /<key>ProvisionsAllDevices<\/key>\s*<true\/>/.test(xml),
    profileExpires: /<key>ExpirationDate<\/key>\s*<date>([^<]*)<\/date>/.exec(xml)?.[1] ?? null,
  };
}

export function profileIncludes(p: Pick<ArtifactInfo, "provisionedDevices" | "provisionsAllDevices">, udid: string): boolean {
  return p.provisionsAllDevices || p.provisionedDevices.some((d) => d.toLowerCase() === udid.toLowerCase());
}

/** `Payload/<Name>.app/` — exactly one, or the archive is refused. */
export function appDirFromListing(listing: string): string {
  const dirs = new Set<string>();
  for (const line of listing.split("\n")) {
    const m = /^(Payload\/[^/]+\.app)\//.exec(line.trim());
    if (m) dirs.add(m[1]!);
  }
  if (dirs.size !== 1) throw new IphoneAppError(`expected one Payload/*.app in the .ipa, found ${dirs.size}`, "bad_artifact");
  return [...dirs][0]!;
}

/** devicectl's install failure → the error the install path acts on. */
export function classifyInstallFailure(message: string): IphoneAppError {
  if (/not (been )?provisioned|DeviceNotProvisioned|profile .*(does not|doesn't) include|0xe8008012|ApplicationVerificationFailed.*provision/i.test(message)) {
    return new IphoneAppError(message, "not_provisioned", "this build's profile does not list the phone: register the phone's UDID with the team that signs the app and rebuild");
  }
  if (/MismatchedApplicationIdentifierEntitlement|different (team|signer|signature)|signer .*(changed|differ)|upgrade.*(mismatch|not allowed|denied)|downgrade|0xe8008001|already installed.*(different|newer)/i.test(message)) {
    return new IphoneAppError(message, "install_conflict", "the phone holds this app signed differently or newer; uninstalling the preview's app first lets this build in, and loses that app's data on the phone");
  }
  return new IphoneAppError(message, "devicectl_failed");
}

const ARG_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ARG_VALUE = /^[A-Za-z0-9_.:\/-]{0,256}$/;

/** `-KEY value` process arguments, which react-native-launch-arguments reads; the one place a caller's text reaches argv. */
export function launchArgs(args: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (!ARG_KEY.test(k) || !ARG_VALUE.test(v)) {
      throw new IphoneAppError(`refusing launch argument ${JSON.stringify(k)}: keys are identifiers and values letters, digits and _ . : / -`, "bad_launch_arg");
    }
    out.push(`-${k}`, v);
  }
  return out;
}

export interface IphoneAppsOptions {
  udid: string;
  /** The bundle id registered for the preview: the only app this instance will install, start, stop or remove. */
  bundleId: string;
  exec?: Exec;
}

export class IphoneApps {
  readonly udid: string;
  readonly bundleId: string;
  private readonly exec: Exec;

  constructor(opts: IphoneAppsOptions) {
    if (!/^[A-Za-z0-9.-]+$/.test(opts.bundleId)) throw new IphoneAppError(`${JSON.stringify(opts.bundleId)} is not a bundle id`, "foreign_bundle");
    this.udid = opts.udid;
    this.bundleId = opts.bundleId;
    this.exec = opts.exec ?? defaultExec;
  }

  private guard(bundleId: string, verb: string): void {
    if (bundleId !== this.bundleId) {
      throw new IphoneAppError(
        `refusing to ${verb} ${bundleId} on ${this.udid}: deckhand only ${verb}s the preview's own app (${this.bundleId}) on a physical phone`,
        "foreign_bundle",
      );
    }
  }

  /**
   * Install an internal-distribution `.ipa` or a device `.app`, checked before the phone is touched:
   * it must be the registered app, and its profile must list this phone. A conflict (signer, team,
   * downgrade) is refused unless `replaceOnConflict`, which uninstalls the registered app — and only
   * it — and installs again.
   */
  async install(artifactPath: string, opts: { replaceOnConflict?: boolean } = {}): Promise<{ replaced: boolean; info: ArtifactInfo }> {
    const info = await inspectArtifact(artifactPath, this.exec);
    this.guard(info.bundleId, "install");
    if (!profileIncludes(info, this.udid)) {
      throw new IphoneAppError(
        `${basename(artifactPath)} is not provisioned for ${this.udid}`,
        "not_provisioned",
        "register the phone's UDID with the team that signs the app and rebuild",
      );
    }
    try {
      await this.devicectl(["device", "install", "app", "--device", this.udid, artifactPath], 600_000);
      return { replaced: false, info };
    } catch (e) {
      const err = e instanceof IphoneAppError ? classifyInstallFailure(e.message) : e;
      if (!(err instanceof IphoneAppError) || err.code !== "install_conflict" || !opts.replaceOnConflict) throw err;
    }
    await this.uninstall(info.bundleId);
    await this.devicectl(["device", "install", "app", "--device", this.udid, artifactPath], 600_000);
    return { replaced: true, info };
  }

  /** Launch fresh (a running copy is terminated, so arguments reach a new process). Returns the pid. */
  async launch(bundleId: string, opts: { args?: Record<string, string>; payloadUrl?: string } = {}): Promise<number | null> {
    this.guard(bundleId, "launch");
    const trailing = launchArgs(opts.args ?? {});
    if (opts.payloadUrl != null && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s]*$/.test(opts.payloadUrl)) {
      throw new IphoneAppError(`refusing payload URL ${JSON.stringify(opts.payloadUrl)}`, "bad_launch_arg");
    }
    const url = opts.payloadUrl != null ? ["--payload-url", opts.payloadUrl] : [];
    const r = (await this.devicectl(["device", "process", "launch", "--device", this.udid, "--terminate-existing", ...url, bundleId], 60_000, trailing)) as
      | { process?: { processIdentifier?: number } }
      | undefined;
    return typeof r?.process?.processIdentifier === "number" ? r.process.processIdentifier : null;
  }

  /** Stop the app's running process; false when it was not running. */
  async terminate(bundleId: string): Promise<boolean> {
    this.guard(bundleId, "terminate");
    const pids = await this.runningPids(bundleId);
    for (const pid of pids) await this.devicectl(["device", "process", "terminate", "--device", this.udid, "--pid", String(pid)], 60_000);
    return pids.length > 0;
  }

  async uninstall(bundleId: string): Promise<void> {
    this.guard(bundleId, "uninstall");
    await this.devicectl(["device", "uninstall", "app", "--device", this.udid, bundleId], 120_000);
  }

  /** What is installed under the registered bundle id, or null. */
  async installedApp(bundleId: string = this.bundleId): Promise<InstalledApp | null> {
    this.guard(bundleId, "read");
    const r = (await this.devicectl(["device", "info", "apps", "--device", this.udid, "--bundle-id", bundleId])) as
      | { apps?: { bundleIdentifier?: string; version?: string; bundleVersion?: string; url?: string }[] }
      | undefined;
    const a = (r?.apps ?? []).find((x) => x.bundleIdentifier === bundleId);
    return a ? { bundleId, version: a.version ?? null, bundleVersion: a.bundleVersion ?? null, url: a.url ?? null } : null;
  }

  async isRunning(bundleId: string = this.bundleId): Promise<boolean> {
    return (await this.runningPids(bundleId)).length > 0;
  }

  private async runningPids(bundleId: string): Promise<number[]> {
    const app = await this.installedApp(bundleId);
    if (!app?.url) return [];
    const r = (await this.devicectl(["device", "info", "processes", "--device", this.udid])) as
      | { runningProcesses?: { executable?: string; processIdentifier?: number }[] }
      | undefined;
    return pidsUnder(r?.runningProcesses ?? [], app.url);
  }

  /** `trailing` goes after `--`: arguments for the launched app, never for devicectl. */
  private async devicectl(args: string[], timeoutMs = 60_000, trailing: string[] = []): Promise<unknown> {
    const dir = mkdtempSync(join(tmpdir(), "deckhand-devicectl-"));
    const out = join(dir, "out.json");
    try {
      const res = await this.exec("xcrun", ["devicectl", ...args, "--json-output", out, ...(trailing.length ? ["--", ...trailing] : [])], { timeoutMs });
      let json: { info?: { outcome?: string }; error?: unknown; result?: unknown } | null = null;
      try {
        json = JSON.parse(readFileSync(out, "utf8")) as typeof json;
      } catch {
        json = null;
      }
      if (res.code !== 0 || json?.info?.outcome !== "success") {
        const why = devicectlError(json?.error) ?? res.stderr.trim().split("\n").filter(Boolean).pop() ?? `exit ${res.code}`;
        throw new IphoneAppError(`devicectl ${args.slice(0, 3).join(" ")}: ${why}`.slice(0, 800), "devicectl_failed");
      }
      return json.result;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** Pids of processes whose executable lives in the app bundle at `appUrl`. */
export function pidsUnder(processes: { executable?: string; processIdentifier?: number }[], appUrl: string): number[] {
  const base = appUrl.endsWith("/") ? appUrl : `${appUrl}/`;
  return processes.filter((p) => typeof p.executable === "string" && p.executable.startsWith(base) && typeof p.processIdentifier === "number").map((p) => p.processIdentifier!);
}

/** The app's process name, from devicectl's bundle URL (`…/Demo.app/` → `Demo`). */
export function executableFromAppUrl(url: string | null): string | null {
  const m = url ? /\/([^/]+)\.app\/?$/.exec(url) : null;
  return m ? decodeURIComponent(m[1]!) : null;
}

/** devicectl's nested NSError, flattened to the most specific description it carries. */
function devicectlError(err: unknown): string | null {
  const parts: string[] = [];
  const walk = (e: unknown, depth: number): void => {
    if (!e || typeof e !== "object" || depth > 6) return;
    const info = (e as { userInfo?: Record<string, { string?: string; error?: unknown }> }).userInfo ?? {};
    for (const k of ["NSLocalizedDescription", "NSLocalizedFailureReason", "NSLocalizedRecoverySuggestion"]) {
      const s = info[k]?.string;
      if (s && !parts.includes(s)) parts.push(s);
    }
    const code = (e as { code?: number; domain?: string }).code;
    const domain = (e as { domain?: string }).domain;
    if (typeof code === "number" && domain) parts.push(`${domain} ${code}`);
    walk(info.NSUnderlyingError?.error, depth + 1);
  };
  walk(err, 0);
  return parts.length ? parts.join(" — ") : null;
}

/**
 * Read an `.ipa` or `.app` without trusting it: only Info.plist and embedded.mobileprovision are
 * extracted from an archive, by exact name, into a fresh temp directory.
 */
export async function inspectArtifact(path: string, exec: Exec = defaultExec): Promise<ArtifactInfo> {
  if (/\.app\/?$/.test(path)) return readApp(path.replace(/\/$/, ""), exec);
  if (!/\.ipa$/.test(path)) throw new IphoneAppError(`can only install an .ipa or a device .app, got ${basename(path)}`, "bad_artifact");
  const list = await exec("unzip", ["-Z1", path], { timeoutMs: 60_000 });
  if (list.code !== 0) throw new IphoneAppError(`unzip could not list ${basename(path)}: ${list.stderr.trim().slice(0, 200)}`, "bad_artifact");
  const app = appDirFromListing(list.stdout.toString());
  const dir = mkdtempSync(join(tmpdir(), "deckhand-ipa-"));
  try {
    const want = [`${app}/Info.plist`, `${app}/embedded.mobileprovision`];
    const x = await exec("unzip", ["-o", "-q", path, ...want, "-d", dir], { timeoutMs: 60_000 });
    if (x.code !== 0) throw new IphoneAppError(`${basename(path)} has no Info.plist or embedded.mobileprovision in ${app}`, "bad_artifact");
    return await readApp(join(dir, app), exec);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function readApp(appDir: string, exec: Exec): Promise<ArtifactInfo> {
  const json = await exec("plutil", ["-convert", "json", "-o", "-", join(appDir, "Info.plist")]);
  if (json.code !== 0) throw new IphoneAppError(`plutil could not read ${basename(appDir)}/Info.plist: ${json.stderr.trim()}`, "bad_artifact");
  const plist = JSON.parse(json.stdout.toString()) as Record<string, unknown>;
  const s = (k: string) => (typeof plist[k] === "string" ? (plist[k] as string) : null);
  const bundleId = s("CFBundleIdentifier");
  if (!bundleId) throw new IphoneAppError(`${basename(appDir)} has no CFBundleIdentifier`, "bad_artifact");
  let prov: ReturnType<typeof parseProvisioning> = { provisionedDevices: [], provisionsAllDevices: false, profileExpires: null };
  try {
    const xml = provisioningPlistXml(readFileSync(join(appDir, "embedded.mobileprovision")));
    if (xml) prov = parseProvisioning(xml);
  } catch {
    /* no profile: profileIncludes says no, which refuses the install before the phone is touched */
  }
  return { bundleId, version: s("CFBundleShortVersionString"), buildVersion: s("CFBundleVersion"), executable: s("CFBundleExecutable"), ...prov };
}
