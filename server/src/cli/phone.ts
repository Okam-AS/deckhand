import { discoverIphones, type PhysicalIphone } from "../devices/iphoneDiscovery.ts";
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { AndroidPhones, usabilityBlocker, type PhoneInfo } from "../devices/androidPhone.ts";
import { loadPhoneHolds, savePhoneHolds, type PhoneHolds } from "../devices/phoneHolds.ts";
import { paths } from "../paths.ts";
import type { PersistedState } from "../state.ts";

// `deckhand phone list|hold|release`: a person at the Mac takes a phone off the market (a held
// phone is never handed to a preview) and gives it back. The server reads the holds file on
// every claim, so a hold takes effect on the next start_preview with no restart.

/** Which live preview drives each phone, from state.json — read-only, a display aid. */
export function phoneTenants(state: Pick<PersistedState, "previews"> | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of state?.previews ?? []) {
    if (p.phase === "stopped") continue;
    for (const d of p.devices) if (d.physical && d.serial) out[d.serial] = `${p.previewId} (app ${p.appId})`;
  }
  return out;
}

export function holdPhone(holds: PhoneHolds, id: string, who: string, now: Date): { holds: PhoneHolds; said: string } {
  const prior = holds[id];
  if (prior && prior.who === who) return { holds, said: `${id} is already held by ${who} (since ${prior.since})` };
  const next = { ...holds, [id]: { who, since: now.toISOString() } };
  return { holds: next, said: prior ? `${id} was held by ${prior.who}; now held by ${who}` : `${id} is held by ${who}: no preview will be given it until \`deckhand phone release ${id}\`` };
}

export function releasePhone(holds: PhoneHolds, id: string): { holds: PhoneHolds; said: string } {
  if (!holds[id]) return { holds, said: `${id} was not held` };
  const { [id]: _gone, ...rest } = holds;
  return { holds: rest, said: `${id} is released: previews may use it again` };
}

export function formatPhones(phones: PhoneInfo[], holds: PhoneHolds, tenants: Record<string, string>, iphones: PhysicalIphone[] = []): string {
  const ids = new Set([...phones.map((p) => p.id), ...iphones.map((p) => p.udid), ...Object.keys(holds)]);
  if (!ids.size) return "no phones plugged in (adb and devicectl list none) and none held";
  return [...ids]
    .map((id) => {
      const p = phones.find((x) => x.id === id);
      const i = iphones.find((x) => x.udid === id);
      const name = p ? [p.manufacturer, p.model, p.os].filter(Boolean).join(" ") : i ? [i.model ?? i.name, i.osVersion ? `iOS ${i.osVersion}` : null].filter(Boolean).join(" ") : "not plugged in";
      const hold = holds[id] ? `held by ${holds[id].who} since ${holds[id].since}` : null;
      const tenant = tenants[id] ? `in preview ${tenants[id]}` : null;
      const blocked = p ? usabilityBlocker(p) : null;
      const status = [hold, tenant, blocked ? `${blocked.blocker} — ${blocked.fix}` : null, ...(i?.blockers ?? [])].filter(Boolean).join("; ") || "free";
      return `${id}  ${name}  ${status}`;
    })
    .join("\n");
}

function readState(): PersistedState | null {
  try {
    return JSON.parse(readFileSync(paths.state(), "utf8")) as PersistedState;
  } catch {
    return null;
  }
}

export async function cmdPhone(sub: string | undefined, id: string | undefined, who: string | undefined): Promise<string> {
  if (sub === "list" || sub === undefined) {
    const [phones, iphones] = await Promise.all([new AndroidPhones().list().catch(() => []), discoverIphones().catch(() => [])]);
    return formatPhones(phones, loadPhoneHolds(), phoneTenants(readState()), iphones);
  }
  if (!id || !/^[A-Za-z0-9._:-]{1,64}$/.test(id)) throw new Error(`usage: deckhand phone ${sub === "release" ? "release <id>" : "hold <id> [--who <name>]"} — the id is the serial \`deckhand phone list\` shows`);
  if (sub === "hold") {
    const r = holdPhone(loadPhoneHolds(), id, who || userInfo().username, new Date());
    savePhoneHolds(r.holds);
    const tenant = phoneTenants(readState())[id];
    return tenant ? `${r.said}\nnote: preview ${tenant} still drives it until that preview stops (stop_preview)` : r.said;
  }
  if (sub === "release") {
    const r = releasePhone(loadPhoneHolds(), id);
    savePhoneHolds(r.holds);
    return r.said;
  }
  throw new Error("usage: deckhand phone list | hold <id> [--who <name>] | release <id>");
}
