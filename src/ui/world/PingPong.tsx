import { createContext, useContext, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { BoxGeometry, CylinderGeometry, MeshStandardMaterial, SphereGeometry, type Mesh } from "three";
import type { BuildingPlan } from "./building.ts";
import type { Kit } from "./Furniture.tsx";
import { usePace } from "./Pace.tsx";
import { BALL_BACK, ballAt, ballBack, BALL_R, BALL_REST, BLADE, NET_H, newPing, PingPlayback, pingTable, TABLE_H, TABLE_L, TABLE_W } from "./pingpong.ts";

// The ping pong table as drawn: its boxes go in with the building's furniture (`furnishPingPong`),
// the ball is one small mesh (`PingScene`) and each player holds a paddle (`Paddle`, in Avatar.tsx).

export interface PingTable { playback: PingPlayback; table: ReturnType<typeof pingTable> }
export const PingContext = createContext<PingTable | null>(null);
export const usePing = () => useContext(PingContext);

const TOP = "#1f5f86";
const LINE = 0.02;

/** The table's boxes: the top with its white lines, the net on its posts, and the legs. */
export function furnishPingPong(kit: Kit, plan: BuildingPlan) {
  const table = pingTable(plan);
  const add = kit.at(table.center, table.yaw);
  const top = TABLE_H - 0.015;
  add("wood", [0, top, 0], [TABLE_L, 0.03, TABLE_W], 0, TOP);
  for (const z of [-1, 1]) add("white", [0, TABLE_H + 0.001, z * (TABLE_W / 2 - LINE / 2)], [TABLE_L, 0.002, LINE]);
  for (const x of [-1, 1]) add("white", [x * (TABLE_L / 2 - LINE / 2), TABLE_H + 0.001, 0], [LINE, 0.002, TABLE_W]);
  add("white", [0, TABLE_H + 0.001, 0], [TABLE_L, 0.002, 0.003]);
  // The net, a little past each side, and its posts.
  add("fabric", [0, TABLE_H + NET_H / 2, 0], [0.008, NET_H, TABLE_W + 0.3], 0, "#eef0f2");
  add("fabric", [0, TABLE_H + NET_H - 0.006, 0], [0.012, 0.012, TABLE_W + 0.3], 0, "#ffffff");
  for (const z of [-1, 1]) add("metal", [0, TABLE_H + NET_H / 2, z * (TABLE_W / 2 + 0.16)], [0.03, NET_H + 0.02, 0.03]);
  for (const x of [-1, 1]) {
    for (const z of [-1, 1]) add("metal", [x * 1.05, (top - 0.015) / 2, z * 0.6], [0.05, top - 0.015, 0.05]);
    add("metal", [x * 1.05, 0.12, 0], [0.04, 0.04, 1.2]);
  }
  add("metal", [0, top - 0.06, 0], [2.2, 0.05, 0.05]);
}

// Shared by the ball and both paddles.
const BALL = new SphereGeometry(BALL_R, 12, 8);
const BALL_FINISH = new MeshStandardMaterial({ color: "#fbfaf4", emissive: "#fff6dc", emissiveIntensity: 0.35, roughness: 0.4 });
const BLADE_SHAPE = new CylinderGeometry(0.075, 0.075, 0.012, 18);
const RUBBER = new MeshStandardMaterial({ color: "#c2302c", roughness: 0.7 });
const HANDLE_SHAPE = new BoxGeometry(0.026, 0.1, 0.022);
const HANDLE = new MeshStandardMaterial({ color: "#b9895a", roughness: 0.8 });

/** A paddle in the hand: the handle in the fist, the blade on along the forearm, its face forward. */
export function Paddle() {
  return (
    <group position={[0, -0.27, 0]}>
      <mesh geometry={HANDLE_SHAPE} material={HANDLE} position={[0, -0.03, 0]} />
      <mesh name="paddle" geometry={BLADE_SHAPE} material={RUBBER} position={[0, -BLADE, 0]} rotation-x={Math.PI / 2} castShadow />
    </group>
  );
}

/**
 * The ball: in play while both players are at the table, otherwise lying on it by player 0's end, where play starts.
 * When play stops it hops back there from wherever it was. Only a rally and that hop ask the pacer for frames.
 */
export function PingScene({ plan }: { plan: BuildingPlan }) {
  const ping = usePing();
  const pace = usePace();
  const ball = useRef<Mesh>(null);
  const at = useMemo(newPing, []);
  // Where it was when play last stopped, and when (ms).
  const back = useMemo(() => ({ from: newPing(), at: -Infinity, playing: false }), []);
  const table = useMemo(() => pingTable(plan), [plan]);
  useFrame(() => {
    const m = ball.current;
    if (!m) return;
    const seconds = ping?.playback.seconds(Date.now()) ?? null;
    if (seconds === null) {
      const now = Date.now();
      if (back.playing) {
        Object.assign(back.from, at);
        back.at = now;
        back.playing = false;
      }
      const u = (now - back.at) / 1000 / BALL_BACK;
      if (u < 1) {
        ballBack(back.from, u, at);
        pace?.moved(performance.now());
      } else Object.assign(at, BALL_REST);
    } else {
      ballAt(seconds, at);
      back.playing = true;
      pace?.moved(performance.now());
    }
    m.position.set(table.center[0] + at.a * table.along[0] + at.c * table.across[0], at.y, table.center[1] + at.a * table.along[1] + at.c * table.across[1]);
  });
  return <mesh ref={ball} name="pingpong-ball" geometry={BALL} material={BALL_FINISH} castShadow />;
}
