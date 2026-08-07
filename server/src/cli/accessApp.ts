// ---------------------------------------------------------------------------
// The Cloudflare Access application that decides WHO may connect.
//
// It covers exactly one path — `<hostname>/oauth/authorize` — and that narrowness
// is the design, not an optimisation. Access works by redirecting a browser to a
// login page, so putting it in front of `/mcp`, `/oauth/token` or `/oauth/register`
// would break the connector outright: those are called by Claude's backend, which
// has no browser to redirect. Authorize is the only endpoint a human ever loads,
// and it is the only one that needs to know who they are.
//
// Deckhand does NOT create the application for you. Doing so needs a Cloudflare
// API token with Access:Edit — a second credential, with a far wider blast radius
// than the tunnel's, held on the machine forever to save one visit to a dashboard.
// So this file produces the errand and reads back the two values that finish it.
// ---------------------------------------------------------------------------

export interface AccessAppSpec {
  hostname: string;
  emails: string[];
}

/** `acme.cloudflareaccess.com` from whatever shape the operator pasted. */
export function normalizeTeamDomain(input: string): string {
  const bare = input
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
  if (!bare) throw new Error("a Zero Trust team domain is required, e.g. acme.cloudflareaccess.com");
  return bare.includes(".") ? bare : `${bare}.cloudflareaccess.com`;
}

/**
 * The steps to click.
 *
 * Written as an errand with an exact end state, because the two things that go
 * wrong here are silent: a policy scoped to the whole hostname (which breaks the
 * connector, and reads as "deckhand is broken") and a second include rule (which
 * widens the allowlist instead of narrowing it).
 */
export function manualInstructions(spec: AccessAppSpec): string {
  const who = spec.emails.length ? spec.emails.join(", ") : "<the address that may connect>";
  return [
    `Cloudflare Zero Trust → Access → Applications → Add an application → Self-hosted:`,
    ``,
    `  Application name:  deckhand (${spec.hostname})`,
    `  Session duration:  24 hours`,
    `  Domain:            ${spec.hostname}`,
    `  Path:              oauth/authorize        ← the path matters, see below`,
    ``,
    `  Policy name:       deckhand allowlist`,
    `  Action:            Allow`,
    `  Include:           Emails  →  ${who}`,
    `  Login method:      One-time PIN`,
    ``,
    `Set the PATH. Protecting the whole hostname also protects /mcp, which Claude's`,
    `backend calls without a browser — the connector would then fail on a redirect it`,
    `cannot follow. Add exactly ONE include rule: Access ORs them together, so a`,
    `second one widens the allowlist rather than narrowing it.`,
    ``,
    `Then open the application's Overview, copy the Application Audience (AUD) tag,`,
    `and finish with:`,
    ``,
    `  deckhand setup --hostname ${spec.hostname} \\`,
    `      --access-team <your-team>.cloudflareaccess.com --access-aud <AUD>`,
  ].join("\n");
}
