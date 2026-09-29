import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorldAgent, WorldTeam } from "../src/shared/types.ts";
import { calls, GRACE_MS } from "../src/ui/world/visits.ts";

const agent = (id: string, extra: Partial<WorldAgent> = {}) =>
  ({ id, name: id, status: "working", teamId: "t1", role: "member", waitingOnYou: false, taskIds: [], ...extra }) as WorldAgent;
const blockedTeam = (blockedBy: string[]) =>
  ({ id: "t1", name: "t1", purpose: "", handsTo: null, path: null, branch: null, standing: false, createdAt: "", status: "blocked", blockedBy }) as WorldTeam;
const byId = (...agents: WorldAgent[]) => new Map(agents.map((a) => [a.id, a]));
const NOW = 10_000_000;

test("a blocked crew member summons the lead only after the grace period", () => {
  const agents = byId(agent("clara", { role: "lead" }), agent("liv", { status: "blocked" }));
  const team = blockedTeam(["liv"]);
  const since = (ago: number) => ({ blockedSince: new Map([["liv", NOW - ago]]), now: NOW });
  assert.equal(GRACE_MS, 6 * 60 * 1000);
  assert.deepEqual(calls([team], agents, new Set(), since(0)), []);
  assert.deepEqual(calls([team], agents, new Set(), since(GRACE_MS - 1)), []);
  const [call] = calls([team], agents, new Set(), since(GRACE_MS));
  assert.deepEqual(call!.stuckIds, ["liv"]);
  // Someone the office has not seen become blocked has only just done so.
  assert.deepEqual(calls([team], agents, new Set(), { blockedSince: new Map(), now: NOW }), []);
});

test("the lead's own block and anyone waiting on you summon at once", () => {
  const fresh = { blockedSince: new Map([["clara", NOW], ["liv", NOW]]), now: NOW };
  const own = byId(agent("clara", { role: "lead", status: "blocked" }), agent("liv"));
  assert.deepEqual(calls([blockedTeam(["clara"])], own, new Set(), fresh).map((c) => c.stuckIds), [["clara"]]);
  const asking = byId(agent("clara", { role: "lead" }), agent("liv", { status: "blocked", waitingOnYou: true }));
  assert.deepEqual(calls([blockedTeam(["liv"])], asking, new Set(), fresh).map((c) => c.stuckIds), [["liv"]]);
});

test("only those past the grace period are named, and without timings nobody waits", () => {
  const agents = byId(agent("clara", { role: "lead" }), agent("liv", { status: "blocked" }), agent("tom", { status: "blocked" }));
  const team = blockedTeam(["liv", "tom"]);
  const [call] = calls([team], agents, new Set(), { blockedSince: new Map([["liv", NOW - GRACE_MS], ["tom", NOW - 5000]]), now: NOW });
  assert.deepEqual(call!.stuckIds, ["liv"]);
  assert.equal(calls([team], agents, new Set()).length, 1);
});
