/** Terrain-relative body height; flight never changes the player's horizontal navigation. */
export const FLIGHT_HEIGHT = 2.25;
const TAU = Math.PI * 2;
const unit = (value: number) => Math.max(0, Math.min(1, value));

/** One calm clock for hover, travel and Shift; movement never speeds up the wings. */
export function flapRate(_moving: number, _sprinting: boolean): number {
  return 1.7;
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
  const lens = Math.tan(Math.max(18, Math.min(80, fov)) * Math.PI / 360) / Math.tan(62 * Math.PI / 360);
  // 38% smaller, without pulling the silhouette back up into the sightline.
  return { distance: 3.2, drop: 0.55 * lens, scale: 0.62 * lens };
}

export interface FlightPose {
  bob: number;
  flap: number;
  /** Wrist sweep, mirrored by the mesh; zero is fully spread. */
  fold: number;
  lean: number;
}

/** Pure local mesh pose, in metres/radians. Camera and ground navigation never receive the bob. */
export function flightPose(seconds: number, phase: number, moving: number): FlightPose {
  const motion = unit(moving);
  const wave = Math.sin(seconds * TAU * 0.65);
  const cycle = ((phase / TAU) % 1 + 1) % 1;
  // Flight rests with spread wings for the last 28% of each beat. Smoothstep
  // brings the stroke to rest gently at both ends, including across phase wrap.
  const stroke = Math.min(1, cycle / 0.72);
  const cruise = Math.sin(TAU * stroke * stroke * (3 - 2 * stroke));
  const beat = Math.sin(phase) * (1 - motion) + cruise * motion;
  return {
    bob: wave * (0.065 + 0.075 * motion),
    flap: 0.08 + beat * (0.48 - 0.14 * motion),
    fold: 0.65 * Math.max(0, beat) ** 2,
    // The mesh faces -Z: a negative X rotation dips its beak forward.
    lean: motion * (-0.28 + wave * 0.045),
  };
}
