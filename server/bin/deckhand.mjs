#!/usr/bin/env node
// The `deckhand` command.
//
// Every document in this repo — the README, `init`'s own next-step, the doctor warnings —
// told people to type `deckhand <something>`, and no such command existed: there was no `bin`
// entry anywhere, so the only way in was `npx tsx server/src/cli.ts`. Instructions that cannot
// be followed are worse than none, because the reader assumes the mistake is theirs.
//
// A launcher rather than a build step: the server runs from source under tsx (that is what the
// LaunchAgent does too), so shipping a compiled bin would add a second way to run the same
// code and a second thing to keep in sync.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
const r = spawnSync(process.execPath, ["--import", "tsx", cli, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
