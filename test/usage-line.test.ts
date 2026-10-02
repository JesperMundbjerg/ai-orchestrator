import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageMeter, UsageShare } from "../src/shared/types.ts";
import { compactTokens, usageLine } from "../src/ui/usageLine.ts";

const meter = (id: string, label: string): UsageMeter => ({ id, label, usedPercent: 50, resetsAt: null, asOf: null, stale: false, window: "week" });
const meters = [meter("claude.week", "Claude week"), meter("codex.week", "Codex week")];
const use = (tokens: number, share: number | null, parts: UsageShare["parts"] = []): UsageShare => ({ tokens, share, parts });

test("the line names the meter's week by its label and shows whole percents and compact tokens", () => {
  assert.equal(usageLine(use(1_234_567, 4.4, [{ meter: "claude.week", share: 4.4 }]), meters), "≈4% of Claude week · 1.2M tokens");
  assert.equal(usageLine(use(1_000, 12.5, [{ meter: "codex.week", share: 12.5 }]), meters), "≈13% of Codex week · 1k tokens");
});

test("a small share reads <1%, never 0%", () => {
  assert.equal(usageLine(use(900, 0.3, [{ meter: "claude.week", share: 0.3 }]), meters), "<1% of Claude week · 900 tokens");
  assert.equal(usageLine(use(900, 0, [{ meter: "claude.week", share: 0 }]), meters), "<1% of Claude week · 900 tokens");
});

test("a team that used both harnesses shows both parts", () => {
  const both = use(2_000_000, 4.2, [{ meter: "claude.week", share: 3.1 }, { meter: "codex.week", share: 0.4 }]);
  assert.equal(usageLine(both, meters), "≈3% of Claude week + <1% of Codex week · 2M tokens");
});

test("tokens with an unknown per-meter share never acquire a percentage in the panel", () => {
  const mixed = use(1000, 3, [{ meter: "claude.week", share: 3, tokens: 600 }, { meter: "codex.week", share: null, tokens: 400 }]);
  assert.equal(usageLine(mixed, meters), "≈3% of Claude week · 1k tokens");
  assert.equal(usageLine(use(400, null, [mixed.parts[1]!]), meters), "400 tokens");
});

test("no tokens leaves the line out; no share shows tokens only", () => {
  assert.equal(usageLine(undefined, meters), null);
  assert.equal(usageLine(use(0, null), meters), null);
  assert.equal(usageLine(use(340_000, null), meters), "340k tokens");
  assert.equal(usageLine(use(1, null), meters), "1 token");
});

test("a part whose meter is not in the data is not guessed at", () => {
  assert.equal(usageLine(use(5000, 3, [{ meter: "other.week", share: 3 }]), meters), "5k tokens");
});

test("compact tokens round to what fits", () => {
  assert.deepEqual([820, 4200, 9_949, 9_950, 340_400, 999_999, 12_000_000].map(compactTokens), ["820", "4.2k", "9.9k", "10k", "340k", "1M", "12M"]);
});
