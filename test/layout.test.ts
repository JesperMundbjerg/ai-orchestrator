import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, Team, WorldAgent } from "../src/shared/types.ts";
import { callerSpot, CORNER_HALF_DEPTH, CORNER_HALF_WIDTH, crewGrid, DESK, DESK_SIZE, LOUNGE_TABLE, pipelineLane, pipelines, planOffice, QUEUE_SIDE_X, queueOrder, queueSpot, route, type Corner, type Desk, type OfficePlan, type Spot, type Vec2 } from "../src/ui/world/layout.ts";
import { plan as planTalk } from "../src/ui/world/visits.ts";

const agent = (id: string, extra: Partial<WorldAgent> = {}): WorldAgent => ({
  id, identity: id, name: id, harness: "pi", cwd: null, project: null, branch: null, status: "idle", title: null, paneId: null, taskIds: [], teamId: null, role: "member", waitingOnYou: false, doing: null, helpers: [], model: null, sessionName: null, ran: true, ...extra,
});
const team = (id: string): Team => ({ id, name: id, purpose: "", handsTo: null, path: `/repo-${id}`, branch: `worktree-${id}`, standing: false, createdAt: "" });

test("the queue has one place per agent, in the order its items wait", () => {
  const agents = [agent("tom", { taskIds: ["t1", "t3"] }), agent("ada", { taskIds: ["t2"] })];
  assert.deepEqual(queueOrder(agents, ["t3", "t2", "t1"]), ["tom", "ada"]);
  assert.deepEqual(queueOrder(agents, ["unknown"]), []);
});

test("everyone has a place: team seats, the line at your desk, or the lounge", () => {
  const teams = [team("mc"), team("fp")];
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

test("walking to the line goes round the path and down the side lane, and the line moves up directly", () => {
  const plan = planOffice([agent("a", { teamId: "mc" }), agent("b"), agent("c")], [team("mc"), team("fp"), team("qa")], ["b", "c"]);
  const desk = plan.spots.get("a")!;
  const [first, second] = [plan.spots.get("b")!, plan.spots.get("c")!];
  const path = route(desk.pos, desk, second);
  assert.ok(path.some((p) => Math.abs(dist(p, DESK) - plan.path) < 0.01), "along the path");
  assert.deepEqual(path.at(-2), [QUEUE_SIDE_X, second.pos[1]]);
  assert.deepEqual(route(second.pos, second, first), [first.pos]);
});

const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** An office with n projects of a lead and three crew each, some agents in the lounge, and two in line. */
function office(n: number, queued = ["q1", "q2"]) {
  const teams = Array.from({ length: n }, (_, i) => team(`t${i}`));
  const agents = [
    ...teams.flatMap((t) => [agent(`${t.id}-lead`, { teamId: t.id, role: "lead" }), ...[1, 2, 3].map((k) => agent(`${t.id}-c${k}`, { teamId: t.id }))]),
    ...["l1", "l2", "l3", ...queued].map((id) => agent(id)),
  ];
  return planOffice(agents, teams, queued);
}

/** The four floor corners of a team's corner, or of the lounge's place on the ring. */
function footprint(center: Vec2, facing: number): Vec2[] {
  const [c, s] = [Math.cos(facing), Math.sin(facing)];
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, z]) => {
    const [lx, lz] = [x! * CORNER_HALF_WIDTH, z! * CORNER_HALF_DEPTH];
    return [center[0] + lx * c + lz * s, center[1] - lx * s + lz * c] as Vec2;
  });
}

/** Whether two convex floor shapes overlap (separating axis test). */
function overlap(a: Vec2[], b: Vec2[]): boolean {
  for (const shape of [a, b]) {
    for (let i = 0; i < shape.length; i++) {
      const [p, q] = [shape[i]!, shape[(i + 1) % shape.length]!];
      const axis: Vec2 = [q[1] - p[1], p[0] - q[0]];
      const span = (s: Vec2[]) => s.map(([x, z]) => x * axis[0] + z * axis[1]);
      if (Math.max(...span(a)) <= Math.min(...span(b)) || Math.max(...span(b)) <= Math.min(...span(a))) return false;
    }
  }
  return true;
}

const inside = (shape: Vec2[], [x, z]: Vec2) =>
  shape.every((p, i) => {
    const q = shape[(i + 1) % shape.length]!;
    return (q[0] - p[0]) * (z - p[1]) - (q[1] - p[1]) * (x - p[0]) >= 0;
  }) || shape.every((p, i) => {
    const q = shape[(i + 1) % shape.length]!;
    return (q[0] - p[0]) * (z - p[1]) - (q[1] - p[1]) * (x - p[0]) <= 0;
  });

/** Every 10 cm of a walk. */
function walked(from: Vec2, path: Vec2[]): Vec2[] {
  return path.flatMap((p, i) => {
    const q = path[i - 1] ?? from;
    const n = Math.max(1, Math.ceil(dist(p, q) / 0.1));
    return Array.from({ length: n }, (_, k) => [q[0] + ((p[0] - q[0]) * k) / n, q[1] + ((p[1] - q[1]) * k) / n] as Vec2);
  });
}

/** A desk's top as seen from above, with room for the walker's body around it. */
function deskShape(pos: Vec2, facing: number, width: number, depth: number): Vec2[] {
  const [c, s] = [Math.cos(facing), Math.sin(facing)];
  const [w, d] = [width / 2 + 0.15, depth / 2 + 0.15];
  return [[-w, -d], [w, -d], [w, d], [-w, d]].map(([x, z]) => [pos[0] + x! * c + z! * s, pos[1] - x! * s + z! * c] as Vec2);
}

function furniture(plan: OfficePlan): Array<{ name: string; hit: (p: Vec2) => boolean }> {
  const desk = (name: string, shape: Vec2[]) => ({ name, hit: (p: Vec2) => inside(shape, p) });
  return [
    desk("your desk", deskShape(DESK, 0, 2.6, 0.9)),
    { name: "the lounge table", hit: (p: Vec2) => dist(p, plan.lounge.center) < LOUNGE_TABLE + 0.2 },
    ...plan.corners.flatMap((c) => c.desks.map((d) => desk(`a desk of ${c.team.id}`, deskShape(d.pos, d.facing, DESK_SIZE[d.kind][0] * d.scale, DESK_SIZE[d.kind][1] * d.scale)))),
  ];
}

test("every corner stands on a ring round your desk, facing it, as close as it can without overlapping", () => {
  for (let n = 1; n <= 12; n++) {
    const plan = office(n);
    const shapes = [...plan.corners.map((c) => footprint(c.center, c.facing)), footprint(plan.lounge.center, plan.lounge.facing)];
    for (const c of plan.corners) {
      assert.ok(Math.abs(dist(c.center, DESK) - plan.ring) < 1e-9, "all equally far");
      const toDesk = Math.atan2(DESK[0] - c.center[0], DESK[1] - c.center[1]);
      assert.ok(Math.abs(Math.sin(c.facing - toDesk)) < 1e-9 && Math.cos(c.facing - toDesk) > 0, "facing your desk");
    }
    assert.ok(plan.ring <= (n <= 5 ? 14.6 : n <= 6 ? 15.5 : 26), `${n} teams stand ${plan.ring.toFixed(1)} m away`);
    for (let i = 0; i < shapes.length; i++) {
      for (let j = i + 1; j < shapes.length; j++) assert.ok(!overlap(shapes[i]!, shapes[j]!), `${n} teams: places ${i} and ${j} overlap`);
      // Nothing on the ring reaches the path, so walking round it passes in front of the corners.
      for (const p of shapes[i]!) assert.ok(dist(p, DESK) > plan.path + 1);
    }
  }
});

test("a new team takes the next place: the teams already there keep their side of the ring, and while it has room, their place", () => {
  for (let n = 1; n < 12; n++) {
    const [before, after] = [office(n), office(n + 1)];
    before.corners.forEach((c, i) => {
      const now = after.corners[i]!;
      assert.equal(now.team.id, c.team.id);
      assert.equal(Math.sign(Math.round(now.center[0] * 1e6)), Math.sign(Math.round(c.center[0] * 1e6)), `team ${i} changes sides at ${n + 1} teams`);
      if (after.ring === before.ring) assert.deepEqual(now.center, c.center);
    });
  }
  // The first straight ahead of you, the next to your right and left.
  const [first, second, third] = office(3).corners;
  assert.ok(Math.abs(first!.center[0]) < 1e-9 && first!.center[1] < 0);
  assert.ok(second!.center[0] > 0 && third!.center[0] < 0);
});

test("walks between corners, the lounge, the line and your desk go round the path, off every desk and through no other corner", () => {
  for (const n of [2, 7, 12]) {
    const plan = office(n);
    const things = furniture(plan);
    // Everyone's place, and where leads stand when they come over to your desk.
    const places: Array<[string, Spot]> = [...plan.spots.entries(), ["caller0", callerSpot(0)], ["caller1", callerSpot(1)]];
    const cornerOf = new Map(plan.corners.map((c) => [c.team.id, footprint(c.center, c.facing)]));
    for (const [fromId, from] of places) {
      for (const [toId, to] of places) {
        if (fromId === toId) continue;
        const steps = walked(from.pos, route(from.pos, from, to));
        for (const p of steps) {
          const hit = things.find((t) => t.hit(p));
          assert.ok(!hit, `${n} teams: ${fromId} → ${toId} walks through ${hit?.name} at ${p.map((v) => v.toFixed(2))}`);
          for (const [teamId, shape] of cornerOf) {
            if (teamId === from.group || teamId === to.group) continue;
            assert.ok(!inside(shape, p), `${n} teams: ${fromId} → ${toId} cuts through ${teamId}`);
          }
        }
      }
    }
  }
});

const said = (id: string, kind: Message["kind"], from: string | null, to: string[], text = "hello"): Message =>
  ({ id, kind, fromAgentId: from, teamId: null, text, workId: null, createdAt: "", toFounder: false, deliveries: to.map((agentId) => ({ agentId, state: "queued", error: null, updatedAt: "" })) });

test("an agent who says something walks to the person it is for and stands beside them", () => {
  const teams = [team("dev"), team("qa")];
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
  const teams = [{ ...team("qa") }, { ...team("dev"), handsTo: "qa" }];
  const office = planOffice([], teams, []);
  const [p] = pipelines(office);
  assert.equal(p!.fromTeamId, "dev");
  assert.ok(p!.path.slice(1, -1).every((q) => Math.abs(dist(q, DESK) - pipelineLane(office)) < 0.01), "round the desk, between the path and the corners");
  assert.equal(pipelines(planOffice([], [team("qa")], [])).length, 0);
});

/** One project: a lead and this many crew, each with a place. */
function bigTeam(crew: number) {
  const t = team("big");
  const agents = [agent("lead", { teamId: "big", role: "lead" }), ...Array.from({ length: crew }, (_, i) => agent(`c${i}`, { teamId: "big" }))];
  return planOffice(agents, [t], []);
}

/** A floor point in a corner's own frame (+z towards your desk): the inverse of how the corner is laid out. */
const inCorner = (c: Corner, p: Vec2): Vec2 => {
  const [dx, dz] = [p[0] - c.center[0], p[1] - c.center[1]];
  return [dx * Math.cos(c.facing) - dz * Math.sin(c.facing), dx * Math.sin(c.facing) + dz * Math.cos(c.facing)];
};
const deskCorners = (c: Corner, d: Desk, margin = 0): Vec2[] =>
  deskShape(d.pos, d.facing, DESK_SIZE[d.kind][0] * d.scale - 2 * margin, DESK_SIZE[d.kind][1] * d.scale - 2 * margin);

test("a team of any size fits its corner: every desk and chair inside it, clear of the lead's desk and of each other", () => {
  for (const crew of [...Array.from({ length: 30 }, (_, i) => i + 1), 45, 80, 200]) {
    const plan = bigTeam(crew);
    const corner = plan.corners[0]!;
    assert.equal(corner.desks.filter((d) => d.kind === "console").length, Math.max(3, crew), `${crew} crew get their desks`);
    // deskShape adds a walker's 15 cm all round, so ask for it back.
    const shapes = corner.desks.map((d) => deskCorners(corner, d, 0.15));
    corner.desks.forEach((d, i) => {
      for (const p of shapes[i]!) {
        const [x, z] = inCorner(corner, p);
        assert.ok(Math.abs(x) <= CORNER_HALF_WIDTH && Math.abs(z) <= CORNER_HALF_DEPTH, `${crew} crew: a ${d.kind} desk sticks out of the corner at ${x.toFixed(2)},${z.toFixed(2)}`);
      }
      for (let j = i + 1; j < corner.desks.length; j++) assert.ok(!overlap(shapes[i]!, shapes[j]!), `${crew} crew: desks ${i} and ${j} overlap`);
    });
    // Each crew member sits behind their desk, in the corner (a chair about 60 cm across).
    for (const m of corner.members) {
      const spot = plan.spots.get(m.id)!;
      const [x, z] = inCorner(corner, spot.pos);
      assert.ok(Math.abs(x) + 0.3 <= CORNER_HALF_WIDTH && Math.abs(z) + 0.3 <= CORNER_HALF_DEPTH, `${crew} crew: ${m.id} sits outside the corner`);
    }
    const lead = corner.desks.find((d) => d.kind === "lead")!;
    assert.ok(corner.desks.filter((d) => d !== lead).every((d) => !overlap(deskCorners(corner, d), deskCorners(corner, lead))));
    assert.ok(corner.desks.every((d) => d === lead || inCorner(corner, d.pos)[1] < inCorner(corner, lead.pos)[1] - 1), `${crew} crew: a crew desk stands too close to the lead's`);
  }
});

test("up to ten crew the desks stand as they always did; beyond that they only get smaller, never fewer or apart", () => {
  for (let n = 1; n <= 10; n++) assert.deepEqual(crewGrid(n), { scale: 1, perRow: 5, pitch: 1.7, rowGap: 1.9, firstZ: -1.9 });
  let last = 1;
  for (let n = 11; n <= 200; n++) {
    const { scale, perRow } = crewGrid(n);
    assert.ok(scale <= last && scale > 0, `${n} crew: desks do not grow with the team`);
    assert.ok(perRow >= 1);
    last = scale;
  }
  assert.ok(crewGrid(15).scale > 0.9 && crewGrid(30).scale > 0.6, "thirty crew still have desks of a usable size");
});

test("crew walk to their desks and between them off every desk, in any size of team", () => {
  for (const crew of [10, 11, 16, 30]) {
    const plan = bigTeam(crew);
    const things = furniture(plan);
    const seats = [...plan.spots.entries()];
    for (const [fromId, from] of seats) {
      for (const [toId, to] of [...seats, ["line", queueSpot(0)] as const]) {
        if (fromId === toId) continue;
        for (const p of walked(from.pos, route(from.pos, from, to))) {
          const hit = things.find((t) => t.hit(p));
          assert.ok(!hit, `${crew} crew: ${fromId} → ${toId} walks through ${hit?.name} at ${p.map((v) => v.toFixed(2))}`);
        }
      }
    }
  }
});
