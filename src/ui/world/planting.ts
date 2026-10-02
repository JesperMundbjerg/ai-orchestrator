// What grows in the building's garden, and where. Pure: from the garden's plan it returns every
// tree, plant, rock and stepping stone, the same every time for the same garden (a seeded random),
// so the garden looks the same on every render and the tests can check what grows where.
//
//   inner bed   trees of every kind down its middle, clear of a trail of stepping stones that
//               winds through it from the walk's front to its back; shrubs, ferns under the
//               trees, tall grasses and flowers round them, and ground cover
//   borders     behind and beside the walk: birches where the bays meet, so no team is hidden,
//               and a thin fringe of grasses, ferns and flowers
//   lawns       the pond in the west one, with rocks round its edge, reeds on its far side, lily
//               pads, and stepping stones across its back; a big shade tree in the east one;
//               conifers and birches in their corners and a loose planting that stays low by the
//               clearing, with open grass between; the east lawn's strip by the clearing is kept
//               for the usage meters' bird feeders (meters.ts)
//
// Everything stands in a bed with its whole footprint, so nothing grows on a path, the clearing
// or a bench, nor in the gravel nook round each bench where a visitor stands; only reeds, lily pads and the pond's stepping stones are in the water. A crown may
// reach out over a path, but only above head height.

import { BAY_WIDTH, GARDEN_INSET, place, type Bench, type Garden, type Rect } from "./building.ts";
import type { Vec2 } from "./layout.ts";
import { meterGround } from "./meters.ts";

export type TreeKind = "broadleaf" | "shade" | "birch" | "palm" | "conifer";

export interface Tree {
  kind: TreeKind;
  pos: Vec2;
  /** From the ground to its top. */
  height: number;
  /** How far its crown reaches out from the trunk, and how high its lowest leaves hang. */
  crown: number;
  base: number;
  trunk: number;
  /** 0 to 1: what makes this tree differ from others of its kind. */
  seed: number;
}

export type PlantKind = "shrub" | "fern" | "grass" | "flowers" | "cover" | "reeds";

export interface Plant {
  kind: PlantKind;
  pos: Vec2;
  radius: number;
  height: number;
  seed: number;
}

/** A rock, a stepping stone or a lily pad: roundish, on the ground or on the water. */
export interface Stone {
  pos: Vec2;
  radius: number;
  height: number;
  seed: number;
}

export interface Planting {
  trees: Tree[];
  plants: Plant[];
  rocks: Stone[];
  /** Stepping stones: the trail through the inner bed, and across the back of the pond. */
  steps: Stone[];
  lilies: Stone[];
}

/** A crown that reaches over a path hangs higher than this: over the heads and name tags of whoever walks there. */
export const HEADROOM = 2.4;
/** Everything keeps this far in from its bed's edge. */
const EDGE = 0.04;

/** How much ground a tree takes: its trunk, or all of it when its leaves come down low. */
export const groundOf = (t: Tree): number => (t.base < HEADROOM ? t.crown : t.trunk + 0.1);

/**
 * The gravel round a bench, kept clear of planting: the bench and a little either side of it and
 * behind it, where someone visiting whoever sits there stands (see visits.ts).
 */
export function benchNook(b: Bench): Rect {
  const corners = [place(b.pos, b.facing, [-1.35, -0.8]), place(b.pos, b.facing, [1.35, 0.35])];
  const xs = corners.map((c) => c[0]);
  const zs = corners.map((c) => c[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}

/** Plants that grow in the water rather than on land. */
export const inWater = (p: Plant): boolean => p.kind === "reeds";

/** The pond's edge, as a share of its radius, at an angle round it: never quite round, never past its radius. */
export const pondEdge = (a: number): number => 0.88 + 0.06 * Math.sin(3 * a + 1) + 0.04 * Math.sin(5 * a + 2);

/** A random number from 0 to 1 that comes out the same every time from the same seed. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const inside = (r: Rect, [x, z]: Vec2, pad: number) => x >= r.minX + pad && x <= r.maxX - pad && z >= r.minZ + pad && z <= r.maxZ - pad;
/** How far a point is from a rectangle, 0 inside it. */
const away = (r: Rect, [x, z]: Vec2) => Math.hypot(Math.max(r.minX - x, 0, x - r.maxX), Math.max(r.minZ - z, 0, z - r.maxZ));

export function plantGarden(garden: Garden): Planting {
  const rand = random(20260930);
  const between = (a: number, b: number) => a + rand() * (b - a);
  const out: Planting = { trees: [], plants: [], rocks: [], steps: [], lilies: [] };
  const { inner, pond, clearing } = garden;
  const [west, east] = garden.lawns;
  const borders = garden.beds.filter((b) => b !== inner && b !== west && b !== east);

  // The ground taken so far, as circles in a grid of metre squares; things may crowd a little, as planting does.
  const taken = new Map<string, Array<{ p: Vec2; r: number }>>();
  let widest = 0;
  const cell = (x: number, z: number) => `${Math.floor(x)},${Math.floor(z)}`;
  const free = (p: Vec2, r: number, gap = 0.85) => {
    const reach = Math.ceil(r + widest);
    for (let i = -reach; i <= reach; i++) for (let j = -reach; j <= reach; j++) {
      for (const t of taken.get(cell(p[0] + i, p[1] + j)) ?? []) if (dist(t.p, p) < (t.r + r) * gap) return false;
    }
    return true;
  };
  const take = (p: Vec2, r: number) => {
    const k = cell(...p);
    taken.set(k, [...(taken.get(k) ?? []), { p, r }]);
    widest = Math.max(widest, r);
  };
  const dry = (p: Vec2, r: number) => dist(p, pond.center) > pond.radius + 0.35 + r;
  const kept = [...garden.benches.map(benchNook), meterGround(garden)];
  const fits = (bed: Rect, p: Vec2, r: number) => inside(bed, p, r + EDGE) && dry(p, r) && kept.every((n) => away(n, p) > r + EDGE);

  // The trail: stepping stones winding through the inner bed from the front of the walk to its back.
  const depth = inner.maxZ - inner.minZ;
  const n = Math.max(3, Math.round(depth / 0.55));
  const wind = Math.min(0.5, (inner.maxX - inner.minX) / 10);
  const trailX = (z: number) => Math.sin(((inner.maxZ - z) / depth) * Math.PI * 2) * wind;
  for (let k = 0; k < n; k++) {
    const z = inner.maxZ - ((k + 0.5) / n) * depth;
    const p: Vec2 = [trailX(z) + between(-0.04, 0.04), z];
    out.steps.push({ pos: p, radius: between(0.19, 0.24), height: 0.05, seed: rand() });
    take(p, 0.45);
  }

  const grow = (kind: TreeKind, pos: Vec2, scale = 1): Tree => {
    const seed = rand();
    if (kind === "broadleaf") {
      const crown = (1 + seed * 0.45) * scale;
      const base = HEADROOM + 0.15 + rand() * 0.5;
      return { kind, pos, crown, base, height: base + crown * 1.8, trunk: 0.12 + 0.04 * scale, seed };
    }
    if (kind === "shade") {
      const crown = (2 + seed * 0.35) * scale;
      const base = HEADROOM + 0.3 + rand() * 0.3;
      return { kind, pos, crown, base, height: base + crown * 1.05, trunk: 0.24, seed };
    }
    if (kind === "birch") {
      const crown = 0.6 + seed * 0.2;
      const base = HEADROOM + 0.3 + rand() * 0.6;
      return { kind, pos, crown, base, height: base + crown * 4.2, trunk: 0.075, seed };
    }
    if (kind === "palm") {
      const height = 3.9 + seed * 0.8;
      const crown = 1.35 + rand() * 0.3;
      return { kind, pos, crown, base: height - 0.55 * crown, height, trunk: 0.12, seed };
    }
    const crown = (0.45 + seed * 0.3) * scale;
    return { kind, pos, crown, base: 0.3, height: crown * 3.4 + 0.4, trunk: 0.1, seed };
  };
  /** A tree here, if it fits: its ground in the bed and its crown clear of every other tree's. */
  const plantTree = (bed: Rect, kind: TreeKind, pos: Vec2, scale = 1) => {
    const t = grow(kind, pos, scale);
    const g = groundOf(t);
    if (!fits(bed, pos, g) || !free(pos, g, 1)) return false;
    const crowded = out.trees.some((o) => dist(o.pos, pos) < (o.crown + t.crown) * (o.kind === "birch" || t.kind === "birch" ? 0.55 : 0.75));
    if (crowded) return false;
    out.trees.push(t);
    take(pos, g);
    return true;
  };

  // The inner bed's trees, in rows down its length, every kind but the conifers mixed.
  const rows = Math.max(1, Math.floor((depth - 0.4) / 3.2));
  const kinds: TreeKind[] = ["broadleaf", "birch", "broadleaf", "palm", "birch", "broadleaf", "conifer", "shade"];
  for (let row = 0; row < rows; row++) {
    const z = inner.minZ + ((row + 0.5) / rows) * depth;
    const jz = Math.max(0, Math.min(0.3, depth / rows / 2 - 0.7));
    for (let x = inner.minX + 1; x <= inner.maxX - 0.8; x += between(2.4, 3.1)) {
      const at: Vec2 = [x + between(-0.3, 0.3), z + between(-jz, jz)];
      if (Math.abs(at[0] - trailX(at[1])) < 1.1) continue;
      let kind = kinds[Math.floor(rand() * kinds.length)]!;
      // A spreading shade tree only where the bed is deep enough to carry it, a conifer only where it has room.
      if (kind === "shade" && depth < 5) kind = "broadleaf";
      if (!plantTree(inner, kind, at, Math.min(1, depth / 2.6)) && kind === "birch") continue;
      // Birches grow in twos and threes.
      if (kind === "birch") for (let k = 0; k < 2; k++) plantTree(inner, "birch", [at[0] + between(-0.9, 0.9), at[1] + between(-0.5, 0.5)]);
    }
  }

  // The borders: birches opposite where the bays meet and in the garden's back corners, clear of every team's front.
  const hallMinX = garden.area.minX - GARDEN_INSET;
  const back = borders.find((b) => b.maxX - b.minX > b.maxZ - b.minZ);
  if (back) {
    const zs = (back.minZ + back.maxZ) / 2;
    const xs = [back.minX + 0.25, back.maxX - 0.25];
    for (let x = hallMinX + BAY_WIDTH; x < back.maxX - 1; x += BAY_WIDTH) if (x > back.minX + 1) xs.push(x - 0.5, x + 0.5);
    for (const x of xs) plantTree(back, "birch", [x, zs]);
  }

  // The lawns. The east one has a big shade tree towards its back; both have trees in their outer corners.
  plantTree(east, "shade", [east.minX + (east.maxX - east.minX) * 0.58, east.minZ + Math.min(2.3, (east.maxZ - east.minZ) * 0.33)]);
  for (const [lawn, outer] of [[west, west.minX], [east, east.maxX]] as const) {
    const s = outer < 0 ? 1 : -1;
    plantTree(lawn, "conifer", [outer + s * 0.75, lawn.minZ + 0.8]);
    plantTree(lawn, "conifer", [outer + s * 1.55, lawn.minZ + 0.7], 0.8);
    plantTree(lawn, "birch", [outer + s * 0.6, lawn.maxZ - 2.2]);
    plantTree(lawn, "birch", [outer + s * 1.2, lawn.maxZ - 2.7]);
    plantTree(lawn, "conifer", [outer + s * 0.7, lawn.maxZ - 0.75], 0.7);
  }
  plantTree(west, "palm", [west.maxX - 0.7, west.minZ + 0.6]);
  plantTree(east, "broadleaf", [east.maxX - 0.9, (east.minZ + east.maxZ) / 2 + 0.6], 0.8);

  // The pond: rocks round its edge, reeds along its far side, stepping stones across its back and lily pads.
  const [px, pz] = pond.center;
  const R = pond.radius;
  const round = (a: number, d: number): Vec2 => [px + Math.sin(a) * d, pz + Math.cos(a) * d];
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2 + between(-0.1, 0.1);
    const radius = between(0.13, 0.3);
    const p = round(a, R * pondEdge(a) + radius * 0.55);
    if (!inside(west, p, radius + EDGE)) continue;
    out.rocks.push({ pos: p, radius, height: radius * between(0.9, 1.4), seed: rand() });
    take(p, radius);
  }
  // Behind it, away from the clearing: the stones across a corner of the water, reeds either side of them.
  const [a0, a1] = [Math.PI - 0.6, Math.PI + 0.6];
  const [s0, s1] = [round(a0, R * pondEdge(a0) - 0.1), round(a1, R * pondEdge(a1) - 0.1)];
  const stones = 5;
  for (let k = 0; k < stones; k++) {
    const t = (k + 0.5) / stones;
    out.steps.push({ pos: [s0[0] + (s1[0] - s0[0]) * t + between(-0.05, 0.05), s0[1] + (s1[1] - s0[1]) * t + between(-0.05, 0.05)], radius: between(0.16, 0.2), height: 0.09, seed: rand() });
  }
  for (const a of [Math.PI * 0.55, Math.PI * 0.65, Math.PI * 0.78, Math.PI * 1.25, Math.PI * 1.38, Math.PI * 1.5]) {
    const at = a + between(-0.05, 0.05);
    out.plants.push({ kind: "reeds", pos: round(at, R * pondEdge(at) - 0.2), radius: between(0.2, 0.28), height: between(1.0, 1.5), seed: rand() });
  }
  for (let tries = 0; out.lilies.length < 9 && tries < 200; tries++) {
    const a = rand() * Math.PI * 2;
    const p = round(a, R * between(0.35, 0.72));
    const radius = between(0.13, 0.21);
    const clear = [...out.steps, ...out.lilies].every((o) => dist(o.pos, p) > o.radius + radius + 0.05) && out.plants.every((o) => dist(o.pos, p) > o.radius + radius);
    if (clear && dist(p, pond.center) > 0.55 + radius) out.lilies.push({ pos: p, radius, height: 0, seed: rand() });
  }

  // What grows under and round the trees: a few rocks, then shrubs, ferns, grasses and flowers,
  // thickest in the inner bed, loosest on the lawns; by the clearing it stays low.
  const low = (p: Vec2, h: number) => Math.min(h, 0.35 + 0.8 * away(clearing, p));
  const shaded = (p: Vec2) => out.trees.some((t) => dist(t.pos, p) < t.crown * 0.9);
  const sow = (bed: Rect, kind: PlantKind, perM2: number, [r0, r1]: [number, number], [h0, h1]: [number, number], likes: (p: Vec2) => number = () => 1) => {
    const want = Math.round((bed.maxX - bed.minX) * (bed.maxZ - bed.minZ) * perM2);
    let placed = 0;
    for (let tries = want * 8; placed < want && tries > 0; tries--) {
      const p: Vec2 = [between(bed.minX, bed.maxX), between(bed.minZ, bed.maxZ)];
      const radius = between(r0, r1);
      if (!fits(bed, p, radius) || rand() > likes(p)) continue;
      if (kind !== "cover") {
        if (!free(p, radius)) continue;
        take(p, radius);
      }
      out.plants.push({ kind, pos: p, radius, height: low(p, between(h0, h1)), seed: rand() });
      placed++;
    }
  };
  const rock = (bed: Rect, perM2: number) => {
    const want = Math.round((bed.maxX - bed.minX) * (bed.maxZ - bed.minZ) * perM2);
    for (let tries = want * 8, placed = 0; placed < want && tries > 0; tries--) {
      const p: Vec2 = [between(bed.minX, bed.maxX), between(bed.minZ, bed.maxZ)];
      const radius = between(0.18, 0.4);
      if (!fits(bed, p, radius) || !free(p, radius)) continue;
      out.rocks.push({ pos: p, radius, height: radius * between(0.7, 1.2), seed: rand() });
      take(p, radius);
      placed++;
    }
  };
  rock(inner, 1 / 14);
  rock(east, 1 / 14);
  const edgy = (bed: Rect) => (p: Vec2) => (Math.min(p[0] - bed.minX, bed.maxX - p[0], p[1] - bed.minZ, bed.maxZ - p[1]) < 0.7 ? 1 : 0.25);
  for (const bed of [inner]) {
    sow(bed, "shrub", 0.3, [0.3, 0.55], [0.5, 1.1]);
    sow(bed, "fern", 0.7, [0.25, 0.42], [0.35, 0.75], (p) => (shaded(p) ? 1 : 0.35));
    sow(bed, "grass", 0.6, [0.17, 0.3], [0.6, 1.1]);
    sow(bed, "flowers", 1.3, [0.14, 0.26], [0.25, 0.6], edgy(bed));
    sow(bed, "cover", 0.9, [0.25, 0.55], [0.04, 0.08]);
  }
  for (const bed of borders) {
    sow(bed, "grass", 1.2, [0.12, 0.155], [0.45, 0.9]);
    sow(bed, "fern", 0.8, [0.12, 0.155], [0.3, 0.5]);
    sow(bed, "flowers", 1.6, [0.1, 0.155], [0.2, 0.45]);
    sow(bed, "cover", 1.5, [0.1, 0.155], [0.03, 0.06]);
  }
  for (const lawn of [west, east]) {
    // Planting in drifts towards the lawn's outer side and round the pond; open grass by the clearing.
    const fromOuter = (p: Vec2) => (lawn === west ? p[0] - lawn.minX : lawn.maxX - p[0]);
    const outer = (p: Vec2) => (fromOuter(p) < 1.6 ? 1 : away(clearing, p) > 1.2 ? 0.45 : 0.1);
    const byWater = (p: Vec2) => (lawn === west && dist(p, pond.center) < R + 1.3 ? 1 : outer(p));
    sow(lawn, "shrub", 0.14, [0.3, 0.55], [0.5, 1.2], outer);
    sow(lawn, "fern", 0.18, [0.22, 0.38], [0.35, 0.7], byWater);
    sow(lawn, "grass", 0.3, [0.17, 0.28], [0.6, 1.2], byWater);
    sow(lawn, "flowers", 0.7, [0.14, 0.26], [0.25, 0.55]);
    sow(lawn, "cover", 0.35, [0.25, 0.55], [0.03, 0.06]);
  }
  return out;
}

/** Trees on the grass round the building, a few metres out: broadleaves, birches and conifers, the front door clear. */
export function treesRound(r: Rect): Tree[] {
  const rand = random(1729);
  const out: Tree[] = [];
  const off = 2.4;
  const spots: Vec2[] = [];
  for (let x = r.minX + 2; x <= r.maxX - 2; x += 7) spots.push([x, r.minZ - off], [x, r.maxZ + off]);
  for (let z = r.minZ + 5; z <= r.maxZ - 5; z += 7) spots.push([r.minX - off, z], [r.maxX + off, z]);
  for (const [x, z] of spots) {
    if (z > r.maxZ && Math.abs(x) < 3) continue;
    const seed = rand();
    const pos: Vec2 = [x + (rand() - 0.5) * 1.5, z + (rand() - 0.5) * 1.2];
    if (seed < 0.3) out.push({ kind: "conifer", pos, crown: 1 + rand() * 0.4, base: 0.4, height: 4.5 + rand() * 1.5, trunk: 0.14, seed });
    else if (seed < 0.5) out.push({ kind: "birch", pos, crown: 0.8 + rand() * 0.2, base: 2.2, height: 6 + rand(), trunk: 0.1, seed });
    else out.push({ kind: "broadleaf", pos, crown: 1.3 + rand() * 0.5, base: 1.6, height: 5 + rand(), trunk: 0.17, seed });
  }
  return out;
}
