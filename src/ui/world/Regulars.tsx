import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { BoxGeometry, CylinderGeometry, MeshStandardMaterial, type Group } from "three";
import type { BuildingPlan, RouteFn } from "./building.ts";
import { Body, liftRig, playRig, restRig, turn, type Joints } from "./Avatar.tsx";
import { useGym } from "./Gym.tsx";
import { armReach, newPose, newReach, stationPose, type Reach } from "./gym.ts";
import { textTexture } from "./label.ts";
import { usePace } from "./Pace.tsx";
import { Paddle, usePing } from "./PingPong.tsx";
import { ballAt, newPing, newPlayer, playerPose } from "./pingpong.ts";
import { cheerAt, coolerAt, cupAt, highFiveAt, matsAt, regularLook, sipAt, type Placement, type Regulars } from "./regulars.ts";
import type { Vec2 } from "./spatial.ts";

// The regulars as drawn (regulars.ts says who they are and where): each on the agents' rig, with
// no status lamp, a plain light name pill and no panel of their own; and the water cooler and the
// mats, on shared geometry and materials. A click shows who they are, never an agent's panel.

const WALK_SPEED = 1.6;
const TURN_RATE = 8;

// Shared by everything the regulars bring: one geometry each, one material each finish.
const BOTTLE = new CylinderGeometry(0.032, 0.032, 0.2, 10);
const BOTTLE_FINISH = new MeshStandardMaterial({ color: "#5fb3e6", roughness: 0.3, transparent: true, opacity: 0.85 });
const CUP = new CylinderGeometry(0.035, 0.028, 0.09, 10);
const PAPER = new MeshStandardMaterial({ color: "#f4f1ea", roughness: 0.8 });
const BOX = new BoxGeometry(1, 1, 1);
const COOLER_BODY = new MeshStandardMaterial({ color: "#e9edf1", roughness: 0.6 });
const WATER = new MeshStandardMaterial({ color: "#7cc4ef", roughness: 0.15, transparent: true, opacity: 0.8 });
const JUG = new CylinderGeometry(0.15, 0.15, 0.38, 14);
const MAT = new MeshStandardMaterial({ color: "#3f8f7a", roughness: 0.95 });

/** Arm poses the touches blend to, from the right shoulder (mirrored for the left): worked out once. */
const reach = (x: number, y: number, z: number, pole: [number, number, number]): Reach => armReach(x, y, z, pole[0], pole[1], pole[2], newReach());
const TO_MOUTH = reach(-0.2, 0.17, 0.2, [1, -1, 0]);
const HIGH_FIVE = reach(-0.22, 0.45, 0.42, [1, -0.3, -0.4]);
const UP = reach(-0.04, 0.6, 0.1, [1, 0, -0.2]);

export interface RegularCardInfo { name: string; where: "gym" | "pingpong" }

/** The regulars, the cooler and the mats. */
export function RegularsScene({ plan, regulars, walk, onSelect }: { plan: BuildingPlan; regulars: Regulars; walk: RouteFn; onSelect: (card: RegularCardInfo) => void }) {
  const cooler = useMemo(() => coolerAt(plan), [plan.outline, plan.hall]);
  const mats = useMemo(() => matsAt(plan), [plan.outline, plan.hall]);
  return (
    <group name="regulars">
      <group position={[cooler.pos[0], 0, cooler.pos[1]]} rotation-y={cooler.facing}>
        <mesh geometry={BOX} material={COOLER_BODY} position={[0, 0.5, 0]} scale={[0.34, 1, 0.34]} castShadow />
        <mesh geometry={JUG} material={WATER} position={[0, 1.19, 0]} />
        <mesh geometry={CUP} material={PAPER} position={[0.1, 1.045, 0.1]} />
      </group>
      {mats.map((m, i) => (
        <mesh key={i} geometry={BOX} material={MAT} position={[m.pos[0], 0.008, m.pos[1]]} rotation-y={m.facing} scale={[0.7, 0.016, 1.7]} receiveShadow />
      ))}
      {[...regulars.values()].map((p) => <Regular key={p.regular.id} placement={p} walk={walk} onSelect={onSelect} />)}
    </group>
  );
}

function Regular({ placement, walk, onSelect }: { placement: Placement; walk: RouteFn; onSelect: (card: RegularCardInfo) => void }) {
  const { regular, spot, act } = placement;
  const look = useMemo(() => regularLook(regular), [regular]);
  const root = useRef<Group>(null);
  const legs = useRef<[Group | null, Group | null]>([null, null]);
  const arms = useRef<[Group | null, Group | null]>([null, null]);
  const knees = useRef<[Group | null, Group | null]>([null, null]);
  const ankles = useRef<[Group | null, Group | null]>([null, null]);
  const elbows = useRef<[Group | null, Group | null]>([null, null]);
  const head = useRef<Group>(null);
  const upper = useRef<Group>(null);
  const body = useRef<Group>(null);
  const bottle = useRef<Group>(null);
  const joints: Joints = useMemo(() => ({ body, upper, head, legs, knees, ankles, arms, elbows }), []);
  // They are there when the office opens, and walk only to step aside or back.
  const motion = useRef({ pos: [...spot.pos] as Vec2, yaw: spot.facing, path: [] as Vec2[], spot, phase: (regular.name.length * 1.7) % 10 });
  const scratch = useMemo(() => ({ pose: newPose(), reach: newReach(), hand: [0, 0, 0] as [number, number, number], player: newPlayer(), ball: newPing() }), []);
  const [hovered, setHovered] = useState(false);
  const pace = usePace();
  const gym = useGym();
  const ping = usePing();

  useEffect(() => {
    const m = motion.current;
    if (m.spot.pos[0] === spot.pos[0] && m.spot.pos[1] === spot.pos[1]) { m.spot = spot; return; }
    m.path = walk(m.pos, m.spot, spot);
    m.spot = spot;
  }, [spot]);

  useEffect(() => {
    if (!hovered) return;
    document.body.style.cursor = "pointer";
    return () => void (document.body.style.cursor = "");
  }, [hovered]);

  // A light pill with their name and nothing else: no project, harness or status, so they never read as an agent.
  const tag = useMemo(() => textTexture([{ text: regular.name, size: 40, color: "#1d2733", weight: 700 }], { width: 256, height: 72, background: "rgba(255,255,255,0.94)", radius: 36 }), [regular.name]);
  useEffect(() => () => tag.dispose(), [tag]);

  useFrame((state, dt) => {
    const m = motion.current;
    const g = root.current;
    if (!g) return;
    const step = Math.min(dt, 0.1);
    let walking = false;
    let remaining = WALK_SPEED * step;
    while (remaining > 0 && m.path.length) {
      const [tx, tz] = m.path[0]!;
      const dx = tx - m.pos[0], dz = tz - m.pos[1];
      const d = Math.hypot(dx, dz);
      if (d < 1e-3) { m.path.shift(); continue; }
      walking = true;
      const move = Math.min(d, remaining);
      m.pos[0] += (dx / d) * move;
      m.pos[1] += (dz / d) * move;
      remaining -= move;
      m.yaw = turn(m.yaw, Math.atan2(dx, dz), TURN_RATE * step);
      if (move >= d) m.path.shift();
    }
    if (!walking) m.yaw = turn(m.yaw, m.spot.facing, TURN_RATE * 0.5 * step);
    const now = performance.now(), ms = Date.now();
    if (walking) pace?.moved(now);
    g.position.set(m.pos[0], 0, m.pos[1]);
    g.rotation.y = m.yaw;
    const there = !walking && !m.path.length;
    const t = state.clock.elapsedTime + m.phase;

    // The same clocks the agents use: the gym's per lifter, the table's for the pair at it.
    gym?.arrive(regular.id, there && act === "lift", ms);
    ping?.playback.arrive(regular.id, there && act === "play", ms);
    const seconds = act === "lift" && spot.gym ? gym?.seconds(regular.id, ms) ?? null : null;
    const lift = seconds !== null ? stationPose(spot.gym!, seconds, look.height, scratch.pose) : null;
    if (lift?.moving) pace?.moved(now);
    const rally = ping?.playback.seconds(ms) ?? null;
    const playing = act === "play" && ping && rally !== null ? playerPose(ping.table, m.pos[0], m.pos[1], m.yaw, spot.pingpong!, rally, look.height, look.build, scratch.player) : null;

    const [ll, lr] = legs.current, [al, ar] = arms.current, [el, er] = elbows.current;
    if (!ll || !lr || !al || !ar || !el || !er) return;
    let sip = 0;
    if (lift && liftRig(joints, g, m.pos, m.yaw, lift, look, scratch)) {
      // Between sets, standing, a sip from the bottle.
      sip = lift.lie ? 0 : sipAt(spot.gym!, seconds!);
      if (sip > 0) {
        blend(ar, er, TO_MOUTH, 1, sip);
        if (head.current) head.current.rotation.x = -0.3 * sip;
        pace?.ambled(now);
      }
    } else if (playing && playRig(joints, g, m.pos, m.yaw, playing, look)) {
      // After a point, the one who didn't catch it punches the air with their free hand.
      const cheer = cheerAt(spot.pingpong!, rally!);
      if (cheer > 0) blend(al, el, UP, -1, cheer);
    } else {
      restRig(joints);
      g.position.y = walking ? Math.abs(Math.sin(t * 9)) * 0.035 : Math.sin(t * 1.6) * 0.006;
      const swing = walking ? Math.sin(t * 9) * 0.55 : 0;
      ll.rotation.x = swing;
      lr.rotation.x = -swing;
      if (upper.current) upper.current.rotation.x = 0;
      if (head.current) head.current.rotation.set(0, 0, 0);
      al.rotation.set(walking ? -swing * 0.8 : Math.sin(t * 1.3) * 0.04, 0, 0);
      ar.rotation.set(walking ? swing * 0.8 : Math.sin(t * 1.3 + 1) * 0.04, 0, 0);
      if (!walking) {
        if (act === "stretch") {
          // Arms up for a long stretch, then folded over to the toes, round again.
          const c = t % 12;
          const up = Math.min(smooth((c - 0.5) / 0.8), smooth((4.5 - c) / 0.8));
          const fold = Math.min(smooth((c - 6) / 1), smooth((10 - c) / 1));
          blend(ar, er, UP, 1, up);
          blend(al, el, UP, -1, up);
          if (upper.current) upper.current.rotation.x = 1.25 * fold;
          if (up > 0 && up < 1 || fold > 0 && fold < 1) pace?.ambled(now);
        } else if (act === "cooler") {
          const five = placement.partner ? highFiveAt(ms) : 0;
          sip = five > 0 ? 0 : cupAt(ms, regular.name.length * 2.3);
          if (five > 0) blend(ar, er, HIGH_FIVE, 1, five);
          else if (sip > 0) blend(ar, er, TO_MOUTH, 1, sip);
          if (head.current) head.current.rotation.x = -0.25 * sip;
          if (five > 0 || sip > 0) pace?.ambled(now);
        } else if (act === "watch") {
          // Hands behind the back, following the ball; a cheer after every point.
          al.rotation.x = ar.rotation.x = 0.35;
          if (ping && rally !== null && head.current) {
            const b = ballAt(rally, scratch.ball);
            const tb = ping.table;
            const dx = tb.center[0] + b.a * tb.along[0] + b.c * tb.across[0] - m.pos[0];
            const dz = tb.center[1] + b.a * tb.along[1] + b.c * tb.across[1] - m.pos[1];
            const c = Math.cos(m.yaw), s = Math.sin(m.yaw);
            head.current.rotation.y = Math.max(-1, Math.min(1, Math.atan2(dx * c - dz * s, dx * s + dz * c)));
            const cheer = cheerAt(null, rally);
            if (cheer > 0) {
              blend(ar, er, UP, 1, cheer);
              blend(al, el, UP, -1, cheer);
            }
          }
        }
      }
    }
    if (bottle.current) bottle.current.visible = sip > 0;
  });

  const click = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.delta < 6) onSelect({ name: regular.name, where: "gym" in regular.home ? "gym" : "pingpong" });
  };
  const held = act === "play" ? <Paddle /> : (
    <group ref={bottle} visible={false} position={[0, -0.3, 0.05]}>
      {act === "cooler" ? <mesh geometry={CUP} material={PAPER} /> : <mesh geometry={BOTTLE} material={BOTTLE_FINISH} />}
    </group>
  );

  return (
    <group ref={root} name={`regular:${regular.name}`} onClick={click} onPointerOver={(e) => (e.stopPropagation(), setHovered(true))} onPointerOut={() => setHovered(false)}>
      <group ref={body} scale={look.height}>
        <Body look={look} legs={legs} knees={knees} ankles={ankles} elbows={elbows} arms={arms} held={held} card={null} head={head} upper={upper} />
      </group>
      <sprite position={[0, 2.25, 0]} scale={[0.85, 0.24, 1]}>
        <spriteMaterial map={tag} transparent depthWrite={false} toneMapped={false} />
      </sprite>
    </group>
  );
}

const smooth = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

/** Turn an arm part of the way to a pose given for the right arm; `side` -1 mirrors it for the left. */
function blend(arm: Group, elbow: Group, to: Reach, side: number, f: number): void {
  arm.rotation.set(arm.rotation.x + (to.x - arm.rotation.x) * f, arm.rotation.y + (side * to.y - arm.rotation.y) * f, arm.rotation.z + (side * to.z - arm.rotation.z) * f);
  elbow.rotation.x += (to.elbow - elbow.rotation.x) * f;
}

/** Who a clicked regular is: a name and where they come to, and nothing an agent has. */
export function RegularCard({ card, onClose }: { card: RegularCardInfo; onClose: () => void }) {
  return (
    <div
      role="status"
      aria-label={`${card.name}, a regular`}
      style={{ position: "absolute", zIndex: 4, left: "50%", bottom: 24, transform: "translateX(-50%)", maxWidth: "calc(100% - 24px)", display: "flex", alignItems: "center", gap: 10, padding: "8px 8px 8px 16px", borderRadius: 999, background: "var(--panel)", boxShadow: "0 8px 24px rgba(0,0,0,0.2)", fontSize: 13 }}
    >
      <span><strong>{card.name}</strong> · Regular at the {card.where === "gym" ? "gym" : "ping pong table"} <span className="muted">(not an agent)</span></span>
      <button className="ghost small" type="button" aria-label="Close" onClick={onClose}>×</button>
    </div>
  );
}
