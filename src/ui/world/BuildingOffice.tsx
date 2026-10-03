import { useMemo } from "react";
import { Color } from "three";
import type { UsageMeter, Work, WorldAgent, WorldTeam } from "../../shared/types.ts";
import { textTexture, type Line } from "./label.ts";
import { lookFor } from "./look.ts";
import { readingNooks, buildingPipelines, place, teamDesks, type BuildingPlan, type Garden, type Rect, type Room, type Wall } from "./building.ts";
import { Furniture, Kit, officeChair, plant, sofa } from "./Furniture.tsx";
import { stationsFor, studio } from "./crafts.ts";
import { Crafts } from "./Crafts.tsx";
import { furnishGym } from "./Gym.tsx";
import { furnishPingPong } from "./PingPong.tsx";
import { GardenScene } from "./Garden.tsx";
import { ReviewRoom } from "./ReviewRoom.tsx";
import { meetingLength } from "./meeting.ts";
import { Meters } from "./Meters.tsx";
import { plantGarden, treesRound } from "./planting.ts";
import { Pipeline } from "./Pipeline.tsx";
import { useTexture } from "./useTexture.ts";
import { freeBoard, teamBoard } from "./corkboard.ts";
import { CorkBoard } from "./CorkBoard.tsx";
import { COUCHES, COFFEE } from "./lounge.ts";
import { WALL_H, type Corner, type Vec2 } from "./spatial.ts";

/** The windows run from the sill to the head, in panes this wide at most; the wall (`WALL_H`, open to the sky) goes on above them. */
const SILL = 0.85;
const HEAD = WALL_H * 0.8;
const PANE = 1.6;
/**
 * The team's corkboard on a bay's back wall, twice as wide as tall. From eye height in the hall
 * the name tags of a full bay's front row cover the back wall up to about 4 m, so the board hangs
 * high enough to read over them, its top (about 5.4 m) still under the wall's.
 */
const BOARD_W = 4.4;
const BOARD_Y = 4.2;
/** Planters between the bays and round the lounge: low enough to see every team from the hall. */
const PLANTER_H = 0.75;
/** The meeting rooms' glass walls, two thirds of the outside wall's height. */
const GLASS_H = WALL_H * (2 / 3);
/** The front door's lintel: a door's height, with glass over it up to the windows' head. */
const LINTEL = 2.5;
/** The lounge's sign on its back wall, beside the sofas and clear of the kitchen. */
const SIGN_X = -1.2;

const CHAIRS = ["#3c4a5c", "#5b6b7d", "#40576b"];

/** The office as one building: an ordinary open-plan office, a team area per team round the hall with its garden, the lounge and kitchen, meeting rooms and reception. */
export function BuildingOffice({ plan, agents, teams, work, queueLength, meters }: { plan: BuildingPlan; agents: Map<string, WorldAgent>; teams: Map<string, WorldTeam>; work: Work[]; queueLength: number; meters: UsageMeter[] }) {
  const { outline, hall } = plan;
  const lounge = plan.rooms.find((r) => r.kind === "lounge")!;
  const meetings = plan.rooms.filter((r) => r.kind === "meeting");
  const pieces = useMemo(() => furnish(plan), [plan]);
  // A craft station for every member of a team, and free ones in the bays no team has yet.
  const stations = [
    ...studio(plan.corners),
    ...plan.rooms.filter((r) => r.kind === "bay" && !r.teamId).flatMap((r) => stationsFor(teamDesks(r, []).desks, `bay@${r.center.join(",")}`)),
  ];
  // The plan is made again whenever the world changes; the garden only grows again when the building's size does.
  const size = JSON.stringify(outline);
  const green = useMemo(() => ({ garden: plan.garden, planting: plantGarden(plan.garden), outside: treesRound(outline) }), [size]);
  return (
    <group>
      <Floor rect={plan.bounds} y={-0.01} color="#b9cba9" />
      <Floor rect={outline} y={0} color="#d8d2c6" shadows />
      <Floor rect={hall} y={0.002} color="#d6bc98" shadows />
      <Floor rect={{ minX: -plan.frontDoor.width, maxX: plan.frontDoor.width, minZ: hall.maxZ, maxZ: outline.maxZ }} y={0.002} color="#d9d6cf" shadows />
      {plan.rooms.filter((r) => r.kind !== "meeting").map((r, i) => (
        <Carpet key={i} room={r} color={r.teamId ? carpetFor(r.teamId) : r.kind === "lounge" ? "#a9a08f" : "#9aa0a6"} />
      ))}
      {meetings.map((r, i) => <Carpet key={i} room={r} color="#8e959c" />)}
      <GardenScene garden={green.garden} planting={green.planting} outside={green.outside} />
      <Meters garden={green.garden} meters={meters} />
      <Furniture pieces={pieces} />
      <Crafts stations={stations} agents={agents} />
      <Reception plan={plan} />
      <WaitingSign garden={plan.garden} queueLength={queueLength} />
      <LoungeSign room={lounge} />
      {plan.corners.map((c) => (
        <TeamBoard key={c.team.id} corner={c} room={plan.rooms.find((r) => r.teamId === c.team.id)!} agents={agents} teams={teams} work={work} />
      ))}
      {plan.rooms.filter((r) => r.kind === "bay" && !r.teamId).map((r, i) => <FreeBay key={i} room={r} />)}
      {meetings.map((r, i) => <group key={i}>
        <MeetingRoom room={r} n={i + 1} />
        <ReviewRoom room={r} index={i} reviewer={[...agents.values()].find((a) => plan.spots.get(a.id)?.group === `meeting:${i}`) ?? null} />
      </group>)}
      {buildingPipelines(plan).map((p) => (
        <Pipeline key={p.fromTeamId} path={p.path} busy={work.some((w) => w.fromTeamId === p.fromTeamId && w.toTeamId === p.toTeamId && w.state === "in_review")} />
      ))}
    </group>
  );
}

/** A team's carpet: a quiet grey with a little of the team's colour in it. */
function carpetFor(teamId: string): string {
  return `#${new Color("#9097a0").lerp(new Color(lookFor(teamId).shirt), 0.22).getHexString()}`;
}

/**
 * Everything that stands on the floor, as boxes, but the craft stations (Crafts.tsx): what is at the back of every bay, planters,
 * the lounge's sofas and kitchen, the meeting rooms' tables, reception, plants, and the garden's
 * benches. What grows in the garden is Garden.tsx.
 */
function furnish(plan: BuildingPlan) {
  const kit = new Kit();
  const { outline, hall } = plan;
  let n = 0;
  const chair = () => CHAIRS[n++ % CHAIRS.length]!;

  // The bays: at the back a low cabinet under the corkboard with finished work on it, a pegboard of tools and a plant.
  for (const room of plan.rooms.filter((r) => r.kind === "bay")) {
    const add = kit.in(room);
    const [hw, hd] = room.half;
    add("white", [0, 0.36, 0.4 - hd], [2.6, 0.72, 0.45]);
    add("wood", [0, 0.735, 0.4 - hd], [2.64, 0.03, 0.48]);
    add("pot", [0.7, 0.87, 0.4 - hd], [0.2, 0.24, 0.2], 0, "#b8643c");
    add("pot", [1.0, 0.83, 0.42 - hd], [0.16, 0.16, 0.16], 0.5, "#6f8fa8");
    add("wood", [-0.8, 0.8, 0.4 - hd], [0.5, 0.1, 0.3], 0.1, "#d9b98c");
    add("wood", [-3.3, 1.45, 0.4 - hd], [1.6, 1.0, 0.04], 0, "#c9a27a");
    add("metal", [-3.3, 1.45, 0.38 - hd], [1.66, 1.06, 0.03]);
    for (const sx of [-1, 1]) add("metal", [-3.3 + sx * 0.78, 0.5, 0.4 - hd], [0.04, 1.0, 0.04]);
    // Tools hung on the pegboard: a saw, hammers, brushes and chisels.
    add("metal", [-3.75, 1.5, 0.44 - hd], [0.42, 0.14, 0.01], 0, "#b8bec6");
    for (const [x, h, c] of [[-3.35, 0.3, "#7a5a40"], [-3.2, 0.24, "#7a5a40"], [-3.02, 0.2, "#d9534f"], [-2.94, 0.2, "#3f7fd0"], [-2.86, 0.2, "#f0c040"], [-2.75, 0.26, "#8a939c"]] as const) {
      add("wood", [x, 1.45, 0.44 - hd], [0.03, h, 0.02], 0, c);
    }
    plant(add, hw - 0.5, 0.5 - hd, 1.4);
  }

  // Planters wherever the bays and the lounge have a wall: a white trough with greenery on top.
  for (const w of plan.walls.filter((x) => x.kind === "planter")) {
    const { x, z, length, yaw } = span(w);
    const add = kit.at([x, z], yaw);
    add("white", [0, PLANTER_H / 2, 0], [length, PLANTER_H, 0.34]);
    add("wood", [0, PLANTER_H + 0.01, 0], [length + 0.02, 0.02, 0.38]);
    add("hedge", [0, PLANTER_H + 0.07, 0], [Math.max(0.1, length - 0.1), 0.12, 0.26]);
    const tufts = Math.max(1, Math.round(length / 0.7));
    for (let i = 0; i < tufts; i++) add("leaf", [-length / 2 + (i + 0.5) * (length / tufts), PLANTER_H + 0.16, 0], [0.4, 0.26 + (i % 3) * 0.07, 0.3], 0.8 * (i % 3));
  }

  // The lounge: sofas round the low table on a rug, and the kitchen along its back and far side.
  const lounge = plan.rooms.find((r) => r.kind === "lounge")!;
  const la = kit.in(lounge);
  const [lw, ld] = lounge.half;
  la("fabric", [0, 0.005, 0], [7.4, 0.01, 7.4], 0, "#c9b79a");
  la("wood", [COFFEE[0], 0.2, COFFEE[1]], [0.6, 0.06, 0.6]);
  la("metal", [COFFEE[0], 0.09, COFFEE[1]], [0.12, 0.18, 0.12]);
  for (const c of COUCHES) sofa(kit.at(place(lounge.center, lounge.facing, c.pos), lounge.facing + c.facing), 0, 0, c.width, "#5f7f8f");
  const back = 0.33 - ld;
  const run = lw - 0.8 - 2.3;
  la("white", [2.3 + run / 2, 0.44, back], [run, 0.88, 0.62]);
  la("wood", [2.3 + run / 2, 0.9, back], [run, 0.04, 0.66]);
  la("white", [lw - 0.42, 1.0, back + 0.05], [0.72, 2.0, 0.7]);
  la("metal", [lw - 0.72, 1.15, back + 0.41], [0.03, 0.5, 0.03]);
  la("metal", [3.0, 1.12, back + 0.02], [0.32, 0.4, 0.34]);
  la("screen", [3.0, 1.2, back + 0.19], [0.18, 0.08, 0.005], 0, "#f0b44c");
  la("pot", [3.5, 0.98, back], [0.1, 0.12, 0.1]);
  la("pot", [3.65, 0.98, back + 0.05], [0.1, 0.12, 0.1]);
  la("metal", [4.5, 0.925, back], [0.5, 0.02, 0.4]);
  // A high table with stools by the kitchen, out of the way of the circle round the lounge's table.
  const tx = lw - 1.9;
  const tz = back + 1.65;
  la("wood", [tx, 1.05, tz], [1.6, 0.04, 0.7]);
  la("metal", [tx, 0.52, tz], [0.08, 1.04, 0.08]);
  for (const dz of [-0.6, 0.6]) for (const dx of [-0.5, 0.5]) {
    la("fabric", [tx + dx, 0.72, tz + dz], [0.38, 0.06, 0.38], 0, "#d68a4c");
    la("metal", [tx + dx, 0.36, tz + dz], [0.05, 0.7, 0.05]);
  }
  plant(la, 0.8 - lw, 0.6 - ld, 1.5);
  plant(la, 0.8 - lw, ld - 1.4, 1.1);

  // Creative review rooms: table and chairs; boards and projector are in ReviewRoom.
  for (const room of plan.rooms.filter((r) => r.kind === "meeting")) {
    const add = kit.in(room);
    const [hw, hd] = room.half;
    const length = meetingLength(room);
    const chairs = Math.max(2, Math.floor(length / 0.9));
    add("wood", [0, 0.74, -0.3], [1.3, 0.05, length]);
    for (const dz of [-1, 1]) add("metal", [0, 0.36, -0.3 + dz * (length / 2 - 0.4)], [0.1, 0.72, 0.1]);
    for (const side of [-1, 1]) for (let i = 0; i < chairs; i++) {
      officeChair(add, side * 0.95, -0.3 - length / 2 + (i + 0.5) * (length / chairs), -side * (Math.PI / 2), chair());
    }
    add("fabric", [0, 0.009, -0.3], [3.5, 0.014, length + 1], 0, "#bdad99");
    plant(add, hw - 0.5, 0.5 - hd, 1.2);
  }

  // Reception: a counter beside the way in, clear of it, with a plant either side of the door.
  const door = plan.frontDoor;
  const rc = kit.at([door.x + 0.9, door.z - 3.2], 0);
  rc("white", [0, 0.53, 0], [0.62, 1.06, 2.2]);
  rc("wood", [0, 1.08, 0], [0.74, 0.04, 2.3]);
  rc("metal", [0.05, 1.2, 0.3], [0.04, 0.26, 0.4], -0.4);
  officeChair(rc, 0.64, 0.2, -Math.PI / 2, CHAIRS[0]!);
  const fa = kit.at([door.x, door.z], 0);
  for (const sx of [-1, 1]) plant(fa, sx * (door.width / 2 + 0.55), -0.55, 1.5);
  // Over the door the outside wall goes on: glass up to the windows' head, and wall above it.
  fa("window", [0, (LINTEL + HEAD) / 2, 0], [door.width, HEAD - LINTEL, 0.04]);
  fa("wall", [0, (HEAD + WALL_H) / 2, 0], [door.width + 0.3, WALL_H - HEAD, 0.3]);

  // The corners where the side rooms meet the north and south ones: a reading nook each.
  for (const nook of readingNooks(plan)) {
    const add = kit.at(nook.center, nook.facing);
    sofa(add, 0, 0, 2, "#8a6f8f");
    add("wood", [0, 0.2, 1.6], [0.9, 0.05, 0.6]);
    plant(add, 1.6, -0.8, 1.6);
    plant(add, -1.6, -0.8, 1.2);
  }
  // The south-east corner's back, behind its nook: the gym (Gym.tsx).
  furnishGym(kit, plan);
  // The south-west corner's: the ping pong table (PingPong.tsx).
  furnishPingPong(kit, plan);

  outerWalls(kit, plan);
  for (const w of plan.walls.filter((x) => x.kind === "glass")) glassWall(kit, w);
  benches(kit, plan.garden);

  // The hall: a plant in each corner, clear of the walkway.
  for (const [x, z] of [[hall.minX + 0.5, hall.minZ + 0.5], [hall.maxX - 0.5, hall.minZ + 0.5], [hall.minX + 0.5, hall.maxZ - 0.5], [hall.maxX - 0.5, hall.maxZ - 0.5]] as Vec2[]) {
    plant(kit.at([x, z], 0), 0, 0, 1.6);
  }
  return kit.pieces;
}

/**
 * The outside walls: a sill and a head, and windows between them in panes, except behind the
 * bays' corkboards, the meeting rooms' and the lounge's sign, where the wall is solid.
 */
function outerWalls(kit: Kit, plan: BuildingPlan) {
  const solid = plan.rooms
    .map((r) => ({ at: place(r.center, r.facing, [r.kind === "lounge" ? SIGN_X : 0, -r.half[1]]), half: r.kind === "bay" ? BOARD_W / 2 + 0.2 : 1.3 }));
  for (const w of plan.walls.filter((x) => x.kind === "outer")) {
    const { x, z, length, yaw } = span(w);
    const add = kit.at([x, z], yaw);
    add("wall", [0, SILL / 2, 0], [length + 0.3, SILL, 0.3]);
    add("wall", [0, (HEAD + WALL_H) / 2, 0], [length + 0.3, WALL_H - HEAD, 0.3]);
    add("wood", [0, SILL + 0.02, 0], [length, 0.04, 0.36]);
    const panes = Math.max(1, Math.round(length / PANE));
    const pane = length / panes;
    for (let i = 0; i < panes; i++) {
      const t = -length / 2 + (i + 0.5) * pane;
      const at: Vec2 = [x + Math.cos(yaw) * t, z - Math.sin(yaw) * t];
      if (solid.some((s) => Math.hypot(s.at[0] - at[0], s.at[1] - at[1]) < s.half + pane / 2)) {
        add("wall", [t, (SILL + HEAD) / 2, 0], [pane + 0.02, HEAD - SILL, 0.3]);
      } else {
        add("window", [t, (SILL + HEAD) / 2, 0], [pane - 0.08, HEAD - SILL, 0.04]);
        add("frame", [t + pane / 2, (SILL + HEAD) / 2, 0], [0.08, HEAD - SILL, 0.14]);
      }
    }
  }
}

/** A meeting room's wall: glass in thin frames, with a frosted band at eye height. */
function glassWall(kit: Kit, w: Wall) {
  const { x, z, length, yaw } = span(w);
  const add = kit.at([x, z], yaw);
  add("glass", [0, GLASS_H / 2, 0], [length, GLASS_H, 0.04]);
  add("frosted", [0, 1.3, 0], [length, 0.28, 0.05]);
  for (const y of [0.03, GLASS_H]) add("frame", [0, y, 0], [length + 0.06, 0.06, 0.08]);
  for (const s of [-1, 1]) add("frame", [(s * length) / 2, GLASS_H / 2, 0], [0.06, GLASS_H, 0.08]);
}

/** The garden's benches: wooden slats on metal legs, along the walk. The ceiling is open over the garden: the view from where you stand is above ceiling height, so a skylight's frame would cut across it. */
function benches(kit: Kit, garden: Garden) {
  for (const b of garden.benches) {
    const at = kit.at(b.pos, b.facing);
    at("wood", [0, 0.45, 0.02], [1.7, 0.05, 0.44]);
    at("wood", [0, 0.72, -0.24], [1.7, 0.3, 0.05]);
    for (const sx of [-0.75, 0.75]) {
      at("metal", [sx, 0.22, 0.02], [0.06, 0.44, 0.4]);
      at("metal", [sx, 0.6, -0.24], [0.06, 0.4, 0.06]);
    }
  }
}

/** A small garden sign by the clearing, turned to you: how many are waiting for you. */
function WaitingSign({ garden, queueLength }: { garden: Garden; queueLength: number }) {
  if (queueLength === 0) return null;
  const lines: Line[] = [
    { text: `${queueLength} waiting for you`, size: 50, color: "#ffc658", weight: 800 },
  ];
  const x = 0.8;
  const z = garden.area.maxZ - 0.4;
  return (
    <group>
      <mesh position={[x, 0.55, z]} castShadow>
        <boxGeometry args={[0.07, 1.1, 0.07]} />
        <meshStandardMaterial color="#7a5a40" roughness={0.9} />
      </mesh>
      <Sign lines={lines} size={[512, 110]} width={0.8} height={0.2} position={[x, 1.2, z + 0.04]} />
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

function Carpet({ room, color }: { room: Room; color: string }) {
  return (
    <mesh rotation-x={-Math.PI / 2} rotation-z={room.facing} position={[room.center[0], 0.004, room.center[1]]} receiveShadow>
      <planeGeometry args={[room.half[0] * 2, room.half[1] * 2]} />
      <meshStandardMaterial color={color} roughness={1} />
    </mesh>
  );
}

/** Where a wall stands and which way it runs. */
function span({ a, b }: Wall) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  return { x: (a[0] + b[0]) / 2, z: (a[1] + b[1]) / 2, length: Math.hypot(dx, dz), yaw: Math.atan2(-dz, dx) };
}

/** A sign on a wall, facing the room it is in. */
function Sign({ lines, size, width, height, position, rotation = 0 }: { lines: Line[]; size: [number, number]; width: number; height: number; position: [number, number, number]; rotation?: number }) {
  const texture = useTexture(() => textTexture(lines, { width: size[0], height: size[1], background: "#2f3b48", radius: 20 }), [JSON.stringify(lines)]);
  return (
    <mesh position={position} rotation-y={rotation}>
      <planeGeometry args={[width, height]} />
      <meshBasicMaterial map={texture} toneMapped={false} />
    </mesh>
  );
}

/** A team's corkboard on its bay's back wall, facing the crew and the hall. */
function TeamBoard({ corner, room, agents, teams, work }: { corner: Corner; room: Room; agents: Map<string, WorldAgent>; teams: Map<string, WorldTeam>; work: Work[] }) {
  return (
    <group position={[room.center[0], 0, room.center[1]]} rotation-y={room.facing}>
      <CorkBoard board={teamBoard(corner, agents, teams, work)} width={BOARD_W} position={[0, BOARD_Y, 0.2 - room.half[1]]} />
    </group>
  );
}

/** A bay no team has yet: its stations stand free, and its board says so. */
function FreeBay({ room }: { room: Room }) {
  return (
    <group position={[room.center[0], 0, room.center[1]]} rotation-y={room.facing}>
      <CorkBoard board={freeBoard(`bay@${room.center.join(",")}`)} width={BOARD_W} position={[0, BOARD_Y, 0.2 - room.half[1]]} />
    </group>
  );
}

/** A meeting room's name on its glass front, over the door, readable from the hall. */
function MeetingRoom({ room, n }: { room: Room; n: number }) {
  return (
    <group position={[room.center[0], 0, room.center[1]]} rotation-y={room.facing}>
      <Sign lines={[{ text: `Creative review ${n}`, size: 56, color: "#ffffff", weight: 800 }]} size={[512, 110]} width={1.6} height={0.34} position={[0, 2.5, room.half[1] + 0.04]} />
    </group>
  );
}

function LoungeSign({ room }: { room: Room }) {
  return (
    <group position={[room.center[0], 0, room.center[1]]} rotation-y={room.facing}>
      <Sign lines={[{ text: "Lounge & kitchen", size: 60, color: "#ffffff", weight: 800 }, { text: "coffee and a break", size: 32, color: "#b8c2cc" }]} size={[640, 180]} width={2.2} height={0.62} position={[SIGN_X, 2.3, 0.2 - room.half[1]]} />
    </group>
  );
}

/** The front door: glass doors slid open, a mat, and the name over it on the inside. */
function Reception({ plan }: { plan: BuildingPlan }) {
  const { x, z, width } = plan.frontDoor;
  return (
    <group position={[x, 0, z]}>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.008, -0.9]}>
        <planeGeometry args={[width, 1.4]} />
        <meshStandardMaterial color="#4f4a45" roughness={1} />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[s * (width / 2 + 0.45), 1.2, -0.2]}>
          <boxGeometry args={[0.9, 2.4, 0.05]} />
          <meshStandardMaterial color="#d6ecff" transparent opacity={0.35} roughness={0.05} depthWrite={false} />
        </mesh>
      ))}
      <mesh position={[0, LINTEL, 0]}>
        <boxGeometry args={[width + 0.1, 0.1, 0.32]} />
        <meshStandardMaterial color="#8a939c" roughness={0.5} />
      </mesh>
      <Sign lines={[{ text: "Welcome", size: 60, color: "#ffffff", weight: 800 }]} size={[420, 120]} width={1.4} height={0.4} position={[0, LINTEL + 0.5, -0.17]} rotation={Math.PI} />
    </group>
  );
}
