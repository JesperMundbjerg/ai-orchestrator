// Fixed-seed, metre-space landscape. No renderer, clock, global cache or random state.
import type { Rect } from "../building.ts";

export const SEED = 0x51a7d;
export const CHUNK = 32;
export const GRID = 8;
export const RADIUS = 4;
export const MAX_CHUNKS = (RADIUS * 2 + 1) ** 2;
export const WATER = -0.8;
export type Lod = 0 | 1 | 2;
export type Kind = "pine" | "oak" | "rock" | "grass" | "shore";
export interface Place { kind: Kind; x: number; y: number; z: number; size: number; yaw: number }
export interface Chunk { key: string; x: number; z: number; positions: Float32Array; colors: Float32Array; places: Place[]; wet: boolean }
export interface Wanted { key: string; x: number; z: number; lod: Lod }
export const chunkKey = (x: number, z: number) => `${x},${z}`;
export const chunkAt = (x: number, z: number): [number, number] => [Math.floor(x / CHUNK), Math.floor(z / CHUNK)];
export const lodAt = (dx: number, dz: number): Lod => Math.max(Math.abs(dx), Math.abs(dz)) <= 1 ? 0 : Math.max(Math.abs(dx), Math.abs(dz)) <= 2 ? 1 : 2;
export const away = (r: Rect, x: number, z: number) => Math.hypot(Math.max(r.minX - x, 0, x - r.maxX), Math.max(r.minZ - z, 0, z - r.maxZ));
export function hash(x: number, z: number, salt = 0): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ SEED ^ Math.imul(salt, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const smooth = (t: number) => t * t * (3 - 2 * t);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
export function noise(x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z), u = smooth(x - ix), v = smooth(z - iz);
  return mix(mix(hash(ix, iz), hash(ix + 1, iz), u), mix(hash(ix, iz + 1), hash(ix + 1, iz + 1), u), v);
}
/** Flat under the existing floor/lawn, a broad soft transition beyond its edge. */
export function height(x: number, z: number, office: Rect): number {
  const blend = smooth(Math.min(1, Math.max(0, (away(office, x, z) - 4) / 24)));
  const hills = (noise(x / 105, z / 105) - 0.46) * 15 + (noise(x / 33 + 18, z / 33 - 9) - 0.5) * 2.2;
  return mix(-0.025, hills, blend);
}
/** Same triangle interpolation as the drawn mesh: feet and planting never float over a facet. */
export function ground(x: number, z: number, office: Rect): number {
  const step = CHUNK / GRID, gx = Math.floor(x / step) * step, gz = Math.floor(z / step) * step;
  const u = (x - gx) / step, v = (z - gz) / step;
  const a = height(gx, gz, office), b = height(gx + step, gz, office), c = height(gx, gz + step, office), d = height(gx + step, gz + step, office);
  return u + v <= 1 ? a + u * (b - a) + v * (c - a) : d + (1 - u) * (c - d) + (1 - v) * (b - d);
}
export const walkingHeight = (x: number, z: number, office: Rect) => Math.max(WATER, ground(x, z, office));

export function wanted(x: number, z: number): Wanted[] {
  const [cx, cz] = chunkAt(x, z);
  const out: Wanted[] = [];
  for (let dz = -RADIUS; dz <= RADIUS; dz++) for (let dx = -RADIUS; dx <= RADIUS; dx++) out.push({ key: chunkKey(cx + dx, cz + dz), x: cx + dx, z: cz + dz, lod: lodAt(dx, dz) });
  return out.sort((a, b) => Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b.x - cx, b.z - cz));
}

export function generate(cx: number, cz: number, office: Rect): Chunk {
  const positions: number[] = [], colors: number[] = [], places: Place[] = [];
  let wet = false;
  const step = CHUNK / GRID;
  for (let iz = 0; iz < GRID; iz++) for (let ix = 0; ix < GRID; ix++) {
    const x = cx * CHUNK + ix * step, z = cz * CHUNK + iz * step;
    const points = [[x, z], [x + step, z], [x, z + step], [x + step, z + step]];
    for (const tri of [[0, 2, 1], [1, 2, 3]]) {
      const ys = tri.map((i) => height(points[i]![0]!, points[i]![1]!, office));
      const avg = ys.reduce((a, b) => a + b, 0) / 3;
      wet ||= Math.min(...ys) < WATER;
      const tint = hash(cx * GRID + ix, cz * GRID + iz, tri[0]) * 0.035;
      // Linear-space colours: moss, dry meadow and a sandy strip meeting the water.
      const c = avg < WATER + 0.5 ? [0.36, 0.32, 0.19] : [0.22, 0.34, 0.13];
      tri.forEach((p, i) => { positions.push(points[p]![0]! - cx * CHUNK, ys[i]!, points[p]![1]! - cz * CHUNK); colors.push(...c.map((v) => v + tint)); });
    }
  }
  // A jittered lattice keeps trees apart across chunk seams; other kinds use separate salts.
  for (let i = 0; i < 80; i++) {
    const x = cx * CHUNK + (i < 16 ? ((i % 4) + 0.2 + hash(cx, cz, i * 5) * 0.6) * 8 : hash(cx, cz, i * 5) * CHUNK);
    const z = cz * CHUNK + (i < 16 ? (Math.floor(i / 4) + 0.2 + hash(cx, cz, i * 5 + 1) * 0.6) * 8 : hash(cx, cz, i * 5 + 1) * CHUNK);
    if (away(office, x, z) < 7) continue;
    const y = ground(x, z, office), s = hash(cx, cz, i * 5 + 2);
    const kind: Kind = i < 16 ? (s < 0.55 ? "pine" : "oak") : i < 24 ? "rock" : y < WATER + 0.55 ? "shore" : "grass";
    if (y < WATER + (kind === "shore" ? -0.15 : 0.2)) continue;
    places.push({ kind, x, y, z, size: 0.7 + s * 0.8, yaw: hash(cx, cz, i * 5 + 3) * Math.PI * 2 });
  }
  return { key: chunkKey(cx, cz), x: cx, z: cz, positions: new Float32Array(positions), colors: new Float32Array(colors), places, wet };
}

/** The entire resident set and work list. Replacement, not an ever-growing visited cache. */
export class Stream {
  chunks = new Map<string, Chunk>();
  desired: Wanted[] = [];
  private center = "";
  move(x: number, z: number): boolean {
    const key = chunkKey(...chunkAt(x, z));
    if (key === this.center) return false;
    this.center = key;
    this.desired = wanted(x, z);
    const keep = new Set(this.desired.map((w) => w.key));
    for (const k of this.chunks.keys()) if (!keep.has(k)) this.chunks.delete(k);
    return true;
  }
  next(): Wanted | undefined { return this.desired.find((w) => !this.chunks.has(w.key)); }
  accept(chunk: Chunk): boolean {
    if (!this.desired.some((w) => w.key === chunk.key)) return false;
    this.chunks.set(chunk.key, chunk);
    return true;
  }
}
