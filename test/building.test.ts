import { test } from "node:test";
import assert from "node:assert/strict";
import type { Team, WorldAgent } from "../src/shared/types.ts";
import { callerSpot, DESK, LOUNGE_TABLE, type Spot, type Vec2 } from "../src/ui/world/layout.ts";
import { buildingPipelines, buildingRoute, doorway, DOOR_WIDTH, MIN_CONSOLES, place, planBuilding, teamDesks, type BuildingPlan, type Rect, type Room } from "../src/ui/world/building.ts";
import { visitSpot } from "../src/ui/world/visits.ts";

const agent = (id: string, extra: Partial<WorldAgent> = {}): WorldAgent => ({
  id, identity: id, name: id, harness: "pi", cwd: null, project: null, branch: null, status: "idle", title: null, paneId: null, taskIds: [], teamId: null, role: "member", waitingOnYou: false, doing: null, helpers: [], model: null, sessionName: null, ran: true, ...extra,
});
const team = (id: string, handsTo: string | null = null): Team => ({ id, name: id, purpose: "", handsTo, path: `/repo-${id}`, branch: `worktree-${id}`, standing: false, createdAt: "" });

/** A building with n teams, each a lead and `crew(i)` crew, three agents in the lounge and two in line. */
function building(n: number, crew: (i: number) => number = () => 3, queued = ["q1", "q2"]): BuildingPlan {
  const teams = Array.from({ length: n }, (_, i) => team(`t${i}`, n > 1 ? `t${(i + 1) % n}` : null));
  const agents = [
    ...teams.flatMap((t, i) => [agent(`${t.id}-lead`, { teamId: t.id, role: "lead" }), ...Array.from({ length: crew(i) }, (_, k) => agent(`${t.id}-c${k}`, { teamId: t.id }))]),
    ...["l1", "l2", "l3", ...queued].map((id) => agent(id)),
  ];
  return planBuilding(agents, teams, queued);
}

const PERSON = 0.25;
const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** How close two floor segments come. */
function segmentGap(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2): number {
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const d1 = cross(q1, q2, p1), d2 = cross(q1, q2, p2), d3 = cross(p1, p2, q1), d4 = cross(p1, p2, q2);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  const toSegment = (p: Vec2, a: Vec2, b: Vec2) => {
    const l = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
    const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / l)) : 0;
    return dist(p, [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
  };
  return Math.min(toSegment(p1, q1, q2), toSegment(p2, q1, q2), toSegment(q1, p1, p2), toSegment(q2, p1, p2));
}

/** A room's floor, as a rectangle: rooms are turned by quarter turns only. */
function footprint(room: Pick<Room, "center" | "facing" | "half">): Rect {
  const corners = [[-1, -1], [1, 1]].map(([sx, sz]) => place(room.center, room.facing, [sx! * room.half[0], sz! * room.half[1]]));
  const xs = corners.map((p) => p[0]);
  const zs = corners.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}

const edges = (r: Rect): Array<[Vec2, Vec2]> => {
  const c: Vec2[] = [[r.minX, r.minZ], [r.maxX, r.minZ], [r.maxX, r.maxZ], [r.minX, r.maxZ]];
  return c.map((p, i) => [p, c[(i + 1) % 4]!]);
};

/** Every desk's top, the founder's desk and the lounge's table, as rectangles the walkers must keep off. */
function furniture(plan: BuildingPlan): Rect[] {
  const desks = plan.corners.flatMap((c) => c.desks.map((d) => footprint({ center: d.pos, facing: d.facing, half: d.kind === "lead" ? [1, 0.35] : [0.7, 0.35] })));
  const [lx, lz] = plan.lounge.center;
  return [...desks, { minX: DESK[0] - 1.3, maxX: DESK[0] + 1.3, minZ: DESK[1] - 0.45, maxZ: DESK[1] + 0.45 }, { minX: lx - LOUNGE_TABLE, maxX: lx + LOUNGE_TABLE, minZ: lz - LOUNGE_TABLE, maxZ: lz + LOUNGE_TABLE }];
}

/** The walk from `from` along `path` keeps inside the building, off every wall and every desk. */
function assertClearWalk(plan: BuildingPlan, from: Vec2, path: Vec2[], what: string) {
  const points = [from, ...path];
  const { minX, maxX, minZ, maxZ } = plan.outline;
  for (const p of points) assert.ok(p[0] > minX && p[0] < maxX && p[1] > minZ && p[1] < maxZ, `${what}: ${p} is outside the building`);
  const things = furniture(plan);
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1]!, points[i]!];
    for (const w of plan.walls) assert.ok(segmentGap(a, b, w.a, w.b) >= PERSON, `${what}: ${a} → ${b} runs into the wall ${w.a} → ${w.b}`);
    for (const t of things) for (const [p, q] of edges(t)) assert.ok(segmentGap(a, b, p, q) > 0.05, `${what}: ${a} → ${b} runs into furniture at ${t.minX},${t.minZ}`);
  }
}

const inRect = (r: Rect, [x, z]: Vec2, pad = 0) => x >= r.minX + pad && x <= r.maxX - pad && z >= r.minZ + pad && z <= r.maxZ - pad;

test("everyone has a place in the building: team seats, the line at your desk, or the lounge", () => {
  const plan = building(2, () => 3, ["q1"]);
  assert.equal(plan.spots.size, 2 * 4 + 3 + 1);
  assert.equal(plan.spots.get("q1")?.zone, "queue");
  assert.equal(plan.spots.get("l1")?.zone, "lounge");
  assert.equal(plan.spots.get("t0-lead")?.zone, "team");
  const places = [...plan.spots.values()].map((s) => s.pos.map((v) => v.toFixed(2)).join(","));
  assert.equal(new Set(places).size, places.length, "no two agents share a place");
  // The first team sits straight ahead of your desk, the second to its right.
  const [first, second] = plan.corners;
  assert.ok(Math.abs(first!.center[0]) < 1e-9 && first!.center[1] < 0);
  assert.ok(second!.center[0] > 0);
});

test("any number of teams and crew fit: a bay each, eight desks or one per crew member, and the lead's", () => {
  for (let n = 1; n <= 12; n++) {
    for (const crew of [0, 3, 8, 13]) {
      const plan = building(n, (i) => (i === 0 ? crew : 2));
      const what = `${n} teams, ${crew} crew`;
      assert.equal(plan.corners.length, n, what);
      assert.ok(plan.rooms.filter((r) => r.kind === "bay").length >= n, what);
      for (const c of plan.corners) {
        const crewHere = c.members.length - 1;
        assert.equal(c.desks.filter((d) => d.kind === "console").length, Math.max(MIN_CONSOLES, crewHere), what);
        assert.equal(c.desks.filter((d) => d.kind === "lead").length, 1, what);
        for (const m of c.members) assert.equal(plan.spots.get(m.id)?.group, c.team.id, what);
      }
      assert.equal(plan.spots.size, n * 3 + crew - (n ? 2 : 0) + 5, what);
      const bays = plan.rooms.filter((r) => r.kind === "bay").length;
      assert.ok(bays <= Math.max(7, n + 3), `${what}: not a building of empty bays (${bays})`);
    }
  }
});

test("rooms never overlap each other, and stay inside the building off the hall", () => {
  for (const n of [1, 4, 7, 12]) {
    const plan = building(n);
    const rooms = plan.rooms.map(footprint);
    rooms.forEach((a, i) => {
      assert.ok(inRect(plan.outline, [a.minX, a.minZ]) && inRect(plan.outline, [a.maxX, a.maxZ]), `room ${i} inside`);
      const hallOverlap = Math.min(a.maxX, plan.hall.maxX) - Math.max(a.minX, plan.hall.minX) > 1e-6 && Math.min(a.maxZ, plan.hall.maxZ) - Math.max(a.minZ, plan.hall.minZ) > 1e-6;
      assert.ok(!hallOverlap, `room ${i} is not in the hall`);
      rooms.slice(i + 1).forEach((b, j) => {
        const overlap = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) > 1e-6 && Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ) > 1e-6;
        assert.ok(!overlap, `${n} teams: rooms ${i} and ${i + 1 + j} overlap`);
      });
    });
    // Your desk, the line and the callers are in the hall, with the walkway round them.
    for (const p of [DESK, ...plan.queue.map((id) => plan.spots.get(id)!.pos), ...[0, 1, 2, 3].map((i) => callerSpot(i).pos)]) assert.ok(inRect(plan.loop, p, 0.5), `${p} inside the walkway`);
  }
});

test("desks stand in their own bay, clear of every wall", () => {
  for (const crew of [3, 13]) {
    const plan = building(5, () => crew);
    for (const c of plan.corners) {
      const room = footprint(plan.rooms.find((r) => r.teamId === c.team.id)!);
      for (const d of c.desks) {
        const top = footprint({ center: d.pos, facing: d.facing, half: d.kind === "lead" ? [1, 0.35] : [0.7, 0.35] });
        assert.ok(inRect(room, [top.minX, top.minZ], 0.3) && inRect(room, [top.maxX, top.maxZ], 0.3), `${c.team.id}: desk inside its bay`);
        for (const w of plan.walls) for (const [p, q] of edges(top)) assert.ok(segmentGap(p, q, w.a, w.b) > 0.3, `${c.team.id}: desk clear of walls`);
      }
    }
  }
});

test("every seat is reached from the front door through a doorway, along the walkway, off walls and desks", () => {
  for (const n of [1, 3, 8, 12]) {
    const plan = building(n, (i) => (i % 3 === 0 ? 11 : 3));
    for (const [id, spot] of plan.spots) {
      assertClearWalk(plan, plan.entrance, buildingRoute(plan, plan.entrance, null, spot), `${n} teams, in to ${id}`);
      if (spot.zone === "team" || spot.zone === "lounge") {
        const room = spot.zone === "lounge" ? plan.rooms.find((r) => r.kind === "lounge")! : plan.rooms.find((r) => r.teamId === spot.group)!;
        // The way in passes a doorway of the spot's own room.
        const through = room.doors.some((x) => dist(doorway(room, x).inside, spot.approach[1]!) < 1e-9);
        assert.ok(through, `${id} comes in by a door of its room`);
      }
    }
  }
});

test("walks between any two places, visits and calls to your desk keep off walls and desks", () => {
  const plan = building(7, (i) => (i === 2 ? 10 : 3), ["q1", "q2", "q3"]);
  const spots = [...plan.spots.entries()];
  const targets: Array<[string, Spot]> = [...spots, ...spots.map(([id, s]) => [`visiting ${id}`, visitSpot(s)] as [string, Spot]), ...[0, 1, 2].map((i) => [`caller ${i}`, callerSpot(i)] as [string, Spot])];
  for (const [fromId, from] of spots) {
    for (const [toId, to] of targets) {
      if (fromId === toId) continue;
      assertClearWalk(plan, from.pos, buildingRoute(plan, from.pos, from, to), `${fromId} to ${toId}`);
    }
  }
  // Back from your desk to their own seat, as a lead does once sent back.
  const lead = plan.spots.get("t3-lead")!;
  assertClearWalk(plan, callerSpot(0).pos, buildingRoute(plan, callerSpot(0).pos, callerSpot(0), lead), "caller home");
});

test("handed-over work runs from a bay's door round the hall to the next bay's, off the walls", () => {
  const plan = building(6);
  const lines = buildingPipelines(plan);
  assert.equal(lines.length, 6);
  for (const line of lines) {
    const path = line.path;
    for (let i = 1; i < path.length; i++) for (const w of plan.walls) assert.ok(segmentGap(path[i - 1]!, path[i]!, w.a, w.b) >= DOOR_WIDTH / 2 - 0.05, `${line.fromTeamId} → ${line.toTeamId}`);
  }
});

/** A unit step the way something faces, on the floor. */
const ahead = (yaw: number): Vec2 => [Math.sin(yaw), Math.cos(yaw)];
const sameWay = (a: number, b: number) => Math.abs(Math.sin(a - b)) < 1e-9 && Math.cos(a - b) > 0;

test("crew sit at benches of facing desks, each at their desk and facing its screens", () => {
  for (const crew of [3, 8, 16]) {
    const plan = building(4, () => crew);
    for (const c of plan.corners) {
      const consoles = c.desks.filter((d) => d.kind === "console");
      // A full bench: every desk has one across it, touching front to front and facing the other way.
      if (consoles.length % (2 * 4) === 0) {
        for (const d of consoles) {
          const [fx, fz] = ahead(d.facing);
          const across = consoles.find((o) => o !== d && dist(o.pos, [d.pos[0] + fx * 0.7, d.pos[1] + fz * 0.7]) < 1e-6);
          assert.ok(across && sameWay(across.facing, d.facing + Math.PI), `${crew} crew: a desk faces each desk in ${c.team.id}`);
        }
      }
      for (const d of c.desks) {
        if (!d.occupantId) continue;
        const spot = plan.spots.get(d.occupantId)!;
        const [fx, fz] = ahead(d.facing);
        assert.ok(dist(spot.pos, [d.pos[0] - fx * 0.75, d.pos[1] - fz * 0.75]) < 1e-6, `${d.occupantId} stands at their desk`);
        assert.ok(sameWay(spot.facing, d.facing), `${d.occupantId} faces their screens`);
      }
      // The lead's desk is at the front, facing the crew.
      const room = plan.rooms.find((r) => r.teamId === c.team.id)!;
      const lead = c.desks.find((d) => d.kind === "lead")!;
      assert.ok(sameWay(lead.facing, room.facing + Math.PI), "the lead faces their crew");
      for (const d of consoles) assert.ok(dist(lead.pos, doorway(room, 0).out) < dist(d.pos, doorway(room, 0).out), "the lead sits nearest the hall");
    }
  }
});

test("a bay no team has yet has the least bench, every desk free, inside it", () => {
  const plan = building(2);
  const empty = plan.rooms.filter((r) => r.kind === "bay" && !r.teamId);
  assert.ok(empty.length > 0);
  for (const room of empty) {
    const { desks, seats } = teamDesks(room, []);
    assert.equal(seats.length, 0);
    assert.equal(desks.filter((d) => d.kind === "console").length, MIN_CONSOLES);
    assert.ok(desks.every((d) => !d.occupantId));
    for (const d of desks) assert.ok(inRect(footprint(room), d.pos, 0.5), "free desk inside its bay");
  }
});

test("the outside walls have windows, the meeting rooms glass, and the bays and the lounge low planters", () => {
  const plan = building(5);
  const { minX, maxX, minZ, maxZ } = plan.outline;
  const onOutline = (p: Vec2) => [minX, maxX].some((x) => Math.abs(p[0] - x) < 1e-6) || [minZ, maxZ].some((z) => Math.abs(p[1] - z) < 1e-6);
  const edgeOf = (room: Room, p: Vec2) => {
    const r = footprint(room);
    return inRect(r, p, -1e-6) && ([r.minX, r.maxX].some((x) => Math.abs(p[0] - x) < 1e-6) || [r.minZ, r.maxZ].some((z) => Math.abs(p[1] - z) < 1e-6));
  };
  const meetings = plan.rooms.filter((r) => r.kind === "meeting");
  for (const w of plan.walls) {
    const mid: Vec2 = [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2];
    if (w.kind === "outer") assert.ok(onOutline(w.a) && onOutline(w.b));
    else assert.equal(w.kind === "glass", meetings.some((m) => edgeOf(m, mid)), `${w.a} → ${w.b} is ${w.kind}`);
  }
  assert.ok(plan.walls.some((w) => w.kind === "planter") && plan.walls.some((w) => w.kind === "glass"));
});
