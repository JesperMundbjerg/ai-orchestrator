import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { BoxGeometry, CylinderGeometry, MeshStandardMaterial, type Group } from "three";
import type { BuildingPlan, RouteFn } from "./building.ts";
import { blend, Body, Bottle, HIGH_FIVE, liftRig, playRig, restGesture, restRig, samePlace, TO_MOUTH, turn, UP, type Joints } from "./Avatar.tsx";
import { useGym } from "./Gym.tsx";
import { gestureAt, HIP, newPose, newReach } from "./gym.ts";
import { textTexture } from "./label.ts";
import { usePace } from "./Pace.tsx";
import { Paddle, usePing } from "./PingPong.tsx";
import { ballAt, newPing, newPlayer, playerPose } from "./pingpong.ts";
import { cheerAt, coolerAt, cornerWalk, cupAt, highFiveAt, matsAt, regularLook, scheduleRegulars, VISIT, visitAt, type Placement, type Regulars } from "./regulars.ts";
import type { Vec2 } from "./spatial.ts";

// The regulars as drawn (regulars.ts says who they are and where): each on the agents' rig, with
// no status lamp, a plain light name pill and no panel of their own; and the water cooler and the
// mats, on shared geometry and materials. A click shows who they are, never an agent's panel.
// Where they are is worked out again once a visit (a minute), when they all move round.

const WALK_SPEED = 1.6;
const TURN_RATE = 8;

// Shared by everything the regulars bring: one geometry each, one material each finish.
const CUP = new CylinderGeometry(0.035, 0.028, 0.09, 10);
const PAPER = new MeshStandardMaterial({ color: "#f4f1ea", roughness: 0.8 });
const BOX = new BoxGeometry(1, 1, 1);
const COOLER_BODY = new MeshStandardMaterial({ color: "#e9edf1", roughness: 0.6 });
const WATER = new MeshStandardMaterial({ color: "#7cc4ef", roughness: 0.15, transparent: true, opacity: 0.8 });
const JUG = new CylinderGeometry(0.15, 0.15, 0.38, 14);
const MAT = new MeshStandardMaterial({ color: "#3f8f7a", roughness: 0.95 });

/** Sitting on a mat: the hips this high off the floor (metres). */
const MAT_SEAT = 0.1;

export interface RegularCardInfo { name: string; where: "gym" | "pingpong" }

/**
 * The regulars, the cooler and the mats. `regulars` is where the office has put them on its stage
 * (`placeRegulars`): the table's clock goes by those ids, so whoever plays at a free end plays on
 * its home regular's. Where they really are comes from the visit's timetable.
 */
export function RegularsScene({ plan, regulars, walk, onSelect }: { plan: BuildingPlan; regulars: Regulars; walk: RouteFn; onSelect: (card: RegularCardInfo) => void }) {
  const [visit, setVisit] = useState(() => visitAt(Date.now()));
  useEffect(() => {
    const next = (visit + 1) * VISIT * 1000 - Date.now();
    const timer = setTimeout(() => setVisit(visitAt(Date.now())), Math.max(0, next) + 20);
    return () => clearTimeout(timer);
  }, [visit]);
  const placed = useMemo(() => scheduleRegulars(plan, plan.spots, visit), [plan, visit]);
  const keepers = useMemo(() => new Map([...regulars].flatMap(([id, p]) => (p.spot.pingpong !== undefined ? [[p.spot.pingpong, id] as const] : []))), [regulars]);
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
      {[...placed.values()].map((p) => <Regular key={p.regular.id} placement={p} keeper={p.spot.pingpong !== undefined ? keepers.get(p.spot.pingpong) ?? null : null} walk={walk} onSelect={onSelect} />)}
    </group>
  );
}

/** One regular; `keeper` is whose clock their end of the table runs on while they play there. */
function Regular({ placement, keeper, walk, onSelect }: { placement: Placement; keeper: string | null; walk: RouteFn; onSelect: (card: RegularCardInfo) => void }) {
  const { regular, spot, act, visit } = placement;
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
  // They are there when the office opens, and walk when they move round, step aside or come back.
  const motion = useRef({ pos: [...spot.pos] as Vec2, yaw: spot.facing, path: [] as Vec2[], spot, phase: (regular.name.length * 1.7) % 10 });
  const scratch = useMemo(() => ({ pose: newPose(), reach: newReach(), hand: [0, 0, 0] as [number, number, number], player: newPlayer(), ball: newPing() }), []);
  const [hovered, setHovered] = useState(false);
  const pace = usePace();
  const gym = useGym();
  const ping = usePing();

  useEffect(() => {
    const m = motion.current;
    if (samePlace(m.spot, spot)) { m.spot = spot; return; }
    // Round the corner they are in along its lane; from one corner to the other by the office's ways.
    m.path = (!m.path.length && cornerWalk(m.spot, spot)) || walk(m.pos, m.spot, spot);
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
    // Only once their walk to a new place has been set off, so nobody is at two stations at once.
    const there = !walking && !m.path.length && samePlace(m.spot, spot);
    const t = state.clock.elapsedTime + m.phase;

    // The same clocks the agents use: the gym's per lifter, the table's for the pair at it.
    gym?.arrive(regular.id, there && act === "lift", ms, visit);
    if (act === "play" && keeper) ping?.playback.arrive(keeper, there, ms);
    const lift = act === "lift" ? gym?.pose(regular.id, ms, look.height, scratch.pose) ?? null : null;
    if (lift?.moving) pace?.moved(now);
    const rally = ping?.playback.seconds(ms) ?? null;
    const playing = act === "play" && ping && rally !== null ? playerPose(ping.table, m.pos[0], m.pos[1], m.yaw, spot.pingpong!, rally, look.height, look.build, scratch.player) : null;

    const [ll, lr] = legs.current, [al, ar] = arms.current, [el, er] = elbows.current;
    if (!ll || !lr || !al || !ar || !el || !er) return;
    let sip = 0;
    if (lift && liftRig(joints, g, m.pos, m.yaw, lift, look, scratch)) {
      // Between sets: their breath back, their arms shaken out, or a sip from the bottle.
      sip = restGesture(joints, lift, t);
      if (gestureAt(lift) > 0) pace?.ambled(now);
    } else if (playing && playRig(joints, g, m.pos, m.yaw, playing, look)) {
      // After a point, the one who won it holds the paddle up high; the free hand may have the ball.
      const cheer = cheerAt(spot.pingpong!, rally!);
      if (cheer > 0) blend(ar, er, UP, 1, cheer);
    } else {
      restRig(joints);
      g.position.y = walking ? Math.abs(Math.sin(t * 9)) * 0.035 : Math.sin(t * 1.6) * 0.006;
      const swing = walking ? Math.sin(t * 9) * 0.55 : 0;
      const [kl, kr] = knees.current;
      const sat = !walking && act === "sit";
      ll.rotation.x = sat ? -1.45 : swing;
      lr.rotation.x = sat ? -1.45 : -swing;
      if (kl && kr) kl.rotation.x = kr.rotation.x = sat ? 0.55 : 0;
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
        } else if (act === "sit") {
          // Sat on the mat, legs out and knees up a little, leaning back on their hands.
          g.position.y = MAT_SEAT - HIP * look.height + Math.sin(t * 1.6) * 0.004;
          if (upper.current) upper.current.rotation.x = -0.18;
          al.rotation.x = ar.rotation.x = 0.55;
          al.rotation.z = -0.12;
          ar.rotation.z = 0.12;
          if (head.current) head.current.rotation.set(0.1 + Math.sin(t * 0.4) * 0.05, Math.sin(t * 0.3) * 0.3, 0);
        } else if (act === "cooler") {
          const five = placement.partner ? highFiveAt(ms) : 0;
          sip = five > 0 ? 0 : cupAt(ms, regular.name.length * 2.3);
          if (five > 0) blend(ar, er, HIGH_FIVE, 1, five);
          else if (sip > 0) blend(ar, er, TO_MOUTH, 1, sip);
          else if (placement.partner) {
            // Chatting in between: a hand that talks and a nod now and then.
            al.rotation.x = -0.3 + Math.max(0, Math.sin(t * 0.9 + regular.name.length)) * Math.sin(t * 5) * 0.25;
            if (head.current) head.current.rotation.x = Math.sin(t * 1.7) * 0.07;
          }
          if (head.current && sip > 0) head.current.rotation.x = -0.25 * sip;
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
    if (e.delta < 6) onSelect({ name: regular.name, where: spot.group === "pingpong" ? "pingpong" : "gym" });
  };
  const held = act === "play" ? <Paddle /> : act === "cooler" ? (
    <group ref={bottle} visible={false} position={[0, -0.3, 0.05]}>
      <mesh geometry={CUP} material={PAPER} />
    </group>
  ) : <Bottle ref={bottle} />;

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
