// The office as one building, the other layout beside the ring. Pure: from the world state and
// the queue order it returns the same plan as the ring does (each agent's spot, each team's
// desks), plus the building's rooms and walls, and the walking route between two spots.
// Coordinates are metres on the floor as [x, z], your desk at the origin, north (-z) ahead.
//
//   hall     an open hall round your desk: the line in front of it (north), callers on your
//            side of it, the front door behind you (south)
//   loop     a walkway round the hall, just inside the rooms' fronts; everyone walking
//            between rooms follows it, so nobody cuts across your desk or the line
//   bays     an open team area per project and standing team, behind low planters, along the
//            north side, then down the east and west sides, the first straight ahead, the next
//            ones alternately right and left. Each has benches of facing desks, four a side
//            (eight desks at least, another bench for a bigger crew), the lead's desk at the
//            front, the team's TV on the back wall and a way in at each front corner. Every bay
//            is as deep as the deepest one needs, so the building stays square; places no team
//            has yet have their desks free.
//   south    the lounge and kitchen west of the front door, two glass meeting rooms east of it

import type { Team, WorldAgent } from "../../shared/types.ts";
import { queueSpot, route, viewOf, yawTo, type Corner, type Desk, type OfficePlan, type Spot, type Vec2 } from "./layout.ts";

export type Layout = "ring" | "building";

export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface Room {
  kind: "bay" | "lounge" | "meeting";
  /** The bay's team; null for an empty bay and for the other rooms. */
  teamId: string | null;
  center: Vec2;
  /** The way the room is turned: its glass front, and its doors, face the hall. */
  facing: number;
  /** Half its width along the front, and half its depth, in its own frame. */
  half: Vec2;
  /** Doorways in the front, as their middle across the room's own frame. */
  doors: number[];
}

/** A wall from a to b: the outside walls have windows, the meeting rooms' walls are glass, the bays' and the lounge's low planters. */
export interface Wall {
  a: Vec2;
  b: Vec2;
  kind: "outer" | "glass" | "planter";
}

export interface BuildingPlan extends OfficePlan {
  layout: "building";
  rooms: Room[];
  walls: Wall[];
  /** The outside of the building. */
  outline: Rect;
  /** The open hall round your desk, between the rooms' fronts. */
  hall: Rect;
  /** The walkway round the hall everyone walks along between rooms. */
  loop: Rect;
  /** The lane handed-over work runs along, just inside the walkway. */
  lane: Rect;
  /** The front door in the south wall, and the lobby behind it. */
  frontDoor: { x: number; z: number; width: number };
}

/** A bay is this wide; the rooms' depth follows from the benches of desks the biggest crew needs. */
export const BAY_WIDTH = 9.6;
export const DOOR_WIDTH = 1.2;
/** Doors, and the side aisles behind them, this far either side of a bay's middle. */
export const DOOR_X = 4.15;
export const MIN_CONSOLES = 8;
/** A row of a bench: four desks side by side, the middle two filled first. */
const ACROSS = [-0.72, 0.72, -2.16, 2.16];
const DESK_DEPTH = 0.7;
const PER_ROW = ACROSS.length;
/** From a desk's middle back to where its person stands, and on to the gap they come in along. */
const SEAT = 0.75;
const BEHIND = 1.25;
/** From one bench's middle line to the next's: two chairs back to back and room to pass between. */
const BENCH_GAP = 3.8;
/** From the back wall to the first bench's middle: the TV, the whiteboard and a way behind the chairs. */
const BACK_ROOM = 3.6;
/** From the last bench's middle to the front: its chairs, the lead's desk and the strip behind their chair. */
const FRONT_ROOM = 5.4;
/** The walkway runs this far out from the rooms' fronts, the work lane this far. */
const LOOP_INSET = 1.2;
const LANE_INSET = 2.2;
/** A door's inside, where the bay's side aisle and the strip behind the lead's chair meet. */
const INSIDE = 0.6;
/** The lobby between the lounge and the meeting rooms, and the front door in it. */
const LOBBY = 4;
const FRONT_DOOR = 2.4;
/** The least hall that has room for your desk, the line, the callers and the walkway round them. */
const MIN_ACROSS = 3;
const MIN_DOWN = 2;
const NORTH = Math.PI;

/** How deep a bay is for this many rows of desks, two rows facing each other to a bench. */
export const bayDepth = (rows: number) => BACK_ROOM + (Math.ceil(rows / 2) - 1) * BENCH_GAP + FRONT_ROOM;

/** A point given in a room's own frame (+z towards the hall), on the floor. */
export const place = (center: Vec2, facing: number, [x, z]: Vec2): Vec2 =>
  [center[0] + x * Math.cos(facing) + z * Math.sin(facing), center[1] - x * Math.sin(facing) + z * Math.cos(facing)];

/**
 * How many bays go along the north side and down each of the east and west sides for this many
 * teams: at least the least hall, then the shorter side of the hall grows until all fit.
 */
export function baysFor(teams: number): { across: number; down: number } {
  let across = MIN_ACROSS;
  let down = MIN_DOWN;
  while (across + 2 * down < teams) {
    if (down < across) down++;
    else across++;
  }
  return { across, down };
}

export function planBuilding(agents: WorldAgent[], teams: Team[], queue: string[]): BuildingPlan {
  const members = new Map(teams.map((t) => [t.id, agents.filter((a) => a.teamId === t.id)]));
  const crewOf = (t: Team) => {
    const who = members.get(t.id)!;
    return who.length - (lead(who) ? 1 : 0);
  };
  const rows = Math.max(2, ...teams.map((t) => Math.ceil(Math.max(MIN_CONSOLES, crewOf(t)) / PER_ROW)));
  const depth = bayDepth(rows);
  const { across, down } = baysFor(teams.length);
  const hx = (across * BAY_WIDTH) / 2;
  const tall = down * BAY_WIDTH;
  const hall: Rect = { minX: -hx, maxX: hx, minZ: -0.55 * tall, maxZ: 0.45 * tall };
  const outline: Rect = { minX: hall.minX - depth, maxX: hall.maxX + depth, minZ: hall.minZ - depth, maxZ: hall.maxZ + depth };
  const loop = inset(hall, LOOP_INSET);
  const lane = inset(hall, LANE_INSET);
  const half: Vec2 = [BAY_WIDTH / 2, depth / 2];

  // The places for bays, in the order teams take them: straight ahead, then right and left along
  // the north side, then down the east and west sides from the north.
  const north = Array.from({ length: across }, (_, k) => ({ center: [hall.minX + (k + 0.5) * BAY_WIDTH, hall.minZ - depth / 2] as Vec2, facing: 0 }))
    .sort((a, b) => Math.round(Math.abs(a.center[0]) - Math.abs(b.center[0])) || b.center[0] - a.center[0]);
  const sides = Array.from({ length: down }, (_, k) => {
    const z = hall.minZ + (k + 0.5) * BAY_WIDTH;
    return [{ center: [hall.maxX + depth / 2, z] as Vec2, facing: -Math.PI / 2 }, { center: [hall.minX - depth / 2, z] as Vec2, facing: Math.PI / 2 }];
  }).flat();
  const places = [...north, ...sides];

  const spots = new Map<string, Spot>();
  const rooms: Room[] = [];
  const corners: Corner[] = [];
  places.forEach((p, i) => {
    const team = teams[i];
    rooms.push({ kind: "bay", teamId: team?.id ?? null, center: p.center, facing: p.facing, half, doors: [-DOOR_X, DOOR_X] });
    if (!team) return;
    const who = members.get(team.id)!;
    const bay = teamDesks(rooms.at(-1)!, who);
    for (const [id, spot] of bay.seats) spots.set(id, spot);
    corners.push({ team, center: p.center, facing: p.facing, desks: bay.desks, members: who });
  });

  // South of the hall: the lounge and kitchen, the lobby with the front door, and two meeting rooms.
  const southZ = hall.maxZ + depth / 2;
  const wing = hx - LOBBY / 2;
  const lounge: Room = { kind: "lounge", teamId: null, center: [-(LOBBY / 2 + wing / 2), southZ], facing: NORTH, half: [wing / 2, depth / 2], doors: [0] };
  rooms.push(lounge);
  for (const k of [0, 1]) {
    rooms.push({ kind: "meeting", teamId: null, center: [LOBBY / 2 + (k + 0.5) * (wing / 2), southZ], facing: NORTH, half: [wing / 4, depth / 2], doors: [0] });
  }

  const queued = new Set(queue);
  queue.forEach((id, i) => spots.set(id, queueSpot(i)));
  const lounging = agents.filter((a) => !queued.has(a.id) && !spots.has(a.id));
  lounging.forEach((a, i) => spots.set(a.id, loungeSpot(i, lounging.length, lounge)));

  const frontDoor = { x: 0, z: outline.maxZ, width: FRONT_DOOR };
  const margin = 3;
  return {
    layout: "building",
    corners,
    lounge: { center: lounge.center, facing: lounge.facing },
    // The ring's own measures; the building has its walkway and lane as rectangles instead.
    ring: 0,
    path: 0,
    entrance: [frontDoor.x, frontDoor.z - 1],
    spots,
    queue,
    bounds: { minX: outline.minX - margin, maxX: outline.maxX + margin, minZ: outline.minZ - margin, maxZ: outline.maxZ + margin },
    rooms,
    walls: walls(rooms, outline, frontDoor),
    outline,
    hall,
    loop,
    lane,
    frontDoor,
  };
}

const inset = (r: Rect, d: number): Rect => ({ minX: r.minX + d, maxX: r.maxX - d, minZ: r.minZ + d, maxZ: r.maxZ - d });
const lead = (members: WorldAgent[]) => members.find((m) => m.role === "lead") ?? null;

/** Where a room's door is, outside on the walkway and just inside, in the floor's frame. */
export function doorway(room: Room, x: number): { out: Vec2; inside: Vec2 } {
  const at = (z: number) => place(room.center, room.facing, [x, z]);
  return { out: at(room.half[1] + LOOP_INSET), inside: at(room.half[1] - INSIDE) };
}

/**
 * A bay's desks and who sits where: the crew at benches of facing desks, the first row of each
 * bench facing the hall and the second the back wall, and the lead at a desk of their own at the
 * front, facing their crew. Crew come in by the way in on their side, down the side aisle and
 * along the gap behind their row's chairs; the lead along the strip behind their chair. A bay no
 * team has yet gets the least bench, every desk free.
 */
export function teamDesks(room: Room, members: WorldAgent[]): { seats: Array<[string, Spot]>; desks: Desk[] } {
  const { center, facing } = room;
  const [, hd] = room.half;
  const group = room.teamId ?? "";
  const boss = lead(members);
  const crew = members.filter((m) => m !== boss);
  const seats: Array<[string, Spot]> = [];
  const desks: Desk[] = [];
  const at = (x: number, z: number) => place(center, facing, [x, z]);
  const strip = hd - INSIDE;
  const seat = (id: string, pos: Vec2, turn: number, door: number, approach: Vec2[]) => {
    const d = doorway(room, door);
    seats.push([id, { pos, facing: facing + turn, zone: "team", group, approach: [d.out, d.inside, ...approach] }]);
  };
  const shown = Math.max(MIN_CONSOLES, crew.length);
  for (let i = 0; i < shown; i++) {
    const row = Math.floor(i / PER_ROW);
    const x = ACROSS[i % PER_ROW]!;
    // Towards the hall (+z) in a bench's first row, towards the back wall in its second.
    const out = row % 2 === 0 ? -1 : 1;
    const bench = -hd + BACK_ROOM + Math.floor(row / 2) * BENCH_GAP;
    const deskZ = bench + (out * DESK_DEPTH) / 2;
    const turn = out < 0 ? 0 : NORTH;
    const occupant = crew[i] ?? null;
    desks.push({ pos: at(x, deskZ), facing: facing + turn, kind: "console", scale: 1, occupantId: occupant?.id ?? null });
    const side = x > 0 ? DOOR_X : -DOOR_X;
    const lane = deskZ + out * BEHIND;
    if (occupant) seat(occupant.id, at(x, deskZ + out * SEAT), turn, side, [at(side, lane), at(x, lane)]);
  }
  const leadSeat = hd - 1.45;
  desks.push({ pos: at(0, leadSeat - SEAT), facing: facing + NORTH, kind: "lead", scale: 1, occupantId: boss?.id ?? null });
  if (boss) seat(boss.id, at(0, leadSeat), NORTH, -DOOR_X, [at(0, strip)]);
  return { seats, desks };
}

/** Round the lounge's table, facing it: in by its door, and round the table inside the sofas. */
function loungeSpot(i: number, n: number, room: Room): Spot {
  const ring = Math.max(1, Math.ceil(n / 8));
  const r = 2.2 + 1.3 * Math.floor(i / 8);
  const inRing = Math.min(8, n - Math.floor(i / 8) * 8);
  const angle = ((i % 8) / inRing) * Math.PI * 2 + (ring > 1 ? Math.floor(i / 8) * 0.4 : 0);
  const local = (a: number, d: number) => place(room.center, room.facing, [Math.sin(a) * d, Math.cos(a) * d]);
  const pos = local(angle, r);
  let turn = angle;
  while (turn > Math.PI) turn -= Math.PI * 2;
  const steps = Math.ceil(Math.abs(turn) / (Math.PI / 6));
  const around = Array.from({ length: steps + 1 }, (_, k) => local((turn * k) / Math.max(1, steps), 1.5));
  const { out, inside } = doorway(room, 0);
  return { pos, facing: yawTo(pos, room.center), zone: "lounge", group: "lounge", approach: [out, inside, ...around] };
}

/**
 * The walls: every room's front, with its doorways left open, and the sides between rooms; round
 * them the outside wall, with the front door. Rooms' backs are the outside wall.
 */
function walls(rooms: Room[], outline: Rect, frontDoor: { x: number; width: number }): Wall[] {
  const out: Wall[] = [];
  const seen = new Set<string>();
  const key = (p: Vec2) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
  const add = (a: Vec2, b: Vec2, kind: Wall["kind"]) => {
    const k = [key(a), key(b)].sort().join("|");
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ a, b, kind });
  };
  // Meeting rooms first, so a wall one shares is glass.
  for (const room of [...rooms].sort((p, q) => Number(q.kind === "meeting") - Number(p.kind === "meeting"))) {
    const [hw, hd] = room.half;
    const kind = room.kind === "meeting" ? "glass" : "planter";
    const at = (x: number, z: number) => place(room.center, room.facing, [x, z]);
    for (const [from, to] of gaps(-hw, hw, room.doors.map((d) => [d - DOOR_WIDTH / 2, d + DOOR_WIDTH / 2]))) add(at(from, hd), at(to, hd), kind);
    add(at(-hw, -hd), at(-hw, hd), kind);
    add(at(hw, -hd), at(hw, hd), kind);
  }
  const { minX, maxX, minZ, maxZ } = outline;
  add([minX, minZ], [maxX, minZ], "outer");
  add([maxX, minZ], [maxX, maxZ], "outer");
  add([minX, minZ], [minX, maxZ], "outer");
  for (const [from, to] of gaps(minX, maxX, [[frontDoor.x - frontDoor.width / 2, frontDoor.x + frontDoor.width / 2]])) add([from, maxZ], [to, maxZ], "outer");
  return out;
}

/** What is left of a run from a to b once the openings are cut out; slivers shorter than a hand are left out too. */
function gaps(a: number, b: number, openings: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let at = a;
  for (const [from, to] of [...openings].sort((p, q) => p[0] - q[0])) {
    if (from - at > 0.15) out.push([at, Math.max(at, from)]);
    at = Math.max(at, to);
  }
  if (b - at > 0.15) out.push([at, b]);
  return out;
}

/** The nearest point on a rectangle's edge. */
export function onEdge(r: Rect, [x, z]: Vec2): Vec2 {
  const inside = x > r.minX && x < r.maxX && z > r.minZ && z < r.maxZ;
  if (!inside) return [Math.min(r.maxX, Math.max(r.minX, x)), Math.min(r.maxZ, Math.max(r.minZ, z))];
  const options: Vec2[] = [[r.minX, z], [r.maxX, z], [x, r.minZ], [x, r.maxZ]];
  return options.reduce((best, p) => (distance(p, [x, z]) < distance(best, [x, z]) ? p : best));
}

/** How far along a rectangle's edge a point on it is, clockwise from its north-west corner as seen from above. */
function along(r: Rect, [x, z]: Vec2): number {
  const w = r.maxX - r.minX;
  const h = r.maxZ - r.minZ;
  const e = 1e-6;
  if (Math.abs(z - r.minZ) < e) return x - r.minX;
  if (Math.abs(x - r.maxX) < e) return w + (z - r.minZ);
  if (Math.abs(z - r.maxZ) < e) return w + h + (r.maxX - x);
  return 2 * w + h + (r.maxZ - z);
}

/** Along a rectangle's edge from near one point to near another, the short way round, turning at its corners. */
export function aroundEdge(r: Rect, from: Vec2, to: Vec2): Vec2[] {
  const a = onEdge(r, from);
  const b = onEdge(r, to);
  const w = r.maxX - r.minX;
  const h = r.maxZ - r.minZ;
  const total = 2 * (w + h);
  const ta = along(r, a);
  const ahead = (along(r, b) - ta + total) % total;
  const forward = ahead <= total - ahead;
  const corners: Array<[Vec2, number]> = [[[r.minX, r.minZ], 0], [[r.maxX, r.minZ], w], [[r.maxX, r.maxZ], w + h], [[r.minX, r.maxZ], 2 * w + h]];
  const passed = corners
    .map(([p, t]) => [p, forward ? (t - ta + total) % total : (ta - t + total) % total] as const)
    .filter(([, d]) => d > 1e-6 && d < (forward ? ahead : total - ahead) - 1e-6)
    .sort((p, q) => p[1] - q[1])
    .map(([p]) => p);
  return [a, ...passed, b];
}

const distance = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * The waypoints from where an avatar is to its new spot in the building: out of its room by its
 * door to the walkway, round the hall along it, and in by the new spot's approach. Moves inside
 * one room stay inside it; moves in the line go straight there.
 */
export function buildingRoute(plan: BuildingPlan, from: Vec2, fromSpot: Spot | null, to: Spot): Vec2[] {
  if (fromSpot && fromSpot.group === to.group) {
    if (to.zone === "queue" || to.zone === "caller") return [to.pos];
    return [...fromSpot.approach.slice(1).reverse(), ...to.approach.slice(1), to.pos];
  }
  const leave = fromSpot ? [...fromSpot.approach].reverse() : [];
  const exit = leave.at(-1) ?? from;
  const entry = to.approach[0] ?? to.pos;
  return [...leave, ...aroundEdge(plan.loop, exit, entry), ...to.approach, to.pos];
}

export type RouteFn = (from: Vec2, fromSpot: Spot | null, to: Spot) => Vec2[];

export const isBuilding = (plan: OfficePlan): plan is BuildingPlan => (plan as Partial<BuildingPlan>).layout === "building";

/** How to walk in this plan's office. */
export const routeIn = (plan: OfficePlan): RouteFn => (isBuilding(plan) ? (from, fromSpot, to) => buildingRoute(plan, from, fromSpot, to) : route);

/** Where to stand to look into a team's place: out in the hall in front of its glass, or in front of its corner. */
export function viewIn(plan: OfficePlan, corner: Corner): { pos: Vec2; yaw: number } {
  if (!isBuilding(plan)) return viewOf(corner);
  const room = plan.rooms.find((r) => r.teamId === corner.team.id)!;
  return { pos: place(room.center, room.facing, [0, room.half[1] + 7]), yaw: -room.facing };
}

/**
 * The floor path each team's finished work takes to the team it hands to: out of a door of its
 * bay, round the hall along the lane just inside the walkway, and in by a door of the other.
 */
export function buildingPipelines(plan: BuildingPlan): Array<{ fromTeamId: string; toTeamId: string; path: Vec2[] }> {
  const byTeam = new Map(plan.rooms.filter((r) => r.teamId).map((r) => [r.teamId!, r]));
  return plan.corners.flatMap(({ team }) => {
    const from = byTeam.get(team.id)!;
    const to = team.handsTo ? byTeam.get(team.handsTo) : undefined;
    if (!to || to === from) return [];
    const ends = (room: Room) => room.doors.map((x) => ({ inside: doorway(room, x).inside, lane: place(room.center, room.facing, [x, room.half[1] + LANE_INSET]) }));
    const options = ends(from).flatMap((a) => ends(to).map((b) => [a.inside, a.lane, ...aroundEdge(plan.lane, a.lane, b.lane), b.lane, b.inside]));
    const length = (p: Vec2[]) => p.slice(1).reduce((s, q, i) => s + distance(p[i]!, q), 0);
    const path = options.reduce((best, p) => (length(p) < length(best) ? p : best));
    return [{ fromTeamId: team.id, toTeamId: to.teamId!, path }];
  });
}

/** The layout this browser last chose; the ring when it has not chosen or cannot say. */
export function savedLayout(): Layout {
  try {
    return globalThis.localStorage?.getItem(LAYOUT_KEY) === "building" ? "building" : "ring";
  } catch {
    return "ring";
  }
}

export function saveLayout(layout: Layout): void {
  try {
    globalThis.localStorage?.setItem(LAYOUT_KEY, layout);
  } catch {
    // Private windows and blocked storage: the choice holds until the office closes.
  }
}

const LAYOUT_KEY = "review-inbox.office-layout";
