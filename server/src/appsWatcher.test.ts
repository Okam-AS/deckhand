import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchApps } from "./appsWatcher.ts";
import type { App } from "./config.ts";

const APP = (id: string): string =>
  `  - id: ${id}\n    path: /tmp/${id}\n    type: expo\n    defaultBranch: main\n    allowForkPRs: false\n    env: {}\n`;

const yaml = (...ids: string[]): string => `apps:\n${ids.map(APP).join("")}`;

describe("watchApps", () => {
  let dir: string;
  let file: string;
  const stops: (() => void)[] = [];

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "deckhand-apps-"));
    file = join(dir, "apps.yaml");
  });
  after(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => {
    while (stops.length) stops.pop()!();
  });

  /** Mirror writeApps: temp file + rename, which swaps the inode. */
  const writeAtomic = (body: string): void => {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, file);
  };

  const nextReload = (apps: App[], opts: Parameters<typeof watchApps>[1] = {}) =>
    new Promise<{ added: string[]; removed: string[] }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("no reload within 3s")), 3000);
      const stop = watchApps(apps, {
        ...opts,
        file,
        debounceMs: 10,
        pollMs: 50,
        onReload: (_a, changed) => {
          clearTimeout(timeout);
          resolve(changed);
        },
      });
      stops.push(stop);
    });

  it("picks up a newly registered app without a restart, mutating the shared array", async () => {
    writeAtomic(yaml("one"));
    const apps: App[] = [{ id: "one", path: "/tmp/one", type: "expo", defaultBranch: "main", allowForkPRs: false, env: {} } as App];
    const shared = apps; // the exact reference createApp and the MCP tools hold

    const pending = nextReload(apps);
    writeAtomic(yaml("one", "two"));
    const changed = await pending;

    assert.deepEqual(changed.added, ["two"]);
    assert.deepEqual(changed.removed, []);
    assert.equal(shared.length, 2, "the array is mutated in place, not replaced");
    assert.deepEqual(
      shared.map((a) => a.id),
      ["one", "two"],
    );
  });

  it("survives the atomic write that swaps the file's inode", async () => {
    writeAtomic(yaml("one"));
    const apps: App[] = [];
    // One watcher, two successive renames: a file-level watcher would go deaf
    // after the first, because rename replaces the inode it was holding.
    const seen: string[][] = [];
    let wake: (() => void) | null = null;
    const stop = watchApps(apps, {
      file,
      debounceMs: 10,
      pollMs: 50,
      onReload: (a) => {
        seen.push(a.map((x) => x.id));
        wake?.();
      },
    });
    stops.push(stop);

    const nth = (n: number) =>
      new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`only ${seen.length} reloads within 3s`)), 3000);
        wake = () => {
          if (seen.length < n) return;
          clearTimeout(timeout);
          resolve();
        };
        wake();
      });

    writeAtomic(yaml("one", "three"));
    await nth(1);
    writeAtomic(yaml("one", "three", "four"));
    await nth(2);

    assert.deepEqual(seen[0], ["one", "three"]);
    assert.deepEqual(seen[1], ["one", "three", "four"], "the second rename must still be observed");
  });

  it("keeps the previous list when the file is invalid", async () => {
    writeAtomic(yaml("one", "two"));
    const apps: App[] = [
      { id: "one", path: "/tmp/one", type: "expo", defaultBranch: "main", allowForkPRs: false, env: {} } as App,
      { id: "two", path: "/tmp/two", type: "expo", defaultBranch: "main", allowForkPRs: false, env: {} } as App,
    ];

    // Watcher first, THEN the write — otherwise there is no event to observe.
    const errored = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("no error within 3s")), 3000);
      const stop = watchApps(apps, {
        file,
        debounceMs: 10,
        pollMs: 50,
        onError: (err) => {
          clearTimeout(timeout);
          resolve(err);
        },
        onReload: () => assert.fail("an invalid file must not reload"),
      });
      stops.push(stop);
    });
    writeAtomic("apps:\n  - id: 4 4 4\n    ][\n");
    await errored;

    assert.deepEqual(
      apps.map((a) => a.id),
      ["one", "two"],
      "a typo mid-edit must not empty the registry",
    );
  });

  it("stays quiet when the file is rewritten with identical content", async () => {
    writeAtomic(yaml("one"));
    // The in-memory list already matches the file — exactly the state add_app
    // leaves behind, since it mutates the array AND writes the file. That echo
    // must not re-announce.
    const apps: App[] = [
      { id: "one", path: "/tmp/one", type: "expo", defaultBranch: "main", allowForkPRs: false, env: {} } as App,
    ];
    let reloads = 0;
    const stop = watchApps(apps, { file, debounceMs: 10, pollMs: 50, onReload: () => reloads++ });
    stops.push(stop);

    writeAtomic(yaml("one"));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(reloads, 0);
  });
});
