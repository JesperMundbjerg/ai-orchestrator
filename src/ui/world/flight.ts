/** Terrain-relative body height; flight never changes the player's horizontal navigation. */
export const FLIGHT_HEIGHT = 2.25;
const TAU = Math.PI * 2;
const unit = (value: number) => Math.max(0, Math.min(1, value));

/** Cycles/second. Hovering takes quicker beats than cruising; Shift adds effort in motion. */
export function flapRate(moving: number, sprinting: boolean): number {
  return 4.2 + ((sprinting ? 5.6 : 2.6) - 4.2) * unit(moving);
}

/** Integrate, rather than time * rate, so changing speed cannot jump the wings. */
export function advanceFlap(phase: number, seconds: number, moving: number, sprinting: boolean): number {
  return ((phase + Math.max(0, seconds) * TAU * flapRate(moving, sprinting)) % TAU + TAU) % TAU;
}

/** Frame-rate-independent easing into/out of the forward flight pose. */
export function flightMotion(current: number, moving: boolean, seconds: number): number {
  return unit(current) + (Number(moving) - unit(current)) * (1 - Math.exp(-8 * Math.max(0, seconds)));
}

/** Keep a close, below-centre silhouette even through the existing telephoto zoom.
 * Scale the presentation, not navigation or camera distance: the bird never drifts away.
 */
export function birdFraming(fov: number): { distance: number; drop: number; scale: number } {
  const scale = Math.tan(Math.max(18, Math.min(80, fov)) * Math.PI / 360) / Math.tan(62 * Math.PI / 360);
  return { distance: 3.2, drop: 0.55 * scale, scale };
}

export interface FlightPose {
  bob: number;
  flap: number;
  lean: number;
}

/** Pure local mesh pose, in metres/radians. Camera and ground navigation never receive the bob. */
export function flightPose(seconds: number, phase: number, moving: number): FlightPose {
  const motion = unit(moving);
  const wave = Math.sin(seconds * TAU * 0.65);
  return {
    bob: wave * (0.065 + 0.075 * motion),
    flap: 0.12 + Math.sin(phase) * (0.95 - 0.15 * motion),
    // The mesh faces -Z: a negative X rotation dips its beak forward.
    lean: motion * (-0.28 + wave * 0.045),
  };
}
