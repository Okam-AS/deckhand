import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlan, usesMetroDeepLink, nativescriptDevRun, webDevRun, webRootDevRun, GENERAL_IDLE_MS, SPM_IDLE_MS, type BuildPlanInput } from "./recipes.ts";

const baseInput: Omit<BuildPlanInput, "type"> = {
  platform: "ios",
  udid: "UDID-123",
  worktreePath: "/wt",
  appEnv: { EXPO_PUBLIC_API_URL: "https://staging" },
};

function stepByName(input: BuildPlanInput, name: string) {
  return buildPlan(input).find((s) => s.name === name);
}

/** Drop quoted text (operator messages) so assertions see only what the shell runs. */
function stripQuoted(script: string): string {
  return script.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
}

/** The install-deps script for a plan, as a string. */
function installScript(input: BuildPlanInput): string {
  const run = buildPlan(input)[0]!.run;
  return run.kind === "shell" ? run.script : "";
}

describe("buildPlan — expo iOS", () => {
  const plan = buildPlan({ ...baseInput, type: "expo" });

  it("installs deps then builds with expo run:ios --no-bundler", () => {
    assert.deepEqual(
      plan.map((s) => s.name),
      ["install-deps", "build"],
    );
    const build = plan[1]!;
    assert.deepEqual(build.run, {
      kind: "argv",
      command: "npx",
      args: ["expo", "run:ios", "--device", "UDID-123", "--no-bundler"],
    });
    assert.equal(build.cwd, "/wt");
  });

  it("forwards app env to the build step (EXPO_PUBLIC_* must reach the build)", () => {
    assert.equal(plan[1]!.env?.EXPO_PUBLIC_API_URL, "https://staging");
  });

  it("never passes --clear anywhere", () => {
    for (const s of plan) {
      const text = s.run.kind === "shell" ? s.run.script : s.run.args.join(" ");
      assert.doesNotMatch(text, /--clear/);
    }
  });

  it("uses a metro deep link for expo", () => {
    assert.equal(usesMetroDeepLink("expo"), true);
  });
});

describe("install-deps — package manager dispatch", () => {
  const git = installScript({ ...baseInput, type: "expo" });
  const local = installScript({ ...baseInput, type: "expo", local: true });

  it("dispatches on each manager's own lockfile, bun/yarn/pnpm before npm", () => {
    // A project's own lockfile drives the install instead of everything being
    // forced through npm, which chokes on peer-dep shapes bun tolerates.
    for (const script of [git, local]) {
      assert.match(script, /if \[ -f "\$PM_ROOT\/bun\.lock" \] \|\| \[ -f "\$PM_ROOT\/bun\.lockb" \]; then/);
      assert.match(script, /elif \[ -f "\$PM_ROOT\/yarn\.lock" \]; then/);
      assert.match(script, /elif \[ -f "\$PM_ROOT\/pnpm-lock\.yaml" \]; then/);
      assert.match(script, /elif \[ -f "\$PM_ROOT\/package-lock\.json" \]; then/);
      // npm is the fallback, so it must be tested last of the four.
      // Measured from the dispatch chain only: local mode prefixes a staleness guard that
      // names every lockfile (in mtime order, not detection order), so indexOf over the whole
      // script compares positions in the guard rather than in the install.
      const chain = script.slice(script.indexOf('if [ -f "$PM_ROOT/bun.lock" ]'));
      const order = ["bun.lock", "yarn.lock", "pnpm-lock.yaml", "package-lock.json"].map((f) => chain.indexOf(f));
      assert.deepEqual(order, [...order].sort((a, b) => a - b), "detection order must be bun, yarn, pnpm, npm");
    }
  });

  it("installs from the lockfile, never rewriting it, in both modes", () => {
    for (const script of [git, local]) {
      assert.match(script, /bun install --frozen-lockfile/);
      assert.match(script, /yarn install --frozen-lockfile/);
      assert.match(script, /pnpm install --frozen-lockfile/);
      assert.match(script, /npm ci/);
    }
  });

  it("fails with a named fix when the lockfile's manager is not installed on the host", () => {
    // Otherwise a yarn-lockfile repo on a Mac without yarn dies as a bare
    // exit-127 "command not found" in the middle of a build log.
    for (const script of [git, local]) {
      assert.match(script, /pm_need\(\) \{ command -v "\$1" >\/dev\/null 2>&1 \|\|/);
      for (const pm of ["bun", "yarn", "pnpm", "npm"]) assert.match(script, new RegExp(`then pm_need ${pm};`));
      assert.match(script, /is not installed on this host/);
    }
  });

  it("git mode falls back to an updating install when the lockfile is out of sync", () => {
    // A frozen install fails hard on a lockfile that lags package.json. In a
    // disposable worktree, rewriting it is harmless — and previewing a branch
    // whose lockfile lags is exactly the case deckhand exists to serve.
    const executed = stripQuoted(git);
    assert.match(executed, /bun install --frozen-lockfile \|\| \{ echo .*; bun install; \}/);
    assert.match(executed, /npm ci \|\| \{ echo .*; npm install; \}/);
    assert.match(git, /retrying with an updating install/);
  });

  it("finds the lockfile up the tree, because a workspace member does not hold one", () => {
    // THE BUG THIS EXISTS FOR (2026-08-09): every test was `-f <lockfile>` in the app's own
    // directory. A pnpm/yarn/bun workspace keeps its lockfile at the repo root, so a monorepo app
    // matched nothing and fell through to the no-lockfile default — `npm install`, which cannot
    // resolve `workspace:*`. Previewing such an app died as EUNSUPPORTEDPROTOCOL, or silently
    // installed a second copy of react and crashed inside a hook with a message naming nothing.
    for (const script of [git, local]) {
      assert.match(script, /pm_root\(\) \{/, "the walk must exist");
      assert.match(script, /d=\$\(dirname "\$d"\)/, "and it must actually ascend");
      assert.match(script, /PM_ROOT=\$\(pm_root\)/, "resolved once, so dispatch and install agree");
    }
  });

  it("bounds the walk by the app's own git repository", () => {
    // Unbounded, a checkout sitting inside an unrelated project would install from a stranger's
    // lockfile — worse than the bug above. Outside a git repo the bound is the app directory,
    // i.e. exactly the behaviour that shipped before the walk existed.
    for (const script of [git, local]) {
      assert.match(script, /rev-parse --show-toplevel/, "the bound is the git root");
      assert.match(script, /\[ "\$d" = "\$stop" \] && return 0/, "and the walk stops there");
      assert.match(script, /printf %s "\$PWD"/, "with the app dir as the fallback bound");
    }
  });

  it("installs from the directory that owns the lockfile, not from the app dir", () => {
    // pnpm run from a member directory installs that member; the workspace has to be installed
    // from its root, which is also where the lockfile it was told to freeze against lives.
    for (const script of [git, local]) {
      for (const pm of ["bun", "yarn", "pnpm", "npm"]) {
        assert.match(script, new RegExp(`then pm_need ${pm}; cd "\\$PM_ROOT" \\|\\| exit 1;`));
      }
    }
  });

  it("no lockfile at all: plain npm install in git mode, --no-package-lock locally", () => {
    assert.match(git, /else npm install; fi/);
    assert.match(local, /else npm install --no-package-lock; fi/);
  });
});

describe("buildPlan — bare react-native iOS", () => {
  const plan = buildPlan({ ...baseInput, type: "react-native" });

  it("runs install, guarded pods, then Release build with --no-packager", () => {
    assert.deepEqual(
      plan.map((s) => s.name),
      ["install-deps", "pods", "build"],
    );
    const pods = stepByName({ ...baseInput, type: "react-native" }, "pods")!;
    assert.equal(pods.run.kind, "shell");
    assert.match((pods.run as { script: string }).script, /cmp -s ios\/Podfile\.lock ios\/Pods\/Manifest\.lock/);

    const build = plan[2]!;
    assert.deepEqual((build.run as { args: string[] }).args, [
      "react-native",
      "run-ios",
      "--udid",
      "UDID-123",
      "--mode",
      "Release",
      "--no-packager",
    ]);
  });

  it("does not use a metro deep link", () => {
    assert.equal(usesMetroDeepLink("react-native"), false);
  });
});

describe("buildPlan — nativescript iOS", () => {
  const input = { ...baseInput, type: "nativescript" as const };
  const plan = buildPlan(input);

  it("pre-resolves SPM out-of-band with a shorter watchdog before building", () => {
    assert.deepEqual(
      plan.map((s) => s.name),
      ["install-deps", "ns-prepare", "spm-resolve", "build"],
    );
    const spm = stepByName(input, "spm-resolve")!;
    assert.equal(spm.idleTimeoutMs, SPM_IDLE_MS);
    assert.equal(spm.optional, true);
    assert.equal(spm.cwd, "/wt/platforms/ios");

    const build = plan[3]!;
    assert.deepEqual((build.run as { args: string[] }).args, [
      "run",
      "ios",
      "--no-hmr",
      "--no-watch",
      "--justlaunch",
      "--device",
      "UDID-123",
    ]);
    assert.equal(build.idleTimeoutMs, GENERAL_IDLE_MS);
  });
});

describe("buildPlan — android", () => {
  const androidInput = { ...baseInput, platform: "android" as const, udid: "emulator-5554" };

  it("expo android resolves the AVD name from the serial before run:android", () => {
    const plan = buildPlan({ ...androidInput, type: "expo" });
    assert.deepEqual(
      plan.map((s) => s.name),
      ["install-deps", "build"],
    );
    const script = (plan[1]!.run as { kind: string; script: string }).script;
    assert.equal((plan[1]!.run as { kind: string }).kind, "shell");
    // Looks the AVD name up rather than handing expo the serial, which it
    // cannot match against a device name.
    assert.match(script, /adb -s 'emulator-5554' emu avd name/);
    // An unusable `emu avd name` answer still falls back to the serial.
    assert.match(script, /_avd='emulator-5554'/);
    assert.match(script, /npx expo run:android --device "\$_avd" --no-bundler/);
  });

  it("bare react-native android uses run-android --deviceId", () => {
    const plan = buildPlan({ ...androidInput, type: "react-native" });
    assert.deepEqual((plan[1]!.run as { args: string[] }).args, [
      "react-native",
      "run-android",
      "--deviceId",
      "emulator-5554",
    ]);
  });

  it("nativescript android uses ns run android", () => {
    const plan = buildPlan({ ...androidInput, type: "nativescript" });
    assert.deepEqual((plan[1]!.run as { args: string[] }).args, [
      "run",
      "android",
      "--no-hmr",
      "--no-watch",
      "--justlaunch",
      "--device",
      "emulator-5554",
    ]);
  });
});

describe("buildPlan — local dev mode", () => {
  const base = { platform: "ios" as const, udid: "UDID", worktreePath: "/Users/dev/app", appEnv: {}, local: true };

  it("never wipes the developer's node_modules (install only when missing or stale)", () => {
    const plan = buildPlan({ ...base, type: "react-native" });
    const deps = plan[0]!;
    assert.equal(deps.name, "install-deps");
    const script = deps.run.kind === "shell" ? deps.run.script : "";
    assert.match(script, /\[ -d node_modules \]/, "an existing node_modules must be left alone");
    // ...unless the manifest moved under it: present-but-incomplete surfaces far
    // downstream as a Metro "Unable to resolve module", which reads as the app's
    // bug rather than a checkout that never got the new dependency.
    assert.match(script, /! \[ package\.json -nt "\$PM_NM" \]/, "a manifest newer than node_modules must install");
    assert.match(script, /! \[ "\$PM_ROOT\/bun\.lock" -nt "\$PM_NM" \]/, "a lockfile newer than node_modules must install");
    assert.match(script, /! \[ "\$PM_ROOT\/yarn\.lock" -nt "\$PM_NM" \]/, "the staleness check covers every manager's lockfile");
    assert.match(script, /! \[ "\$PM_ROOT\/pnpm-lock\.yaml" -nt "\$PM_NM" \]/, "the staleness check covers every manager's lockfile");
  });

  it("leaves the borrowed checkout's tracked git state clean (frozen installs, or --no-package-lock)", () => {
    const script = (() => {
      const s = buildPlan({ ...base, type: "react-native" })[0]!.run;
      return s.kind === "shell" ? s.script : "";
    })();
    // Every manager installs in its frozen/read-only mode, so no lockfile is
    // rewritten. Without any lockfile: `npm install --no-package-lock`, so no
    // stray lockfile lands in their repo.
    assert.match(script, /npm ci/);
    assert.match(script, /npm install --no-package-lock/);
    // The invariant: no manager may reach an updating install here, since that
    // would rewrite a lockfile deckhand only borrowed. Strip the quoted operator
    // messages first — they name the command a human should run, and must not be
    // confused with one this script runs.
    const executed = stripQuoted(script);
    for (const pm of ["bun", "yarn", "pnpm"]) {
      assert.doesNotMatch(
        executed,
        new RegExp(`${pm} install(?! --frozen-lockfile)`),
        `local mode must not run an updating ${pm} install`,
      );
    }
    assert.doesNotMatch(executed, /retrying with an updating install/);
    // A stale lockfile must fail with instructions, not a silent repair.
    assert.match(script, /will not modify a borrowed checkout/);
    assert.match(script, /exit 1/);
  });

  it("local nativescript is deps-only — the livesync process does the build", () => {
    const plan = buildPlan({ ...base, type: "nativescript" });
    assert.equal(plan.length, 1);
    assert.equal(plan[0]!.name, "install-deps");
  });

  it("nativescriptDevRun watches with HMR off and stays alive (no --justlaunch)", () => {
    const { command, args } = nativescriptDevRun("ios", "UDID");
    assert.equal(command, "ns");
    assert.deepEqual(args, ["run", "ios", "--no-hmr", "--device", "UDID"]);
    assert.ok(!args.includes("--no-watch"), "watch is the point of dev mode");
    assert.ok(!args.includes("--justlaunch"), "the process must keep running to livesync");
  });

  it("git-mode plans still use the wiping npm ci install", () => {
    const plan = buildPlan({ ...base, local: false, type: "react-native" });
    const script = plan[0]!.run.kind === "shell" ? (plan[0]!.run as { script: string }).script : "";
    assert.ok(!script.includes("[ -d node_modules ]"), "worktrees want the reproducible npm ci path");
  });

  it("installs yarn with --frozen-lockfile, never --immutable", () => {
    // Not style. Measured against yarn 1.22.22 and yarn 4.18.0 with a stale lockfile
    // (2026-08-01): `--immutable` on yarn 1 exits 0 and REWRITES the lockfile, because
    // yarn 1 ignores unknown flags — so switching to it would silently break
    // borrow-never-own in a local checkout, which is the invariant local mode exists for.
    // `--frozen-lockfile` is deprecated on berry but still enforces, and is correct on both.
    for (const local of [true, false]) {
      const plan = buildPlan({ ...base, local, type: "expo" });
      const script = plan[0]!.run.kind === "shell" ? (plan[0]!.run as { script: string }).script : "";
      assert.match(script, /yarn install --frozen-lockfile/);
      assert.doesNotMatch(
        script,
        /yarn install --immutable/,
        "--immutable is a no-op on yarn 1.x, so a stale lockfile in a borrowed checkout is rewritten",
      );
    }
  });

  it("prefers bun when the project has a bun lockfile, in both modes", () => {
    for (const local of [true, false]) {
      const plan = buildPlan({ ...base, local, type: "expo" });
      const full = plan[0]!.run.kind === "shell" ? (plan[0]!.run as { script: string }).script : "";
      // Only the install clause decides the package manager; local mode prefixes
      // a staleness guard that names every lockfile, so match on the whole
      // script would compare positions in the guard, not in the install.
      const script = full.slice(full.indexOf('if [ -f "$PM_ROOT/bun.lock" ]'));
      // bun is tested BEFORE npm: a bun project keeps its private-registry
      // scopes in bunfig.toml, which npm can't read — npm resolves them against
      // the public registry and 404s.
      assert.ok(script.indexOf("bun.lock") < script.indexOf("package-lock.json"), "bun must be checked first");
      assert.match(script, /bun install --frozen-lockfile/, "never rewrite the borrowed lockfile");
      // The availability check is the shared `pm_need` helper (which is `command -v "$1"`),
      // applied per manager rather than bun-only. Asserted on the FULL script: the helper is
      // DEFINED above the dispatch chain, so the slice above cuts its definition off.
      assert.match(script, /then pm_need bun;/, "a missing bun must say so, not fall through to npm");
      assert.match(full, /command -v "\$1"/);
      // Also on the full script: `exit 127` lives inside the pm_need definition.
      assert.match(full, /exit 127/, "a missing manager is a command-not-found condition");
    }
  });
});

describe("install-deps — the emitted script, run for real", () => {
  /**
   * Run a plan's install-deps script in `cwd` with every package manager stubbed, and return
   * what it did. The text assertions above cannot see this: the staleness guard and the
   * dispatch chain only disagree once a real directory layout is under them.
   */
  function runInstallDeps(cwd: string, local = true): string {
    const stubs = mkdtempSync(join(tmpdir(), "deckhand-pm-bin-"));
    for (const pm of ["bun", "yarn", "pnpm", "npm"]) {
      writeFileSync(join(stubs, pm), `#!/bin/sh\necho "RAN ${pm} $* in $(pwd -P)"\n`, { mode: 0o755 });
    }
    const script = installScript({ ...baseInput, type: "expo", local, worktreePath: cwd });
    const r = spawnSync("/bin/sh", ["-c", script], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, PATH: `${stubs}:${process.env.PATH ?? ""}` },
    });
    return (r.stdout ?? "") + (r.stderr ?? "");
  }

  /** Touch `paths` in order, each a second apart, so `-nt` comparisons are unambiguous. */
  function age(root: string, paths: string[]): void {
    paths.forEach((p, i) => {
      const t = new Date(Date.now() - (paths.length - i) * 60_000);
      utimesSync(join(root, p), t, t);
    });
  }

  /** A git repo with a pnpm workspace: lockfile at the root, the app a member of it. */
  function mkWorkspace(): { root: string; app: string } {
    const root = mkdtempSync(join(tmpdir(), "deckhand-ws-"));
    spawnSync("git", ["init", "-q", root]);
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    writeFileSync(join(root, "package.json"), '{"name":"root","private":true}');
    const app = join(root, "apps", "foo");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, "package.json"), '{"name":"foo"}');
    return { root, app };
  }

  it("leaves a hoisted workspace alone when the root's node_modules is fresh", () => {
    // npm and yarn workspaces hoist: apps/foo has NO node_modules, so `[ -d node_modules ]`
    // was false forever and every preview reinstalled the whole workspace — under an npm
    // lockfile that is `npm ci` at the root, which deletes the developer's node_modules
    // first. Local mode exists to never do that.
    const { root, app } = mkWorkspace();
    mkdirSync(join(root, "node_modules"));
    age(root, ["pnpm-lock.yaml", "apps/foo/package.json", "node_modules"]);
    assert.doesNotMatch(runInstallDeps(app), /RAN/, "nothing should be installed");
  });

  it("still installs — from the root, with the root's manager — when the member's manifest is newer", () => {
    const { root, app } = mkWorkspace();
    mkdirSync(join(root, "node_modules"));
    age(root, ["pnpm-lock.yaml", "node_modules", "apps/foo/package.json"]);
    const out = runInstallDeps(app);
    assert.match(out, /RAN pnpm install --frozen-lockfile in /);
    assert.ok(out.includes(`in ${realpathSync(root)}`), "the workspace installs from its root");
  });

  it("single repo: unchanged — its own node_modules is what the guard reads", () => {
    const dir = mkdtempSync(join(tmpdir(), "deckhand-single-"));
    spawnSync("git", ["init", "-q", dir]);
    writeFileSync(join(dir, "package.json"), '{"name":"solo"}');
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    mkdirSync(join(dir, "node_modules"));
    age(dir, ["package.json", "pnpm-lock.yaml", "node_modules"]);
    assert.doesNotMatch(runInstallDeps(dir), /RAN/, "a fresh node_modules must be left alone");

    age(dir, ["node_modules", "package.json"]);
    assert.match(runInstallDeps(dir), /RAN pnpm install --frozen-lockfile/, "a newer manifest must install");
  });
});

describe("buildPlan — web", () => {
  const input: BuildPlanInput = { type: "web", platform: "web", udid: "", worktreePath: "/Users/dev/site", appEnv: {}, local: true };

  it("is deps-only (guarded) — the long-lived dev server does the rest", () => {
    const plan = buildPlan(input);
    assert.equal(plan.length, 1);
    assert.equal(plan[0]!.name, "install-deps");
    const script = plan[0]!.run.kind === "shell" ? plan[0]!.run.script : "";
    assert.match(script, /\[ -d node_modules \]/, "a web dev's node_modules must be left alone");
  });
});

describe("webDevRun", () => {
  it("runs the dev script and injects loopback host, port, and the share base", () => {
    const { command, args } = webDevRun("dev", "/s/abc123/web/", 5173);
    assert.equal(command, "npm");
    assert.deepEqual(args, ["run", "dev", "--", "--host", "127.0.0.1", "--port", "5173", "--strictPort", "--base", "/s/abc123/web/"]);
  });

  it("honors a custom dev script name", () => {
    const { args } = webDevRun("start", "/s/x/web/", 5180);
    assert.equal(args[1], "start");
    assert.ok(args.includes("--base") && args.includes("/s/x/web/"));
  });
});

describe("webRootDevRun (subdomain hosting — no base, no checkout edit)", () => {
  it("runs Nuxt/Next at root with -H/-p and NO base flag", () => {
    const nuxt = webRootDevRun("nuxt", "dev", 5171);
    assert.deepEqual(nuxt, { command: "npm", args: ["run", "dev", "--", "-H", "127.0.0.1", "-p", "5171"] });
    assert.ok(!nuxt.args.includes("--base"), "root hosting must not inject a base path");
    const next = webRootDevRun("next", "dev", 5172);
    assert.deepEqual(next.args.slice(-4), ["-H", "127.0.0.1", "-p", "5172"]);
  });

  it("runs Vite at root with --host/--port/--strictPort (still no base)", () => {
    const vite = webRootDevRun("vite", "dev", 5173);
    assert.deepEqual(vite.args, ["run", "dev", "--", "--host", "127.0.0.1", "--port", "5173", "--strictPort"]);
    assert.ok(!vite.args.includes("--base"));
  });
});

describe("pods never rewrite a borrowed checkout", () => {
  const podsScriptFor = (local: boolean): string => {
    const plan = buildPlan({ ...baseInput, local, type: "react-native", platform: "ios" });
    const step = plan.find((s) => s.name === "pods");
    assert.ok(step, "the react-native iOS plan has a pods step");
    return step!.run.kind === "shell" ? (step!.run as { script: string }).script : "";
  };

  it("uses --deployment in local mode, so Podfile.lock is never rewritten", () => {
    // `pod install` rewrites ios/Podfile.lock — a TRACKED file — in the developer's own
    // working copy. That is the one build step that broke borrow-never-own, and it broke it
    // silently: the developer finds their checkout dirty with no idea what did it.
    const local = podsScriptFor(true);
    assert.match(local, /pod install --deployment/);
    // Only the EXECUTED part: the guidance message deliberately contains the bare command,
    // because that is what the developer is being told to run themselves.
    const executed = local.slice(0, local.indexOf("|| { echo"));
    assert.doesNotMatch(executed, /pod install(?! --deployment)/, "no un-frozen pod install may run in local mode");
    assert.match(local, /pod install' here yourself/, "and the developer is told the command to run");
    assert.match(local, /exit 1/, "a stale Pods dir fails rather than being fixed for them");
  });

  it("still installs normally in a disposable git worktree", () => {
    // The worktree is thrown away, so rewriting its lockfile costs nothing — and refusing
    // would brick a preview of a branch whose Pods legitimately moved.
    const git = podsScriptFor(false);
    assert.match(git, /pod install/);
    assert.doesNotMatch(git, /--deployment/);
  });

  it("still skips the step entirely when Pods are already in sync", () => {
    for (const local of [true, false]) {
      assert.match(podsScriptFor(local), /cmp -s ios\/Podfile\.lock ios\/Pods\/Manifest\.lock/);
    }
  });
});
