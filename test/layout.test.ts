import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, Team, WorldAgent } from "../src/shared/types.ts";
import { CORRIDOR_Z, pipelines, planOffice, QUEUE_SIDE_X, queueOrder, route } from "../src/ui/world/layout.ts";
import { plan as planTalk } from "../src/ui/world/visits.ts";

const agent = (id: string, extra: Partial<WorldAgent> = {}): WorldAgent => ({
  id, identity: id, name: id, harness: "pi", cwd: null, project: null, status: "idle", title: null, paneId: null, taskIds: [], teamId: null, role: "member", waitingOnYou: false, doing: null, helpers: [], ...extra,
});
const team = (id: string, structure: Team["structure"]): Team => ({ id, name: id, structure, purpose: "", handsTo: null, createdAt: "" });

test("the queue has one place per agent, in the order its items wait", () => {
  const agents = [agent("tom", { taskIds: ["t1", "t3"] }), agent("ada", { taskIds: ["t2"] })];
  assert.deepEqual(queueOrder(agents, ["t3", "t2", "t1"]), ["tom", "ada"]);
  assert.deepEqual(queueOrder(agents, ["unknown"]), []);
});

test("everyone has a place: team seats, the line at your desk, or the lounge", () => {
  const teams = [team("mc", "dispatch"), team("fp", "circle")];
  const agents = [
    agent("lead", { teamId: "mc", role: "lead" }), agent("c1", { teamId: "mc" }), agent("c2", { teamId: "mc" }),
    agent("p1", { teamId: "fp" }), agent("p2", { teamId: "fp" }), agent("asking", { teamId: "fp" }),
    agent("free1"), agent("free2"),
  ];
  const plan = planOffice(agents, teams, ["asking"]);
  assert.equal(plan.spots.size, agents.length);
  assert.equal(plan.spots.get("asking")?.zone, "queue");
  assert.equal(plan.spots.get("free1")?.zone, "lounge");
  assert.equal(plan.spots.get("lead")?.zone, "team");
  const places = [...plan.spots.values()].map((s) => s.pos.map((v) => v.toFixed(2)).join(","));
  assert.equal(new Set(places).size, places.length, "no two agents share a place");
  // Someone away in the line keeps their desk, shown empty.
  const fp = plan.corners.find((c) => c.team.id === "fp")!;
  assert.ok(fp.desks.some((d) => d.occupantId === "asking"));
});

test("walking to the line goes along the corridor and the side lane, and the line moves up directly", () => {
  const plan = planOffice([agent("a", { teamId: "mc" }), agent("b"), agent("c")], [team("mc", "dispatch")], ["b", "c"]);
  const desk = plan.spots.get("a")!;
  const [first, second] = [plan.spots.get("b")!, plan.spots.get("c")!];
  const path = route(desk.pos, desk, second);
  assert.ok(path.some(([, z]) => z === CORRIDOR_Z));
  assert.deepEqual(path.at(-2), [QUEUE_SIDE_X, second.pos[1]]);
  assert.deepEqual(route(second.pos, second, first), [first.pos]);
});

const said = (id: string, kind: Message["kind"], from: string | null, to: string[], text = "hello"): Message =>
  ({ id, kind, fromAgentId: from, teamId: null, text, workId: null, createdAt: "", deliveries: to.map((agentId) => ({ agentId, state: "queued", error: null, updatedAt: "" })) });

test("an agent who says something walks to the person it is for and stands beside them", () => {
  const teams = [team("dev", "dispatch"), team("qa", "circle")];
  const agents = [agent("lead", { teamId: "dev", role: "lead" }), agent("coder", { teamId: "dev" }), agent("rev", { teamId: "qa" })];
  const office = planOffice(agents, teams, []);
  const { visits, bubbles } = planTalk([said("m1", "handoff", "coder", ["rev"]), said("m2", "instruction", null, ["lead"], "Ship it")], office, 1000);
  assert.equal(visits.length, 1);
  const [v] = visits;
  const target = office.spots.get("rev")!.pos;
  const gap = Math.hypot(v!.spot.pos[0] - target[0], v!.spot.pos[1] - target[1]);
  assert.ok(gap > 0.5 && gap < 1.2, `stands beside, not on top (${gap.toFixed(2)} m)`);
  assert.equal(v!.kind, "handoff");
  assert.match(v!.text, /^Handing over: hello/);
  assert.ok(v!.until > 1000 + 7000, "the visit lasts the walk there and the talk");
  assert.deepEqual(bubbles.map((b) => [b.agentId, b.text]), [["lead", "You: Ship it"]]);
});

test("work flows along the floor from a team to the team it hands to", () => {
  const teams = [{ ...team("qa", "circle") }, { ...team("dev", "dispatch"), handsTo: "qa" }];
  const office = planOffice([], teams, []);
  const [p] = pipelines(office);
  assert.equal(p!.fromTeamId, "dev");
  assert.ok(p!.path.some(([, z]) => Math.abs(z - CORRIDOR_Z) < 1), "along the corridor");
  assert.equal(pipelines(planOffice([], [team("qa", "circle")], [])).length, 0);
});
