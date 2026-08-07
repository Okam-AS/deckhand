import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as toYaml } from "yaml";
import { loadConfig, type Config } from "./config.ts";
import { watchAllowlist } from "./connectorWatcher.ts";

/**
 * Without this watcher, `deckhand allow rm` is a lie.
 *
 * The config object is loaded once at boot and closed over by `createApp`, so removing an
 * address edited a file nobody was reading — and the revoked person kept connecting until
 * someone restarted the server, which tears down every booted simulator on the machine.
 *
 * The gap was invisible three ways: the CLI printed "starting with their next call", PLAN said
 * the allowlist is re-checked per request, and the check genuinely DID run per request — it
 * just kept re-reading the same stale array.
 */

let home: string;
let file: string;

const baseConfig = (emails: string[]): Record<string, unknown> => ({
  hostname: "deckhand.example.com",
  port: 4300,
  streaming: { serveSim: { version: "0.1.34", codec: "auto", helperPortRange: [3100, 3199] } },
  connector: { allowedEmails: emails },
});

const write = (emails: string[]): void => writeFileSync(file, toYaml(baseConfig(emails)));

before(() => {
  home = mkdtempSync(join(tmpdir(), "deckhand-allowwatch-"));
  file = join(home, "config.yaml");
});
after(() => rmSync(home, { recursive: true, force: true }));

/** Poll until `check` passes, so the test does not depend on the debounce window's length. */
async function eventually(check: () => boolean, whatWasExpected: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(whatWasExpected);
}

describe("watchAllowlist", () => {
  it("adopts a removal without a restart, and mutates the array the server closed over", async () => {
    write(["owner@example.com", "second@example.com"]);
    const config: Config = loadConfig(file);
    // What `createApp` actually captures: the array, not the config object.
    const live = config.connector.allowedEmails;
    const stop = watchAllowlist(config, { file, debounceMs: 5, pollMs: 20 });
    try {
      assert.deepEqual(live, ["owner@example.com", "second@example.com"]);
      write(["owner@example.com"]);
      await eventually(() => live.length === 1, "the removal never reached the array the server reads");
      assert.deepEqual(live, ["owner@example.com"]);
      assert.equal(config.connector.allowedEmails, live, "the array must be mutated in place, not replaced");
    } finally {
      stop();
    }
  });

  // Same direction as tokens.yaml, opposite to apps.yaml: a revocation must land when it is
  // made. Treating "suddenly empty" as a truncated write would keep a removed address working.
  it("honours an empty allowlist immediately", async () => {
    write(["owner@example.com"]);
    const config: Config = loadConfig(file);
    const live = config.connector.allowedEmails;
    const stop = watchAllowlist(config, { file, debounceMs: 5, pollMs: 20 });
    try {
      write([]);
      await eventually(() => live.length === 0, "an emptied allowlist must lock everyone out at once");
    } finally {
      stop();
    }
  });

  it("keeps the previous allowlist when the file is mid-write, and says so", async () => {
    write(["owner@example.com"]);
    const config: Config = loadConfig(file);
    const live = config.connector.allowedEmails;
    const errors: unknown[] = [];
    const stop = watchAllowlist(config, { file, debounceMs: 5, pollMs: 20, onError: (e) => errors.push(e) });
    try {
      writeFileSync(file, "connector: {allowedEmails: [\n"); // truncated yaml
      await eventually(() => errors.length > 0, "a broken config must be reported, not swallowed");
      // Locking everyone out of a running server because config.yaml was mid-save is a worse
      // failure than a stale allowlist.
      assert.deepEqual(live, ["owner@example.com"]);
    } finally {
      stop();
    }
  });

  it("reports the reload so the operator can see an empty list happened", async () => {
    write(["owner@example.com"]);
    const config: Config = loadConfig(file);
    const seen: string[][] = [];
    const stop = watchAllowlist(config, { file, debounceMs: 5, pollMs: 20, onReload: (e) => seen.push(e) });
    try {
      write(["other@example.com"]);
      await eventually(() => seen.length > 0, "a change to who may connect must be logged");
      assert.deepEqual(seen.at(-1), ["other@example.com"]);
    } finally {
      stop();
    }
  });
});
