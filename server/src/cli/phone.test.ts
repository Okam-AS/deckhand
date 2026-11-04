import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatPhones, holdPhone, phoneTenants, releasePhone } from "./phone.ts";
import { loadPhoneHolds, savePhoneHolds } from "../devices/phoneHolds.ts";

describe("deckhand phone", () => {
  it("holds and releases a phone, saying who has it", () => {
    const now = new Date("2026-11-03T12:00:00Z");
    const held = holdPhone({}, "RF8", "dana", now);
    assert.deepEqual(held.holds, { RF8: { who: "dana", since: "2026-11-03T12:00:00.000Z" } });
    assert.match(held.said, /release RF8/);
    assert.match(holdPhone(held.holds, "RF8", "kim", now).said, /was held by dana; now held by kim/);
    const freed = releasePhone(held.holds, "RF8");
    assert.deepEqual(freed.holds, {});
    assert.match(releasePhone({}, "RF8").said, /was not held/);
  });

  it("holds an iPhone under devicectl's upper-case UDID however it was typed, and leaves an adb serial as typed", () => {
    const now = new Date("2026-11-03T12:00:00Z");
    const udid = "00008120-001A2B3C4D5E6F70";
    const held = holdPhone({}, udid.toLowerCase(), "dana", now);
    assert.deepEqual(Object.keys(held.holds), [udid]);
    assert.deepEqual(releasePhone(held.holds, udid.toLowerCase()).holds, {});
    assert.deepEqual(Object.keys(holdPhone({}, "emulator-5554x", "dana", now).holds), ["emulator-5554x"]);
  });

  it("lists free, held, busy and blocked phones, and a held phone that is unplugged", () => {
    const out = formatPhones(
      [
        { id: "A", state: "device", manufacturer: "samsung", model: "SM-G980F", os: "Android 13", awake: true, locked: false },
        { id: "B", state: "unauthorized" },
      ],
      { C: { who: "dana", since: "t" } },
      { A: "pv1 (app elton)" },
    );
    assert.match(out, /^A {2}samsung SM-G980F Android 13 {2}in preview pv1 \(app elton\)$/m);
    assert.match(out, /^B .*not authorized for USB debugging/m);
    assert.match(out, /^C {2}not plugged in {2}held by dana/m);
  });

  it("lists iPhones beside Android phones, with discovery's blockers", () => {
    const out = formatPhones([], {}, {}, [
      { udid: "00008120-00000000000000AA", name: "QA", model: "iPhone 15", osVersion: "27.0.1", blockers: [] },
      { udid: "00008120-0000000000000BBB", name: "B", model: null, osVersion: null, blockers: ["no WDA installed: copy a WebDriverAgent Products folder"] },
    ]);
    assert.match(out, /^00008120-00000000000000AA {2}iPhone 15 iOS 27\.0\.1 {2}free$/m);
    assert.match(out, /^00008120-0000000000000BBB {2}B {2}no WDA installed/m);
  });

  it("reads which preview drives a phone from state.json, ignoring stopped previews", () => {
    const dev = (serial: string) => ({ deviceId: "android-0", platform: "android" as const, label: "x", serial, physical: true as const, phase: "ready" as const });
    const base = { shareId: "s", appId: "a", ref: "local", source: "local" as const, createdAt: "", updatedAt: "", passwordProtected: true };
    assert.deepEqual(
      phoneTenants({
        previews: [
          { ...base, previewId: "live", phase: "ready", devices: [dev("A")] },
          { ...base, previewId: "gone", phase: "stopped", devices: [dev("B")] },
        ],
      }),
      { A: "live (app a)" },
    );
  });

  it("keeps holds in their own file, and an unreadable one is an error rather than no holds", () => {
    const dir = mkdtempSync(join(tmpdir(), "dh-holds-"));
    try {
      const file = join(dir, "phone-holds.json");
      assert.deepEqual(loadPhoneHolds(file), {});
      savePhoneHolds({ RF8: { who: "dana", since: "t" } }, file);
      assert.deepEqual(loadPhoneHolds(file), { RF8: { who: "dana", since: "t" } });
      writeFileSync(file, "{not json");
      assert.throws(() => loadPhoneHolds(file));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
