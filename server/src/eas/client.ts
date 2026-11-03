// ---------------------------------------------------------------------------
// The Expo (EAS) GraphQL API, read-only: builds of a project, one build by id or
// prefix, and the newest EAS Update a dev-client build may load. The robot token
// goes to EXPO_GRAPHQL and nowhere else — artifact URLs are pre-authorised, so a
// download never carries it (eas/artifact.ts).
// ---------------------------------------------------------------------------

export const EXPO_GRAPHQL = "https://api.expo.dev/graphql";

export type EasPlatform = "ANDROID" | "IOS";

export interface EasBuild {
  id: string;
  platform: EasPlatform;
  buildProfile: string | null;
  status: string;
  distribution: string | null;
  appVersion: string | null;
  appBuildVersion: string | null;
  gitCommitHash: string | null;
  createdAt: string;
  completedAt: string | null;
  artifacts: { buildUrl: string | null } | null;
  appIdentifier?: string | null;
  developmentClient?: boolean | null;
  isForIosSimulator?: boolean | null;
  runtime?: { version: string } | null;
  /** The EAS Update channel baked into the build; null when it was built without one. */
  updateChannel?: { name: string; branchMapping: string } | null;
}

export interface EasUpdate {
  id: string;
  group: string;
  branchId: string;
  branchName: string;
  platform: string;
  runtimeVersion: string;
  createdAt: string;
  message: string | null;
}

export class EasError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    readonly code = "eas_error",
  ) {
    super(message);
    this.name = "EasError";
  }
}

export type TokenSource = () => { ok: true; token: string } | { ok: false; message: string; hint: string };

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const BUILD_FIELDS =
  "id platform buildProfile status distribution appVersion appBuildVersion gitCommitHash createdAt completedAt artifacts { buildUrl } appIdentifier developmentClient isForIosSimulator runtime { version } updateChannel { name branchMapping }";

const SET_TOKEN = "On the deckhand machine: `deckhand secret set expo`, with a read-only Expo robot token on stdin.";

export class EasClient {
  constructor(
    private readonly token: TokenSource,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async query<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const t = this.token();
    if (!t.ok) throw new EasError(t.message, t.hint, "eas_token_missing");
    let res: Response;
    try {
      res = await this.fetchImpl(EXPO_GRAPHQL, {
        method: "POST",
        headers: { authorization: `Bearer ${t.token}`, "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new EasError(`could not reach the Expo API: ${(e as Error).message}`, "check this Mac's network, then try again");
    }
    if (res.status === 401 || res.status === 403) {
      throw new EasError(`the Expo API refused deckhand's token (HTTP ${res.status})`, `The token is revoked or lacks access. ${SET_TOKEN}`, "eas_token_rejected");
    }
    const body = (await res.json().catch(() => null)) as { data?: T; errors?: { message: string }[] } | null;
    if (!res.ok || !body || body.errors?.length || !body.data) {
      const msg = body?.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}`;
      throw new EasError(`Expo API: ${msg.slice(0, 300)}`, "check the app's EAS project id (apps.yaml easProjectId) and that the robot token can read that project");
    }
    return body.data;
  }

  /** Who the token is (`Robot`, `User`): proves it authenticates, nothing more. */
  async whoami(): Promise<string> {
    const data = await this.query<{ meActor: { __typename: string } | null }>("query { meActor { __typename } }", {});
    if (!data.meActor) throw new EasError("the Expo API does not recognise this token", SET_TOKEN, "eas_token_rejected");
    return data.meActor.__typename;
  }

  /** The project's slug; a dev client's own URL scheme is `exp+<slug>`. */
  async projectSlug(projectId: string): Promise<string> {
    const data = await this.query<{ app: { byId: { slug: string } } }>("query($id: String!) { app { byId(appId: $id) { slug } } }", { id: projectId });
    const slug = data.app.byId.slug;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)) throw new EasError(`the EAS project's slug ${JSON.stringify(slug)} is not usable in a URL scheme`);
    return slug;
  }

  /** Newest first. EAS applies `filter`, so `limit` counts matching builds. */
  async builds(projectId: string, opts: { limit?: number; platform?: EasPlatform; profile?: string; status?: "FINISHED" } = {}): Promise<EasBuild[]> {
    const filter: Record<string, string> = {};
    if (opts.platform) filter.platform = opts.platform;
    if (opts.profile) filter.buildProfile = opts.profile;
    if (opts.status) filter.status = opts.status;
    const data = await this.query<{ app: { byId: { builds: EasBuild[] } } }>(
      `query($id: String!, $limit: Int!, $filter: BuildFilter) { app { byId(appId: $id) { builds(limit: $limit, offset: 0, filter: $filter) { ${BUILD_FIELDS} } } } }`,
      { id: projectId, limit: opts.limit ?? 50, filter },
    );
    return data.app.byId.builds;
  }

  /** The newest FINISHED build of a profile for a platform that `want` accepts, or null. */
  async latest(projectId: string, profile: string, platform: EasPlatform, want: (b: EasBuild) => boolean = () => true): Promise<EasBuild | null> {
    return (await this.builds(projectId, { limit: 20, profile, platform, status: "FINISHED" })).find(want) ?? null;
  }

  /** One build by full id, or by a prefix that matches exactly one recent build. */
  async build(projectId: string, idOrPrefix: string): Promise<EasBuild | null> {
    const id = idOrPrefix.toLowerCase();
    if (!/^[0-9a-f-]{4,36}$/.test(id)) throw new EasError(`"${idOrPrefix}" is not an EAS build id or id prefix`, "pass the build id EAS shows (a UUID), or its first 8 characters", "bad_request");
    if (UUID_RE.test(id)) {
      const data = await this.query<{ builds: { byId: EasBuild | null } }>(`query($id: ID!) { builds { byId(buildId: $id) { ${BUILD_FIELDS} } } }`, { id });
      return data.builds.byId;
    }
    const matches = (await this.builds(projectId, { limit: 100 })).filter((b) => b.id.startsWith(id));
    if (matches.length > 1) {
      throw new EasError(`build id prefix "${idOrPrefix}" matches ${matches.length} builds (${matches.map((b) => b.id.slice(0, 12)).join(", ")})`, "pass more characters of the id", "bad_request");
    }
    return matches[0] ?? null;
  }

  /**
   * The newest update for the build's platform and runtime on the branches its channel maps to.
   * Null without a channel: any other branch could be a production one.
   */
  async latestUpdateFor(projectId: string, b: Pick<EasBuild, "platform" | "runtime" | "updateChannel">): Promise<EasUpdate | null> {
    const rv = b.runtime?.version;
    const branchIds = channelBranchIds(b.updateChannel?.branchMapping);
    if (!rv || branchIds.length === 0) return null;
    const data = await this.query<{
      app: { byId: { updateBranches: { id: string; name: string; updates: { id: string; group: string; platform: string; createdAt: string; message: string | null }[] }[] } };
    }>(
      `query($id: String!, $filter: UpdatesFilter) { app { byId(appId: $id) { updateBranches(offset: 0, limit: 200) { id name updates(offset: 0, limit: 1, filter: $filter) { id group platform createdAt message } } } } }`,
      { id: projectId, filter: { platform: b.platform, runtimeVersions: [rv] } },
    );
    const found = data.app.byId.updateBranches
      .filter((br) => branchIds.includes(br.id))
      .flatMap((br) => br.updates.map((u) => ({ ...u, branchId: br.id, branchName: br.name, runtimeVersion: rv })))
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt));
    return found[0] ?? null;
  }
}

/** Branch ids a channel's `branchMapping` JSON can serve, every arm of a rollout included. */
export function channelBranchIds(branchMapping: string | null | undefined): string[] {
  if (!branchMapping) return [];
  try {
    const m = JSON.parse(branchMapping) as { data?: { branchId?: unknown }[] };
    return (m.data ?? []).map((d) => d.branchId).filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

/** The dev-client deep link that loads one EAS Update group. */
export function devClientUpdateUrl(scheme: string, projectId: string, group: string): string {
  if (!/^[a-z][a-z0-9+.-]*$/i.test(scheme)) throw new EasError(`"${scheme}" is not a URL scheme`);
  if (!UUID_RE.test(projectId) || !/^[0-9a-f-]{8,64}$/i.test(group)) throw new EasError("refusing an update link built from an unexpected project id or update group");
  return `${scheme}://expo-development-client/?url=${encodeURIComponent(`https://u.expo.dev/${projectId}/group/${group}`)}`;
}

export type ArtifactKind = "apk" | "aab" | "ipa" | "simulator" | "unknown";

export function artifactKind(b: Pick<EasBuild, "artifacts">): ArtifactKind {
  let path: string;
  try {
    path = new URL(b.artifacts?.buildUrl ?? "").pathname;
  } catch {
    return "unknown";
  }
  if (path.endsWith(".apk")) return "apk";
  if (path.endsWith(".aab")) return "aab";
  if (path.endsWith(".ipa")) return "ipa";
  if (path.endsWith(".tar.gz") || path.endsWith(".tgz")) return "simulator";
  return "unknown";
}
