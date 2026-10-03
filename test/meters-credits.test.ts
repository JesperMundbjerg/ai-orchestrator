import { test } from "node:test";
import assert from "node:assert/strict";
import type { UsageCredits } from "../src/shared/types.ts";
import { creditLook, perches, seedlingSpot, type MeterSpot } from "../src/ui/world/meters.ts";

const NOW = Date.parse("2026-10-02T14:05:00Z");
const credits = (extra: Partial<UsageCredits> = {}): UsageCredits => ({ label: "Codex credits", left: true, balance: 1240, unlimited: false, asOf: "2026-10-02T14:00:00Z", stale: false, inUse: false, ...extra });

test("the credits' seedling says how many are left, grows with them, and shows unknown as unknown, never as none", () => {
  const some = creditLook(credits(), NOW);
  assert.equal(some.label, "Codex credits: 1,240 left");
  assert.ok(!some.dry && !some.faded);
  const more = creditLook(credits({ balance: 61461.25 }), NOW);
  assert.ok(more.growth > some.growth && more.leaves >= some.leaves, "more credits, a bigger plant");
  assert.ok(creditLook(credits({ balance: 3 }), NOW).growth > 0, "a few credits still show");
  assert.equal(creditLook(credits({ inUse: true }), NOW).label, "Codex credits: 1,240 left · in use now");

  const unlimited = creditLook(credits({ balance: null, unlimited: true }), NOW);
  assert.deepEqual([unlimited.label, unlimited.growth, unlimited.bloom], ["Codex credits: unlimited", 1, true]);

  const none = creditLook(credits({ left: false, balance: 0 }), NOW);
  assert.deepEqual([none.label, none.dry, none.leaves], ["Codex credits: none left", true, 0]);

  const unknown = creditLook(credits({ left: null, balance: null, asOf: null }), NOW);
  assert.equal(unknown.label, "Codex credits: unknown");
  assert.ok(unknown.faded && !unknown.dry && unknown.leaves > 0, "faded and grey, not a dry stub");

  assert.match(creditLook(credits({ stale: true }), NOW, "UTC").label, /^Codex credits: 1,240 left as of Fri 14:00$/);
});

test("the seedling grows on its feeder's ground, inside the usage ring and clear of the ground bird", () => {
  const spot: MeterSpot = { id: "codex.week", pos: [4, 2], radius: 0.36, glass: 0.15, height: 0.46, post: 0.95 };
  const at = seedlingSpot(spot);
  const from = (p: [number, number]) => Math.hypot(p[0] - spot.pos[0], p[1] - spot.pos[1]);
  assert.ok(from(at) < spot.radius * 1.22 - 0.05, "inside the ring");
  assert.ok(from(at) > spot.glass * 1.55, "out from under the tray");
  for (const p of perches(spot, 3).filter((p) => p.on === "ground")) assert.ok(Math.hypot(p.pos[0] - at[0], p.pos[1] - at[1]) > 0.15);
});
