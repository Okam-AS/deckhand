---
paths:
  - "server/src/engine/**/*.ts"
  - "server/src/devices/**/*.ts"
---

The orchestrator: previews, worktrees, builds, devices, and everything that outlives the process.

Hardest rules:

- **Anything spawned detached must stamp an env marker** a later boot can hunt for. An in-memory `Map` is not an owner — it is empty in a fresh process while the children are still running. Three of four detached resources leaked; one reached 36 orphans at 418% CPU, which starved the emulators (CPU-bound QEMU) while iOS stayed fine. → `invariants.test.ts` "marks every long-lived detached spawn"
- **Bookkeeping goes AFTER the effect it records.** A pooled AVD's tenancy was recorded before the `-wipe-data` boot, so a boot that threw left the new app as owner, the retry skipped the wipe, and the previous tenant's storage was handed across owner scopes.
- **Every new `await` widens a window.** Ask what was true between the two lines that is no longer true. Putting the Metro reap ahead of `liveDeviceHandles()` did exactly this.
- **An empty result and a failed lookup must not be the same value.** `loadAppsSafe()` returned `[]` on any failure and `app add` then wrote a file containing only the new app. `AndroidManager.describe` returned `""` for a failed `uiautomator dump`, which an agent reads as "the screen is empty". For every new `catch {}`, `?? []`, `|| false` or unchecked exit code: **which direction does this fail in, and is that the safe one?**
- **Ask adb, not your own bookkeeping.** Deckhand's port set knows nothing about emulators it did not start, and `adb wait-for-device` answers instantly against a stranger's — or a dying one.

**Borrow-never-own.** A `path` app is the developer's working copy: never wipe it, never remove it, never commit in it, never rewrite a tracked file. The install path has no updating fallback there for exactly this reason.
