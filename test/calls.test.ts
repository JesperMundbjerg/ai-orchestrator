import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorldAgent, WorldTeam } from "../src/shared/types.ts";
import { SPAWN, yawTo } from "../src/ui/world/spatial.ts";
import { callerIn, planBuilding, routeIn } from "../src/ui/world/building.ts";
import { calls as callsIn, walkMs } from "../src/ui/world/visits.ts";

function calls(teams: WorldTeam[], agents: Map<string, WorldAgent>, sentBack: ReadonlySet<string>) {
  const office = planBuilding([...agents.values()], teams, []);
  return callsIn(teams, agents, sentBack, callerIn(office));
}

const agent = (id: string, extra: Partial<WorldAgent> = {}) =>
  ({ id, name: id, status: "working", teamId: "t1", role: "member", waitingOnYou: false, taskIds: [], ...extra }) as WorldAgent;
const team = (id: string, extra: Partial<WorldTeam> = {}) =>
  ({ id, name: id, purpose: "", handsTo: null, path: null, branch: null, standing: false, createdAt: "", status: "working", blockedBy: [], ...extra }) as WorldTeam;
const byId = (...agents: WorldAgent[]) => new Map(agents.map((a) => [a.id, a]));

test("a blocked team's lead comes to the clearing and faces you; a team that is not blocked stays", () => {
  const agents = byId(agent("clara", { role: "lead" }), agent("liv", { status: "blocked" }), agent("ada", { teamId: "t2", role: "lead" }));
  const out = calls([team("t1", { status: "blocked", blockedBy: ["liv"] }), team("t2")], agents, new Set());
  assert.equal(out.length, 1);
  assert.equal(out[0]!.leadId, "clara");
  assert.deepEqual(out[0]!.stuckIds, ["liv"]);
  assert.equal(out[0]!.spot.zone, "caller");
  assert.equal(out[0]!.spot.facing, yawTo(out[0]!.spot.pos, SPAWN));
  // On the clearing in front of you.
  assert.ok(out[0]!.spot.pos[1] > 0);
});

test("sending a lead back holds until what the team is stuck on changes", () => {
  const blocked = team("t1", { status: "blocked", blockedBy: ["liv"] });
  const agents = byId(agent("clara", { role: "lead" }), agent("liv", { status: "blocked" }), agent("tom", { waitingOnYou: true }));
  const [first] = calls([blocked], agents, new Set());
  const sentBack = new Set([first!.key]);
  assert.deepEqual(calls([blocked], agents, sentBack), []);
  // Tom now waits on you as well: the lead comes again.
  assert.equal(calls([{ ...blocked, blockedBy: ["liv", "tom"] }], agents, sentBack).length, 1);
  // Liv stops being at a prompt and asks you instead: that is something new too.
  assert.equal(calls([blocked], byId(agent("clara", { role: "lead" }), agent("liv", { waitingOnYou: true })), sentBack).length, 1);
});

test("no lead walks over who is offline or missing, and a stuck lead is named first", () => {
  const blocked = team("t1", { status: "blocked", blockedBy: ["liv", "clara"] });
  assert.deepEqual(calls([blocked], byId(agent("clara", { role: "lead", status: "offline" }), agent("liv", { status: "blocked" })), new Set()), []);
  assert.deepEqual(calls([blocked], byId(agent("liv", { status: "blocked" })), new Set()), []);
  const [call] = calls([blocked], byId(agent("clara", { role: "lead", status: "blocked" }), agent("liv", { status: "blocked" })), new Set());
  assert.deepEqual(call!.stuckIds, ["clara", "liv"]);
});

test("two leads on the clearing stand apart, and walk there from their bay round the path", () => {
  const agents = byId(agent("clara", { role: "lead" }), agent("liv", { status: "blocked" }), agent("ada", { teamId: "t2", role: "lead", status: "blocked" }));
  const teams = [team("t1", { status: "blocked", blockedBy: ["liv"] }), team("t2", { status: "blocked", blockedBy: ["ada"] })];
  const [a, b] = calls(teams, agents, new Set());
  assert.ok(Math.hypot(a!.spot.pos[0] - b!.spot.pos[0], a!.spot.pos[1] - b!.spot.pos[1]) > 0.8);
  const office = planBuilding([...agents.values()], teams, []);
  assert.deepEqual(b!.spot, callerIn(office)(1));
  const route = routeIn(office);
  const home = office.spots.get("clara")!;
  const path = route(home.pos, home, a!.spot);
  assert.deepEqual(path.at(-1), a!.spot.pos);
  // Keep out of the planted beds on the walk to the clearing.
  const points = path.flatMap((p, i) => {
    const q = path[i - 1] ?? home.pos;
    return Array.from({ length: 20 }, (_, k) => [q[0] + ((p[0] - q[0]) * k) / 20, q[1] + ((p[1] - q[1]) * k) / 20] as const);
  });
  for (const [x, z] of points) for (const bed of office.garden.beds) {
    assert.ok(!(x > bed.minX && x < bed.maxX && z > bed.minZ && z < bed.maxZ), `walks through a bed at ${x},${z}`);
  }
  assert.ok(walkMs(home, a!.spot, route) > 1000);
});
