import type { App } from "../config.ts";
import type { KeyLookup } from "./secrets.ts";

export const EGRESS_HOST = "api.typesafe.ai";

/** The apps whose screens `navigate` may send to TypeSafe: the operator's per-app consent. */
export function egressApps(apps: App[]): string[] {
  return apps.filter((a) => a.navigateEgress === true).map((a) => a.id);
}

export interface EgressStatus {
  /** true when screen text can leave this machine right now. */
  sending: boolean;
  detail: string;
}

export function egressStatus(apps: App[], key: KeyLookup): EgressStatus {
  const ids = egressApps(apps);
  const hasKey = key.state === "ok";
  if (ids.length === 0) {
    return { sending: false, detail: `navigate egress off for every app${hasKey ? " (a TypeSafe key is set)" : ""} — enable one with \`deckhand navigate enable <appId>\`` };
  }
  if (!hasKey) {
    return { sending: false, detail: `navigate egress consented for ${ids.join(", ")}, but no TypeSafe key is set, so nothing is sent — \`deckhand secret set typesafe\`` };
  }
  return { sending: true, detail: `navigate sends screen labels to ${EGRESS_HOST} (a third party) for: ${ids.join(", ")} — test data and test accounts only` };
}

export function navigateEgressLine(apps: App[], key: KeyLookup): string {
  return egressStatus(apps, key).detail;
}
