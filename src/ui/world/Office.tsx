import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group, Texture } from "three";
import type { Work, WorldAgent, WorldTeam } from "../../shared/types.ts";
import { textTexture } from "./label.ts";
import { lookFor } from "./look.ts";
import { studio } from "./crafts.ts";
import { Crafts } from "./Crafts.tsx";
import { teamBoard } from "./corkboard.ts";
import { CorkBoard } from "./CorkBoard.tsx";
import { CORNER_HALF_DEPTH, CORNER_HALF_WIDTH, DESK, LOUNGE_SOFAS, LOUNGE_TABLE, pipelineLane, pipelines, QUEUE_FRONT, QUEUE_ROW, QUEUE_SLANT, type Corner, type OfficePlan, type Vec2 } from "./layout.ts";

/** The room and its furniture. Nothing here moves on its own; it follows the plan. */
export function Office({ plan, agents, teams, work, queueLength }: { plan: OfficePlan; agents: Map<string, WorldAgent>; teams: Map<string, WorldTeam>; work: Work[]; queueLength: number }) {
  const { minX, maxX, minZ, maxZ } = plan.bounds;
  const w = maxX - minX;
  const d = maxZ - minZ;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[cx, 0, cz]} receiveShadow>
        <planeGeometry args={[w, d]} />
        <meshStandardMaterial color="#cfd5dc" roughness={0.95} />
      </mesh>
      <gridHelper args={[Math.max(w, d), Math.round(Math.max(w, d) / 2), "#bcc3cc", "#c5ccd4"]} position={[cx, 0.002, cz]} />
      {/* The walkway around your desk, and the lane handed-over work runs along */}
      <mesh rotation-x={-Math.PI / 2} position={[DESK[0], 0.004, DESK[1]]} receiveShadow>
        <ringGeometry args={[plan.path - 1.1, plan.path + 0.6, 96]} />
        <meshStandardMaterial color="#b9c1ca" roughness={0.9} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[DESK[0], 0.004, DESK[1]]}>
        <ringGeometry args={[pipelineLane(plan) - 0.3, pipelineLane(plan) + 0.3, 96]} />
        <meshStandardMaterial color="#c3cad2" roughness={0.9} />
      </mesh>
      <Walls minX={minX} maxX={maxX} minZ={minZ} maxZ={maxZ} />
      <YourDesk queueLength={queueLength} />
      <Lounge center={plan.lounge.center} facing={plan.lounge.facing} />
      {plan.corners.map((c) => (
        <TeamCorner key={c.team.id} corner={c} agents={agents} teams={teams} work={work} />
      ))}
      <Crafts stations={studio(plan.corners)} agents={agents} />
      {pipelines(plan).map((p) => (
        <Pipeline key={p.fromTeamId} path={p.path} busy={work.some((w) => w.fromTeamId === p.fromTeamId && w.toTeamId === p.toTeamId && w.state === "in_review")} />
      ))}
      {[[minX + 1.5, minZ + 1.5], [maxX - 1.5, minZ + 1.5], [minX + 1.5, maxZ - 1.5], [maxX - 1.5, maxZ - 1.5]].map(([x, z]) => (
        <Plant key={`${x},${z}`} x={x!} z={z!} />
      ))}
    </group>
  );
}

function Walls({ minX, maxX, minZ, maxZ }: { minX: number; maxX: number; minZ: number; maxZ: number }) {
  const h = 3.2;
  const wall = <meshStandardMaterial color="#e9ecef" roughness={0.9} />;
  const sides: Array<[number, number, number, number]> = [
    [(minX + maxX) / 2, minZ, maxX - minX, 0],
    [(minX + maxX) / 2, maxZ, maxX - minX, 0],
    [minX, (minZ + maxZ) / 2, maxZ - minZ, Math.PI / 2],
    [maxX, (minZ + maxZ) / 2, maxZ - minZ, Math.PI / 2],
  ];
  return (
    <group>
      {sides.map(([x, z, len, rot], i) => (
        <group key={i} position={[x, 0, z]} rotation-y={rot}>
          <mesh position={[0, h / 2, 0]} receiveShadow>
            <boxGeometry args={[len, h, 0.2]} />
            {wall}
          </mesh>
          {/* A band of windows */}
          <mesh position={[0, 1.9, i % 2 ? -0.11 : 0.11]} rotation-y={i === 1 || i === 3 ? Math.PI : 0}>
            <planeGeometry args={[len - 2, 1.1]} />
            <meshStandardMaterial color="#a9c8e8" emissive="#a9c8e8" emissiveIntensity={0.35} roughness={0.2} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** Your desk, with the rope lane the queue forms in. */
export function YourDesk({ queueLength }: { queueLength: number }) {
  const sign = useTexture(
    () => textTexture(
      [
        { text: "Your desk", size: 64, color: "#ffffff", weight: 800 },
        { text: queueLength ? `${queueLength} waiting in line` : "Nobody is waiting", size: 38, color: queueLength ? "#ffc658" : "#b8c2cc", weight: 600 },
      ],
      { width: 640, height: 220, background: "#1d2530", radius: 24 },
    ),
    [queueLength],
  );
  const [x, z] = DESK;
  const pitch = 1.05;
  const length = pitch * (QUEUE_ROW - 1) + 1.1;
  // The lane runs along the slanted line, from just behind the desk towards the corridor.
  const laneYaw = Math.atan2(QUEUE_SLANT, pitch);
  const laneMid: [number, number] = [QUEUE_FRONT[0] + (QUEUE_SLANT * (QUEUE_ROW - 1)) / 2, QUEUE_FRONT[1] + 0.3 - length / 2];
  return (
    <group>
      <group position={[x, 0, z]}>
        <mesh position={[0, 0.74, 0]} castShadow receiveShadow>
          <boxGeometry args={[2.6, 0.06, 0.9]} />
          <meshStandardMaterial color="#8a6a4f" roughness={0.6} />
        </mesh>
        {[-1.2, 1.2].map((dx) => (
          <mesh key={dx} position={[dx, 0.37, 0]} castShadow>
            <boxGeometry args={[0.08, 0.74, 0.8]} />
            <meshStandardMaterial color="#5c4636" />
          </mesh>
        ))}
        {/* The sign faces the line; from your side of the desk the top bar says the same. */}
        <mesh position={[0, 0.42, -0.46]} rotation-y={Math.PI}>
          <planeGeometry args={[1.5, 0.52]} />
          <meshBasicMaterial map={sign} toneMapped={false} />
        </mesh>
      </group>
      {/* Queue lane: a carpet between two rope lines */}
      <group position={[laneMid[0], 0, laneMid[1]]} rotation-y={-laneYaw}>
        {[-0.75, 0.75].map((dx) => (
          <group key={dx}>
            {Array.from({ length: QUEUE_ROW }, (_, i) => (
              <mesh key={i} position={[dx, 0.45, length / 2 - 0.2 - i * (length - 0.4) / (QUEUE_ROW - 1)]} castShadow>
                <cylinderGeometry args={[0.035, 0.05, 0.9, 10]} />
                <meshStandardMaterial color="#c9a227" metalness={0.6} roughness={0.35} />
              </mesh>
            ))}
            <mesh position={[dx, 0.82, 0]}>
              <boxGeometry args={[0.03, 0.04, length - 0.4]} />
              <meshStandardMaterial color="#9e2a2b" />
            </mesh>
          </group>
        ))}
        <mesh rotation-x={-Math.PI / 2} position={[0, 0.006, 0]}>
          <planeGeometry args={[1.4, length]} />
          <meshStandardMaterial color="#e2c979" roughness={0.9} />
        </mesh>
      </group>
    </group>
  );
}

/** The lounge takes a place on the ring like a corner, open towards your desk; in the building it is a room as deep as the bays. */
export function Lounge({ center, facing, halfDepth = CORNER_HALF_DEPTH }: { center: Vec2; facing: number; halfDepth?: number }) {
  const [x, z] = center;
  const sign = useTexture(
    () => textTexture([{ text: "Lounge", size: 64, color: "#ffffff", weight: 800 }, { text: "agents not on a project", size: 32, color: "#b8c2cc" }], { width: 512, height: 180, background: "#2b3a4a", radius: 24 }),
    [],
  );
  return (
    <group position={[x, 0, z]} rotation-y={facing}>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.006, 0]} receiveShadow>
        <circleGeometry args={[4.4, 48]} />
        <meshStandardMaterial color="#a7b99e" roughness={1} />
      </mesh>
      <mesh position={[0, 0.22, 0]} castShadow>
        <cylinderGeometry args={[LOUNGE_TABLE, LOUNGE_TABLE, 0.44, 32]} />
        <meshStandardMaterial color="#7a5c43" roughness={0.6} />
      </mesh>
      {/* No sofa on the side facing your desk, so the way in is open. */}
      {LOUNGE_SOFAS.map((a) => (
        <group key={a} position={[Math.sin(a) * 3.7, 0, Math.cos(a) * 3.7]} rotation-y={a + Math.PI}>
          <mesh position={[0, 0.25, 0]} castShadow>
            <boxGeometry args={[2.2, 0.5, 0.8]} />
            <meshStandardMaterial color="#5a6f8c" roughness={0.9} />
          </mesh>
          <mesh position={[0, 0.65, -0.32]} castShadow>
            <boxGeometry args={[2.2, 0.6, 0.18]} />
            <meshStandardMaterial color="#4d6079" roughness={0.9} />
          </mesh>
        </group>
      ))}
      <mesh position={[0, 2.2, -(halfDepth - 0.1)]}>
        <planeGeometry args={[1.8, 0.63]} />
        <meshBasicMaterial map={sign} toneMapped={false} side={2} />
      </mesh>
    </group>
  );
}

/** A team's corner of the ring, or its bay in the building, which is as wide and deep as `half` says. */
export function TeamCorner({ corner, agents, teams, work, half = [CORNER_HALF_WIDTH, CORNER_HALF_DEPTH] }: { corner: Corner; agents: Map<string, WorldAgent>; teams: Map<string, WorldTeam>; work: Work[]; half?: Vec2 }) {
  const { team, center, facing } = corner;
  const [cx, cz] = center;
  const tint = useMemo(() => lookFor(team.id).shirt, [team.id]);
  const board = teamBoard(corner, agents, teams, work);
  return (
    <group>
      {/* Turned so its open side faces your desk; the board is at the back, facing you. */}
      <group position={[cx, 0, cz]} rotation-y={facing}>
        <mesh rotation-x={-Math.PI / 2} position={[0, 0.005, 0]} receiveShadow>
          <planeGeometry args={[half[0] * 2, half[1] * 2]} />
          <meshStandardMaterial color={tint} roughness={1} transparent opacity={0.28} />
        </mesh>
        <group position={[0, 0, 0.5 - half[1]]}>
          {/* The crew's corkboard on two wooden legs, high enough to read over their heads and name tags */}
          <CorkBoard board={board} width={6} position={[0, 4.15, 0]} />
          {[-2.6, 2.6].map((dx) => (
            <group key={dx}>
              <mesh position={[dx, 1.45, -0.08]} castShadow>
                <boxGeometry args={[0.14, 2.9, 0.14]} />
                <meshStandardMaterial color="#7a4f2e" roughness={0.8} />
              </mesh>
              <mesh position={[dx, 0.04, -0.08]}>
                <boxGeometry args={[0.2, 0.08, 0.9]} />
                <meshStandardMaterial color="#6b4428" roughness={0.8} />
              </mesh>
            </group>
          ))}
        </group>
      </group>
    </group>
  );
}

export function Plant({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 0.3, 0]} castShadow>
        <cylinderGeometry args={[0.28, 0.22, 0.6, 16]} />
        <meshStandardMaterial color="#b0673f" roughness={0.8} />
      </mesh>
      {[[0, 1.0, 0, 0.45], [0.2, 1.35, 0.1, 0.32], [-0.18, 1.3, -0.1, 0.3]].map(([dx, y, dz, r], i) => (
        <mesh key={i} position={[dx!, y!, dz!]} castShadow>
          <icosahedronGeometry args={[r!, 1]} />
          <meshStandardMaterial color="#3f7d4e" roughness={0.9} flatShading />
        </mesh>
      ))}
    </group>
  );
}

const CHEVRON_GAP = 0.9;

/** Arrows on the floor flowing from one team to the team it hands its work to; brighter while work is in review. */
export function Pipeline({ path, busy }: { path: Vec2[]; busy: boolean }) {
  const segments = useMemo(() => path.slice(1).map((p, i) => {
    const a = path[i]!;
    return { a, dx: p[0] - a[0], dz: p[1] - a[1], len: Math.hypot(p[0] - a[0], p[1] - a[1]) };
  }), [path]);
  const total = segments.reduce((s, x) => s + x.len, 0);
  const count = Math.max(1, Math.floor(total / CHEVRON_GAP));
  const chevrons = useRef<Array<Group | null>>([]);

  useFrame((state) => {
    const shift = (state.clock.elapsedTime * (busy ? 1.2 : 0.5)) % CHEVRON_GAP;
    for (let i = 0; i < count; i++) {
      const g = chevrons.current[i];
      if (!g) continue;
      let d = i * CHEVRON_GAP + shift;
      let seg = segments[0]!;
      for (const s of segments) {
        seg = s;
        if (d <= s.len) break;
        d -= s.len;
      }
      const t = Math.min(1, d / seg.len);
      g.position.set(seg.a[0] + seg.dx * t, 0.012, seg.a[1] + seg.dz * t);
      g.rotation.y = Math.atan2(-seg.dz, seg.dx);
    }
  });

  return (
    <group>
      {Array.from({ length: count }, (_, i) => (
        <group key={i} ref={(g) => void (chevrons.current[i] = g)}>
          <mesh rotation-x={-Math.PI / 2}>
            <circleGeometry args={[0.2, 3]} />
            <meshBasicMaterial color={busy ? "#3b6fe0" : "#7d8fa8"} transparent opacity={busy ? 0.85 : 0.5} toneMapped={false} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** A texture made once per key and disposed when replaced. */
export function useTexture(make: () => Texture, deps: unknown[]): Texture {
  const texture = useMemo(make, deps);
  useEffect(() => () => texture.dispose(), [texture]);
  return texture;
}
