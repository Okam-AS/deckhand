import { describe, it } from "node:test";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DOCTOR_AVD_NAME,
  DOCTOR_SIM_NAME,
  checkConnectorAuth,
  checkPublicUrl,
  deviceGateExit,
  freshnessVerdict,
  readTokens,
  releaseSmokeAvd,
  type Check,
} from "./doctor.ts";
import { fakeAndroid } from "../test-support/fakes.ts";
import { orphanAvds, orphanSims } from "../engine/reaper.ts";
import type { Config } from "../config.ts";

/**
 * The `--device-only` exit code (`npm run test:device`).
 *
 * The gate shipped failing open: `runDoctor` pushes the smoke test only inside `if (config)`,
 * so a config-load failure produced a `checks` array holding nothing but `config files`
 * (dropped by the filter) and the two toolchain checks — which pass on any Mac with Xcode.
 * `failed.length === 0`, exit 0, "success" reported by a run that never created a simulator.
 * "The check did not run" and "the check passed" were the same value, which is the permissive-
 * default class this repo has been bitten by three times (loadAppsSafe, allocAndroidPort,
 * Simctl.delete).
 *
 * Testing it at all required pulling the decision out of `cli.ts`, which is an unrunnable
 * entry point full of `process.exit`. That extraction IS the fix; these tests only pin it.
 */

const smoke = (platform: "ios" | "android", ok = true): Check => ({ name: `smoke ${platform}: boot`, ok, gate: true, smoke: platform });
/** Both legs green — the only shape that may exit 0. */
const bothPlatforms = (): Check[] => [smoke("ios"), smoke("android")];
const tool = (name: string, ok: boolean): Check => ({ name, ok, gate: true });

describe("deviceGateExit", () => {
  it("fails when no smoke check was produced", () => {
    // The shipped bug, exactly: config threw, so runDoctor never reached the smoke tests.
    const r = deviceGateExit([{ name: "config files", ok: false }, tool("xcodebuild", true), tool("simctl", true)]);
    assert.equal(r.code, 1, "a gate that booted no device has not passed");
    assert.match(r.reason ?? "", /did not run/);
  });

  it("fails when only one platform was exercised", () => {
    // The gate was iOS-only while ci.yml justified excluding it from CI *because* CI cannot
    // do Android. Half the devices, reading as all of them — one layer further down.
    const r = deviceGateExit([tool("xcodebuild", true), smoke("ios")]);
    assert.equal(r.code, 1);
    assert.match(r.reason ?? "", /android/, "the missing platform must be named");
  });

  it("passes only when the smoke check ran and every gated check is green", () => {
    const r = deviceGateExit([{ name: "config files", ok: true }, tool("xcodebuild", true), ...bothPlatforms()]);
    assert.equal(r.code, 0);
    assert.equal(r.reason, undefined);
  });

  it("fails on a failed smoke check", () => {
    const r = deviceGateExit([tool("xcodebuild", true), smoke("ios"), smoke("android", false)]);
    assert.equal(r.code, 1);
    assert.deepEqual(
      r.failed.map((c) => c.name),
      ["smoke android: boot"],
    );
  });

  it("fails when a capability below boot is red, even though both platforms booted", () => {
    // boot/stream/describe are separate checks precisely so "it booted" cannot stand in for
    // "it streamed". A device that comes up and never produces a frame is the single most
    // common failure on this machine.
    const r = deviceGateExit([
      ...bothPlatforms(),
      { name: "smoke android: stream", ok: false, gate: true, detail: "no first frame" },
    ]);
    assert.equal(r.code, 1);
    assert.deepEqual(r.failed.map((c) => c.name), ["smoke android: stream"]);
  });

  it("ignores checks outside the gate, however they fail", () => {
    // The whole point of --device-only: a missing GitHub credential is real, and is exactly
    // the wrong reason for a code gate to go red. A gate that fails for reasons the author
    // cannot fix gets ignored within a week.
    const r = deviceGateExit([
      { name: "github credential", ok: false, detail: "no PAT" },
      { name: "auto-restart services (launchd)", ok: false, warn: true },
      ...bothPlatforms(),
    ]);
    assert.equal(r.code, 0);
  });

  it("treats skipped and warn gated checks as non-failures", () => {
    const r = deviceGateExit([{ name: "serve-sim (vendored)", ok: false, gate: true, skipped: true }, ...bothPlatforms()]);
    assert.equal(r.code, 0);
  });

  it("is keyed on the gate flag, not on the check's display name", () => {
    // `serve-sim (vendored, 1.2.3)` builds its label at runtime and `smoke: …` is prose.
    // The previous filter was a regex over those strings, so renaming the one check that
    // boots a device would have silently dropped it from the gate and kept exiting 0.
    const renamed: Check = { name: "first frame (real device)", ok: false, gate: true, smoke: "ios" };
    assert.equal(deviceGateExit([renamed, smoke("android")]).code, 1, "the flag travels with the check, the name does not");
  });
});

describe("freshnessVerdict", () => {
  it("catches a server too old to report its own version", () => {
    // The situation that prompted this: the running server predated the check that says
    // "you pulled, now restart", so it could not say it about itself. doctor is a fresh
    // process every time and always has the newest logic — this is where a stale server gets
    // caught by something that is not itself.
    const v = freshnessVerdict("abc1234", { });
    assert.equal(v.ok, false);
    assert.equal(v.warn, true, "a stale server still works — failing doctor over it teaches people to ignore doctor");
    assert.match(v.detail, /too old to report/);
    assert.match(v.detail, /launchctl kickstart/, "and the exact command");
  });

  it("catches a pull without a restart", () => {
    const v = freshnessVerdict("newsha1", { commit: "oldsha0" });
    assert.equal(v.ok, false);
    assert.match(v.detail, /running oldsha0, checkout is newsha1/);
    assert.match(v.detail, /tears down every booted preview/, "so the operator knows what it costs");
  });

  it("is quiet when the server is on this checkout", () => {
    const v = freshnessVerdict("abc1234", { commit: "abc1234", describe: "v0.1.61" });
    assert.equal(v.ok, true);
    assert.equal(v.detail, "v0.1.61");
  });
});

describe("checkConnectorAuth", () => {
  it("passes once there is a local credential to approve with", () => {
    const c = checkConnectorAuth([{ name: "me" }]);
    assert.equal(c.ok, true);
    assert.match(String(c.detail), /deckhand pair/);
  });

  // An OUTAGE the operator has no other signal for: the connector URL still resolves, still
  // looks right, and can never be authorized, because approving needs a credential that is
  // only obtainable at the machine.
  it("fails with no local credential, and names the command that fixes it", () => {
    const c = checkConnectorAuth([]);
    assert.equal(c.ok, false);
    assert.equal(c.warn, undefined, "a connector nobody can approve is not an advisory");
    assert.match(String(c.detail), /deckhand token add/);
  });

  // `runDoctor` loaded tokens.yaml inside the same try as config.yaml and apps.yaml, so ANY of
  // the three throwing left the list empty — and an empty list is a diagnosis: "no local
  // credential". The operator writes a second credential beside a file that is merely
  // malformed, while the running server serves the last good list.
  it("does not read an unreadable tokens.yaml as an empty one", () => {
    const c = checkConnectorAuth([], "bad indentation at line 3");
    assert.equal(c.ok, false);
    assert.match(String(c.detail), /would not load/);
    assert.doesNotMatch(String(c.detail), /no local credential/, "that is a different fault with a different fix");
  });
});

describe("readTokens", () => {
  const withHome = (dir: string, fn: () => void): void => {
    const had = process.env.DECKHAND_HOME;
    process.env.DECKHAND_HOME = dir;
    try {
      fn();
    } finally {
      if (had === undefined) delete process.env.DECKHAND_HOME;
      else process.env.DECKHAND_HOME = had;
    }
  };

  // `loadTokens` throws on ENOENT as readily as on bad YAML, so treating every throw as
  // "unreadable" sent a FRESH install to repair a file that `token add` would have created.
  it("reports a missing file as empty, not as unreadable", () => {
    const home = mkdtempSync(join(tmpdir(), "deckhand-doc0-"));
    try {
      withHome(home, () => {
        const r = readTokens();
        assert.deepEqual(r.tokens, []);
        assert.equal(r.unreadable, undefined, "there is nothing to fix — the file has not been created yet");
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reports a malformed file as unreadable, not as empty", () => {
    const home = mkdtempSync(join(tmpdir(), "deckhand-docbad-"));
    try {
      writeFileSync(join(home, "tokens.yaml"), "tokens: [ this: is: not: yaml\n");
      withHome(home, () => {
        const r = readTokens();
        assert.equal(r.tokens.length, 0);
        assert.ok(r.unreadable, "an empty list here is a diagnosis the operator cannot act on");
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("checkPublicUrl", () => {
  // Every other check in doctor looks at loopback, so it could report a completely healthy
  // install while the only address a user has was serving a Cloudflare error page. That is
  // not hypothetical — a user sat on Error 1033 while doctor printed ticks all the way down.
  const config = { hostname: "deckhand.example.com", port: 4300 } as unknown as Config;
  const answering = (status: number, body = "") =>
    (async () => new Response(body, { status })) as unknown as typeof fetch;

  it("catches a 1033, and names the tunnel rather than the server", async () => {
    // 1033 means cloudflared has NO registered edge connection while the process is fine —
    // launchd sees nothing wrong and KeepAlive has nothing to restart. Told apart from a
    // 5xx it points at the tunnel; lumped in with one it points at the server, which is
    // where the time gets wasted.
    const c = await checkPublicUrl(config, answering(530, "<h1>Error 1033</h1> Cloudflare Tunnel error"));
    assert.equal(c.ok, false);
    assert.match(String(c.detail), /1033/);
    assert.match(String(c.detail), /tunnel\.log/, "it must point at the log that answers it");
    assert.match(String(c.detail), /http2/, "and at the setting that prevents it");
  });

  it("blames deckhand, not the tunnel, on a 5xx", async () => {
    const c = await checkPublicUrl(config, answering(502));
    assert.equal(c.ok, false);
    assert.match(String(c.detail), /the tunnel reached deckhand and deckhand failed/);
    assert.ok(!/1033/.test(String(c.detail)), "a plain 5xx must not be reported as a tunnel fault");
  });

  it("treats a 404 from the root as healthy, and says why", async () => {
    // The root has no route. Without the wording a reader sees "✓ … 404" and stops
    // trusting the tick.
    const c = await checkPublicUrl(config, answering(404));
    assert.equal(c.ok, true);
    assert.match(String(c.detail), /the tunnel reached deckhand/);
  });

  it("reports an unreachable host as a failure rather than throwing", async () => {
    const boom = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    const c = await checkPublicUrl(config, boom);
    assert.equal(c.ok, false);
    assert.match(String(c.detail), /unreachable/);
    assert.match(String(c.detail), /ENOTFOUND/, "the real cause must survive");
  });
});

describe("the tunnel agent forces http2", () => {
  it("keeps --protocol http2 in the LaunchAgent template", () => {
    // Captured from tunnel.log while a user was staring at an Error 1033 page: all four
    // QUIC edge connections died together on "timeout: no recent network activity" and
    // took 38 seconds to re-register, backing off 4→8→16s. The process never exited, so
    // KeepAlive had nothing to restart and every other doctor check stayed green.
    //
    // cloudflared defaults to QUIC over UDP; http2 rides TCP/443, which is the thing that
    // survives hostile networks. Without this check a future edit drops the flag in
    // silence and the 1033s come back with nothing to point at.
    const tpl = readFileSync(new URL("../../../ops/launchd/no.deckhand.tunnel.plist.template", import.meta.url), "utf8");
    const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(tpl)?.[1] ?? "";
    assert.match(args, /<string>--protocol<\/string>/, "the flag itself must be in ProgramArguments, not only in a comment");
    assert.match(args, /<string>http2<\/string>/, "and its value");
    // Order matters to cloudflared: global flags come before the subcommand.
    assert.ok(args.indexOf("--protocol") < args.indexOf("run"), "--protocol must precede `run` or cloudflared rejects it");
  });
});

/**
 * The gate creates two devices of its own, and an interrupted run (Ctrl-C, a throw past the
 * `finally`, a laptop lid) leaves them behind. Whether anything ever collects them is decided
 * entirely by whether their names fall inside the prefixes the sweeps select on.
 *
 * They did not. Both were hand-written `"deckhand-doctor"`, so the AVD sat outside
 * `AVD_PREFIX` ("deckhand_") and was invisible to `orphanAvds` AND to `sweepDeviceRecorders`'
 * second ownership gate — leaving an orphaned `screenrecord` holding the machine's single
 * H.264 encoder, which drops every other emulator to MJPEG with nothing in any log to say so.
 */
describe("the device gate's own devices are reapable", () => {
  it("names them inside the prefixes both sweeps select on", () => {
    // Asserted through the selectors rather than with `startsWith`, so this fails for the
    // reason that matters — the reaper cannot see them — and keeps failing if the selectors
    // themselves change shape.
    assert.deepEqual(
      orphanSims([{ udid: "DOCTOR", name: DOCTOR_SIM_NAME, state: "Booted" }]).map((s) => s.name),
      [DOCTOR_SIM_NAME],
      `${DOCTOR_SIM_NAME} is not reaped as an orphan simulator`,
    );
    assert.deepEqual(orphanAvds([DOCTOR_AVD_NAME]), [DOCTOR_AVD_NAME], `${DOCTOR_AVD_NAME} is not reaped as an orphan AVD`);
  });

  it("spells no device name by hand anywhere in doctor.ts", () => {
    // The selector test above can only judge the names doctor EXPORTS. A future author adding
    // a third device — the way the second one was added — writes a fresh literal at its call
    // site, and nothing above would notice. So: no string literal in this file may begin with
    // `deckhand-`/`deckhand_` at all. Derive it from `SIM_PREFIX`/`AVD_PREFIX` instead.
    const src = stripComments(readFileSync(new URL("./doctor.ts", import.meta.url), "utf8"));
    const literals = [...src.matchAll(/["'`]deckhand[-_][^"'`]*/g)].map((m) => m[0].slice(1));
    assert.deepEqual(literals, [], "derive device names from SIM_PREFIX / AVD_PREFIX, do not spell them out");
  });

  it("reads the scan's comment stripper both ways", () => {
    // A guardrail that fires on prose gets deleted rather than obeyed, and one that reads a
    // comment as code would let a real literal hide behind a `//`. Both directions, or neither
    // half of the scan above is trustworthy.
    const scan = (s: string) => [...stripComments(s).matchAll(/["'`]deckhand[-_][^"'`]*/g)].map((m) => m[0].slice(1));
    assert.deepEqual(scan('// it used to be called "deckhand-doctor"\nconst x = 1;\n'), [], "a name quoted in prose is not a device name");
    assert.deepEqual(scan('/* was "deckhand-doctor" */\nconst avd = "deckhand_doctor";\n'), ["deckhand_doctor"], "and a real literal still fires");
  });
});

describe("releaseSmokeAvd", () => {
  /** `shutdown` answers `answer`; every call is recorded. */
  const android = (calls: string[], answer: boolean) =>
    fakeAndroid({
      shutdown: async (serial: string) => {
        calls.push(`shutdown ${serial}`);
        return answer;
      },
      deleteAvd: async (name: string) => void calls.push(`deleteAvd ${name}`),
    });

  it("deletes the gate's AVD once the emulator has actually gone", async () => {
    const calls: string[] = [];
    assert.equal(await releaseSmokeAvd(android(calls, true), DOCTOR_AVD_NAME, "emulator-5680"), null);
    assert.deepEqual(calls, ["shutdown emulator-5680", `deleteAvd ${DOCTOR_AVD_NAME}`]);
  });

  it("keeps it when the emulator would not exit, and says why", async () => {
    // Deleting it here is what makes the leftover uncollectable: the sweep in
    // `Reaper.reap` kills an emulator with `pkill -f "avd <name>"` over the names
    // `listAvds()` returns, and `avdmanager delete` takes this one out of that list.
    // The gate's own leftover check (`smokeAndroid`) has the same dependency — it
    // tells the operator to kill a device that nothing can name any more.
    const calls: string[] = [];
    const kept = await releaseSmokeAvd(android(calls, false), DOCTOR_AVD_NAME, "emulator-5680");
    assert.deepEqual(calls, ["shutdown emulator-5680"], "the AVD must survive an emulator that did not exit");
    assert.match(kept ?? "", /emulator-5680/, "and the operator has to be told which device is still up");
    assert.match(kept ?? "", new RegExp(DOCTOR_AVD_NAME));
  });

  it("deletes it when there was no emulator to stop at all", async () => {
    // A createAvd that succeeded and a boot that never returned a serial: nothing is
    // running, so keeping the image would leak ~2 GB per red gate run.
    const calls: string[] = [];
    assert.equal(await releaseSmokeAvd(android(calls, false), DOCTOR_AVD_NAME, undefined), null);
    assert.deepEqual(calls, [`deleteAvd ${DOCTOR_AVD_NAME}`]);
  });
});

/**
 * Comments are not code, and a name quoted in prose must not fire the scan above. Twin of the
 * walks in `test-support/invariants.test.ts` and `testing/control.test.ts`, duplicated rather
 * than shared for the same reason they are: it is a dozen lines, and importing a scanner
 * couples guardrails that have to be able to fail independently.
 */
function stripComments(src: string): string {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === "`") {
      // Copy the literal whole — that is the part the scan is looking at.
      out += c;
      for (i++; i < src.length; i++) {
        out += src[i];
        if (src[i] === "\\") {
          out += src[++i] ?? "";
          continue;
        }
        if (src[i] === c) break;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}
