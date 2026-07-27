import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// ---------------------------------------------------------------------------
// The migration parity ledger (PLAN — migration features). A migration TARGET
// app (one with `migratesFrom`) carries a small, agent-maintained checklist of
// screens and their parity status. The file lives in the TARGET repo's root —
// version-controlled, reviewable in the PR, written by the coding agent that
// owns the repo. Deckhand only READS it (a bounded single-file read, never an
// arbitrary-exec surface) and surfaces it in the viewer. Missing or malformed →
// null (soft-fail: the viewer just shows "no ledger yet").
// ---------------------------------------------------------------------------

export const LEDGER_FILENAME = "deckhand.migration.yaml";

export const SCREEN_STATUSES = ["not-started", "in-progress", "matches", "differs"] as const;
export type ScreenStatus = (typeof SCREEN_STATUSES)[number];

const ledgerSchema = z.object({
  screens: z
    .array(
      z.object({
        name: z.string().min(1),
        status: z.enum(SCREEN_STATUSES).default("not-started"),
        note: z.string().min(1).optional(),
      }),
    )
    .default([]),
});

export type MigrationLedger = z.infer<typeof ledgerSchema>;

/**
 * Read the parity ledger from a target preview's source dir. Returns null when
 * the dir is unknown, the file is absent, the YAML is malformed, or it lists no
 * screens — every failure is soft, so a broken ledger never breaks a preview.
 */
export function readMigrationLedger(sourceDir: string | undefined): MigrationLedger | null {
  if (!sourceDir) return null;
  let text: string;
  try {
    text = readFileSync(join(sourceDir, LEDGER_FILENAME), "utf8");
  } catch {
    return null; // no ledger file yet — the common, expected case
  }
  try {
    const parsed = ledgerSchema.parse(parseYaml(text) ?? {});
    return parsed.screens.length ? parsed : null;
  } catch {
    return null; // malformed → treat as "no ledger yet" rather than surfacing an error
  }
}
