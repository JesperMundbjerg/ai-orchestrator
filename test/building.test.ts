import { test } from "node:test";
import assert from "node:assert/strict";
import type { Team, WorldAgent } from "../src/shared/types.ts";
import { LOUNGE_TABLE, YOUR_VIEW, type Spot, type Vec2 } from "../src/ui/world/layout.ts";
import { buildingPipelines, buildingRoute, callerIn, doorway, DOOR_WIDTH, MIN_CONSOLES, PATH_HALF, place, planBuilding, teamDesks, type BuildingPlan, type Garden, type Rect, type Room } from "../src/ui/world/building.ts";
import { groundOf, HEADROOM, inWater, plantGarden, type Planting } from "../src/ui/world/planting.ts";
import { visitSpot } from "../src/ui/world/visits.ts";

const agent = (id: string, extra: Partial<WorldAgent> = {}): WorldAgent => ({
  id, identity: id, name: id, harness: "pi", cwd: null, project: null, branch: null, status: "idle", title: null, paneId: null, taskIds: [], teamId: null, role: "member", waitingOnYou: false, doing: null, helpers: [], model: null, sessionName: null, ran: true, ...extra,
});
const team = (id: string, handsTo: string | null = null): Team => ({ id, name: id, purpose: "", handsTo, path: `/repo-${id}`, branch: `worktree-${id}`, standing: false, createdAt: "" });

/** A building with n teams, each a lead and `crew(i)` crew, `idle` agents in the garden and two in line. */
function building(n: number, crew: (i: number) => number = () => 3, queued = ["q1", "q2"], idle = 3): BuildingPlan {
  const teams = Array.from({ length: n }, (_, i) => team(`t${i}`, n > 1 ? `t${(i + 1) % n}` : null));
  const agents = [
    ...teams.flatMap((t, i) => [agent(`${t.id}-lead`, { teamId: t.id, role: "lead" }), ...Array.from({ length: crew(i) }, (_, k) => agent(`${t.id}-c${k}`, { teamId: t.id }))]),
    ...[...Array.from({ length: idle }, (_, i) => `l${i + 1}`), ...queued].map((id) => agent(id)),
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

/** Every desk's top and the lounge's table, as rectangles the walkers must keep off. */
function furniture(plan: BuildingPlan): Rect[] {
  const desks = plan.corners.flatMap((c) => c.desks.map((d) => footprint({ center: d.pos, facing: d.facing, half: d.kind === "lead" ? [1, 0.35] : [0.7, 0.35] })));
  const [lx, lz] = plan.lounge.center;
  return [...desks, { minX: lx - LOUNGE_TABLE, maxX: lx + LOUNGE_TABLE, minZ: lz - LOUNGE_TABLE, maxZ: lz + LOUNGE_TABLE }];
}

/** Whether a point is in one of the garden's beds or its pond (a hand's breadth in from their edge). */
function inBedOrWater(plan: BuildingPlan, p: Vec2): string | null {
  const bed = plan.garden.beds.findIndex((b) => inRect(b, p, 0.1));
  if (bed >= 0) return `bed ${bed}`;
  return dist(p, plan.garden.pond.center) < plan.garden.pond.radius + 0.1 ? "the pond" : null;
}

/** What grows in a plan's garden, and the ground each thing takes as circles in a grid of metre squares, to look up near a point. */
const grown = new WeakMap<Garden, { planting: Planting; ground: Map<string, Array<{ p: Vec2; r: number; what: string }>> }>();
function planted(garden: Garden) {
  const known = grown.get(garden);
  if (known) return known;
  const planting = plantGarden(garden);
  const ground = new Map<string, Array<{ p: Vec2; r: number; what: string }>>();
  const add = (p: Vec2, r: number, what: string) => {
    const k = `${Math.floor(p[0])},${Math.floor(p[1])}`;
    ground.set(k, [...(ground.get(k) ?? []), { p, r, what }]);
  };
  for (const t of planting.trees) add(t.pos, groundOf(t), `a ${t.kind}`);
  // Ground cover is walked on; everything else is walked round.
  for (const p of planting.plants) if (p.kind !== "cover") add(p.pos, p.radius, `a ${p.kind}`);
  for (const r of planting.rocks) add(r.pos, r.radius, "a rock");
  const out = { planting, ground };
  grown.set(garden, out);
  return out;
}

/** Whatever grows within a person's reach of a point, if anything. */
function plantAt(plan: BuildingPlan, p: Vec2): string | null {
  if (!inRect(plan.garden.area, p, -1)) return null;
  const { ground } = planted(plan.garden);
  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
    for (const g of ground.get(`${Math.floor(p[0]) + i},${Math.floor(p[1]) + j}`) ?? []) if (dist(g.p, p) < g.r + PERSON) return `${g.what} at ${g.p}`;
  }
  return null;
}

/** How far a point is from a rectangle, 0 inside it. */
const away = (r: Rect, [x, z]: Vec2) => Math.hypot(Math.max(r.minX - x, 0, x - r.maxX), Math.max(r.minZ - z, 0, z - r.maxZ));

/** Every point along a walk, a hand's breadth apart. */
function along(from: Vec2, path: Vec2[]): Vec2[] {
  const points = [from, ...path];
  const out: Vec2[] = [from];
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1]!, points[i]!];
    const n = Math.ceil(dist(a, b) / 0.1);
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

/** The walk from `from` along `path` keeps inside the building, off every wall and every desk, out of the garden's beds and water, and clear of all that grows there. */
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
  for (const p of along(from, path)) {
    const hit = inBedOrWater(plan, p) ?? plantAt(plan, p);
    assert.ok(!hit, `${what}: walks through ${hit} at ${p}`);
  }
}

const inRect = (r: Rect, [x, z]: Vec2, pad = 0) => x >= r.minX + pad && x <= r.maxX - pad && z >= r.minZ + pad && z <= r.maxZ - pad;

test("everyone has a place in the building: team seats, waiting for you on the clearing, or the garden", () => {
  const plan = building(2, () => 3, ["q1"]);
  assert.equal(plan.spots.size, 2 * 4 + 3 + 1);
  assert.equal(plan.spots.get("q1")?.zone, "queue");
  assert.equal(plan.spots.get("l1")?.zone, "garden");
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
    // The garden, and so the line and the callers on its clearing, are in the hall, with the walkway round them.
    const g = plan.garden.area;
    assert.ok(inRect(plan.loop, [g.minX, g.minZ], 0.5) && inRect(plan.loop, [g.maxX, g.maxZ], 0.5), `${n} teams: the garden inside the walkway`);
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
  const callerSpot = callerIn(plan);
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

test("the garden lies in the middle of the hall: paths, beds and the pond inside it, the clearing at its front", () => {
  for (const n of [1, 4, 9, 12]) {
    const plan = building(n);
    const g = plan.garden;
    const what = `${n} teams`;
    for (const r of [...g.paths, ...g.beds, g.clearing]) assert.ok(inRect(g.area, [r.minX, r.minZ], -1e-9) && inRect(g.area, [r.maxX, r.maxZ], -1e-9), `${what}: inside the garden`);
    assert.ok(inRect(plan.hall, [g.area.minX, g.area.minZ]) && inRect(plan.hall, [g.area.maxX, g.area.maxZ]), `${what}: the garden in the hall`);
    // The pond is in a lawn, with room round it; no path crosses it.
    const [px, pz] = g.pond.center;
    const r = g.pond.radius;
    assert.ok(r > 1, `${what}: a pond, not a puddle`);
    assert.ok(g.beds.some((b) => inRect(b, [px - r, pz - r], 0.2) && inRect(b, [px + r, pz + r], 0.2)), `${what}: the pond lies in a bed`);
    // Where you stand is on the clearing, and the clearing is in front, towards the door.
    assert.ok(inRect(g.clearing, [0, 0], 1) && inRect(g.clearing, [0.3, 3.7], 0.5), `${what}: you stand on the clearing`);
    assert.ok(YOUR_VIEW[1] > g.area.maxZ && YOUR_VIEW[1] < plan.loop.maxZ + 1.5, `${what}: "Your desk" looks at the garden from its front`);
    assert.ok(g.clearing.minZ > g.walk.maxZ, `${what}: the clearing is in front of the walk`);
    // Paths and beds do not overlap: nothing planted where people walk.
    for (const p of [...g.paths, g.clearing]) for (const b of g.beds) {
      const overlap = Math.min(p.maxX, b.maxX) - Math.max(p.minX, b.minX) > 1e-6 && Math.min(p.maxZ, b.maxZ) - Math.max(p.minZ, b.minZ) > 1e-6;
      assert.ok(!overlap, `${what}: a path runs over a bed`);
    }
    // Benches stand on the walk, off its middle line.
    for (const b of g.benches) assert.ok(!inBedOrWater(plan, b.pos) && g.paths.some((p) => inRect(p, b.pos, 0.2)), `${what}: bench at ${b.pos} on a path`);
  }
});

test("everything in the garden grows in a bed, off every path, the clearing and the benches, and on land but for what grows in water", () => {
  for (const n of [1, 3, 4, 9, 12]) {
    const plan = building(n);
    const g = plan.garden;
    const { planting } = planted(g);
    const { center, radius } = g.pond;
    const onLand = [
      ...planting.trees.map((t) => ({ pos: t.pos, r: groundOf(t), what: `a ${t.kind}` })),
      ...planting.plants.filter((p) => !inWater(p)).map((p) => ({ pos: p.pos, r: p.radius, what: `a ${p.kind}` })),
      ...planting.rocks.map((r) => ({ pos: r.pos, r: r.radius, what: "a rock" })),
      // The trail's stones: those not in the pond.
      ...planting.steps.filter((s) => dist(s.pos, center) > radius).map((s) => ({ pos: s.pos, r: s.radius, what: "a stepping stone" })),
    ];
    const seats = [...plan.spots.values()].filter((s) => s.sit).map((s) => s.pos);
    for (const { pos, r, what } of onLand) {
      const here = `${n} teams: ${what} at ${pos}`;
      assert.ok(g.beds.some((b) => inRect(b, pos, r - 1e-9)), `${here} is in a bed`);
      for (const p of [...g.paths, g.clearing]) assert.ok(away(p, pos) >= r, `${here} is off the paths and the clearing`);
      for (const s of seats) assert.ok(dist(s, pos) >= r + PERSON, `${here} leaves room on the bench at ${s}`);
      // Rocks may stand at the water's edge; nothing else grows in it.
      if (what !== "a rock") assert.ok(dist(pos, center) >= radius + r, `${here} is on land`);
    }
    for (const p of planting.plants.filter(inWater)) assert.ok(dist(p.pos, center) < radius, `${n} teams: reeds at ${p.pos} in the pond`);
    for (const l of planting.lilies) assert.ok(dist(l.pos, center) + l.radius < radius, `${n} teams: a lily pad at ${l.pos} on the water`);
    // A crown that reaches out over a path or the clearing is above everyone's head.
    for (const t of planting.trees) {
      const over = [...g.paths, g.clearing].some((p) => away(p, t.pos) < t.crown);
      if (over) assert.ok(t.base >= HEADROOM, `${n} teams: the ${t.kind} at ${t.pos} hangs over a path at ${t.base}`);
    }
  }
});

test("the garden grows the same every time, and so looks the same on every render", () => {
  const a = building(4);
  const b = building(4, () => 5, ["q1"], 9);
  assert.deepEqual(plantGarden(a.garden), plantGarden(b.garden));
});

test("from where \"Your desk\" puts you, nothing growing stands between you and the leads who come to you or those waiting for you", () => {
  for (const n of [1, 6, 12]) {
    const plan = building(n, () => 3, Array.from({ length: 20 }, (_, i) => `q${i}`));
    const { planting } = planted(plan.garden);
    const blocks = [
      ...planting.trees.map((t) => ({ pos: t.pos, r: t.crown, what: `a ${t.kind}` })),
      ...planting.plants.filter((p) => p.height > 0.4).map((p) => ({ pos: p.pos, r: p.radius, what: `a ${p.kind}` })),
      ...planting.rocks.filter((r) => r.height > 0.4).map((r) => ({ pos: r.pos, r: r.radius, what: "a rock" })),
    ];
    const seen = [...Array.from({ length: 12 }, (_, i) => callerIn(plan)(i)), ...plan.queue.map((id) => plan.spots.get(id)!)];
    for (const s of seen) {
      for (const b of blocks) assert.ok(segmentGap(YOUR_VIEW, s.pos, b.pos, b.pos) > b.r, `${n} teams: ${b.what} at ${b.pos} hides the ${s.zone} at ${s.pos}`);
    }
  }
});

test("any number of idle agents fits in the garden: on a bench or strolling round the walk, never on a bed or in the water", () => {
  for (const idle of [0, 1, 2, 3, 7, 20, 45, 120]) {
    const plan = building(3, () => 3, ["q1"], idle);
    const what = `${idle} idle`;
    const here = [...plan.spots.values()].filter((s) => s.zone === "garden");
    assert.equal(here.length, idle, what);
    const places = here.map((s) => s.pos.map((v) => v.toFixed(3)).join(","));
    assert.equal(new Set(places).size, places.length, `${what}: no two share a place`);
    const sitting = here.filter((s) => s.sit);
    if (idle >= 2) assert.ok(sitting.length >= 1 && sitting.length < idle, `${what}: some sit and some stroll`);
    for (const s of here) {
      assert.ok(inRect(plan.garden.area, s.pos), `${what}: ${s.pos} in the garden`);
      assert.ok(!inBedOrWater(plan, s.pos), `${what}: ${s.pos} is ${inBedOrWater(plan, s.pos)}`);
      assert.ok(plan.garden.paths.some((p) => inRect(p, s.pos)), `${what}: ${s.pos} on a path`);
      if (s.sit) {
        // On a bench, facing the way it faces.
        assert.ok(plan.garden.benches.some((b) => dist(b.pos, s.pos) < 0.5 && Math.abs(Math.sin(b.facing - s.facing)) < 1e-9), `${what}: sits on a bench`);
      } else {
        // Strolling round the walk and back to where they joined it, never onto a bed or the pond.
        assert.ok(s.stroll && s.stroll.length >= 4, `${what}: a stroller strolls`);
        assert.equal(s.stroll!.at(-1), s.pos);
        for (const p of along(s.pos, s.stroll!)) assert.ok(!inBedOrWater(plan, p) && !plantAt(plan, p) && plan.garden.paths.some((r) => inRect(r, p, PATH_HALF - 0.05)), `${what}: the stroll keeps to the walk at ${p}`);
      }
    }
  }
});

test("walks into, round and out of the garden keep to its paths, from a bench or from anywhere on a stroll", () => {
  const plan = building(4, () => 3, ["q1", "q2", "q3"], 12);
  const garden = [...plan.spots.entries()].filter(([, s]) => s.zone === "garden");
  const others = [...plan.spots.entries()].filter(([, s]) => s.zone !== "garden").slice(0, 8);
  for (const [id, spot] of garden) {
    assertClearWalk(plan, plan.entrance, buildingRoute(plan, plan.entrance, null, spot), `in to ${id}`);
    // A stroller is anywhere round their walk when they are called away or the garden fills.
    const starts = spot.stroll ? along(spot.pos, spot.stroll).filter((_, i) => i % 17 === 0) : [spot.pos];
    for (const from of starts) {
      for (const [toId, to] of [...others, ...garden.filter(([o]) => o !== id).slice(0, 4), ["caller 0", callerIn(plan)(0)] as [string, Spot]]) {
        assertClearWalk(plan, from, buildingRoute(plan, from, spot, to), `${id} at ${from} to ${toId}`);
      }
    }
  }
});

test("leads who come to you and agents waiting for you stand apart on the clearing, in order, clear of beds and water", () => {
  for (const n of [1, 6, 12]) {
    const plan = building(n, () => 3, Array.from({ length: 20 }, (_, i) => `q${i}`));
    const callers = Array.from({ length: 12 }, (_, i) => callerIn(plan)(i));
    const waiting = plan.queue.map((id) => plan.spots.get(id)!);
    const what = `${n} teams`;
    for (const s of [...callers, ...waiting]) {
      assert.ok(inRect(plan.garden.clearing, s.pos, 0.4), `${what}: ${s.zone} at ${s.pos} on the clearing`);
      assert.ok(!inBedOrWater(plan, s.pos) && !plantAt(plan, s.pos), `${what}: ${s.pos} off beds, water and planting`);
      assertClearWalk(plan, plan.entrance, buildingRoute(plan, plan.entrance, null, s), `${what}: to ${s.zone} at ${s.pos}`);
    }
    const all = [...callers, ...waiting];
    all.forEach((a, i) => all.slice(i + 1).forEach((b) => assert.ok(dist(a.pos, b.pos) > 0.6, `${what}: ${a.pos} and ${b.pos} have room`)));
    // The first lead stands where your desk's callers stood, so turning to face them still works; the first in line stands nearest you.
    assert.deepEqual(callers[0]!.pos, [-1.2, 1]);
    const toYou = (s: Spot) => dist(s.pos, YOUR_VIEW);
    assert.ok(waiting.slice(1, 10).every((s) => toYou(s) > toYou(waiting[0]!)), `${what}: the first in line is nearest you`);
    // The callers stand left of the way in, those waiting right of it, so the way in stays open.
    for (const c of callers) assert.ok(c.pos[0] < -0.6, `${what}: caller left of the way in`);
    for (const w of waiting) assert.ok(w.pos[0] > 0.6, `${what}: waiting right of the way in`);
  }
});
