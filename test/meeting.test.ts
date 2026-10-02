import { test } from "node:test";
import assert from "node:assert/strict";
import type { Work, WorldAgent } from "../src/shared/types.ts";
import { buildingRoute, planBuilding, place } from "../src/ui/world/building.ts";
import { meetingPlan, projectedExcerpt, reviewing } from "../src/ui/world/meeting.ts";

const agent = (id: string, type = "code-reviewer"): WorldAgent => ({ id, name: id, identity: id, harness: "manual", cwd: null, project: null, branch: null, status: "working", title: null, paneId: null, taskIds: [], teamId: "t", role: "member", waitingOnYou: false, doing: null, helpers: type ? [{ id: "h", type, startedAt: "" }] : [], model: null, sessionName: null, ran: true });
const team = { id: "t", name: "Team", purpose: "", handsTo: null, path: null, branch: null, standing: true, worktrees: [], createdAt: "" };

test("projector uses server code without helper reads, but the newest real review read wins", () => {
  const a = agent("a");
  const fallback = { path: "fallback.ts", startLine: 1, lines: ["fallback"] };
  a.reviewExcerpt = fallback;
  assert.deepEqual(projectedExcerpt(a), fallback);
  const read = { path: "read.ts", startLine: 8, lines: ["real read"], viewedAt: 20 };
  a.helpers[0]!.excerpt = read;
  a.helpers.push({ id: "older", type: "reviewer", startedAt: "", excerpt: { ...read, viewedAt: 10 } });
  assert.deepEqual(projectedExcerpt(a), read);
  a.helpers = [];
  assert.deepEqual(projectedExcerpt(a), fallback, "handed-over work need not have a helper");
  assert.equal(projectedExcerpt(null), null);
  assert.equal(projectedExcerpt(agent("idle", "")), null);
});

test("review definitions and pending office work choose reviewers, not authors or finished work", () => {
  const a = agent("a", ".claude/agents/architecture-reviewer.md"), b = agent("b", ""), c = agent("c", "builder");
  b.role = "lead";
  const work: Work = { id: "w", title: "w", summary: "", fromAgentId: "c", fromTeamId: null, toTeamId: "t", state: "in_review", reviewerId: null, notes: "", round: 1, createdAt: "", updatedAt: "" };
  assert.deepEqual([...reviewing([a, b, c], [work])], ["a", "b"]);
  assert.deepEqual([...reviewing([a, b, c], [{ ...work, reviewerId: "c" }])], ["a", "c"]);
  assert.deepEqual([...reviewing([a, b, c], [{ ...work, state: "accepted", reviewerId: "c" }])], ["a"]);
  a.status = "offline";
  assert.equal(reviewing([a], []).size, 0);
});

test("two rooms, stable occupancy, overflow at desk, release and return when helpers stop", () => {
  const agents = [agent("b"), agent("c"), agent("d")];
  const base = planBuilding(agents, [team], []);
  const first = meetingPlan(base, agents, []);
  assert.deepEqual([...first.meetings], [["b", 0], ["c", 1]]);
  assert.equal(first.plan.spots.get("d"), base.spots.get("d"));
  const newcomers = [agent("a"), ...agents].reverse();
  const next = meetingPlan(planBuilding(newcomers, [team], []), newcomers, [], first.meetings);
  assert.deepEqual([...next.meetings], [...first.meetings]);
  agents[0]!.helpers = [];
  const released = meetingPlan(base, agents, [], first.meetings);
  assert.deepEqual([...released.meetings], [["c", 1], ["d", 0]]);
  assert.equal(released.plan.spots.get("b"), base.spots.get("b"));
  const queued = meetingPlan(planBuilding(agents, [team], ["c"]), agents, [], released.meetings);
  assert.equal(queued.plan.spots.get("c")!.zone, "queue");
});

test("reviewer sits facing the table and enters and leaves through the room's door, clear of table", () => {
  const a = agent("a");
  const base = planBuilding([a], [team], []);
  const plan = meetingPlan(base, [a], []).plan;
  const home = base.spots.get("a")!, spot = plan.spots.get("a")!;
  const room = base.rooms.find((r) => r.kind === "meeting")!;
  assert.equal(spot.sit, true);
  assert.equal(spot.zone, "meeting");
  assert.equal(spot.facing, room.facing + Math.PI / 2);
  assert.deepEqual(spot.approach[1], place(room.center, room.facing, [0, room.half[1] - 0.6]));
  assert.deepEqual(buildingRoute(base, home.pos, home, spot).slice(-5), [...spot.approach, spot.pos]);
  assert.deepEqual(buildingRoute(base, spot.pos, spot, home).slice(0, 4), [...spot.approach].reverse());
});
