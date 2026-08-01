import type { MetroManager, MetroHandle } from "../engine/metro.ts";
import type { DevProcessManager, DevRunSpec } from "../engine/devProcess.ts";

/**
 * Complete test doubles, one per injected dependency.
 *
 * Test files used to build these inline as object literals cast with
 * `as unknown as X`, which turns off BOTH excess-property and
 * missing-property checking. Adding a method to the real class then left every
 * fake silently behind, and the failure surfaced far from the cause:
 *
 *   - `proxy.test.ts`'s engine fake kept a renamed method, so the proxy called
 *     `undefined` at runtime with a clean typecheck.
 *   - the android fake lacked `attachedSerials`, the worktree fake lacked
 *     `localBranch` — the latter shipped 16 red tests.
 *   - worst, the metro and devProcs fakes lacked `livePids`, so `reapOrphans()`
 *     threw, the surrounding `catch` swallowed it, and **the entire orphan sweep
 *     was a no-op in every test using the base harness while reporting success**.
 *
 * The rule these enforce: a fake is a COMPLETE implementation plus an override,
 * declared as the real type. Adding a method to the real class is then one
 * compile error here, not silence in eleven files.
 *
 * Only for dependencies that are classes. `StreamingBackend` needs nothing like
 * this because it is a two-method interface — which is the deeper lesson: a dep
 * declared as the narrow interface its caller actually uses makes total fakes
 * free.
 */

/**
 * The public surface of a class, as a plain object type.
 *
 * `keyof` on a class type yields only its PUBLIC members, so an object literal
 * declared as `PublicOf<Simctl>` must implement every public method — a missing
 * one is a compile error right here. The single `as unknown as T` afterwards is
 * then safe and deliberate: it only launders the private fields, which no caller
 * can reach anyway.
 *
 * Writing the fake as `{...} as unknown as T` directly is what this replaces —
 * that form silences the completeness check, which is the entire bug class.
 */
type PublicOf<T> = { [K in keyof T]: T[K] };

export function fakeMetro(over: Partial<MetroManager> = {}, log: string[] = []): MetroManager {
  const complete: PublicOf<MetroManager> = {
    livePids: () => [],
    portForApp: () => null,
    ensure: async () => {
      log.push("metro ensure");
      return { manifestUrl: "http://127.0.0.1:8081", port: 8081 } as unknown as MetroHandle;
    },
    stop: async () => {
      log.push("metro stop");
    },
    stopApp: async () => {
      log.push("metro stopApp");
    },
  };
  return Object.assign(complete as unknown as MetroManager, over);
}

export function fakeDevProcs(over: Partial<DevProcessManager> = {}, log: string[] = []): DevProcessManager {
  const complete: PublicOf<DevProcessManager> = {
    livePids: () => [],
    start: (spec: DevRunSpec) => {
      log.push(`dev start ${spec.key}`);
    },
    isAlive: () => true,
    exitCode: () => null,
    restart: () => true,
    stop: (key: string) => {
      log.push(`dev stop ${key}`);
    },
    stopAll: () => {
      log.push("dev stopAll");
    },
  };
  return Object.assign(complete as unknown as DevProcessManager, over);
}
