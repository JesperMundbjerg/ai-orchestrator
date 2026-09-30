// Where everything stands in the office. Pure: from the world state and the queue order it
// returns each agent's spot, the furniture each team's corner needs, and the walking route
// between two spots. Coordinates are metres on the floor as [x, z], with your desk at the
// origin; north (-z) is straight ahead of you.
//
//   centre   your desk, the line in front of it (north) and, on your side of it, whoever came
//            over to talk to you
//   path     a walkway circling the desk, between it and the corners
//   ring     a corner per project and standing team, each facing the desk; the first straight
//            ahead, the next ones alternately right and left, then the lounge. Corners stand
//            side by side from the front until the ring is full; after that it widens just
//            enough for everyone to fit, so all corners stay about as close to you.

import type { Team, WorldAgent } from "../../shared/types.ts";

export type Vec2 = [number, number];

export type Zone = "team" | "queue" | "lounge" | "caller" | "garden";

export type Pose = "look" | "pick" | "watch" | "chat" | "stretch";

export interface Spot {
  pos: Vec2;
  /** Yaw the avatar faces when it has arrived (0 faces south, towards you). */
  facing: number;
  zone: Zone;
  /** Spots sharing a group are reached from each other directly: same corner, same line. */
  group: string;
  /** Waypoints from the path around the desk to the spot, in walking order. */
  approach: Vec2[];
  /** Sitting down once there, on a bench. */
  sit?: boolean;
  /** Once there, standing in the garden: looking up at a tree, picking a flower, watching the ducks, chatting or stretching. */
  pose?: Pose;
  /** A stroll: once there, round these waypoints and back to the spot, again and again. */
  stroll?: Vec2[];
}

/** A member's place in their team's room: a craft station stands there (crafts.ts), its person in front of it, facing it. */
export interface Desk {
  pos: Vec2;
  facing: number;
  kind: "console" | "lead";
  /** 1 for a desk at full size; a big team's console desks are smaller (see crewGrid). */
  scale: number;
  occupantId: string | null;
}

export interface Corner {
  team: Team;
  center: Vec2;
  /** The way the corner is turned: its open side, and the crew's backs, face your desk. */
  facing: number;
  desks: Desk[];
  members: WorldAgent[];
}

export interface OfficePlan {
  corners: Corner[];
  lounge: { center: Vec2; facing: number };
  /** How far the corners' centres are from your desk, and the path around it. */
  ring: number;
  path: number;
  /** Where someone new walks in from: the path in front of the lounge. */
  entrance: Vec2;
  spots: Map<string, Spot>;
  queue: string[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

export const DESK: Vec2 = [0, 0];
export const QUEUE_FRONT: Vec2 = [0, -1.2];
export const QUEUE_SIDE_X = -2.4;
export const QUEUE_ROW = 6;
/** Each place in line steps sideways a little, so from your desk you see past the person in front. */
export const QUEUE_SLANT = 0.8;
/** Where the side lane to the line starts, coming in from the path. */
const QUEUE_HEAD: Vec2 = [QUEUE_SIDE_X, QUEUE_FRONT[1] - 1.05 * (QUEUE_ROW - 1) - 0.8];
export const SPAWN: Vec2 = [0, 3.3];
/** Where "Your desk" puts you: just behind your chair, facing north. */
export const YOUR_VIEW: Vec2 = [SPAWN[0], SPAWN[1] + 5.5];

/** A corner is this wide and deep (the lounge fits the same space), with a metre between corners. */
export const CORNER_HALF_WIDTH = 4.7;
export const CORNER_HALF_DEPTH = 4.5;
const CORNER_GAP = 1;
/** The path runs this far inside the corners' open sides, and never closer to the desk than PATH_MIN (clear of the line). */
const PATH_INSET = 1.4;
const PATH_MIN = 8.6;
const CREW_PITCH = 1.7;
const CREW_PER_ROW = 5;

/** Facing from a point towards another. */
export const yawTo = (from: Vec2, to: Vec2): number => Math.atan2(to[0] - from[0], to[1] - from[1]);
const NORTH = Math.PI;

/** A point given in a corner's own frame (+z towards your desk), on the floor. */
const place = (center: Vec2, facing: number, [x, z]: Vec2): Vec2 =>
  [center[0] + x * Math.cos(facing) + z * Math.sin(facing), center[1] - x * Math.sin(facing) + z * Math.cos(facing)];

/** Ahead of you is angle 0, to your right positive. */
const onCircle = (r: number, angle: number): Vec2 => [DESK[0] + r * Math.sin(angle), DESK[1] - r * Math.cos(angle)];
const angleOf = ([x, z]: Vec2) => Math.atan2(x - DESK[0], DESK[1] - z);
const distance = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** The i-th place on the ring counted from straight ahead: 0, then +1, -1, +2, -2… steps to the right and left. */
const slot = (i: number) => (i % 2 ? (i + 1) / 2 : -i / 2);

/**
 * How far out the corners stand for this many places on the ring (teams and the lounge), and
 * the angle between neighbours. Up to what fits at the smallest ring they stand side by side,
 * so a new team takes the next place without moving anyone; beyond that the ring widens until
 * all of them fit evenly spaced.
 */
export function ringFor(places: number): { radius: number; step: number } {
  const half = CORNER_HALF_WIDTH + CORNER_GAP / 2;
  const smallest = PATH_MIN + PATH_INSET + CORNER_HALF_DEPTH;
  const packed = 2 * Math.atan(half / (smallest - CORNER_HALF_DEPTH));
  if (places * packed <= Math.PI * 2) return { radius: smallest, step: packed };
  const step = (Math.PI * 2) / places;
  return { radius: half / Math.tan(step / 2) + CORNER_HALF_DEPTH, step };
}

export function planOffice(agents: WorldAgent[], teams: Team[], queue: string[]): OfficePlan {
  const { radius, step } = ringFor(teams.length + 1);
  const path = radius - CORNER_HALF_DEPTH - PATH_INSET;
  const at = (i: number) => {
    const center = onCircle(radius, slot(i) * step);
    return { center, facing: yawTo(center, DESK), door: onCircle(path, slot(i) * step) };
  };

  const spots = new Map<string, Spot>();
  const corners = teams.map((team, i) => {
    const { center, facing, door } = at(i);
    const members = agents.filter((a) => a.teamId === team.id);
    const corner = controlRoom(team, center, facing, door, members);
    for (const [id, spot] of corner.seats) spots.set(id, spot);
    return { team, center, facing, desks: corner.desks, members };
  });

  const queued = new Set(queue);
  queue.forEach((id, i) => spots.set(id, queueSpot(i)));

  const lounge = at(teams.length);
  const lounging = agents.filter((a) => !queued.has(a.id) && !spots.has(a.id));
  lounging.forEach((a, i) => spots.set(a.id, loungeSpot(i, lounging.length, lounge.center, lounge.facing, lounge.door)));

  const edge = radius + CORNER_HALF_DEPTH + 2;
  return {
    corners,
    lounge: { center: lounge.center, facing: lounge.facing },
    ring: radius,
    path,
    entrance: lounge.door,
    spots,
    queue,
    bounds: { minX: DESK[0] - edge, maxX: DESK[0] + edge, minZ: DESK[1] - edge, maxZ: DESK[1] + edge },
  };
}

/** A desk's top as seen from above, in metres (across, deep). A crowded team's console desks shrink by Desk.scale. */
export const DESK_SIZE: Record<Desk["kind"], Vec2> = { console: [1.4, 0.7], lead: [2, 0.7] };
const LEAD_DESK_Z = 2.3;

export interface CrewGrid {
  /** How much the console desks and the spacing between them shrink; 1 up to ten crew. */
  scale: number;
  perRow: number;
  /** Across and between rows, and the first row's place, in the corner's frame. */
  pitch: number;
  rowGap: number;
  firstZ: number;
}

/** The widest row of desks: five at today's pitch. The side lanes run outside it. */
const ROW_SPAN = 4 * CREW_PITCH + DESK_SIZE.console[0];
/** The lane behind the last row stays clear of the lead's desk. */
const LANE_LIMIT = LEAD_DESK_Z - DESK_SIZE.lead[1] / 2 - 0.2;

/** What a scale gives room for: desks per row, and rows from just in front of the screen to the lead's desk. */
function gridAt(scale: number): CrewGrid & { rows: number } {
  const pitch = CREW_PITCH * scale;
  const firstZ = -3.55 + 0.35 * scale;
  const rowGap = 1.9 * scale;
  const perRow = Math.floor((ROW_SPAN - DESK_SIZE.console[0] * scale) / pitch + 1e-9) + 1;
  const rows = Math.floor((LANE_LIMIT - 1.25 * scale - firstZ) / rowGap + 1e-9) + 1;
  return { scale, perRow, pitch, rowGap, firstZ, rows };
}

/**
 * Where n console desks go. Up to ten, as ever: rows of five, at full size. Beyond that the
 * desks shrink together, and the rows tighten, just enough to fit every desk in the corner, so
 * a team can be any size; more rows are filled evenly.
 */
export function crewGrid(n: number): CrewGrid {
  if (n <= 2 * CREW_PER_ROW) return { scale: 1, perRow: CREW_PER_ROW, pitch: CREW_PITCH, rowGap: 1.9, firstZ: -1.9 };
  let scale = 0.99;
  let grid = gridAt(scale);
  while (grid.perRow * grid.rows < n && scale > 0.02) grid = gridAt((scale = Math.round((scale - 0.01) * 100) / 100));
  const { scale: fit, pitch, rowGap, firstZ } = grid;
  return { scale: fit, perRow: Math.ceil(n / Math.ceil(n / grid.perRow)), pitch, rowGap, firstZ };
}

/**
 * The lead (a project's first mate) at the back and the crew in rows facing the big screen, like
 * a flight control room. Laid out in the corner's own frame, the screen away from your desk.
 */
function controlRoom(team: Team, center: Vec2, facing: number, door: Vec2, members: WorldAgent[]) {
  const lead = members.find((m) => m.role === "lead") ?? null;
  const crew = members.filter((m) => m !== lead);
  const seats: Array<[string, Spot]> = [];
  const desks: Desk[] = [];
  const at = (x: number, z: number) => place(center, facing, [x, z]);
  const seat = (id: string, pos: Vec2, approach: Vec2[]) => seats.push([id, { pos, facing: facing + NORTH, zone: "team", group: team.id, approach: [door, ...approach] }]);
  const aisle = CORNER_HALF_DEPTH - 0.2;
  const shown = Math.max(3, crew.length);
  const grid = crewGrid(shown);
  const k = grid.scale;
  for (let i = 0; i < shown; i++) {
    const row = Math.floor(i / grid.perRow);
    const inRow = Math.min(grid.perRow, shown - row * grid.perRow);
    const x = (i % grid.perRow - (inRow - 1) / 2) * grid.pitch;
    const deskZ = grid.firstZ + row * grid.rowGap;
    const occupant = crew[i] ?? null;
    desks.push({ pos: at(x, deskZ), facing: facing + NORTH, kind: "console", scale: k, occupantId: occupant?.id ?? null });
    // Crew come in down the side of the room and along the gap behind their row's chairs, so
    // they pass neither the lead's desk nor anyone sitting down.
    const side = (x > 0 ? 1 : -1) * (CORNER_HALF_WIDTH - 0.3);
    const lane = deskZ + 1.25 * k;
    if (occupant) seat(occupant.id, at(x, deskZ + 0.75 * k), [at(side, aisle), at(side, lane), at(x, lane)]);
  }
  desks.push({ pos: at(0, LEAD_DESK_Z), facing: facing + NORTH, kind: "lead", scale: 1, occupantId: lead?.id ?? null });
  if (lead) seat(lead.id, at(0, 3.05), [at(0, aisle)]);
  return { seats, desks };
}

/** Where to stand to look at a corner: inside the path, in front of its open side. */
export function viewOf(corner: Corner): { pos: Vec2; yaw: number } {
  const pos = place(corner.center, corner.facing, [0, CORNER_HALF_DEPTH + 4]);
  // The player's yaw counts from north the other way round from an avatar's facing.
  return { pos, yaw: -corner.facing };
}

/** The line at your desk: the front faces you, later arrivals queue behind towards the path. */
export function queueSpot(i: number): Spot {
  const column = Math.floor(i / QUEUE_ROW);
  const row = i % QUEUE_ROW;
  const pos: Vec2 = [QUEUE_FRONT[0] + QUEUE_SLANT * row - 1.3 * column, QUEUE_FRONT[1] - 1.05 * row];
  // Arrive and leave along the side lane, so nobody walks through the people in line.
  return { pos, facing: 0, zone: "queue", group: "queue", approach: [QUEUE_HEAD, [QUEUE_SIDE_X, pos[1]]] };
}

/** Where a lead stands when they came to your desk: on your side of it, to the left of you, facing you. */
export const CALLER: Vec2 = [-1.2, DESK[1] + 1];
const CALLER_PITCH = 1.1;

/**
 * The i-th lead who came over to you. They come in from the west, beside the side lane, so they
 * pass neither the desk nor the line in front of it, and stand side by side where you can see them.
 */
export function callerSpot(i: number): Spot {
  const pos: Vec2 = [CALLER[0] - CALLER_PITCH * i, CALLER[1] - 0.2 * i];
  return { pos, facing: yawTo(pos, SPAWN), zone: "caller", group: "caller", approach: [[QUEUE_SIDE_X - 0.6, DESK[1]]] };
}

/** The lounge's table, and the sofas round it; the side facing your desk is open. */
export const LOUNGE_TABLE = 0.8;
export const LOUNGE_SOFAS = [Math.PI / 3, Math.PI, (5 * Math.PI) / 3];

/** Around the lounge's table, facing it. In through the open side, and round the table inside the circle of chairs. */
function loungeSpot(i: number, n: number, center: Vec2, facing: number, door: Vec2): Spot {
  const ring = Math.max(1, Math.ceil(n / 8));
  const r = 2.2 + 1.3 * Math.floor(i / 8);
  const inRing = Math.min(8, n - Math.floor(i / 8) * 8);
  const angle = ((i % 8) / inRing) * Math.PI * 2 + (ring > 1 ? Math.floor(i / 8) * 0.4 : 0);
  const local = (a: number, d: number) => place(center, facing, [Math.sin(a) * d, Math.cos(a) * d]);
  const pos = local(angle, r);
  let turn = angle;
  while (turn > Math.PI) turn -= Math.PI * 2;
  const steps = Math.ceil(Math.abs(turn) / (Math.PI / 6));
  const around = Array.from({ length: steps + 1 }, (_, k) => local((turn * k) / Math.max(1, steps), 1.5));
  return { pos, facing: yawTo(pos, center), zone: "lounge", group: "lounge", approach: [door, local(0, 3), ...around] };
}

/** Points along the circle around the desk from one angle to another, the short way round. */
function arc(r: number, from: number, to: number): Vec2[] {
  let turn = to - from;
  while (turn > Math.PI) turn -= Math.PI * 2;
  while (turn < -Math.PI) turn += Math.PI * 2;
  const steps = Math.ceil(Math.abs(turn) / (Math.PI / 12));
  return Array.from({ length: steps + 1 }, (_, k) => onCircle(r, from + (turn * k) / Math.max(1, steps)));
}

/**
 * The waypoints from where an avatar is to its new spot: out of its old place to the path,
 * round the desk along it, and in by the new spot's approach. Moves inside one corner or the
 * lounge stay off the path; moves in the line go straight there. From the line or the desk, whichever is closer in, the walk first steps out
 * to the path and back in at the other end.
 */
export function route(from: Vec2, fromSpot: Spot | null, to: Spot): Vec2[] {
  if (fromSpot && fromSpot.group === to.group) {
    // In a corner or the lounge, out to where the two ways in meet and in again; in the line, straight on.
    if (to.zone === "queue" || to.zone === "caller") return [to.pos];
    return [...fromSpot.approach.slice(1).reverse(), ...to.approach.slice(1), to.pos];
  }
  const leave = fromSpot ? [...fromSpot.approach].reverse() : [];
  const exit = leave.at(-1) ?? from;
  const entry = to.approach[0] ?? to.pos;
  const r = Math.max(distance(exit, DESK), distance(entry, DESK));
  const around = arc(r, angleOf(exit), angleOf(entry)).filter((p) => distance(p, exit) > 0.05 && distance(p, entry) > 0.05);
  return [...leave, ...around, ...to.approach, to.pos];
}

/**
 * The floor path each team's finished work takes to the team it hands to: out of its corner,
 * round the desk just outside the walkway, and into the other corner.
 */
export function pipelines(plan: OfficePlan): Array<{ fromTeamId: string; toTeamId: string; path: Vec2[] }> {
  const at = new Map(plan.corners.map((c) => [c.team.id, c]));
  const lane = pipelineLane(plan);
  return plan.corners.flatMap((from) => {
    const to = from.team.handsTo ? at.get(from.team.handsTo) : undefined;
    if (!to || to === from) return [];
    let turn = angleOf(to.center) - angleOf(from.center);
    while (turn > Math.PI) turn -= Math.PI * 2;
    while (turn < -Math.PI) turn += Math.PI * 2;
    // Beside each corner's aisle, on the side it leaves towards, so the arrows do not run under people walking in.
    const side = turn > 0 ? -1.2 : 1.2;
    const out = place(from.center, from.facing, [side, CORNER_HALF_DEPTH]);
    const into = place(to.center, to.facing, [-side, CORNER_HALF_DEPTH]);
    const path: Vec2[] = [out, ...arc(lane, angleOf(out), angleOf(into)), into];
    return [{ fromTeamId: from.team.id, toTeamId: to.team.id, path }];
  });
}

/** The circle handed-over work follows: between the walkway and the corners. */
export const pipelineLane = (plan: OfficePlan) => plan.path + PATH_INSET * 0.55;

/** Agent ids in queue order, one place per agent however many items it waits with. */
export function queueOrder(agents: WorldAgent[], taskIdsInQueueOrder: string[]): string[] {
  const byTask = new Map(agents.flatMap((a) => a.taskIds.map((t) => [t, a.id] as const)));
  const out: string[] = [];
  for (const taskId of taskIdsInQueueOrder) {
    const id = byTask.get(taskId);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}
