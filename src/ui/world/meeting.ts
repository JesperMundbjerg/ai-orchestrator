// Creative reviews are standing state, not message visits. One reviewer per room; existing
// occupants keep their room until finished, even when agents arrive or the world reorders.
import type { Work, WorldAgent } from "../../shared/types.ts";
import { isReviewHelper } from "../../shared/review.ts";
import { doorway, place, type BuildingPlan, type Room } from "./building.ts";
import type { Spot } from "./layout.ts";

export type Meetings = Map<string, number>;
export const meetingLength = (room: Room) => Math.max(2, Math.min(4.2, 2 * room.half[1] - 3.4));
export const reviewSeatZ = (room: Room) => -0.3 - meetingLength(room) / 2 + 0.5 * meetingLength(room) / Math.max(2, Math.floor(meetingLength(room) / 0.9));

/** Pending work has no reviewerId until a verdict today: its receiving lead owns that review. */
export function reviewing(agents: WorldAgent[], work: Work[]): Set<string> {
  const pending = new Set(work.filter((w) => w.state === "in_review").map((w) => w.reviewerId ?? agents.find((a) => a.teamId === w.toTeamId && a.role === "lead")?.id));
  return new Set(agents.filter((a) => a.status !== "offline" && (a.helpers.some(isReviewHelper) || pending.has(a.id))).map((a) => a.id));
}

export function meetingSpot(room: Room, index: number): Spot {
  const door = doorway(room, 0);
  const at = (x: number, z: number) => place(room.center, room.facing, [x, z]);
  const z = reviewSeatZ(room);
  return { pos: at(-0.95, z), facing: room.facing + Math.PI / 2, zone: "meeting", group: `meeting:${index}`, sit: true,
    approach: [door.out, door.inside, at(-1.85, room.half[1] - 0.6), at(-1.85, z)] };
}

export function meetingPlan(plan: BuildingPlan, agents: WorldAgent[], work: Work[], before: ReadonlyMap<string, number> = new Map()): { plan: BuildingPlan; meetings: Meetings } {
  const rooms = plan.rooms.filter((r) => r.kind === "meeting");
  const who = reviewing(agents, work);
  for (const id of plan.queue) who.delete(id); // A founder answer takes precedence.
  const meetings: Meetings = new Map();
  const held = new Set<number>();
  for (const [id, room] of before) if (who.has(id) && rooms[room] && !held.has(room)) {
    meetings.set(id, room); held.add(room);
  }
  for (const id of [...who].sort()) {
    if (meetings.has(id)) continue;
    const free = rooms.findIndex((_, i) => !held.has(i));
    if (free < 0) break;
    meetings.set(id, free); held.add(free);
  }
  const spots = new Map(plan.spots);
  for (const [id, room] of meetings) spots.set(id, meetingSpot(rooms[room]!, room));
  return { plan: { ...plan, spots }, meetings };
}
