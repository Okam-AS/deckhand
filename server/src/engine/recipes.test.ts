import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
      assert.match(script, /if \[ -f bun\.lock \] \|\| \[ -f bun\.lockb \]; then/);
      assert.match(script, /elif \[ -f yarn\.lock \]; then/);
      assert.match(script, /elif \[ -f pnpm-lock\.yaml \]; then/);
      assert.match(script, /elif \[ -f package-lock\.json \]; then/);
      // npm is the fallback, so it must be tested last of the four.
      const order = ["bun.lock", "yarn.lock", "pnpm-lock.yaml", "package-lock.json"].map((f) => script.indexOf(f));
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

  it("expo android runs install then expo run:android with the serial", () => {
    const plan = buildPlan({ ...androidInput, type: "expo" });
    assert.deepEqual(
      plan.map((s) => s.name),
      ["install-deps", "build"],
    );
    assert.deepEqual((plan[1]!.run as { args: string[] }).args, [
      "expo",
      "run:android",
      "--device",
      "emulator-5554",
      "--no-bundler",
    ]);
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

  it("never wipes the developer's node_modules (install only when missing)", () => {
    const plan = buildPlan({ ...base, type: "react-native" });
    const deps = plan[0]!;
    assert.equal(deps.name, "install-deps");
    const script = deps.run.kind === "shell" ? deps.run.script : "";
    assert.match(script, /^if \[ -d node_modules \]; then exit 0; fi/, "an existing node_modules must be left alone");
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

  it("prefers bun when the project has a bun lockfile, in both modes", () => {
    for (const local of [true, false]) {
      const plan = buildPlan({ ...base, local, type: "expo" });
      const script = plan[0]!.run.kind === "shell" ? (plan[0]!.run as { script: string }).script : "";
      // bun is tested BEFORE npm: a bun project keeps its private-registry
      // scopes in bunfig.toml, which npm can't read — npm resolves them against
      // the public registry and 404s.
      assert.ok(script.indexOf("bun.lock") < script.indexOf("package-lock.json"), "bun must be checked first");
      assert.match(script, /bun install --frozen-lockfile/, "never rewrite the borrowed lockfile");
      // The availability check is the shared `pm_need` helper (which is
      // `command -v "$1"`), applied per manager rather than bun-only.
      assert.match(script, /then pm_need bun;/, "a missing bun must say so, not fall through to npm");
      assert.match(script, /command -v "\$1"/);
      assert.match(script, /exit 127/, "a missing manager is a command-not-found condition");
    }
  });
});

describe("buildPlan — web", () => {
  const input: BuildPlanInput = { type: "web", platform: "web", udid: "", worktreePath: "/Users/dev/site", appEnv: {}, local: true };

  it("is deps-only (guarded) — the long-lived dev server does the rest", () => {
    const plan = buildPlan(input);
    assert.equal(plan.length, 1);
    assert.equal(plan[0]!.name, "install-deps");
    const script = plan[0]!.run.kind === "shell" ? plan[0]!.run.script : "";
    assert.match(script, /^if \[ -d node_modules \]; then exit 0; fi/, "a web dev's node_modules must be left alone");
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
