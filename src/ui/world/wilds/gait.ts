import type { Species } from './animals.ts';

/** One tiny upload per animal. Zero speed means planted legs/wings and no body hopping. */
export function gaitPose(kind: Species, phase: number, speed: number) {
  const strength = Math.min(1, Math.max(0, speed) / (kind === 'deer' ? 1.2 : .45));
  const hop = strength === 0 ? 0 : kind === 'rabbit' ? Math.max(0, Math.sin(phase)) * .22 * strength
    : kind === 'duck' ? Math.sin(phase * 2) * .025 * strength
    : kind === 'deer' ? (1 - Math.cos(phase * 2)) * .012 * strength : 0;
  return { phase, strength, hop };
}

/** Testable counterpart of the vertex shader: rotation round a fixed local limb pivot. */
export function limbAngle(phase: number, strength: number, amplitude: number, offset: number): number {
  return Math.sin(phase + offset) * strength * amplitude;
}
