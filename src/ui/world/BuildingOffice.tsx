import type { Work, WorldAgent, WorldTeam } from "../../shared/types.ts";
import { textTexture } from "./label.ts";
import { buildingPipelines, type BuildingPlan, type Rect, type Room, type Wall } from "./building.ts";
import { Lounge, Pipeline, Plant, TeamCorner, useTexture, YourDesk } from "./Office.tsx";

/** High enough for the bays' big screens, which hang over the crew's heads. */
const WALL_H = 5.4;

/** The office as one building: the hall round your desk, a glass-fronted bay per team, the lounge and meeting rooms. */
export function BuildingOffice({ plan, agents, teams, work, queueLength }: { plan: BuildingPlan; agents: Map<string, WorldAgent>; teams: Map<string, WorldTeam>; work: Work[]; queueLength: number }) {
  const { outline, hall, loop, lane } = plan;
  const bays = new Map(plan.rooms.filter((r) => r.teamId).map((r) => [r.teamId!, r]));
  const lounge = plan.rooms.find((r) => r.kind === "lounge")!;
  // The squares where the east and west rooms meet the north and south ones are closed off: plants there.
  const nooks: Array<[number, number]> = [
    [(outline.minX + hall.minX) / 2, (outline.minZ + hall.minZ) / 2], [(outline.maxX + hall.maxX) / 2, (outline.minZ + hall.minZ) / 2],
    [(outline.minX + hall.minX) / 2, (outline.maxZ + hall.maxZ) / 2], [(outline.maxX + hall.maxX) / 2, (outline.maxZ + hall.maxZ) / 2],
  ];
  return (
    <group>
      <Floor rect={plan.bounds} y={-0.01} color="#c3cfbb" />
      <Floor rect={outline} y={0} color="#d9dde2" shadows />
      <Floor rect={hall} y={0.002} color="#cfd5dc" />
      <Frame rect={loop} width={1.3} y={0.004} color="#b9c1ca" />
      <Frame rect={lane} width={0.6} y={0.005} color="#c3cad2" />
      {plan.walls.map((w, i) => (w.outer ? <OuterWall key={i} wall={w} /> : <GlassWall key={i} wall={w} />))}
      <FrontDoor plan={plan} />
      <YourDesk queueLength={queueLength} />
      <Lounge center={lounge.center} facing={lounge.facing} halfDepth={lounge.half[1]} />
      {plan.corners.map((c) => (
        <TeamCorner key={c.team.id} corner={c} agents={agents} teams={teams} work={work} half={bays.get(c.team.id)!.half} />
      ))}
      {plan.rooms.filter((r) => r.kind === "bay" && !r.teamId).map((r, i) => <EmptyBay key={i} room={r} />)}
      {plan.rooms.filter((r) => r.kind === "meeting").map((r, i) => <MeetingRoom key={i} room={r} n={i + 1} />)}
      {buildingPipelines(plan).map((p) => (
        <Pipeline key={p.fromTeamId} path={p.path} busy={work.some((w) => w.fromTeamId === p.fromTeamId && w.toTeamId === p.toTeamId && w.state === "in_review")} />
      ))}
      {nooks.map(([x, z]) => (
        <Plant key={`${x},${z}`} x={x} z={z} />
      ))}
    </group>
  );
}

function Floor({ rect, y, color, shadows = false }: { rect: Rect; y: number; color: string; shadows?: boolean }) {
  return (
    <mesh rotation-x={-Math.PI / 2} position={[(rect.minX + rect.maxX) / 2, y, (rect.minZ + rect.maxZ) / 2]} receiveShadow={shadows}>
      <planeGeometry args={[rect.maxX - rect.minX, rect.maxZ - rect.minZ]} />
      <meshStandardMaterial color={color} roughness={0.95} />
    </mesh>
  );
}

/** A band on the floor along a rectangle's edge: the walkway round the hall, or the lane the work runs along. */
function Frame({ rect, width, y, color }: { rect: Rect; width: number; y: number; color: string }) {
  const { minX, maxX, minZ, maxZ } = rect;
  const bands: Array<[number, number, number, number]> = [
    [(minX + maxX) / 2, minZ, maxX - minX + width, width],
    [(minX + maxX) / 2, maxZ, maxX - minX + width, width],
    [minX, (minZ + maxZ) / 2, width, maxZ - minZ - width],
    [maxX, (minZ + maxZ) / 2, width, maxZ - minZ - width],
  ];
  return (
    <group>
      {bands.map(([x, z, w, d], i) => (
        <mesh key={i} rotation-x={-Math.PI / 2} position={[x, y, z]} receiveShadow>
          <planeGeometry args={[w, d]} />
          <meshStandardMaterial color={color} roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
}

/** Where a wall stands and which way it runs. */
function span({ a, b }: Wall) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  return { x: (a[0] + b[0]) / 2, z: (a[1] + b[1]) / 2, length: Math.hypot(dx, dz), yaw: Math.atan2(-dz, dx) };
}

function OuterWall({ wall }: { wall: Wall }) {
  const { x, z, length, yaw } = span(wall);
  return (
    <group position={[x, 0, z]} rotation-y={yaw}>
      <mesh position={[0, WALL_H / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[length + 0.3, WALL_H, 0.3]} />
        <meshStandardMaterial color="#e9ecef" roughness={0.9} />
      </mesh>
      {length > 2.5 ? (
        <mesh position={[0, 2.4, 0]}>
          <boxGeometry args={[length - 1.6, 1.7, 0.34]} />
          <meshStandardMaterial color="#a9c8e8" emissive="#a9c8e8" emissiveIntensity={0.35} roughness={0.2} />
        </mesh>
      ) : null}
    </group>
  );
}

/** The rooms' walls: a low solid skirting and glass above it, so you see into every room from the hall. */
function GlassWall({ wall }: { wall: Wall }) {
  const { x, z, length, yaw } = span(wall);
  return (
    <group position={[x, 0, z]} rotation-y={yaw}>
      <mesh position={[0, 0.45, 0]} castShadow receiveShadow>
        <boxGeometry args={[length + 0.12, 0.9, 0.12]} />
        <meshStandardMaterial color="#dfe3e8" roughness={0.8} />
      </mesh>
      <mesh position={[0, 0.9 + (WALL_H - 0.9) / 2, 0]}>
        <boxGeometry args={[length, WALL_H - 0.9, 0.05]} />
        <meshStandardMaterial color="#cfe3f5" transparent opacity={0.16} roughness={0.1} depthWrite={false} />
      </mesh>
      <mesh position={[0, WALL_H, 0]}>
        <boxGeometry args={[length + 0.12, 0.08, 0.12]} />
        <meshStandardMaterial color="#9aa6b4" />
      </mesh>
    </group>
  );
}

function FrontDoor({ plan }: { plan: BuildingPlan }) {
  const { x, z, width } = plan.frontDoor;
  const sign = useTexture(() => textTexture([{ text: "Entrance", size: 60, color: "#ffffff", weight: 800 }], { width: 420, height: 120, background: "#2b3a4a", radius: 24 }), []);
  return (
    <group position={[x, 0, z]}>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.006, -1]}>
        <planeGeometry args={[width, 1.6]} />
        <meshStandardMaterial color="#6b5a4a" roughness={1} />
      </mesh>
      <mesh position={[0, 3.2, -0.2]} rotation-y={Math.PI}>
        <planeGeometry args={[1.6, 0.46]} />
        <meshBasicMaterial map={sign} toneMapped={false} side={2} />
      </mesh>
    </group>
  );
}

/** A bay no team has yet: bare floor and a sign. */
function EmptyBay({ room }: { room: Room }) {
  const sign = useTexture(() => textTexture([{ text: "Free bay", size: 60, color: "#ffffff", weight: 800 }, { text: "for the next project", size: 32, color: "#b8c2cc" }], { width: 512, height: 180, background: "#2b3a4a", radius: 24 }), []);
  return (
    <group position={[room.center[0], 0, room.center[1]]} rotation-y={room.facing}>
      <mesh position={[0, 2.4, 0.3 - room.half[1]]}>
        <planeGeometry args={[1.8, 0.63]} />
        <meshBasicMaterial map={sign} toneMapped={false} />
      </mesh>
    </group>
  );
}

/** A meeting room: a long table with chairs round it and a screen on the back wall. Nobody meets here yet. */
function MeetingRoom({ room, n }: { room: Room; n: number }) {
  const sign = useTexture(() => textTexture([{ text: `Meeting room ${n}`, size: 56, color: "#ffffff", weight: 800 }], { width: 512, height: 110, background: "#2b3a4a", radius: 24 }), [n]);
  const [hw, hd] = room.half;
  // The table runs from front to back; chairs down both long sides.
  const length = Math.max(2, Math.min(4.2, 2 * hd - 3.4));
  const chairs = Math.max(2, Math.floor(length / 1));
  return (
    <group position={[room.center[0], 0, room.center[1]]} rotation-y={room.facing}>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.005, 0]} receiveShadow>
        <planeGeometry args={[hw * 2, hd * 2]} />
        <meshStandardMaterial color="#b9a88f" roughness={1} transparent opacity={0.35} />
      </mesh>
      <mesh position={[0, 0.74, -0.3]} castShadow receiveShadow>
        <boxGeometry args={[1.3, 0.06, length]} />
        <meshStandardMaterial color="#8a6a4f" roughness={0.6} />
      </mesh>
      {[-1, 1].flatMap((side) =>
        Array.from({ length: chairs }, (_, i) => (
          <mesh key={`${side}${i}`} position={[side * 0.95, 0.25, -0.3 - length / 2 + (i + 0.5) * (length / chairs)]} castShadow>
            <boxGeometry args={[0.45, 0.5, 0.45]} />
            <meshStandardMaterial color="#5a6f8c" roughness={0.9} />
          </mesh>
        )),
      )}
      <mesh position={[0, 1.6, 0.12 - hd]}>
        <boxGeometry args={[Math.min(3, hw * 2 - 1), 1.4, 0.08]} />
        <meshStandardMaterial color="#15181d" />
      </mesh>
      <mesh position={[0, 3.2, 0.2 - hd]}>
        <planeGeometry args={[1.8, 0.39]} />
        <meshBasicMaterial map={sign} toneMapped={false} />
      </mesh>
    </group>
  );
}
