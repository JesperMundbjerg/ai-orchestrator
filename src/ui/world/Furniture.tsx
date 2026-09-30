import { useLayoutEffect, useMemo, useRef } from "react";
import { BoxGeometry, Color, CylinderGeometry, IcosahedronGeometry, Matrix4, Object3D, type InstancedMesh } from "three";
import { place, type Room } from "./building.ts";
import type { Desk, Vec2 } from "./layout.ts";

// The building's furniture as a few instanced meshes: every box of one finish, however many desks,
// chairs and planters there are, is one draw call. A piece is built from boxes in its own frame
// and put down on the floor by `Kit`.

export type Finish = "white" | "wood" | "metal" | "fabric" | "screen" | "leaf" | "hedge" | "pot" | "wall" | "frame" | "window" | "glass" | "frosted";

export interface Piece {
  at: [number, number, number];
  size: [number, number, number];
  yaw: number;
  color?: string;
}

export type Pieces = Record<Finish, Piece[]>;

const FINISH: Record<Finish, { color: string; roughness: number; metalness?: number; basic?: boolean; flat?: boolean; opacity?: number; glow?: number }> = {
  white: { color: "#f1f2f0", roughness: 0.7 },
  wood: { color: "#c9a27a", roughness: 0.55 },
  metal: { color: "#3b4048", roughness: 0.45, metalness: 0.3 },
  fabric: { color: "#ffffff", roughness: 0.95 },
  screen: { color: "#ffffff", roughness: 1, basic: true },
  leaf: { color: "#4e8a52", roughness: 0.9, flat: true },
  hedge: { color: "#4a8450", roughness: 0.9 },
  pot: { color: "#e6e1d8", roughness: 0.8 },
  wall: { color: "#eeeeea", roughness: 0.9 },
  frame: { color: "#8a939c", roughness: 0.5 },
  window: { color: "#d6ecff", roughness: 0.05, opacity: 0.45, glow: 0.55 },
  glass: { color: "#d9ecf8", roughness: 0.05, opacity: 0.18 },
  frosted: { color: "#ffffff", roughness: 0.6, opacity: 0.55 },
};

/** Collects the boxes of the furniture, each placed in the frame of the thing it belongs to. */
export class Kit {
  pieces: Pieces = { white: [], wood: [], metal: [], fabric: [], screen: [], leaf: [], hedge: [], pot: [], wall: [], frame: [], window: [], glass: [], frosted: [] };

  /** A frame on the floor at `pos`, turned by `yaw`: `box` then takes coordinates in it. */
  at(pos: Vec2, yaw: number) {
    const add = (finish: Finish, [x, y, z]: [number, number, number], size: [number, number, number], turn = 0, color?: string) => {
      const [wx, wz] = place(pos, yaw, [x, z]);
      this.pieces[finish].push({ at: [wx, y, wz], size, yaw: yaw + turn, color });
    };
    return add;
  }

  /** A room's own frame: +z towards the hall. */
  in(room: Room) {
    return this.at(room.center, room.facing);
  }
}

type Add = ReturnType<Kit["at"]>;

/** An office chair whose seat is at `z` behind the desk, turned `turn` from facing it. */
export function officeChair(add: Add, x: number, z: number, turn: number, color: string) {
  const s = Math.sin(turn);
  const c = Math.cos(turn);
  const r = (dx: number, dz: number): [number, number] => [x + dx * c + dz * s, z - dx * s + dz * c];
  const [bx, bz] = r(0, -0.24);
  add("fabric", [x, 0.47, z], [0.5, 0.08, 0.48], turn, color);
  add("fabric", [bx, 0.8, bz], [0.46, 0.55, 0.07], turn, color);
  add("metal", [x, 0.25, z], [0.06, 0.42, 0.06], turn);
  add("metal", [x, 0.05, z], [0.56, 0.04, 0.07], turn);
  add("metal", [x, 0.05, z], [0.07, 0.04, 0.56], turn);
}

/**
 * A desk as the plan has it: a white top on legs, two monitors on the far side facing the person
 * and their chair. Someone standing there has pushed it back to their left, out of the way of a
 * visitor, who stands to their right.
 */
export function deskUnit(kit: Kit, desk: Desk, occupied: boolean, lit: boolean, chair: string) {
  const lead = desk.kind === "lead";
  const w = lead ? 2 : 1.4;
  const add = kit.at(desk.pos, desk.facing);
  add("white", [0, 0.73, 0], [w, 0.04, 0.7]);
  for (const sx of [-1, 1]) add("metal", [sx * (w / 2 - 0.05), 0.36, 0], [0.05, 0.72, 0.62]);
  add("white", [0, 0.9, 0.36], [w, 0.3, 0.02]);
  const screens = lead ? [-0.45, 0.45] : [-0.3, 0.3];
  for (const dx of screens) {
    add("metal", [dx, 0.8, 0.2], [0.06, 0.12, 0.06]);
    add("metal", [dx, 1.03, 0.18], [0.56, 0.34, 0.03]);
    add("screen", [dx, 1.03, 0.163], [0.52, 0.3, 0.005], 0, lit ? "#8fd6a8" : occupied ? "#3a4a5e" : "#1a1e24");
  }
  add("white", [0.1, 0.765, -0.12], [0.42, 0.015, 0.14]);
  if (occupied) officeChair(add, -0.45, -0.95, 0.5, chair);
  else officeChair(add, 0, -0.45, 0, chair);
}

/** A potted plant: a pot and a few leafy clumps above it. */
export function plant(add: Add, x: number, z: number, height = 1.2) {
  add("pot", [x, 0.22, z], [0.42, 0.44, 0.42]);
  add("leaf", [x, 0.44 + height * 0.3, z], [0.7, height * 0.6, 0.7], 0.4);
  add("leaf", [x + 0.08, 0.44 + height * 0.62, z - 0.05], [0.52, height * 0.5, 0.52], 1.1);
  add("leaf", [x - 0.1, 0.44 + height * 0.85, z + 0.06], [0.34, height * 0.34, 0.34], 2.1);
}

/** A sofa facing +z, its middle at x, z. */
export function sofa(add: Add, x: number, z: number, width: number, color: string) {
  add("fabric", [x, 0.22, z], [width, 0.32, 0.86], 0, color);
  add("fabric", [x, 0.47, z + 0.04], [width - 0.36, 0.14, 0.7], 0, color);
  add("fabric", [x, 0.62, z - 0.34], [width, 0.62, 0.2], 0, color);
  for (const sx of [-1, 1]) add("fabric", [x + sx * (width / 2 - 0.1), 0.45, z], [0.2, 0.34, 0.86], 0, color);
}

/** Every box of every finish, as one instanced mesh a finish. */
export function Furniture({ pieces }: { pieces: Pieces }) {
  return (
    <group>
      {(Object.keys(pieces) as Finish[]).map((f) => (pieces[f].length ? <Boxes key={`${f}:${pieces[f].length}`} finish={f} pieces={pieces[f]} /> : null))}
    </group>
  );
}

const unitBox = new BoxGeometry(1, 1, 1);
/** Leaves are round: a ball as wide as the box it stands in for. */
const unitBall = new IcosahedronGeometry(0.5, 1);

function Boxes({ finish, pieces }: { finish: Finish; pieces: Piece[] }) {
  const ref = useRef<InstancedMesh>(null);
  const look = FINISH[finish];
  useLayoutEffect(() => {
    const mesh = ref.current!;
    const o = new Object3D();
    const color = new Color();
    pieces.forEach((p, i) => {
      o.position.set(...p.at);
      o.rotation.set(0, p.yaw, 0);
      o.scale.set(...p.size);
      o.updateMatrix();
      mesh.setMatrixAt(i, o.matrix);
      mesh.setColorAt(i, color.set(p.color ?? look.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [pieces, look]);
  const shadows = look.opacity === undefined && !look.basic;
  return (
    <instancedMesh ref={ref} args={[finish === "leaf" ? unitBall : unitBox, undefined, pieces.length]} castShadow={shadows} receiveShadow={shadows}>
      {look.basic ? (
        <meshBasicMaterial toneMapped={false} />
      ) : (
        <meshStandardMaterial roughness={look.roughness} metalness={look.metalness ?? 0} flatShading={look.flat} transparent={look.opacity !== undefined} opacity={look.opacity ?? 1} depthWrite={look.opacity === undefined} emissive={look.color} emissiveIntensity={look.glow ?? 0} />
      )}
    </instancedMesh>
  );
}

/** Trees round the outside of the building, seen through its windows: a trunk and a crown each, all in two meshes. */
export function Trees({ spots }: { spots: Vec2[] }) {
  const trunk = useMemo(() => new CylinderGeometry(0.12, 0.16, 1.6, 8), []);
  const crown = useMemo(() => new IcosahedronGeometry(1.1, 1), []);
  const trunks = useRef<InstancedMesh>(null);
  const crowns = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const m = new Matrix4();
    spots.forEach(([x, z], i) => {
      const s = 0.85 + ((Math.abs(Math.sin(x * 12.9898 + z * 78.233)) * 43758.5453) % 1) * 0.4;
      trunks.current!.setMatrixAt(i, m.makeTranslation(x, 0.8, z));
      crowns.current!.setMatrixAt(i, m.makeScale(s, s * 1.15, s).setPosition(x, 1.6 + s, z));
    });
    trunks.current!.instanceMatrix.needsUpdate = true;
    crowns.current!.instanceMatrix.needsUpdate = true;
    trunks.current!.computeBoundingSphere();
    crowns.current!.computeBoundingSphere();
  }, [spots]);
  return (
    <group key={spots.length}>
      <instancedMesh ref={trunks} args={[trunk, undefined, spots.length]} castShadow>
        <meshStandardMaterial color="#7a5a40" roughness={0.9} />
      </instancedMesh>
      <instancedMesh ref={crowns} args={[crown, undefined, spots.length]} castShadow>
        <meshStandardMaterial color="#5f9a5a" roughness={0.9} flatShading />
      </instancedMesh>
    </group>
  );
}
