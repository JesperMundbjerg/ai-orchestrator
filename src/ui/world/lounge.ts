// Shared lounge furniture and seats, in room-local metres. Drawing and routing use the same plan.
import type { Spot, Vec2 } from "./layout.ts";
export const COUCHES = [-1.65, 1.65].map((z) => ({ pos: [-3.3, z] as Vec2, facing: Math.PI / 2, width: 2.4 }));
export const COFFEE: Vec2 = [-1.8, 0];
export const POOL: Vec2 = [0.2, -1];
export const DARTS: Vec2 = [3.1, 0.8];
export const localPlace = (center: Vec2, facing: number, [x,z]: Vec2): Vec2 => [center[0]+x*Math.cos(facing)+z*Math.sin(facing), center[1]-x*Math.sin(facing)+z*Math.cos(facing)];
export function loungeSeats(center: Vec2, facing: number, entry: Vec2[]): Spot[] {
  const at = (p: Vec2) => localPlace(center, facing, p);
  return COUCHES.flatMap((c) => [-0.55, 0.55].map((side): Spot => {
    const p = localPlace(c.pos, c.facing, [side, 0]);
    return { pos: at(p), facing: facing+c.facing, zone: "lounge", group: "lounge", sit: true,
      approach: [...entry, at([-1.05, 3.3]), at([-1.05, p[1]]), at([p[0]+0.75, p[1]])] };
  }));
}
