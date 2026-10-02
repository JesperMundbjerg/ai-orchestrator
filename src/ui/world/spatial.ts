// Shared floor coordinates, places and measures for the building.
// Metres as [x, z], with the clearing at the origin and north (-z) ahead.
import type { Team, WorldAgent } from "../../shared/types.ts";
import type { GameSeat } from "./games.ts";

export type Vec2 = [number, number];
export type Zone = "team" | "queue" | "lounge" | "caller" | "garden" | "meeting";
export type Pose = "look" | "pick" | "watch" | "chat" | "stretch";

export interface Spot {
  pos: Vec2;
  /** Yaw the avatar faces when it has arrived (0 faces south, towards you). */
  facing: number;
  zone: Zone;
  /** Spots sharing a group are reached without leaving their room or gathering. */
  group: string;
  /** Waypoints from the hall's walkway to the spot, in walking order. */
  approach: Vec2[];
  /** Sitting down once there. */
  sit?: boolean;
  /** A deterministic lounge play, only while idle and at this spot. */
  game?: GameSeat;
  /** Standing in the garden: looking up, picking a flower, watching ducks, chatting or stretching. */
  pose?: Pose;
  /** Once there, stroll round these waypoints and back, again and again. */
  stroll?: Vec2[];
}

/** A member's place in their team's bay: a craft station, its person facing it. */
export interface Desk {
  pos: Vec2;
  facing: number;
  kind: "console" | "lead";
  scale: number;
  occupantId: string | null;
}

/** A team's furnished corner of the building. */
export interface Corner {
  team: Team;
  center: Vec2;
  /** Its open side faces the hall. */
  facing: number;
  desks: Desk[];
  members: WorldAgent[];
}

export const SPAWN: Vec2 = [0, 3.3];
/** The opening view, facing north across the clearing. */
export const CLEARING_VIEW: Vec2 = [SPAWN[0], SPAWN[1] + 5.5];
/** The first lead who comes over stands to your left. */
export const CALLER: Vec2 = [-1.2, 1];
/** Walls clear the corkboards; windows, glass and the door's head follow from this. */
export const WALL_H = 6.2;
/** A station's footprint, across and deep. */
export const DESK_SIZE: Record<Desk["kind"], Vec2> = { console: [1.4, 0.7], lead: [2, 0.7] };
/** Facing from a point towards another. */
export const yawTo = (from: Vec2, to: Vec2): number => Math.atan2(to[0] - from[0], to[1] - from[1]);

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
