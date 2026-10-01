import { test } from "node:test";
import assert from "node:assert/strict";
import type { Team, WorldAgent } from "../src/shared/types.ts";
import { DESK_SIZE, planOffice, type OfficePlan } from "../src/ui/world/layout.ts";
import { planBuilding } from "../src/ui/world/building.ts";
import { CRAFTS, crafters, LEAD_CRAFTS, pieceParts, STAGE_S, stageAt, STAGES, stationParts, studio, type Craft, type Part } from "../src/ui/world/crafts.ts";

const agent = (id: string, extra: Partial<WorldAgent> = {}): WorldAgent => ({
  id, identity: id, name: id, harness: "pi", cwd: null, project: null, branch: null, status: "working", title: null, paneId: null, taskIds: [], teamId: null, role: "member", waitingOnYou: false, doing: null, helpers: [], model: null, sessionName: null, ran: true, ...extra,
});
const team = (id: string): Team => ({ id, name: id, purpose: "", handsTo: null, path: `/repo-${id}`, branch: `worktree-${id}`, standing: false, worktrees: [], createdAt: "" });

function plans(crew: number): OfficePlan[] {
  const teams = [team("a"), team("b"), team("c")];
  const agents = teams.flatMap((t, i) => [agent(`${t.id}-lead`, { teamId: t.id, role: "lead" }), ...Array.from({ length: i ? 3 : crew }, (_, k) => agent(`${t.id}-${k}`, { teamId: t.id }))]);
  return [planOffice(agents, teams, []), planBuilding(agents, teams, [])];
}

/** A part's eight corners in the station's frame, turned as the renderer turns it (y, then x, then z). */
function corners(p: Part): Array<[number, number, number]> {
  const [cy, sy] = [Math.cos(p.turn ?? 0), Math.sin(p.turn ?? 0)];
  const [cx, sx] = [Math.cos(p.tilt ?? 0), Math.sin(p.tilt ?? 0)];
  const [cz, sz] = [Math.cos(p.roll ?? 0), Math.sin(p.roll ?? 0)];
  const out: Array<[number, number, number]> = [];
  for (const a of [-0.5, 0.5]) for (const b of [-0.5, 0.5]) for (const c of [-0.5, 0.5]) {
    let [x, y, z] = [a * p.size[0], b * p.size[1], c * p.size[2]];
    [x, y] = [x * cz - y * sz, x * sz + y * cz];
    [y, z] = [y * cx - z * sx, y * sx + z * cx];
    [x, z] = [x * cy + z * sy, -x * sy + z * cy];
    out.push([p.at[0] + x, p.at[1] + y, p.at[2] + z]);
  }
  return out;
}

test("every station, and its piece at every stage, stands inside the footprint of the desk it replaces, under the lamps", () => {
  for (const craft of CRAFTS) for (const lead of [false, true]) {
    if (lead && !LEAD_CRAFTS.includes(craft)) continue;
    const [w, d] = DESK_SIZE[lead ? "lead" : "console"];
    for (let stage = 0; stage <= STAGES[craft]; stage++) for (const seed of [0, 1, 2, 3, 7]) {
      for (const part of [...stationParts(craft, lead), ...pieceParts(craft, lead, stage, seed)]) {
        for (const [x, y, z] of corners(part)) {
          const what = `${lead ? "a lead's" : "a"} ${craft} station at stage ${stage}`;
          assert.ok(Math.abs(x) <= w / 2 + 1e-9 && Math.abs(z) <= d / 2 + 1e-9, `${what} sticks out at ${x.toFixed(2)},${z.toFixed(2)}`);
          assert.ok(y >= -0.03 && y <= 2, `${what} reaches ${y.toFixed(2)} m`);
        }
      }
    }
  }
});

test("a piece changes at every stage while its maker works", () => {
  for (const craft of CRAFTS) for (const lead of [false, true]) {
    for (let stage = 1; stage <= STAGES[craft]; stage++) {
      assert.notDeepEqual(pieceParts(craft, lead, stage, 1), pieceParts(craft, lead, stage - 1, 1), `${craft} at stage ${stage}`);
    }
  }
});

test("a piece grows a stage every STAGE_S of work, stands finished a while, and the next is started", () => {
  for (const craft of CRAFTS) {
    const seen = Array.from({ length: 40 }, (_, i) => stageAt(craft, i * STAGE_S + 1));
    const last = STAGES[craft];
    seen.slice(0, last + 1).forEach((s, i) => assert.equal(s, i, `${craft} after ${i} stages`));
    assert.equal(seen[last + 1], last, `${craft} stands finished`);
    assert.equal(seen[seen.indexOf(last) + 3], 0, `${craft} starts over`);
    assert.ok(seen.every((s) => s >= 0 && s <= last));
  }
});

test("in both layouts and any size of team, every desk is a craft station, neighbours make different things and the lead has a larger one", () => {
  for (const crew of [0, 1, 2, 3, 5, 8, 12, 30, 80, 200]) for (const plan of plans(crew)) {
    const stations = studio(plan.corners);
    assert.equal(stations.length, plan.corners.reduce((n, c) => n + c.desks.length, 0), `${crew} crew: a station on every desk`);
    const makes = crafters(plan.corners);
    for (const c of plan.corners) {
      const here = stations.filter((s) => c.desks.includes(s.desk));
      const lead = here.filter((s) => s.lead);
      assert.equal(lead.length, 1, `${crew} crew: one lead's station in ${c.team.id}`);
      assert.ok(LEAD_CRAFTS.includes(lead[0]!.craft) && lead[0]!.desk.kind === "lead");
      const crewStations = here.filter((s) => !s.lead);
      crewStations.slice(1).forEach((s, i) => assert.notEqual(s.craft, crewStations[i]!.craft, `${crew} crew: places ${i} and ${i + 1} in ${c.team.id} make the same`));
      if (crewStations.length >= CRAFTS.length) assert.equal(new Set(crewStations.map((s) => s.craft)).size, CRAFTS.length, "a big room has every craft");
      // Everyone in the room makes what their own station is for.
      for (const s of here) if (s.desk.occupantId) assert.equal(makes.get(s.desk.occupantId), s.craft);
    }
    const inRooms = plan.corners.flatMap((c) => c.members.map((m) => m.id));
    assert.equal([...makes.keys()].sort().join(), inRooms.sort().join(), `${crew} crew: every member has a station`);
  }
});

test("the crafts a room starts from differ between teams, so rooms look different", () => {
  const first = new Set<Craft>();
  for (let i = 0; i < 12; i++) {
    const teams = [team(`team-${i}`)];
    const office = planOffice([agent("l", { teamId: teams[0]!.id, role: "lead" }), agent("c", { teamId: teams[0]!.id })], teams, []);
    first.add(studio(office.corners)[0]!.craft);
  }
  assert.ok(first.size >= 3);
});
