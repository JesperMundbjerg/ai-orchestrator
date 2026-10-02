import type { Rect } from "../building.ts";
import { away, CHUNK, chunkAt, ground, hash, WATER } from "./land.ts";

export const MAX_ANIMALS = 12;
export const ANIMAL_RADIUS = 36;
export type Species = "deer" | "rabbit" | "duck" | "bird";
export interface Animal { id: string; kind: Species; x: number; z: number; y: number; yaw: number; homeX: number; homeZ: number; phase: number; fleeing: boolean }
/** Local candidates only. No global animal history; revisiting regenerates the same population. */
export function populate(previous: Animal[], x: number, z: number, office: Rect): Animal[] {
  const [cx, cz] = chunkAt(x, z), candidates: Animal[] = [];
  for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) for (let i = 0; i < 4; i++) {
    const gx = cx + dx, gz = cz + dz, id = `${gx},${gz}:${i}`;
    const px = (gx + hash(gx, gz, 400 + i * 3)) * CHUNK, pz = (gz + hash(gx, gz, 401 + i * 3)) * CHUNK;
    if (Math.hypot(px - x, pz - z) > ANIMAL_RADIUS - 5 || away(office, px, pz) < 8) continue;
    const y = ground(px, pz, office);
    const kind: Species = i === 3 ? "bird" : y < WATER - 0.15 ? "duck" : i % 2 ? "rabbit" : "deer";
    const old = previous.find((a) => a.id === id);
    const a = old ?? { id, kind, x: px, z: pz, y, yaw: 0, homeX: px, homeZ: pz, phase: hash(gx, gz, 402 + i * 3) * 6.28, fleeing: false };
    if (Math.hypot(a.x - x, a.z - z) < ANIMAL_RADIUS) candidates.push(a);
  }
  return candidates.sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z)).slice(0, MAX_ANIMALS);
}
/** A few animals alone move at the still rate. Never calls the pacer's moved/ambled hooks. */
export function stepAnimals(animals: Animal[], x: number, z: number, dt: number, office: Rect): void {
  const step = Math.min(dt, 0.22);
  for (const a of animals) {
    a.phase += step;
    const distance = Math.hypot(a.x - x, a.z - z);
    a.fleeing = distance < (a.kind === "deer" ? 7 : 4);
    const angle = a.fleeing ? Math.atan2(a.x - x, a.z - z) : Math.atan2(a.homeX + Math.sin(a.phase * 0.3) * 4 - a.x, a.homeZ + Math.cos(a.phase * 0.3) * 4 - a.z);
    const speed = a.fleeing ? (a.kind === "duck" ? 1.3 : 3.8) : a.kind === "bird" ? 1.8 : 0.45;
    const nx = a.x + Math.sin(angle) * speed * step, nz = a.z + Math.cos(angle) * speed * step, h = ground(nx, nz, office);
    const habitat = a.kind === "bird" || (a.kind === "duck" ? h < WATER - 0.08 : h > WATER + 0.12);
    if (habitat && away(office, nx, nz) > 6) { a.x = nx; a.z = nz; }
    a.yaw = angle;
    a.y = a.kind === "duck" ? WATER : ground(a.x, a.z, office) + (a.kind === "bird" ? 5 + Math.sin(a.phase) * 0.6 : 0);
  }
}
