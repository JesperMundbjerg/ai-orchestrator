import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import {
  BoxGeometry,
  BufferGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  DoubleSide,
  Float32BufferAttribute,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  Matrix4,
  MeshStandardMaterial,
  Object3D,
  Shape,
  ShapeGeometry,
  type InstancedMesh,
  type Material,
  type Mesh,
} from "three";
import type { Garden, Rect } from "./building.ts";
import type { Vec2 } from "./layout.ts";
import { benchNook, pondEdge, type Planting, type Tree } from "./planting.ts";

// The garden as it grows: every tree, plant, rock and paving slab is an instance of one of a few
// shared shapes, so the whole garden is a couple of dozen draw calls however much grows in it.
// Leaves, grasses and flowers sway in the vertex shader, on one clock; the ducks, birds,
// butterflies and the fountain's spray move by a handful of matrices a frame.

/** The clock the swaying reads. */
const TIME = { value: 0 };

/**
 * A leafy material that sways: each vertex moves with the wind by how far it is up the shape
 * (or out along it, for fronds), each plant a little out of step with its neighbours.
 */
function swaying(amount: number, along: "y" | "z", from: number, doubleSided = false) {
  const m = new MeshStandardMaterial({ roughness: 0.85, flatShading: true, side: doubleSided ? DoubleSide : undefined });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = TIME;
    shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nuniform float uTime;").replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
      {
        vec3 root = vec3(0.0);
        #ifdef USE_INSTANCING
        root = instanceMatrix[3].xyz;
        #endif
        float phase = root.x * 0.63 + root.z * 0.41;
        float bend = max(position.${along} + ${from.toFixed(3)}, 0.0) * ${amount.toFixed(4)};
        float gust = sin(uTime * 1.6 + phase) * 0.65 + sin(uTime * 0.7 + phase * 1.7) * 0.35;
        transformed.x += gust * bend;
        transformed.z += cos(uTime * 1.3 + phase) * bend * 0.5;
      }`,
    );
  };
  m.customProgramCacheKey = () => `sway:${amount}:${along}:${from}:${doubleSided}`;
  return m;
}

const still = (roughness: number, flat = true, doubleSided = false) => new MeshStandardMaterial({ roughness, flatShading: flat, side: doubleSided ? DoubleSide : undefined });

/** A leaf or frond along +z from its stem to its tip: rising, then drooping, widest in its middle, folded a little along its rib. */
function leafShape() {
  const pos: number[] = [];
  const index: number[] = [];
  const n = 6;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const w = Math.sin(Math.PI * Math.min(1, t * 1.05)) * 0.16 + 0.01;
    const y = 0.55 * t - 0.75 * t * t;
    pos.push(-w, y - 0.03, t, 0, y + 0.02, t, w, y - 0.03, t);
  }
  for (let i = 0; i < n; i++) {
    const a = i * 3;
    const b = a + 3;
    index.push(a, b, a + 1, a + 1, b, b + 1, a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** A clump of grass blades a unit tall and about a unit across, each blade leaning out its own way. */
function bladesShape(blades = 11) {
  const pos: number[] = [];
  for (let k = 0; k < blades; k++) {
    const a = k * 2.39996;
    const [cx, cz] = [Math.cos(a), Math.sin(a)];
    const lean = 0.18 + (k % 3) * 0.1;
    const base: Vec2 = [cx * 0.1, cz * 0.1];
    const w = 0.045;
    pos.push(base[0] - cz * w, 0, base[1] + cx * w, base[0] + cz * w, 0, base[1] - cx * w, base[0] + cx * lean, 1 - (k % 4) * 0.12, base[1] + cz * lean);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** A wing, from its root at the body out along +x: birds and butterflies alike. */
function wingShape() {
  const p: Vec2[] = [[0, 0.45], [0.8, 0.5], [1, 0.05], [0.55, -0.45], [0, -0.3]];
  const pos: number[] = [];
  for (let i = 1; i < p.length - 1; i++) for (const q of [p[0]!, p[i]!, p[i + 1]!]) pos.push(q[0], 0, q[1]);
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

const SHAPES = {
  trunk: new CylinderGeometry(0.35, 0.5, 1, 7).translate(0, 0.5, 0),
  crown: new IcosahedronGeometry(0.5, 1),
  cone: new ConeGeometry(0.5, 1, 7).translate(0, 0.5, 0),
  leaf: leafShape(),
  blades: bladesShape(),
  bloom: new IcosahedronGeometry(0.5, 0),
  cover: new CylinderGeometry(0.5, 0.5, 1, 9).translate(0, 0.5, 0),
  rock: new DodecahedronGeometry(0.5, 0),
  step: new CylinderGeometry(0.5, 0.45, 1, 9).translate(0, 0.5, 0),
  slab: new BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
  lily: new CircleGeometry(0.5, 12, 0.4, Math.PI * 2 - 0.8).rotateX(-Math.PI / 2),
  wing: wingShape(),
};
type Part = keyof typeof SHAPES;

const MATERIALS: Record<Exclude<Part, "wing">, Material> = {
  trunk: still(0.9),
  crown: swaying(0.05, "y", 0.5),
  cone: swaying(0.035, "y", 0),
  leaf: swaying(0.1, "z", 0, true),
  blades: swaying(0.22, "y", 0, true),
  bloom: swaying(0.1, "y", 3),
  cover: still(1),
  rock: still(0.95),
  step: still(0.95),
  slab: still(0.95, false),
  lily: still(0.7, true, true),
};
/** What casts a shadow: trees and rocks; the low planting only receives them. */
const CASTS = new Set<Part>(["trunk", "crown", "cone", "rock"]);

const PALETTE = {
  trunk: ["#6f5238", "#7a5a40", "#5f4630"],
  birchBark: "#ece8de",
  palmBark: "#9c7f5a",
  broadleaf: ["#4f8a3c", "#5e9b45", "#3f7a3a", "#6aa04a", "#77a83f"],
  shade: ["#3f7d3c", "#4c8a40", "#35703a", "#46823f"],
  birch: ["#8dbb4f", "#9cc25a", "#7fb04a", "#a8c65e"],
  conifer: ["#2f5d3a", "#35694a", "#2c5a44", "#3e6f4f"],
  palm: ["#5c9a3d", "#6aa844", "#4f8f3a"],
  shrub: ["#4a7d3a", "#557f35", "#3d6e3f", "#6b8f3a", "#5a8a5a"],
  fern: ["#5d9a3f", "#6aa545", "#4f8a38", "#74ad4c"],
  grass: ["#8aa25a", "#a6a86a", "#c9b877", "#6f9a6a", "#7fa39a"],
  reeds: ["#6f8d45", "#7d9650", "#8a9a55"],
  cover: ["#6c9a45", "#5f8f3f", "#7fa64d", "#4f7f3c", "#8aae55", "#98b860"],
  flowers: ["#e8604c", "#f2b134", "#f4e9d8", "#c46bd1", "#ef8fb1", "#6f8fe8", "#f47c2c", "#ffd84d", "#ffffff", "#b0306a"],
  rock: ["#9a968d", "#a8a39a", "#8c8983", "#b2aa9c", "#7f7c76"],
  slab: ["#d8cfbd", "#cfc4b0", "#e0d8c8", "#c9bfab", "#d3c9b6"],
};

/** A number from 0 to 1 that stays the same for the same seed and key. */
const hash = (seed: number, k: number) => (Math.abs(Math.sin(seed * 12.9898 + k * 78.233 + 0.5)) * 43758.5453) % 1;
const pick = (colors: string[], s: number) => colors[Math.floor(s * colors.length) % colors.length]!;

type Batch = { m: number[]; c: number[] };

/** Collects the instances of each shape: where, how big, which way turned, and in what colour. */
class Parts {
  batches = Object.fromEntries(Object.keys(SHAPES).map((k) => [k, { m: [], c: [] }])) as unknown as Record<Part, Batch>;
  private o = new Object3D();
  private color = new Color();

  /** `turn` is [tilt, yaw, roll], the tilt and roll in the thing's own frame after its yaw. */
  add(part: Part, at: [number, number, number], size: [number, number, number], turn: [number, number, number], color: string, vary = 0) {
    this.o.position.set(...at);
    this.o.rotation.set(turn[0], turn[1], turn[2], "YXZ");
    this.o.scale.set(...size);
    this.o.updateMatrix();
    this.batches[part].m.push(...this.o.matrix.elements);
    this.color.set(color);
    if (vary) this.color.offsetHSL((vary - 0.5) * 0.03, (hash(vary, 7) - 0.5) * 0.12, (hash(vary, 9) - 0.5) * 0.1);
    this.batches[part].c.push(this.color.r, this.color.g, this.color.b);
  }
}

/** Where a leaning trunk is at a height: its foot plus the lean. */
const up = (foot: Vec2, yaw: number, lean: number, y: number): [number, number, number] => [foot[0] + Math.sin(yaw) * y * Math.sin(lean), y, foot[1] + Math.cos(yaw) * y * Math.sin(lean)];

function tree(parts: Parts, t: Tree) {
  const s = t.seed;
  const h = (k: number) => hash(s, k);
  const yaw = h(1) * Math.PI * 2;
  const lean = (h(2) - 0.5) * 0.1;
  const c = t.crown;
  const trunk = (color: string, height: number, radius = t.trunk) => parts.add("trunk", [t.pos[0], 0, t.pos[1]], [radius * 2, height, radius * 2], [lean, yaw, 0], color, h(3));
  const blob = (at: [number, number, number], size: [number, number, number], colors: string[], k: number) => parts.add("crown", at, size, [0, h(k) * 6, 0], pick(colors, h(k + 1)), h(k + 2));
  if (t.kind === "broadleaf") {
    trunk(pick(PALETTE.trunk, h(4)), t.base + c * 0.8);
    const top = up(t.pos, yaw, lean, t.base + c * 0.9);
    blob(top, [2 * c, 1.6 * c, 2 * c], PALETTE.broadleaf, 10);
    for (let k = 0; k < 4; k++) {
      const a = yaw + k * 2.1 + h(20 + k);
      blob([top[0] + Math.sin(a) * 0.55 * c, t.base + c * (0.75 + 0.3 * (k % 2)), top[2] + Math.cos(a) * 0.55 * c], [1.15 * c, 1.1 * c, 1.15 * c], PALETTE.broadleaf, 30 + k * 3);
    }
  } else if (t.kind === "shade") {
    trunk(pick(PALETTE.trunk, h(4)), t.base + 0.4);
    for (const side of [-1, 1]) parts.add("trunk", up(t.pos, yaw, lean, t.base * 0.75), [0.2, c * 0.8, 0.2], [0.6, yaw + side * 1.3 + h(5), 0], pick(PALETTE.trunk, h(6)), h(7));
    blob(up(t.pos, yaw, lean, t.base + 0.6 * c), [1.4 * c, 0.9 * c, 1.4 * c], PALETTE.shade, 10);
    for (let k = 0; k < 6; k++) {
      const a = yaw + (k / 6) * Math.PI * 2 + h(20 + k) * 0.4;
      blob([t.pos[0] + Math.sin(a) * 0.62 * c, t.base + c * (0.42 + (k % 2) * 0.15), t.pos[1] + Math.cos(a) * 0.62 * c], [1.05 * c, 0.72 * c, 1.05 * c], PALETTE.shade, 30 + k * 3);
    }
  } else if (t.kind === "birch") {
    const height = t.height * 0.92;
    trunk(PALETTE.birchBark, height);
    // The dark marks on its bark.
    for (let k = 0; k < 5; k++) parts.add("trunk", up(t.pos, yaw, lean, 0.4 + k * (t.base / 5) + h(40 + k) * 0.3), [t.trunk * 2.1, 0.05, t.trunk * 2.1], [lean, yaw, 0], "#2d2a26");
    for (let k = 0; k < 3; k++) {
      const w = 1.6 * c * (1 - k * 0.15);
      const at = up(t.pos, yaw, lean, t.base + c * (1.1 + k * 1.0));
      blob([at[0] + (h(50 + k) - 0.5) * 0.3 * c, at[1], at[2] + (h(60 + k) - 0.5) * 0.3 * c], [w, 2.2 * c, w], PALETTE.birch, 70 + k * 3);
    }
  } else if (t.kind === "palm") {
    // A curving trunk in three pieces, each leaning further, and a crown of drooping fronds.
    let foot: [number, number, number] = [t.pos[0], 0, t.pos[1]];
    const piece = t.height / 3;
    for (let k = 0; k < 3; k++) {
      const tilt = 0.06 + k * 0.08;
      parts.add("trunk", foot, [0.26 - k * 0.03, piece + 0.05, 0.26 - k * 0.03], [tilt, yaw, 0], PALETTE.palmBark, h(80 + k));
      foot = [foot[0] + Math.sin(yaw) * piece * Math.sin(tilt), foot[1] + piece * Math.cos(tilt), foot[2] + Math.cos(yaw) * piece * Math.sin(tilt)];
    }
    for (let k = 0; k < 10; k++) parts.add("leaf", foot, [c * 1.1, c * 0.9, c], [-0.25 + (k % 3) * 0.2, (k / 10) * Math.PI * 2 + h(90), 0], pick(PALETTE.palm, h(91 + k)), h(100 + k));
    for (let k = 0; k < 3; k++) parts.add("bloom", [foot[0] + Math.sin(k * 2.1) * 0.12, foot[1] - 0.12, foot[2] + Math.cos(k * 2.1) * 0.12], [0.14, 0.16, 0.14], [0, 0, 0], "#6b4a2a");
  } else {
    trunk("#4e3a2a", 0.6, 0.1);
    const tiers = 4;
    const tall = (t.height - 0.3) * 0.42;
    for (let k = 0; k < tiers; k++) {
      const r = c * (1 - k * 0.2);
      parts.add("cone", [t.pos[0], 0.3 + (k * (t.height - 0.3 - tall)) / (tiers - 1), t.pos[1]], [2 * r, tall, 2 * r], [0, h(110 + k) * 6, 0], pick(PALETTE.conifer, h(120)), h(121 + k));
    }
  }
}

/** Everything that grows, and the rocks, stones and lily pads, as instances. */
function grow(planting: Planting, outside: Tree[]): Record<Part, Batch> {
  const parts = new Parts();
  for (const t of [...planting.trees, ...outside]) tree(parts, t);
  for (const p of planting.plants) {
    const [x, z] = p.pos;
    const h = (k: number) => hash(p.seed, k);
    const yaw = h(1) * Math.PI * 2;
    const { radius: r, height } = p;
    if (p.kind === "shrub") {
      // Now and then one with copper leaves.
      const color = h(12) > 0.93 ? "#8a5a48" : pick(PALETTE.shrub, h(2));
      parts.add("crown", [x, height * 0.45, z], [2 * r, height * 0.9, 2 * r * 0.9], [0, yaw, 0], color, h(3));
      const more = Math.floor(h(4) * 3);
      for (let k = 0; k < more; k++) {
        const a = yaw + k * 2.4;
        parts.add("crown", [x + Math.sin(a) * r * 0.45, height * 0.32, z + Math.cos(a) * r * 0.45], [1.2 * r, height * 0.6, 1.2 * r], [0, a, 0], color, h(5 + k));
      }
      // Some are in flower.
      if (h(9) > 0.8) {
        const bloom = pick(["#f4e9d8", "#ef8fb1", "#8fa8e8", "#ffffff"], h(10));
        for (let k = 0; k < 7; k++) {
          const a = k * 2.4 + yaw;
          const d = r * 0.6 * h(11 + k);
          parts.add("bloom", [x + Math.sin(a) * d, height * (0.7 + 0.25 * h(20 + k)), z + Math.cos(a) * d], [0.16, 0.14, 0.16], [0, a, 0], bloom, h(30 + k));
        }
      }
    } else if (p.kind === "fern") {
      const color = pick(PALETTE.fern, h(2));
      const fronds = 6 + Math.floor(h(3) * 3);
      for (let k = 0; k < fronds; k++) parts.add("leaf", [x, 0.02, z], [r * 1.3, height * 1.6, r * 1.1], [-(0.45 + h(10 + k) * 0.45), yaw + (k / fronds) * Math.PI * 2, 0], color, h(20 + k));
    } else if (p.kind === "grass" || p.kind === "reeds") {
      const reeds = p.kind === "reeds";
      parts.add("blades", [x, 0, z], [r * (reeds ? 1.5 : 2), height, r * (reeds ? 1.5 : 2)], [0, yaw, 0], pick(reeds ? PALETTE.reeds : PALETTE.grass, h(2)), h(3));
      // Reeds carry bulrush heads; some grasses a plume.
      const heads = reeds ? 3 : h(4) > 0.7 ? 2 : 0;
      for (let k = 0; k < heads; k++) {
        const a = yaw + k * 2.2;
        parts.add("bloom", [x + Math.sin(a) * r * 0.35, height * (0.8 + 0.1 * k), z + Math.cos(a) * r * 0.35], reeds ? [0.06, 0.2, 0.06] : [0.07, 0.16, 0.07], [0, a, 0], reeds ? "#5a3d26" : "#e6dcb8", h(5 + k));
      }
    } else if (p.kind === "flowers") {
      parts.add("crown", [x, height * 0.2, z], [2 * r, height * 0.45, 2 * r], [0, yaw, 0], pick(PALETTE.fern, h(2)), h(3));
      const color = pick(PALETTE.flowers, h(4));
      const mixed = h(5) > 0.75;
      if (h(6) > 0.78) {
        // Spires, as lupins and foxgloves have.
        for (let k = 0; k < 3; k++) {
          const a = yaw + k * 2.1;
          parts.add("cone", [x + Math.sin(a) * r * 0.45, height * 0.3, z + Math.cos(a) * r * 0.45], [0.09, height * (0.9 + 0.3 * h(7 + k)), 0.09], [0, a, 0], mixed ? pick(PALETTE.flowers, h(8 + k)) : color, h(12 + k));
        }
      } else {
        const blooms = 4 + Math.floor(h(7) * 4);
        for (let k = 0; k < blooms; k++) {
          const a = yaw + k * 2.39996;
          const d = r * 0.75 * Math.sqrt(h(10 + k));
          const size = 0.07 + h(20 + k) * 0.05;
          parts.add("bloom", [x + Math.sin(a) * d, height * (0.6 + 0.4 * h(30 + k)), z + Math.cos(a) * d], [size, size * 0.8, size], [0, a, 0], mixed ? pick(PALETTE.flowers, h(40 + k)) : color, h(50 + k));
        }
      }
    } else if (p.kind === "cover") {
      parts.add("cover", [x, 0.004, z], [2 * r, height, 2 * r * 0.85], [0, yaw, 0], pick(PALETTE.cover, h(2)), h(3));
      if (h(4) > 0.65) {
        const dot = pick(["#ffffff", "#ffe066", "#c9a6f0"], h(5));
        for (let k = 0; k < 6; k++) {
          const a = k * 2.39996 + yaw;
          const d = r * 0.7 * Math.sqrt(h(6 + k));
          parts.add("bloom", [x + Math.sin(a) * d, height + 0.02, z + Math.cos(a) * d], [0.05, 0.04, 0.05], [0, 0, 0], dot);
        }
      }
    }
  }
  for (const r of planting.rocks) {
    const h = (k: number) => hash(r.seed, k);
    parts.add("rock", [r.pos[0], r.height * 0.32, r.pos[1]], [2 * r.radius, r.height, 2 * r.radius * (0.75 + 0.2 * h(1))], [(h(2) - 0.5) * 0.3, h(3) * 6, (h(4) - 0.5) * 0.3], pick(PALETTE.rock, h(5)), h(6));
  }
  for (const s of planting.steps) parts.add("step", [s.pos[0], 0, s.pos[1]], [2 * s.radius, s.height, 2 * s.radius * 0.88], [0, hash(s.seed, 1) * 6, 0], pick(PALETTE.rock, hash(s.seed, 2) * 0.6 + 0.2), hash(s.seed, 3));
  for (const l of planting.lilies) {
    const h = (k: number) => hash(l.seed, k);
    parts.add("lily", [l.pos[0], 0.056, l.pos[1]], [2 * l.radius, 1, 2 * l.radius], [0, h(1) * 6, 0], "#5e9a4f", h(2));
    if (h(3) > 0.55) parts.add("bloom", [l.pos[0] + 0.03, 0.09, l.pos[1]], [0.1, 0.07, 0.1], [0, 0, 0], h(4) > 0.5 ? "#f7c6d9" : "#fbf6ea");
  }
  return parts.batches;
}

/**
 * The paving: the walk as a path of slabs narrower than the ground kept clear for it, grass either
 * side; gravel round each bench; and the clearing as flagstones with grass between.
 */
function pave(garden: Garden): Batch {
  const parts = new Parts();
  const slab = (x: number, z: number, w: number, d: number, s: number) => parts.add("slab", [x, 0.006, z], [w, 0.02, d], [0, 0, 0], pick(PALETTE.slab, s), hash(s, 3));
  const { walk } = garden;
  const HALF = 0.62;
  const run = (from: number, to: number, fixed: number, alongX: boolean) => {
    let at = from;
    for (let k = 0; at < to - 0.05; k++) {
      const s = hash(from + fixed, k);
      const len = Math.min(to - at, 0.5 + s * 0.3);
      for (const [side, w] of [[-1, HALF], [1, HALF]] as const) {
        // The two slabs across the path break joint.
        const mid = at + len / 2 + (side > 0 ? 0.12 : 0);
        const across = fixed + (side * w) / 2;
        if (mid + len / 2 > to + 0.1) continue;
        if (alongX) slab(mid, across, len - 0.05, w - 0.05, hash(s, side + 2));
        else slab(across, mid, w - 0.05, len - 0.05, hash(s, side + 2));
      }
      at += len;
    }
  };
  run(walk.minX - HALF, walk.maxX + HALF, walk.minZ, true);
  run(walk.minX - HALF, walk.maxX + HALF, walk.maxZ, true);
  run(walk.minZ + HALF, walk.maxZ - HALF, walk.minX, false);
  run(walk.minZ + HALF, walk.maxZ - HALF, walk.maxX, false);
  for (const b of garden.benches) {
    const n = benchNook(b);
    parts.add("slab", [(n.minX + n.maxX) / 2, 0.003, (n.minZ + n.maxZ) / 2], [n.maxX - n.minX, 0.012, n.maxZ - n.minZ], [0, 0, 0], "#cbbfa6", hash(n.minX, n.minZ));
  }
  const c = garden.clearing;
  for (let z = c.minZ + 0.36, row = 0; z < c.maxZ; z += 0.72, row++) {
    let x = c.minX + (row % 2) * 0.35;
    for (let k = 0; x < c.maxX - 0.05; k++) {
      const s = hash(row, k);
      const len = Math.min(c.maxX - x, 0.6 + s * 0.4);
      // Here and there a stone is missing and the grass has taken its place.
      if (hash(s, 5) > 0.05) slab(x + len / 2, z, len - 0.07, 0.65, s);
      x += len;
    }
  }
  return parts.batches.slab;
}

/** One shape's instances, drawn in one call. */
function Instances({ part, batch, material }: { part: Part; batch: Batch; material?: Material }) {
  const ref = useRef<InstancedMesh>(null);
  const count = batch.m.length / 16;
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    mesh.instanceMatrix.array.set(batch.m);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(batch.c), 3);
    mesh.computeBoundingSphere();
  }, [batch]);
  if (!count) return null;
  const shade = CASTS.has(part);
  return <instancedMesh key={count} ref={ref} args={[SHAPES[part], material ?? MATERIALS[part as Exclude<Part, "wing">], count]} castShadow={shade} receiveShadow />;
}

/** The garden: its ground, its paving, everything that grows in it and round the building, the pond, and what lives there. */
export function GardenScene({ garden, planting, outside }: { garden: Garden; planting: Planting; outside: Tree[] }) {
  const batches = useMemo(() => grow(planting, outside), [planting, outside]);
  const paving = useMemo(() => pave(garden), [garden]);
  return (
    <group>
      <Ground garden={garden} />
      <Instances part="slab" batch={paving} />
      {(Object.keys(batches) as Part[]).filter((p) => p !== "wing" && p !== "slab").map((p) => <Instances key={p} part={p} batch={batches[p]} />)}
      <Pond garden={garden} />
      <Life garden={garden} planting={planting} />
    </group>
  );
}

/** The garden's ground: grass, darker and mossier in the beds, fresher on the lawns. */
function Ground({ garden }: { garden: Garden }) {
  const lawns: Rect[] = garden.lawns;
  return (
    <group>
      <Flat rect={garden.area} y={0.004} color="#86ad5e" />
      {garden.beds.map((b, i) => <Flat key={i} rect={b} y={0.005} color={lawns.includes(b) ? "#93b86a" : "#5f6f3c"} />)}
    </group>
  );
}

function Flat({ rect, y, color }: { rect: Rect; y: number; color: string }) {
  return (
    <mesh rotation-x={-Math.PI / 2} position={[(rect.minX + rect.maxX) / 2, y, (rect.minZ + rect.maxZ) / 2]} receiveShadow>
      <planeGeometry args={[rect.maxX - rect.minX, rect.maxZ - rect.minZ]} />
      <meshStandardMaterial color={color} roughness={1} />
    </mesh>
  );
}

/** The pond's outline, as the planting has it, grown or shrunk by `d`. */
function pondShape(radius: number, d: number): ShapeGeometry {
  const shape = new Shape();
  const n = 48;
  for (let k = 0; k <= n; k++) {
    const a = (k / n) * Math.PI * 2;
    const r = radius * pondEdge(a) + d;
    if (k === 0) shape.moveTo(Math.sin(a) * r, Math.cos(a) * r);
    else shape.lineTo(Math.sin(a) * r, Math.cos(a) * r);
  }
  // The shape is drawn in x and y; lying flat, its y becomes -z, so mirror it back.
  return new ShapeGeometry(shape).rotateX(Math.PI / 2);
}

/** The pond: a muddy bank, the water deepening to its middle, and the fountain with its bowl and jet. */
function Pond({ garden }: { garden: Garden }) {
  const { center: [x, z], radius } = garden.pond;
  const shapes = useMemo(() => ({ bank: pondShape(radius, 0.16), water: pondShape(radius, 0), deep: pondShape(radius * 0.55, 0) }), [radius]);
  return (
    <group position={[x, 0, z]}>
      <mesh geometry={shapes.bank} position={[0, 0.008, 0]} receiveShadow>
        <meshStandardMaterial color="#6d6a48" roughness={1} side={DoubleSide} />
      </mesh>
      <mesh geometry={shapes.water} position={[0, 0.05, 0]} receiveShadow>
        <meshStandardMaterial color="#4a90b0" roughness={0.12} metalness={0.15} side={DoubleSide} />
      </mesh>
      <mesh geometry={shapes.deep} position={[0, 0.051, 0]}>
        <meshStandardMaterial color="#35728f" roughness={0.12} metalness={0.15} side={DoubleSide} />
      </mesh>
      <mesh position={[0, 0.3, 0]} castShadow>
        <cylinderGeometry args={[0.12, 0.2, 0.5, 14]} />
        <meshStandardMaterial color="#cfc6b6" roughness={0.9} />
      </mesh>
      <mesh position={[0, 0.58, 0]} castShadow>
        <cylinderGeometry args={[0.45, 0.3, 0.1, 20]} />
        <meshStandardMaterial color="#cfc6b6" roughness={0.9} />
      </mesh>
      <mesh position={[0, 0.635, 0]}>
        <cylinderGeometry args={[0.4, 0.4, 0.01, 20]} />
        <meshStandardMaterial color="#6fb0d0" roughness={0.1} />
      </mesh>
    </group>
  );
}

const DROPS = 40;
/** Ducks, one behind another: a drake, a duck and a duckling. */
const DUCKS = [
  { body: "#8a7d6b", head: "#2f6b3a", size: 1, behind: 0 },
  { body: "#8b6f4e", head: "#7a5f42", size: 0.95, behind: 0.7 },
  { body: "#a08a62", head: "#8a7250", size: 0.6, behind: 1.25 },
];
const BIRDS = 4;
const BUTTERFLIES = ["#f2b134", "#ffffff", "#6f8fe8", "#e8604c", "#f4e9d8", "#c46bd1"];
const smooth = (a: number, b: number, t: number) => {
  const x = Math.max(0, Math.min(1, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
};

/**
 * What lives in the garden, moved a little every frame: three ducks paddling round the pond, the
 * fountain's spray and the rings it sends out, birds circling overhead (one now and then comes
 * down to sit on the fountain's bowl), and butterflies going from flower to flower.
 */
function Life({ garden, planting }: { garden: Garden; planting: Planting }) {
  const bodies = useRef<InstancedMesh>(null);
  const wings = useRef<InstancedMesh>(null);
  const drops = useRef<InstancedMesh>(null);
  const rings = useRef<Array<Mesh | null>>([]);
  const [px, pz] = garden.pond.center;
  const R = garden.pond.radius;
  const flowers = useMemo(() => planting.plants.filter((p) => p.kind === "flowers").sort((a, b) => a.pos[0] - b.pos[0]), [planting]);
  const middle: Vec2 = [(garden.area.minX + garden.area.maxX) / 2, (garden.area.minZ + garden.area.maxZ) / 2];
  const bodyCount = DUCKS.length * 4 + BIRDS * 2 + BUTTERFLIES.length;
  const wingCount = (BIRDS + BUTTERFLIES.length) * 2;

  useLayoutEffect(() => {
    const colors = [
      ...DUCKS.flatMap((d) => [d.body, d.head, "#e8a23a", d.body]),
      ...Array.from({ length: BIRDS }, (_, i) => [i === 0 ? "#6b4a3a" : "#3b3a40", i === 0 ? "#d0643a" : "#2f2e33"]).flat(),
      ...BUTTERFLIES.map(() => "#2a2622"),
    ];
    const wingColors = [...Array.from({ length: BIRDS * 2 }, (_, i) => (i < 2 ? "#5a4032" : "#34333a")), ...BUTTERFLIES.flatMap((c) => [c, c])];
    const tint = (list: string[]) => {
      const out = new Float32Array(list.length * 3);
      const c = new Color();
      list.forEach((hex, i) => c.set(hex).toArray(out, i * 3));
      return new InstancedBufferAttribute(out, 3);
    };
    bodies.current!.instanceColor = tint(colors);
    wings.current!.instanceColor = tint(wingColors);
  }, []);

  const o = useMemo(() => new Object3D(), []);
  const m = useMemo(() => new Matrix4(), []);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    TIME.value = t;
    const body = bodies.current;
    const wing = wings.current;
    const drop = drops.current;
    if (!body || !wing || !drop) return;
    let b = 0;
    let w = 0;
    const put = (mesh: InstancedMesh, i: number, at: [number, number, number], size: [number, number, number], yaw: number, pitch = 0, roll = 0) => {
      o.position.set(...at);
      o.rotation.set(pitch, yaw, roll, "YXZ");
      o.scale.set(...size);
      o.updateMatrix();
      mesh.setMatrixAt(i, o.matrix);
    };
    /** A point in a creature's own frame (+z ahead), on the floor. */
    const local = (at: [number, number, number], yaw: number, [x, y, z]: [number, number, number]): [number, number, number] => [at[0] + x * Math.cos(yaw) + z * Math.sin(yaw), at[1] + y, at[2] - x * Math.sin(yaw) + z * Math.cos(yaw)];

    // Ducks: in a line round the front of the pond, between the fountain and the bank, clear of the stones at its back.
    DUCKS.forEach((d, i) => {
      const round = (s: number) => {
        const a = s * 0.3 - d.behind;
        return [px + Math.sin(a) * R * 0.57, pz + R * 0.17 + Math.cos(a) * R * 0.43] as const;
      };
      const [x, z] = round(t);
      const [nx, nz] = round(t + 0.2);
      const yaw = Math.atan2(nx - x, nz - z);
      const at: [number, number, number] = [x, 0.08 + Math.sin(t * 2.6 + i) * 0.008, z];
      const k = d.size;
      put(body, b++, at, [0.22 * k, 0.14 * k, 0.34 * k], yaw);
      put(body, b++, local(at, yaw, [0, 0.13 * k, 0.14 * k]), [0.12 * k, 0.12 * k, 0.13 * k], yaw);
      put(body, b++, local(at, yaw, [0, 0.12 * k, 0.22 * k]), [0.05 * k, 0.03 * k, 0.08 * k], yaw);
      put(body, b++, local(at, yaw, [0, 0.05 * k, -0.17 * k]), [0.1 * k, 0.07 * k, 0.1 * k], yaw, -0.5);
    });

    // Birds: circling high over the garden; the first comes down to the fountain's bowl for a while every half minute.
    for (let i = 0; i < BIRDS; i++) {
      const dir = i % 2 ? -1 : 1;
      const fly = (s: number): [number, number, number] => {
        const a = dir * s * (0.22 + i * 0.04) + i * 1.7;
        const r = 5 + i * 1.6;
        return [middle[0] + Math.sin(a) * r, 6.5 + i * 0.7 + Math.sin(s * 0.3 + i) * 0.6, middle[1] + Math.cos(a) * r];
      };
      const cycle = (t + 8) % 30;
      const down = i === 0 ? smooth(12, 16, cycle) * (1 - smooth(22, 26, cycle)) : 0;
      const perch: [number, number, number] = [px + 0.4, 0.66, pz];
      const mix = (s: number): [number, number, number] => {
        const f = fly(s);
        const d = i === 0 ? smooth(12, 16, (s + 8) % 30) * (1 - smooth(22, 26, (s + 8) % 30)) : 0;
        return [f[0] + (perch[0] - f[0]) * d, f[1] + (perch[1] - f[1]) * d, f[2] + (perch[2] - f[2]) * d];
      };
      const at = mix(t);
      const ahead = mix(t + 0.1);
      const moving = Math.hypot(ahead[0] - at[0], ahead[2] - at[2]) > 1e-4;
      const yaw = moving ? Math.atan2(ahead[0] - at[0], ahead[2] - at[2]) : Math.sin(t * 0.8) * 1.2 - Math.PI / 2;
      const sitting = down > 0.98;
      const hop = sitting ? Math.max(0, Math.sin(t * 5)) * 0.02 : 0;
      const body0: [number, number, number] = [at[0], at[1] + 0.05 + hop, at[2]];
      put(body, b++, body0, [0.09, 0.08, 0.18], yaw, sitting ? -0.3 : 0);
      put(body, b++, local(body0, yaw, [0, sitting ? 0.07 : 0.03, 0.09]), [0.07, 0.07, 0.07], yaw);
      const flap = sitting ? 0.9 : Math.sin(t * (down > 0 ? 14 : 9) + i) * 0.7 * (1 - down * 0.5) + (down > 0 ? 0 : 0.1);
      const span = sitting ? 0.13 : 0.26;
      put(wing, w++, body0, [span, 1, 0.16], yaw, 0, flap);
      put(wing, w++, body0, [-span, 1, 0.16], yaw, 0, -flap);
    }

    // Butterflies: from one flower to another every few seconds, dancing a little on the way.
    BUTTERFLIES.forEach((_, i) => {
      const period = 7 + i;
      const s = t / period + i * 0.37;
      const leg = Math.floor(s);
      const f = s - leg;
      const n = flowers.length;
      const at: [number, number, number] = [middle[0], 1, middle[1]];
      if (n) {
        const from = flowers[(i * 11 + leg * 5) % n]!;
        const to = flowers[(i * 11 + (leg + 1) * 5) % n]!;
        const e = smooth(0.25, 0.85, f);
        at[0] = from.pos[0] + (to.pos[0] - from.pos[0]) * e + Math.sin(t * 1.9 + i) * 0.25;
        at[1] = from.height + 0.08 + Math.sin(Math.PI * e) * 0.9 + Math.sin(t * 4.3 + i) * 0.06;
        at[2] = from.pos[1] + (to.pos[1] - from.pos[1]) * e + Math.cos(t * 1.4 + i) * 0.25;
      }
      const yaw = t * 0.6 + i * 2;
      put(body, b++, at, [0.02, 0.02, 0.07], yaw);
      const flap = 0.2 + Math.abs(Math.sin(t * 16 + i * 3)) * 1.1;
      put(wing, w++, at, [0.08, 1, 0.1], yaw, 0, flap);
      put(wing, w++, at, [-0.08, 1, 0.1], yaw, 0, -flap);
    });
    body.instanceMatrix.needsUpdate = true;
    wing.instanceMatrix.needsUpdate = true;

    // The fountain: drops thrown up and out of the jet, falling back into its bowl.
    for (let j = 0; j < DROPS; j++) {
      const phase = (t * 0.9 + j / DROPS) % 1;
      const a = j * 2.39996;
      const out = 0.36 + (j % 5) * 0.02;
      drop.setMatrixAt(j, m.makeScale(0.035, 0.05, 0.035).setPosition(px + Math.cos(a) * out * phase, 1.05 + 0.9 * phase - 1.5 * phase * phase, pz + Math.sin(a) * out * phase));
    }
    drop.instanceMatrix.needsUpdate = true;
    // Rings spreading over the water from under the bowl.
    rings.current.forEach((ring, i) => {
      if (!ring) return;
      const f = (t / 3.2 + i / 3) % 1;
      const r = 0.5 + f * R * 0.45;
      ring.scale.set(r, r, 1);
      (ring.material as MeshStandardMaterial).opacity = 0.35 * (1 - f);
    });
  });

  return (
    <group>
      <instancedMesh ref={bodies} args={[SHAPES.crown, undefined, bodyCount]} castShadow frustumCulled={false}>
        <meshStandardMaterial roughness={0.7} />
      </instancedMesh>
      <instancedMesh ref={wings} args={[SHAPES.wing, undefined, wingCount]} frustumCulled={false}>
        <meshStandardMaterial roughness={0.7} side={DoubleSide} />
      </instancedMesh>
      <instancedMesh ref={drops} args={[SHAPES.bloom, undefined, DROPS]} frustumCulled={false}>
        <meshStandardMaterial color="#d8eefa" transparent opacity={0.75} roughness={0.1} depthWrite={false} />
      </instancedMesh>
      <mesh position={[px, 0.85, pz]}>
        <cylinderGeometry args={[0.03, 0.07, 0.5, 8]} />
        <meshStandardMaterial color="#d8eefa" transparent opacity={0.7} roughness={0.1} depthWrite={false} />
      </mesh>
      {[0, 1, 2].map((i) => (
        <mesh key={i} ref={(r) => void (rings.current[i] = r)} position={[px, 0.055, pz]} rotation-x={-Math.PI / 2}>
          <ringGeometry args={[0.94, 1, 40]} />
          <meshStandardMaterial color="#e6f4fb" transparent opacity={0.3} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
}
