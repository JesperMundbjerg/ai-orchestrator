import assert from "node:assert/strict";
import { test } from "node:test";
import type { ItemDetail, Option, Reply } from "../src/shared/types.ts";
import { decisionAnswer, recommendedOption } from "../src/ui/components/decision.ts";

const options: Option[] = [
  { id: "a", label: "Overlay", consequence: "Covers the slider" },
  { id: "b", label: "Docked", consequence: "Keeps the slider visible" },
];
test("recommendation marks only an unambiguous leading option, preserving prose", () => {
  assert.equal(recommendedOption(options, "Docked, because the slider stays visible"), "b");
  assert.equal(recommendedOption(options, "B: keeps the slider visible"), "b");
  assert.equal(recommendedOption(options, "Option B — keeps the slider visible"), "b");
  assert.equal(recommendedOption(options, "I recommend Docked: keeps it visible"), "b");
  assert.equal(recommendedOption(options, "Keep it visible rather than use Overlay"), null);
  assert.equal(recommendedOption(options, "A docked stage would work best"), null);
  assert.equal(recommendedOption(options, "Overlaying the controls is a risk"), null);
  assert.equal(recommendedOption(options, ""), null);
  assert.equal(recommendedOption([...options, { id: "c", label: "Docked column", consequence: "" }], "Docked column: more space"), null);
});

function detail(state: ItemDetail["item"]["state"], replies: Partial<Reply>[], revision = 1): ItemDetail {
  return { item: { state, revision, options }, replies: replies.map((r) => ({ revision: 1, state: "queued", text: "", ...r })) } as ItemDetail;
}
test("a sheet receipt names the chosen label or open answer, not subsequent discussion", () => {
  assert.equal(decisionAnswer(detail("answer_queued", [{ action: "choose", choice: "b" }, { action: "discuss", text: "Also check mobile" }])), "Docked");
  assert.equal(decisionAnswer(detail("delivered", [{ action: "answer", text: "Make room for discovery." }])), "Make room for discovery.");
  assert.equal(decisionAnswer(detail("needs_attention", [{ action: "discuss", text: "Something else?" }])), null);
  assert.equal(decisionAnswer(detail("answer_queued", [{ action: "discuss", text: "Use a separate page instead." }])), "Use a separate page instead.");
});
test("failed, stale and earlier-revision answers never collapse a waiting question", () => {
  assert.equal(decisionAnswer(detail("needs_attention", [{ action: "choose", choice: "b", state: "failed" }])), null);
  assert.equal(decisionAnswer(detail("answer_queued", [{ action: "choose", choice: "b", state: "stale" }])), null);
  assert.equal(decisionAnswer(detail("answer_queued", [{ action: "choose", choice: "b" }], 2)), null);
  assert.equal(decisionAnswer(detail("snoozed", [{ action: "answer", text: "Tomorrow" }])), null);
});
