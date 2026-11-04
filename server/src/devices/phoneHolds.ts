import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "../paths.ts";

// A hold takes a phone off the market from the Mac: a held phone is listed with who holds it
// and is never handed to a preview. Its own file, not state.json: the CLI writes it while the
// server runs, and the server rewrites state.json from memory on every transition, which would
// drop a hold written there by another process.

export interface PhoneHold {
  who: string;
  since: string;
}

export type PhoneHolds = Record<string, PhoneHold>;

/** The holds on disk. Missing means none; an unreadable file or entry throws rather than freeing a phone. */
export function loadPhoneHolds(file = paths.phoneHolds()): PhoneHolds {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`cannot read ${file}: ${(e as Error).message}`);
  }
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object of holds`);
  const out: PhoneHolds = {};
  for (const [serial, h] of Object.entries(parsed as Record<string, unknown>)) {
    const hold = h as Partial<PhoneHold> | null;
    if (!hold || typeof hold.who !== "string" || typeof hold.since !== "string") throw new Error(`${file}: the hold on ${serial} has no who/since — fix or remove it`);
    out[serial] = { who: hold.who, since: hold.since };
  }
  return out;
}

export function savePhoneHolds(holds: PhoneHolds, file = paths.phoneHolds()): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(holds, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

const LOCK_STALE_MS = 30_000;

/**
 * Load, change and save the holds as one transaction across processes: two `phone hold` runs
 * would otherwise each save what they read and drop the other's hold.
 */
export function updatePhoneHolds<T>(change: (holds: PhoneHolds) => { holds: PhoneHolds } & T, file = paths.phoneHolds(), waitMs = 5_000): T {
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx", 0o600));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
      } catch {}
      if (Date.now() > deadline) throw new Error(`${lock} is held by another deckhand phone command — retry, or remove it if none is running`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    const r = change(loadPhoneHolds(file));
    savePhoneHolds(r.holds, file);
    return r;
  } finally {
    unlinkSync(lock);
  }
}
