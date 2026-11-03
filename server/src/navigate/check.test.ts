import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { check, FAIL_AT, HEALTH, HEALTH_FAIL_AT, PASS_AT } from "./check.ts";
import type { JevChooser, JevImage, JevQuestion, JevResult } from "./jev.ts";
import { encodePng } from "./png.ts";

const shot = encodePng({ width: 300, height: 600, data: Buffer.alloc(300 * 600 * 4, 255) });

/** Answers each Noul with the probability its statement maps to in `p` (by substring), else 0.5. */
type Asked = { state: Record<string, unknown>; questions: Record<string, JevQuestion>; assets?: Record<string, JevImage> };

function jevAnswering(p: Record<string, number>): JevChooser & { asked: Asked[] } {
  const asked: Asked[] = [];
  return {
    asked,
    async ask(state, questions, assets): Promise<JevResult> {
      asked.push({ state: state as Record<string, unknown>, questions, assets });
      const answers = Object.fromEntries(
        Object.entries(questions).map(([id, q]) => {
          const text = JSON.stringify(q.instructions);
          const hit = Object.entries(p).find(([k]) => text.includes(k));
          return [id, { type: "noul" as const, noul: hit ? hit[1] : 0.5 }];
        }),
      );
      return { model: "jev-test", answers, usage: { input_tokens: 3300 } };
    },
  };
}

describe("check", () => {
  it("asks one yes/no per statement plus the health questions, with the screenshot as the only image", async () => {
    const jev = jevAnswering({ "325,-": 0.97, "error banner": 0.02, "`screenshot`": 0.05 });
    const r = await check({ expect: { price: "The Premium wash costs 325,-" }, expectNot: { banner: "An error banner is shown" } }, { shot, jev });
    assert.equal(r.verdict, "pass");
    assert.deepEqual(r.items.map((i) => [i.name, i.verdict]), [["price", "pass"], ["banner", "pass"], ...Object.keys(HEALTH).map((k) => [k, "pass"])]);
    const a = jev.asked[0]!;
    assert.deepEqual(Object.keys(a.assets ?? {}), [a.state.screenshot]);
    assert.equal(a.state.reference, undefined);
  });

  it("fails a statement that does not hold and calls the middle unsure", async () => {
    const r = await check({ expect: { price: "costs 325,-", tab: "Bilvask tab selected" } }, { shot, jev: jevAnswering({ "325,-": FAIL_AT - 0.1, Bilvask: (PASS_AT + FAIL_AT) / 2, "`screenshot`": 0.01 }) });
    assert.equal(r.verdict, "fail");
    assert.equal(r.items.find((i) => i.name === "price")!.verdict, "fail");
    assert.equal(r.items.find((i) => i.name === "tab")!.verdict, "unsure");
  });

  it("compares against a reference screenshot when given one", async () => {
    const jev = jevAnswering({ "same screen": 0.9, "`screenshot`": 0.01 });
    const r = await check({ expect: {} }, { shot, reference: shot, jev });
    assert.deepEqual(r.items.map((i) => i.name), ["matches_reference", ...Object.keys(HEALTH)]);
    assert.equal(Object.keys(jev.asked[0]!.assets ?? {}).length, 2);
    assert.equal(r.verdict, "pass");
  });

  it("reports the request to the egress hook before sending, and sends nothing if it refuses", async () => {
    const jev = jevAnswering({});
    await assert.rejects(check({ expect: { a: "abc" } }, { shot, jev, onEgress: () => { throw new Error("key removed"); } }), /key removed/);
    assert.equal(jev.asked.length, 0);
  });

  it("fails the screen on a health question only well above the middle", async () => {
    const r = await check({ expect: {} , skipHealth: false }, { shot, jev: jevAnswering({ "developer tool": HEALTH_FAIL_AT + 0.1, "`screenshot`": 0.05 }) });
    assert.equal(r.items.find((i) => i.name === "health_dev_overlay")!.verdict, "fail");
    assert.equal(r.verdict, "fail");
    const mild = await check({ expect: {} }, { shot, jev: jevAnswering({ "on top of each other": 0.31, "`screenshot`": 0.05 }) });
    assert.equal(mild.verdict, "pass", "a 0.31 overlap reading (a card under the tab bar) is not a broken screen");
  });
});
