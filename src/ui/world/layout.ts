// Where everything stands in the office. Pure: from the world state and the queue order it
// returns each agent's spot, the furniture each team's corner needs, and the walking route
// between two spots. Coordinates are metres on the floor as [x, z]; north is -z.
//
//   north   a corner per project and standing team, in a grid (3 per row)
//   ─────   the corridor everyone walks along
//   south   the lounge (west) · your desk with its queue (centre)

import type { Team, WorldAgent } from "../../shared/types.ts";

export type Vec2 = [number, number];

export type Zone = "team" | "queue" | "lounge";

export interface Spot {
  pos: Vec2;
  /** Yaw the avatar faces when it has arrived (0 faces south, towards you). */
  facing: number;
  zone: Zone;
  /** Spots sharing a group are reached from each other directly: same corner, same line. */
  group: string;
  /** Waypoints from the corridor to the spot, in walking order. */
  approach: Vec2[];
}

export interface Desk {
  pos: Vec2;
  facing: number;
  kind: "console" | "lead";
  occupantId: string | null;
}

export interface Corner {
  team: Team;
  center: Vec2;
  desks: Desk[];
  members: WorldAgent[];
}

export interface OfficePlan {
  corners: Corner[];
  spots: Map<string, Spot>;
  queue: string[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

export const CORRIDOR_Z = 1.4;
export const DESK: Vec2 = [0, 10.4];
export const QUEUE_FRONT: Vec2 = [0, 9.2];
export const QUEUE_SIDE_X = -2.4;
export const QUEUE_ROW = 6;
/** Each place in line steps sideways a little, so from your desk you see past the person in front. */
export const QUEUE_SLANT = 0.8;
export const LOUNGE_CENTER: Vec2 = [-14, 7.5];
export const SPAWN: Vec2 = [0, 13.7];
export const ENTRANCE: Vec2 = [-6, 13.5];

/** The first team sits straight ahead of your desk, the next ones to either side. */
const CORNER_COLUMNS = [0, -13, 13];
const CORNER_FIRST_Z = -6.5;
const CORNER_PITCH = 12;
const CORNER_HALF_DEPTH = 4.6;
const CREW_PITCH = 1.7;
const CREW_PER_ROW = 5;

/** Facing from a point towards another. */
export const yawTo = (from: Vec2, to: Vec2): number => Math.atan2(to[0] - from[0], to[1] - from[1]);
const NORTH = Math.PI;

export function planOffice(agents: WorldAgent[], teams: Team[], queue: string[]): OfficePlan {
  const spots = new Map<string, Spot>();
  const corners = teams.map((team, i) => {
    const center: Vec2 = [CORNER_COLUMNS[i % CORNER_COLUMNS.length]!, CORNER_FIRST_Z - CORNER_PITCH * Math.floor(i / CORNER_COLUMNS.length)];
    const members = agents.filter((a) => a.teamId === team.id);
    const corner = controlRoom(team, center, members);
    for (const [id, spot] of corner.seats) spots.set(id, spot);
    return { team, center, desks: corner.desks, members };
  });

  const queued = new Set(queue);
  queue.forEach((id, i) => spots.set(id, queueSpot(i)));

  const lounging = agents.filter((a) => !queued.has(a.id) && !spots.has(a.id));
  lounging.forEach((a, i) => spots.set(a.id, loungeSpot(i, lounging.length)));

  const rows = Math.max(1, Math.ceil(teams.length / CORNER_COLUMNS.length));
  return {
    corners,
    spots,
    queue,
    bounds: { minX: -22, maxX: 22, minZ: CORNER_FIRST_Z - CORNER_PITCH * (rows - 1) - 7, maxZ: 14.5 },
  };
}

/** The lead (a project's first mate) at the back and the crew in rows facing the big screen, like a flight control room. */
function controlRoom(team: Team, [cx, cz]: Vec2, members: WorldAgent[]) {
  const lead = members.find((m) => m.role === "lead") ?? null;
  const crew = members.filter((m) => m !== lead);
  const seats: Array<[string, Spot]> = [];
  const desks: Desk[] = [];
  const aisleZ = cz + CORNER_HALF_DEPTH - 0.3;
  const shown = Math.max(3, crew.length);
  for (let i = 0; i < shown; i++) {
    const row = Math.floor(i / CREW_PER_ROW);
    const inRow = Math.min(CREW_PER_ROW, shown - row * CREW_PER_ROW);
    const x = cx + (i % CREW_PER_ROW - (inRow - 1) / 2) * CREW_PITCH;
    const deskZ = cz - 1.9 + row * 1.9;
    const occupant = crew[i] ?? null;
    desks.push({ pos: [x, deskZ], facing: NORTH, kind: "console", occupantId: occupant?.id ?? null });
    if (occupant) seats.push([occupant.id, { pos: [x, deskZ + 0.75], facing: NORTH, zone: "team", group: team.id, approach: [[x, aisleZ]] }]);
  }
  const leadZ = cz + 2.3;
  desks.push({ pos: [cx, leadZ], facing: NORTH, kind: "lead", occupantId: lead?.id ?? null });
  if (lead) seats.push([lead.id, { pos: [cx, leadZ + 0.75], facing: NORTH, zone: "team", group: team.id, approach: [[cx, aisleZ]] }]);
  return { seats, desks };
}

/** The line at your desk: the front faces you, later arrivals queue behind towards the corridor. */
export function queueSpot(i: number): Spot {
  const column = Math.floor(i / QUEUE_ROW);
  const row = i % QUEUE_ROW;
  const pos: Vec2 = [QUEUE_FRONT[0] + QUEUE_SLANT * row - 1.3 * column, QUEUE_FRONT[1] - 1.05 * row];
  // Arrive and leave along the side lane, so nobody walks through the people in line.
  return { pos, facing: 0, zone: "queue", group: "queue", approach: [[QUEUE_SIDE_X, pos[1]]] };
}

function loungeSpot(i: number, n: number): Spot {
  const ring = Math.max(1, Math.ceil(n / 8));
  const r = 2.2 + 1.3 * Math.floor(i / 8);
  const inRing = Math.min(8, n - Math.floor(i / 8) * 8);
  const angle = ((i % 8) / inRing) * Math.PI * 2 + (ring > 1 ? Math.floor(i / 8) * 0.4 : 0);
  const pos: Vec2 = [LOUNGE_CENTER[0] + Math.sin(angle) * r, LOUNGE_CENTER[1] + Math.cos(angle) * r];
  return { pos, facing: yawTo(pos, LOUNGE_CENTER), zone: "lounge", group: "lounge", approach: [] };
}

/**
 * The waypoints from where an avatar is to its new spot: out of its old place, along the
 * corridor, and in by the new spot's approach. Moves inside one group go straight there.
 */
export function route(from: Vec2, fromSpot: Spot | null, to: Spot): Vec2[] {
  if (fromSpot && fromSpot.group === to.group) return [to.pos];
  const leave = fromSpot ? [...fromSpot.approach].reverse() : [];
  const exit = leave.at(-1) ?? from;
  const entry = to.approach[0] ?? to.pos;
  return [...leave, [exit[0], CORRIDOR_Z], [entry[0], CORRIDOR_Z], ...to.approach, to.pos];
}

/**
 * The floor path each team's finished work takes to the team it hands to: out of its corner,
 * along the corridor, and into the other corner.
 */
export function pipelines(plan: OfficePlan): Array<{ fromTeamId: string; toTeamId: string; path: Vec2[] }> {
  const at = new Map(plan.corners.map((c) => [c.team.id, c.center]));
  return plan.corners.flatMap(({ team, center: [cx, cz] }) => {
    const to = team.handsTo ? at.get(team.handsTo) : undefined;
    if (!team.handsTo || !to) return [];
    const [tx, tz] = to;
    // Beside each corner's aisle, so the arrows do not run under people walking in.
    const lane = CORRIDOR_Z - 0.55;
    const out = cx + (tx > cx ? 1.2 : -1.2);
    const into = tx + (tx > cx ? -1.2 : 1.2);
    const path: Vec2[] = [[out, cz + CORNER_HALF_DEPTH], [out, lane], [into, lane], [into, tz + CORNER_HALF_DEPTH]];
    return [{ fromTeamId: team.id, toTeamId: team.handsTo, path }];
  });
}

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
