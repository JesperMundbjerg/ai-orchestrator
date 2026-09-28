import { useEffect, useMemo } from "react";
import type { Texture } from "three";
import type { WorldAgent, WorldTeam } from "../../shared/types.ts";
import { textTexture, type Line } from "./label.ts";
import { lookFor } from "./look.ts";
import { teamLine } from "./team.ts";
import { CORRIDOR_Z, DESK, LOUNGE_CENTER, QUEUE_FRONT, QUEUE_ROW, QUEUE_SLANT, type Corner, type Desk, type OfficePlan } from "./layout.ts";

/** The room and its furniture. Nothing here moves on its own; it follows the plan. */
export function Office({ plan, agents, teams, queueLength }: { plan: OfficePlan; agents: Map<string, WorldAgent>; teams: Map<string, WorldTeam>; queueLength: number }) {
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
      {/* The corridor */}
      <mesh rotation-x={-Math.PI / 2} position={[cx, 0.004, CORRIDOR_Z]} receiveShadow>
        <planeGeometry args={[w - 1, 2.2]} />
        <meshStandardMaterial color="#b9c1ca" roughness={0.9} />
      </mesh>
      <Walls minX={minX} maxX={maxX} minZ={minZ} maxZ={maxZ} />
      <YourDesk queueLength={queueLength} />
      <Lounge />
      {plan.corners.map((c) => (
        <TeamCorner key={c.team.id} corner={c} agents={agents} team={teams.get(c.team.id) ?? null} />
      ))}
      {[[-20, 12.5], [20, 12.5], [-20, -2], [20, -2], [7, 12.8], [-8.5, 3]].map(([x, z]) => (
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
function YourDesk({ queueLength }: { queueLength: number }) {
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

function Lounge() {
  const [x, z] = LOUNGE_CENTER;
  const sign = useTexture(
    () => textTexture([{ text: "Lounge", size: 64, color: "#ffffff", weight: 800 }, { text: "agents not in a team", size: 32, color: "#b8c2cc" }], { width: 512, height: 180, background: "#2b3a4a", radius: 24 }),
    [],
  );
  return (
    <group position={[x, 0, z]}>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.006, 0]} receiveShadow>
        <circleGeometry args={[4.6, 48]} />
        <meshStandardMaterial color="#a7b99e" roughness={1} />
      </mesh>
      <mesh position={[0, 0.22, 0]} castShadow>
        <cylinderGeometry args={[0.8, 0.8, 0.44, 32]} />
        <meshStandardMaterial color="#7a5c43" roughness={0.6} />
      </mesh>
      {[0, (2 * Math.PI) / 3, (4 * Math.PI) / 3].map((a) => (
        <group key={a} position={[Math.sin(a) * 3.9, 0, Math.cos(a) * 3.9]} rotation-y={a + Math.PI}>
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
      <mesh position={[-4.9, 2.2, 0]} rotation-y={Math.PI / 2}>
        <planeGeometry args={[1.8, 0.63]} />
        <meshBasicMaterial map={sign} toneMapped={false} side={2} />
      </mesh>
    </group>
  );
}

function TeamCorner({ corner, agents, team: live }: { corner: Corner; agents: Map<string, WorldAgent>; team: WorldTeam | null }) {
  const { team, center, desks, members } = corner;
  const [cx, cz] = center;
  const tint = useMemo(() => lookFor(team.id).shirt, [team.id]);
  const status = live ? teamLine(live, agents) : { text: "", color: "#8b95a3" };
  const lines: Line[] = [
    { text: team.name, size: 72, color: "#ffffff", weight: 800 },
    { text: `${team.structure === "dispatch" ? "Lead + crew" : "Peers around one table"} · ${members.length} ${members.length === 1 ? "agent" : "agents"}`, size: 34, color: "#b8c2cc", weight: 500 },
    { text: status.text, size: 34, color: status.color, weight: 600 },
  ];
  const board = useTexture(() => textTexture(lines, { width: 1024, height: 360, background: "#141a22", radius: 28 }), [JSON.stringify(lines)]);
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[cx, 0.005, cz]} receiveShadow>
        <planeGeometry args={[10.4, 9]} />
        <meshStandardMaterial color={tint} roughness={1} transparent opacity={0.28} />
      </mesh>
      {team.structure === "dispatch" ? (
        <group position={[cx, 0, cz - 4]}>
          {/* The big wall screen the crew faces, high enough to read over their heads */}
          <mesh position={[0, 3.3, 0]} castShadow>
            <boxGeometry args={[7.2, 2.7, 0.12]} />
            <meshStandardMaterial color="#0e1116" />
          </mesh>
          <mesh position={[0, 3.3, 0.07]}>
            <planeGeometry args={[6.9, 2.43]} />
            <meshBasicMaterial map={board} toneMapped={false} />
          </mesh>
          {[-3, 3].map((dx) => (
            <mesh key={dx} position={[dx, 1, 0]}>
              <boxGeometry args={[0.12, 2, 0.12]} />
              <meshStandardMaterial color="#2c3440" />
            </mesh>
          ))}
        </group>
      ) : (
        <group position={[cx, 0, cz]}>
          <mesh position={[0, 0.74, 0]} castShadow receiveShadow>
            <cylinderGeometry args={[1.4, 1.4, 0.06, 40]} />
            <meshStandardMaterial color="#e8e1d5" roughness={0.5} />
          </mesh>
          <mesh position={[0, 0.37, 0]}>
            <cylinderGeometry args={[0.12, 0.3, 0.74, 16]} />
            <meshStandardMaterial color="#6b7280" />
          </mesh>
          {/* A standing board with the team's name */}
          <group position={[0, 0, -4.1]}>
            <mesh position={[0, 1.1, 0]}>
              <cylinderGeometry args={[0.04, 0.04, 2.2, 8]} />
              <meshStandardMaterial color="#6b7280" />
            </mesh>
            <mesh position={[0, 2.3, 0.03]}>
              <planeGeometry args={[2.9, 1.02]} />
              <meshBasicMaterial map={board} toneMapped={false} side={2} />
            </mesh>
          </group>
        </group>
      )}
      {desks.map((desk, i) => (
        <DeskUnit key={i} desk={desk} working={desk.occupantId ? agents.get(desk.occupantId)?.status === "working" : false} round={team.structure === "circle"} />
      ))}
    </group>
  );
}

function DeskUnit({ desk, working, round }: { desk: Desk; working: boolean; round: boolean }) {
  const [x, z] = desk.pos;
  if (round) {
    // At the round table a place is a laptop on the tabletop.
    return (
      <group position={[x, 0.77, z]} rotation-y={desk.facing}>
        <mesh position={[0, 0.01, 0]}>
          <boxGeometry args={[0.36, 0.02, 0.25]} />
          <meshStandardMaterial color="#9aa3ad" metalness={0.5} roughness={0.4} />
        </mesh>
        <mesh position={[0, 0.13, 0.12]} rotation-x={0.25}>
          <boxGeometry args={[0.36, 0.24, 0.015]} />
          <meshStandardMaterial color="#9aa3ad" metalness={0.5} roughness={0.4} />
        </mesh>
        <mesh position={[0, 0.13, 0.104]} rotation={[0.25, Math.PI, 0]}>
          <planeGeometry args={[0.32, 0.2]} />
          <meshBasicMaterial color={working ? "#3ddc84" : desk.occupantId ? "#2d3a4a" : "#1b1f24"} toneMapped={false} />
        </mesh>
      </group>
    );
  }
  const lead = desk.kind === "lead";
  return (
    <group position={[x, 0, z]} rotation-y={desk.facing + Math.PI}>
      <mesh position={[0, 0.74, 0]} castShadow receiveShadow>
        <boxGeometry args={[lead ? 2 : 1.4, 0.06, 0.7]} />
        <meshStandardMaterial color={lead ? "#3a4656" : "#4a5566"} roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.37, -0.25]}>
        <boxGeometry args={[lead ? 1.9 : 1.3, 0.72, 0.05]} />
        <meshStandardMaterial color="#2c3440" />
      </mesh>
      {(lead ? [-0.55, 0, 0.55] : [-0.3, 0.3]).map((dx) => (
        <Monitor key={dx} position={[dx, 0.77, -0.15]} rotation={0} lit={working} color={lead ? "#5b9dff" : "#3ddc84"} dim={!!desk.occupantId} />
      ))}
    </group>
  );
}

function Monitor({ position, rotation, lit, color, dim = true }: { position: [number, number, number]; rotation: number; lit: boolean; color: string; dim?: boolean }) {
  return (
    <group position={position} rotation-y={rotation}>
      <mesh position={[0, 0.06, 0]}>
        <boxGeometry args={[0.12, 0.12, 0.08]} />
        <meshStandardMaterial color="#1b1f24" />
      </mesh>
      <mesh position={[0, 0.3, 0]} castShadow>
        <boxGeometry args={[0.52, 0.32, 0.03]} />
        <meshStandardMaterial color="#15181d" />
      </mesh>
      <mesh position={[0, 0.3, 0.017]}>
        <planeGeometry args={[0.48, 0.28]} />
        <meshBasicMaterial color={lit ? color : dim ? "#2d3a4a" : "#16191e"} toneMapped={false} />
      </mesh>
    </group>
  );
}

function Plant({ x, z }: { x: number; z: number }) {
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

/** A texture made once per key and disposed when replaced. */
function useTexture(make: () => Texture, deps: unknown[]): Texture {
  const texture = useMemo(make, deps);
  useEffect(() => () => texture.dispose(), [texture]);
  return texture;
}
