import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import { BoxGeometry, Color, CylinderGeometry, Euler, IcosahedronGeometry, Matrix4, Quaternion, Vector3, type BufferGeometry, type Group, type InstancedMesh } from "three";
import type { WorldAgent } from "../../shared/types.ts";
import { onFloor, pieceParts, stageAt, startSeconds, stationParts, type Craft, type Part, type Shape, type Station, type Stuff } from "./crafts.ts";

// The team rooms' craft stations as a few instanced meshes: every part of one shape and stuff,
// however many stations there are, is one draw call. What stays is drawn once; the pieces being
// made are drawn again only when one of them grows a stage, and a potter's wheel turns while
// they work.

const GEOMETRY: Record<Shape, BufferGeometry> = {
  box: new BoxGeometry(1, 1, 1),
  round: new CylinderGeometry(0.5, 0.5, 1, 18),
  ball: new IcosahedronGeometry(0.5, 2),
};

const STUFF: Record<Stuff, { roughness: number; metalness?: number }> = {
  wood: { roughness: 0.6 },
  matte: { roughness: 0.85 },
  metal: { roughness: 0.4, metalness: 0.35 },
  clay: { roughness: 0.95 },
  cloth: { roughness: 0.9 },
};

/** How many seconds each station's maker has put in, kept while the office is open, across layouts. */
const worked = new Map<string, number>();
const secondsOn = (s: Station) => worked.get(s.key) ?? startSeconds(s);

/** A part on a station, placed on the floor. */
interface Placed {
  part: Part;
  station: Station;
}

export function Crafts({ stations: given, agents }: { stations: Station[]; agents: Map<string, WorldAgent> }) {
  // The plan is made again whenever the world changes; the stations are only drawn again when one moves or changes hands.
  const same = useRef<{ sign: string; stations: Station[] }>({ sign: "", stations: [] });
  const sign = given.map((s) => `${s.key}@${s.desk.pos[0].toFixed(3)},${s.desk.pos[1].toFixed(3)},${s.desk.facing.toFixed(3)},${s.desk.scale}:${s.craft}`).join("|");
  if (sign !== same.current.sign) same.current = { sign, stations: given };
  const stations = same.current.stations;
  const busy = useRef<Set<string>>(new Set());
  busy.current = new Set([...agents.values()].filter((a) => a.status === "working").map((a) => a.id));
  const fixed = useMemo(() => stations.flatMap((station) => stationParts(station.craft, station.lead).map((part) => ({ part, station }))), [stations]);
  const [stages, setStages] = useState<string>("");

  // Makers at work put the time in; a piece that grows a stage has the pieces drawn again.
  useFrame((_, dt) => {
    const step = Math.min(dt, 0.1);
    let next = "";
    for (const s of stations) {
      const id = s.desk.occupantId;
      if (id && busy.current.has(id)) worked.set(s.key, secondsOn(s) + step);
      next += `${stageAt(s.craft, secondsOn(s))},`;
    }
    if (next !== stages) setStages(next);
  });
  const pieces = useMemo(() => {
    const at = stages.split(",");
    return stations.flatMap((station, i) => pieceParts(station.craft, station.lead, Number(at[i] ?? 0), station.seed).map((part) => ({ part, station })));
  }, [stations, stages]);

  return (
    <group>
      <PartMeshes placed={fixed} busy={busy} />
      <PartMeshes placed={pieces} busy={busy} />
    </group>
  );
}

/** Parts grouped by shape and stuff, one instanced mesh a group. */
function PartMeshes({ placed, busy }: { placed: Placed[]; busy: RefObject<Set<string>> }) {
  const groups = useMemo(() => {
    const out = new Map<string, Placed[]>();
    for (const p of placed) {
      const k = `${p.part.shape}:${p.part.stuff}`;
      out.set(k, [...(out.get(k) ?? []), p]);
    }
    return [...out.entries()];
  }, [placed]);
  return (
    <group>
      {groups.map(([k, list]) => (
        <Instanced key={`${k}:${list.length}`} placed={list} busy={busy} />
      ))}
    </group>
  );
}

const matrix = new Matrix4();
const position = new Vector3();
const quaternion = new Quaternion();
const scale = new Vector3();
const euler = new Euler(0, 0, 0, "YXZ");

/** Where a part stands on the floor: its station's place and turn, and the station's scale across the floor. */
function place(p: Placed, spin: number) {
  const { part, station } = p;
  const { desk } = station;
  let [x, , z] = part.at;
  if (spin) [x, z] = [x * Math.cos(spin) + z * Math.sin(spin), -x * Math.sin(spin) + z * Math.cos(spin)];
  const [wx, wz] = onFloor(desk, [x, z]);
  position.set(wx, part.at[1], wz);
  euler.set(part.tilt ?? 0, desk.facing + (part.turn ?? 0) + spin, part.roll ?? 0);
  quaternion.setFromEuler(euler);
  scale.set(part.size[0] * desk.scale, part.size[1], part.size[2] * desk.scale);
  return matrix.compose(position, quaternion, scale);
}

function Instanced({ placed, busy }: { placed: Placed[]; busy: RefObject<Set<string>> }) {
  const ref = useRef<InstancedMesh>(null);
  const { shape, stuff } = placed[0]!.part;
  const spinning = useMemo(() => placed.map((p, i) => (p.part.spin ? i : -1)).filter((i) => i >= 0), [placed]);
  useLayoutEffect(() => {
    const mesh = ref.current!;
    const color = new Color();
    placed.forEach((p, i) => {
      mesh.setMatrixAt(i, place(p, 0));
      mesh.setColorAt(i, color.set(p.part.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [placed]);
  // The wheels of potters at work turn.
  const spin = useRef(new Map<number, number>());
  useFrame((_, dt) => {
    const mesh = ref.current;
    if (!mesh || !spinning.length) return;
    let moved = false;
    for (const i of spinning) {
      const p = placed[i]!;
      if (!p.station.desk.occupantId || !busy.current?.has(p.station.desk.occupantId)) continue;
      const a = (spin.current.get(i) ?? 0) + Math.min(dt, 0.1) * 7;
      spin.current.set(i, a);
      mesh.setMatrixAt(i, place(p, a));
      moved = true;
    }
    if (moved) mesh.instanceMatrix.needsUpdate = true;
  });
  const look = STUFF[stuff];
  return (
    <instancedMesh ref={ref} args={[GEOMETRY[shape], undefined, placed.length]} castShadow receiveShadow>
      <meshStandardMaterial roughness={look.roughness} metalness={look.metalness ?? 0} />
    </instancedMesh>
  );
}

/**
 * What a maker holds in their right hand while they work, in the hand's frame (the arm hangs
 * along -y, the hand at its end): a saw or a hammer, a brush, a mallet, a shuttle; a potter's
 * hands are on the clay. `hammer` is shown instead of `saw` while a woodworker hammers.
 */
export function HandTool({ craft, tool, saw, hammer }: { craft: Craft; tool: RefObject<Group | null>; saw: RefObject<Group | null>; hammer: RefObject<Group | null> }) {
  const handle = <meshStandardMaterial color="#7a5a40" roughness={0.7} />;
  const steel = <meshStandardMaterial color="#b8bec6" roughness={0.35} metalness={0.5} />;
  return (
    <group ref={tool} position={[0, -0.56, 0]} visible={false}>
      {craft === "woodwork" ? (
        <>
          <group ref={saw}>
            <mesh position={[0, 0, 0.02]}>
              <boxGeometry args={[0.04, 0.09, 0.1]} />
              {handle}
            </mesh>
            <mesh position={[0, -0.24, 0.04]}>
              <boxGeometry args={[0.008, 0.4, 0.1]} />
              {steel}
            </mesh>
          </group>
          <group ref={hammer} visible={false}>
            <mesh position={[0, 0, 0.12]} rotation-x={Math.PI / 2}>
              <cylinderGeometry args={[0.016, 0.016, 0.28, 8]} />
              {handle}
            </mesh>
            <mesh position={[0, 0, 0.26]}>
              <boxGeometry args={[0.04, 0.13, 0.05]} />
              {steel}
            </mesh>
          </group>
        </>
      ) : craft === "painting" ? (
        <group>
          <mesh position={[0, -0.1, 0.02]}>
            <cylinderGeometry args={[0.009, 0.009, 0.24, 6]} />
            {handle}
          </mesh>
          <mesh position={[0, -0.23, 0.02]}>
            <coneGeometry args={[0.014, 0.04, 6]} />
            <meshStandardMaterial color="#d9534f" roughness={0.6} />
          </mesh>
        </group>
      ) : craft === "sculpture" ? (
        <group>
          <mesh position={[0, 0, 0.1]} rotation-x={Math.PI / 2}>
            <cylinderGeometry args={[0.015, 0.015, 0.22, 8]} />
            {handle}
          </mesh>
          <mesh position={[0, 0, 0.22]}>
            <cylinderGeometry args={[0.045, 0.045, 0.1, 10]} />
            <meshStandardMaterial color="#9c7a55" roughness={0.7} />
          </mesh>
        </group>
      ) : craft === "weaving" ? (
        <mesh position={[0, -0.02, 0.02]}>
          <boxGeometry args={[0.3, 0.025, 0.05]} />
          <meshStandardMaterial color="#c8a171" roughness={0.6} />
        </mesh>
      ) : null}
    </group>
  );
}

/** How a maker's arms move at their craft, t in seconds: the rotations of the left and right arm (about x, then z) and the lean of the upper body. */
export function craftPose(craft: Craft, t: number): { left: [number, number]; right: [number, number]; lean: number; hammering: boolean } {
  switch (craft) {
    case "woodwork": {
      // Saw a while, then hammer a while.
      const hammering = t % 10 > 6;
      if (hammering) return { left: [-0.75, 0.1], right: [-1.25 - Math.max(0, Math.sin(t * 7)) * 0.7, 0], lean: 0.15, hammering };
      return { left: [-0.8, 0.15], right: [-0.95 + Math.sin(t * 6) * 0.28, 0], lean: 0.12 + Math.sin(t * 6) * 0.04, hammering };
    }
    case "painting":
      // The brush on the canvas in short strokes, the palette held in the left hand.
      return { left: [-0.65, 0.2], right: [-1.35 + Math.sin(t * 3.1) * 0.12, -0.1 + Math.sin(t * 1.7) * 0.18], lean: 0.02, hammering: false };
    case "pottery":
      // Bent over the wheel, both hands on the clay.
      return { left: [-0.95 + Math.sin(t * 2) * 0.03, 0.2], right: [-0.95 + Math.sin(t * 2 + 1) * 0.03, -0.2], lean: 0.32, hammering: false };
    case "sculpture":
      // A chisel held to the stone, the mallet tapping it.
      return { left: [-1.2, 0.15], right: [-1.15 - Math.max(0, Math.sin(t * 6)) * 0.45, -0.2], lean: 0.08, hammering: false };
    case "weaving": {
      // The shuttle passed across the loom and the row beaten down.
      const across = Math.sin(t * 1.6);
      return { left: [-1.05 + Math.max(0, -across) * 0.2, 0.15], right: [-1.05, -0.35 * across], lean: 0.05, hammering: false };
    }
  }
}
