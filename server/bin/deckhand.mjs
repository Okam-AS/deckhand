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
//
// tsx is resolved to an ABSOLUTE path from THIS file, not by name. `--import tsx` resolves
// against the process's working directory, so the command worked inside the deckhand checkout
// and died everywhere else with `Cannot find package 'tsx'` — which is every real use, since
// the whole point is to run it from wherever your project is.
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let loader;
try {
  loader = pathToFileURL(require.resolve("tsx")).href;
} catch {
  console.error(
    "deckhand: tsx is missing from the deckhand checkout.\n" +
      `  Run \`npm install\` in ${join(here, "..", "..")} and try again.`,
  );
  process.exit(1);
}

const cli = join(here, "..", "src", "cli.ts");
const r = spawnSync(process.execPath, ["--import", loader, cli, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
