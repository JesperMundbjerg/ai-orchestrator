import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { CylinderGeometry, MeshStandardMaterial, type Group, type Mesh, type MeshBasicMaterial, type Texture } from "three";
import type { ItemType, WorldAgent } from "../../shared/types.ts";
import { HARNESS_INFO } from "../../shared/harnesses.ts";
import { textTexture } from "./label.ts";
import { LAMP } from "./status.ts";
import { lookFor, type Look } from "./look.ts";
import type { Spot, Vec2 } from "./spatial.ts";
import type { Craft } from "./crafts.ts";
import { craftPose, HandTool } from "./Crafts.tsx";
import { usePace } from "./Pace.tsx";
import { useGames } from "./Games.tsx";
import { useGym } from "./Gym.tsx";
import { armReach, gestureAt, handTarget, newPose, newReach, type LiftPose, type Reach, type Visit } from "./gym.ts";
import { Paddle, usePing } from "./PingPong.tsx";
import { newPlayer, playerPose, type Player as PingPlayer } from "./pingpong.ts";

const WALK_SPEED = 1.9;
/** Strolling round the garden, taking it easy. */
const STROLL_SPEED = 0.8;
const TURN_RATE = 8;
/** Sitting on a bench: the hips drop to its seat and the legs reach forward. */
const HIP = 0.86;
const SEAT_H = 0.47;
/** Bending down to pick a flower: a short step, the hips as low as that brings them, and bent this far forward at the hips. */
const STEP = 0.3;
const STEP_DROP = HIP * (1 - Math.cos(STEP));
const BEND = 0.95;

export const CARD: Record<ItemType, { color: string; glyph: string }> = {
  decide: { color: "#8a4fd8", glyph: "?" },
  try: { color: "#0f8a6c", glyph: "▶" },
  milestone: { color: "#c26a12", glyph: "✓" },
};

interface Props {
  agent: WorldAgent;
  spot: Spot;
  /** Where a newly arrived agent first appears; null places it straight at its spot. */
  enterFrom: Vec2 | null;
  waiting: { count: number; type: ItemType } | null;
  selected: boolean;
  onSelect: (id: string) => void;
  /** What they are saying; shown once they stand still, so a visitor says it on arrival. */
  bubble: string | null;
  /** A folder in hand, for work being handed over. */
  carrying: boolean;
  /** Their team, named on their tag in its colour while they are out in the garden, so it stays clear whose they are. */
  team?: { name: string; color: string } | null;
  /** How to walk along the building's walkway. */
  walk: (from: Vec2, fromSpot: Spot | null, to: Spot) => Vec2[];
  /** What they make at their station in their team's room, while they work there. */
  craft?: Craft | null;
}

export function Avatar({ agent, spot, enterFrom, waiting, selected, onSelect, bubble, carrying, team = null, walk, craft = null }: Props) {
  const look = useMemo(() => lookFor(agent.id), [agent.id]);
  const root = useRef<Group>(null);
  const legs = useRef<[Group | null, Group | null]>([null, null]);
  const arms = useRef<[Group | null, Group | null]>([null, null]);
  const lamp = useRef<Mesh>(null);
  const halo = useRef<Mesh>(null);
  const speech = useRef<Group>(null);
  const head = useRef<Group>(null);
  const upper = useRef<Group>(null);
  const flower = useRef<Group>(null);
  const tool = useRef<Group>(null);
  const saw = useRef<Group>(null);
  const hammer = useRef<Group>(null);
  const body = useRef<Group>(null);
  const knees = useRef<[Group | null, Group | null]>([null, null]);
  const ankles = useRef<[Group | null, Group | null]>([null, null]);
  const elbows = useRef<[Group | null, Group | null]>([null, null]);
  const motion = useRef({
    pos: [...(enterFrom ?? spot.pos)] as Vec2,
    yaw: spot.facing,
    path: enterFrom ? walk(enterFrom, null, spot) : ([] as Vec2[]),
    spot,
    strolling: false,
    phase: Math.random() * 10,
  });
  const [hovered, setHovered] = useState(false);
  const pace = usePace();
  const games = useGames();
  const gym = useGym();
  const ping = usePing();
  // Scratch for the gym's lifts and ping pong, so a frame allocates nothing.
  const lifting = useMemo(() => ({ pose: newPose(), reach: newReach(), hand: [0, 0, 0] as [number, number, number], player: newPlayer() }), []);
  // At a gym station they do their own routine, round and round, for as long as they stay.
  const visit: Visit | undefined = useMemo(() => (spot.gym ? { station: spot.gym, seed: agent.id, until: Infinity } : undefined), [spot.gym, agent.id]);
  const bottle = useRef<Group>(null);
  const joints: Joints = useMemo(() => ({ body, upper, head, legs, knees, ankles, arms, elbows }), []);

  // A new spot sends the avatar walking there from wherever it is now.
  useEffect(() => {
    const m = motion.current;
    if (m.spot.pos[0] === spot.pos[0] && m.spot.pos[1] === spot.pos[1] && m.spot.group === spot.group) { m.spot = spot; return; }
    m.path = walk(m.pos, m.spot, spot);
    m.spot = spot;
    m.strolling = false;
  }, [spot]);

  useEffect(() => {
    document.body.style.cursor = hovered ? "pointer" : "";
    return () => void (document.body.style.cursor = "");
  }, [hovered]);

  // Up close at the clearing the full board would fill the view, and the card there names them already.
  const close = spot.zone === "caller";
  const tag = useMemo(() => {
    if (close) return textTexture([{ text: agent.name, size: 46, color: "#ffffff", weight: 700 }], { width: 320, height: 80, background: "rgba(16,20,28,0.72)", radius: 40 });
    const out = spot.zone === "garden" && team;
    const sub = [out ? team.name : agent.project, HARNESS_INFO[agent.harness].label].filter(Boolean).join(" · ");
    return textTexture(
      [
        { text: agent.name, size: 46, color: "#ffffff", weight: 700 },
        waiting
          ? { text: `waiting for you${waiting.count > 1 ? ` · ${waiting.count}` : ""}`, size: 26, color: "#ffc658" }
          : { text: sub, size: 26, color: out ? team.color : "#c8d0da", weight: out ? 700 : 500 },
      ],
      { width: 512, height: 128, background: "rgba(16,20,28,0.72)", radius: 40 },
    );
  }, [close, agent.name, agent.project, agent.harness, waiting?.count, spot.zone === "garden" && team ? `${team.name}${team.color}` : null]);
  useEffect(() => () => tag.dispose(), [tag]);

  const card = useMemo(
    () => (waiting ? textTexture([{ text: CARD[waiting.type].glyph, size: 150, color: "#ffffff", weight: 800 }], { width: 256, height: 256, background: CARD[waiting.type].color, radius: 28 }) : null),
    [waiting?.type],
  );
  useEffect(() => () => card?.dispose(), [card]);

  // The bubble is as wide as what is said, up to a limit.
  const saidWidth = bubble ? Math.min(1024, 120 + bubble.length * 15) : 0;
  const said = useMemo(
    () => (bubble ? textTexture([{ text: bubble, size: 30, color: "#16202c", weight: 600 }], { width: saidWidth, height: 96, background: "rgba(255,255,255,0.94)", radius: 44 }) : null),
    [bubble],
  );
  useEffect(() => () => said?.dispose(), [said]);

  useFrame((state, dt) => {
    const m = motion.current;
    const g = root.current;
    if (!g) return;
    const step = Math.min(dt, 0.1);
    // There, and out for a stroll: once more round it.
    if (!m.path.length && m.spot.stroll?.length) {
      m.path = [...m.spot.stroll];
      m.strolling = true;
    }
    let walking = false;
    let remaining = (m.strolling ? STROLL_SPEED : WALK_SPEED) * step;
    while (remaining > 0 && m.path.length) {
      const [tx, tz] = m.path[0]!;
      const dx = tx - m.pos[0];
      const dz = tz - m.pos[1];
      const d = Math.hypot(dx, dz);
      if (d < 1e-3) {
        m.path.shift();
        continue;
      }
      walking = true;
      const move = Math.min(d, remaining);
      m.pos[0] += (dx / d) * move;
      m.pos[1] += (dz / d) * move;
      remaining -= move;
      m.yaw = turn(m.yaw, Math.atan2(dx, dz), TURN_RATE * step);
      if (move >= d) m.path.shift();
    }
    if (!walking) m.yaw = turn(m.yaw, m.spot.facing, TURN_RATE * 0.5 * step);
    // Someone walking somewhere is drawn smoothly; walks round the garden, less so.
    if (walking) m.spot.zone === "garden" ? pace?.ambled(performance.now()) : pace?.moved(performance.now());
    g.position.set(m.pos[0], 0, m.pos[1]);
    g.rotation.y = m.yaw;
    const sitting = !walking && !!m.spot.sit;
    const pose = walking ? undefined : m.spot.pose;
    games?.arrive(agent.id, !walking && !m.path.length && !!spot.game && agent.status === "idle");
    const play = spot.game ? games?.frame(spot.game, Date.now()) : null;
    const gaming = play?.active && play.player === spot.game?.player ? play : null;
    if (play?.active) pace?.moved(performance.now());
    // At a gym station, once there and while idle: the lift's pose, the hands on the bar.
    gym?.arrive(agent.id, !walking && !m.path.length && !!visit && agent.status === "idle", Date.now(), visit);
    const lift = visit ? gym?.pose(agent.id, Date.now(), look.height, lifting.pose) ?? null : null;
    if (lift?.moving) pace?.moved(performance.now());
    // At their end of the ping pong table, once both players are there: the rally's stance and swing.
    const end = spot.pingpong;
    ping?.playback.arrive(agent.id, !walking && !m.path.length && end !== undefined && agent.status === "idle", Date.now());
    const rally = end !== undefined ? ping?.playback.seconds(Date.now()) ?? null : null;
    const playing = ping && end !== undefined && rally !== null ? playerPose(ping.table, m.pos[0], m.pos[1], m.yaw, end, rally, look.height, look.build, lifting.player) : null;

    const t = state.clock.elapsedTime + m.phase;
    // At their station while they work, they make something; otherwise they stand at it.
    const crafting = craft && !walking && m.spot.zone === "team" && agent.status === "working" ? craftPose(craft, t) : null;
    if (tool.current) tool.current.visible = !!crafting;
    if (saw.current) saw.current.visible = !crafting?.hammering;
    if (hammer.current) hammer.current.visible = !!crafting?.hammering;
    const holding = m.spot.zone === "queue" || carrying;
    // A stroller never stops, so they say it on the way.
    if (speech.current) speech.current.visible = !walking || m.strolling;
    const swing = walking ? Math.sin(t * (m.strolling ? 6 : 9)) * (m.strolling ? 0.4 : 0.55) : 0;
    const [ll, lr] = legs.current;
    const [al, ar] = arms.current;
    const picking = pose === "pick";
    if (ll && lr) {
      ll.rotation.x = sitting ? -1.4 : picking ? -STEP : swing;
      lr.rotation.x = sitting ? -1.4 : picking ? STEP : -swing;
    }
    // Picking a flower: bend down to it for a few seconds, then stand up and hold it up to look at it.
    const holdingFlower = picking && (t % 8) > 3.5;
    if (upper.current) upper.current.rotation.x = picking && !holdingFlower ? BEND : pose === "look" || pose === "stretch" ? -0.08 : gaming ? gaming.lean : crafting ? crafting.lean : 0;
    if (flower.current) flower.current.visible = holdingFlower;
    if (head.current) {
      head.current.rotation.x = pose === "look" ? -0.5 + Math.sin(t * 0.5) * 0.06 : picking ? (holdingFlower ? 0.1 : -0.4) : pose === "watch" ? 0.3 : pose === "chat" ? Math.sin(t * 1.7) * 0.07 : 0;
      head.current.rotation.y = pose === "look" ? Math.sin(t * 0.3) * 0.35 : pose === "watch" ? Math.sin(t * 0.4) * 0.3 : 0;
    }
    if (al && ar) {
      al.rotation.z = crafting ? crafting.left[1] : 0;
      ar.rotation.z = crafting ? crafting.right[1] : 0;
      if (gaming) {
        al.rotation.x = spot.game?.kind === "pool" ? gaming.arm : 0;
        ar.rotation.x = gaming.arm;
      } else if (pose === "pick") {
        // Bent over, the arms hang to the ground and one reaches for the flower.
        al.rotation.x = holdingFlower ? 0 : -BEND + 0.1;
        ar.rotation.x = holdingFlower ? -1.9 : -BEND - 0.35 + Math.sin(t * 3) * 0.12;
      } else if (pose === "watch") {
        // Hands clasped behind the back.
        al.rotation.x = 0.35;
        ar.rotation.x = 0.35;
      } else if (pose === "chat") {
        al.rotation.x = Math.sin(t * 1.3) * 0.04;
        ar.rotation.x = -0.35 + Math.max(0, Math.sin(t * 0.9)) * Math.sin(t * 5) * 0.3;
      } else if (pose === "stretch" && (t % 9) < 3.5) {
        // Arms up over the head for a long stretch, then down again.
        al.rotation.x = -2.9;
        ar.rotation.x = -2.9;
      } else if (crafting) {
        al.rotation.x = crafting.left[0];
        ar.rotation.x = crafting.right[0];
      } else if (sitting) {
        al.rotation.x = -0.55 + Math.sin(t * 1.3) * 0.03;
        ar.rotation.x = -0.55 + Math.sin(t * 1.3 + 1) * 0.03;
      } else {
        al.rotation.x = walking ? -swing * 0.8 : Math.sin(t * 1.3) * 0.04;
        ar.rotation.x = holding ? -0.9 : walking ? swing * 0.8 : Math.sin(t * 1.3 + 1) * 0.04;
      }
    }
    // Walking bob, and a gentle breath at rest.
    g.position.y = sitting ? SEAT_H - HIP * look.height : picking ? -STEP_DROP * look.height : walking ? Math.abs(Math.sin(t * 9)) * 0.035 : Math.sin(t * 1.6) * 0.006;
    let sip = 0;
    if (lift && liftRig(joints, g, m.pos, m.yaw, lift, look, lifting)) {
      // Between sets: their breath back, their arms shaken out or a sip from the bottle.
      sip = restGesture(joints, lift, t);
      if (gestureAt(lift) > 0) pace?.ambled(performance.now());
    } else if (!(playing && playRig(joints, g, m.pos, m.yaw, playing, look))) restRig(joints);
    if (bottle.current) bottle.current.visible = sip > 0;

    const status = LAMP[agent.status];
    const pulse = agent.status === "working" ? 0.75 + 0.25 * Math.sin(t * 4) : agent.status === "blocked" ? (Math.sin(t * 6) > 0 ? 1 : 0.35) : 1;
    if (lamp.current) {
      lamp.current.position.y = 2.18 + Math.sin(t * 2) * 0.03;
      (lamp.current.material as MeshBasicMaterial).opacity = 0.35 + 0.65 * status.glow * pulse;
    }
    if (halo.current) {
      halo.current.position.y = lamp.current?.position.y ?? 2.18;
      const s = 1 + 0.25 * pulse * status.glow;
      halo.current.scale.setScalar(s);
      (halo.current.material as MeshBasicMaterial).opacity = 0.28 * status.glow * pulse;
    }
  });

  const click = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.delta < 6) onSelect(agent.id);
  };

  return (
    <group
      ref={root}
      name={`avatar:${agent.id}`}
      onClick={click}
      onPointerOver={(e) => (e.stopPropagation(), setHovered(true))}
      onPointerOut={() => setHovered(false)}
    >
      <group ref={body} scale={look.height}>
        <Body look={look} legs={legs} knees={knees} ankles={ankles} elbows={elbows} held={spot.pingpong !== undefined ? <Paddle /> : spot.gym ? <Bottle ref={bottle} /> : null} arms={arms} card={card} folder={carrying} head={head} upper={upper} flower={flower} tool={craft ? <HandTool craft={craft} tool={tool} saw={saw} hammer={hammer} /> : null} />
      </group>
      <mesh ref={lamp} position={[0, 2.18, 0]}>
        <sphereGeometry args={[0.08, 20, 16]} />
        <meshBasicMaterial color={LAMP[agent.status].color} transparent toneMapped={false} />
      </mesh>
      <mesh ref={halo} position={[0, 2.18, 0]}>
        <sphereGeometry args={[0.2, 20, 16]} />
        <meshBasicMaterial color={LAMP[agent.status].color} transparent opacity={0.2} depthWrite={false} toneMapped={false} />
      </mesh>
      <sprite position={close ? [0, 2.42, 0] : [0, 2.68, 0]} scale={close ? [0.56, 0.14, 1] : [1.5, 0.375, 1]}>
        <spriteMaterial map={tag} transparent depthWrite={false} />
      </sprite>
      {said ? (
        <group ref={speech} position={[0, 3.12, 0]}>
          <sprite scale={[(saidWidth / 96) * 0.36, 0.36, 1]}>
            <spriteMaterial map={said} transparent depthWrite={false} />
          </sprite>
        </group>
      ) : null}
      {selected || hovered ? (
        <mesh rotation-x={-Math.PI / 2} position={[0, 0.015, 0]}>
          <ringGeometry args={[0.42, 0.52, 40]} />
          <meshBasicMaterial color={selected ? "#5b9dff" : "#ffffff"} transparent opacity={selected ? 0.9 : 0.5} toneMapped={false} />
        </mesh>
      ) : null}
    </group>
  );
}

/** The rig's joints, for the poses the gym and the ping pong table set. */
export interface Joints {
  body: RefObject<Group | null>;
  upper: RefObject<Group | null>;
  head: RefObject<Group | null>;
  legs: RefObject<[Group | null, Group | null]>;
  knees: RefObject<[Group | null, Group | null]>;
  ankles: RefObject<[Group | null, Group | null]>;
  arms: RefObject<[Group | null, Group | null]>;
  elbows: RefObject<[Group | null, Group | null]>;
}

/** A lift's pose on the rig standing at `pos`, the hands on the bar; false until the rig is there. */
export function liftRig(j: Joints, g: Group, pos: Vec2, yaw: number, lift: LiftPose, look: Look, scratch: { reach: Reach; hand: [number, number, number] }): boolean {
  const [ll, lr] = j.legs.current, [kl, kr] = j.knees.current, [nl, nr] = j.ankles.current, [al, ar] = j.arms.current, [el, er] = j.elbows.current;
  if (!(ll && lr && al && ar && kl && kr && nl && nr && el && er && j.body.current)) return false;
  const h = look.height;
  g.position.set(pos[0] + Math.sin(yaw) * lift.rootZ * h, lift.rootY * h, pos[1] + Math.cos(yaw) * lift.rootZ * h);
  j.body.current.rotation.x = lift.lie ? -Math.PI / 2 : 0;
  j.body.current.position.set(0, lift.lie ? lift.lieY * h : 0, lift.lie ? lift.lieZ * h : 0);
  ll.rotation.x = lr.rotation.x = lift.thigh;
  kl.rotation.x = kr.rotation.x = lift.knee;
  nl.rotation.x = nr.rotation.x = lift.ankle;
  if (j.upper.current) j.upper.current.rotation.x = lift.bend;
  if (j.head.current) j.head.current.rotation.set(lift.lift === "pullup" ? -0.25 : 0, 0, 0);
  for (let i = 0; i < 2; i++) {
    const side = i ? 1 : -1;
    const hand = handTarget(lift, look.build, side, scratch.hand);
    const r = armReach(hand[0], hand[1], hand[2], side * lift.poleX, lift.poleY, lift.poleZ, scratch.reach);
    (i ? ar : al).rotation.set(r.x, r.y, r.z);
    (i ? er : el).rotation.x = r.elbow;
  }
  return true;
}

/** A ping pong player's stance and swing on the rig standing at `pos`; false until the rig is there. */
export function playRig(j: Joints, g: Group, pos: Vec2, yaw: number, playing: PingPlayer, look: Look): boolean {
  const [ll, lr] = j.legs.current, [kl, kr] = j.knees.current, [nl, nr] = j.ankles.current, [al, ar] = j.arms.current, [el, er] = j.elbows.current;
  if (!(ll && lr && al && ar && kl && kr && nl && nr && el && er && j.body.current)) return false;
  const h = look.height;
  // Across to the ball, and in a step towards the table.
  g.position.set(pos[0] + Math.cos(yaw) * playing.rootX + Math.sin(yaw) * playing.rootZ, playing.rootY * h, pos[1] - Math.sin(yaw) * playing.rootX + Math.cos(yaw) * playing.rootZ);
  j.body.current.rotation.x = 0;
  j.body.current.position.set(0, 0, 0);
  // Stepping in, the left foot forward and the right back.
  ll.rotation.x = playing.thigh - playing.stride;
  lr.rotation.x = playing.thigh + playing.stride * 0.5;
  kl.rotation.x = kr.rotation.x = playing.knee;
  nl.rotation.x = nr.rotation.x = playing.ankle;
  if (j.upper.current) j.upper.current.rotation.x = playing.bend;
  if (j.head.current) j.head.current.rotation.set(0, playing.head, 0);
  ar.rotation.set(playing.right.x, playing.right.y, playing.right.z);
  er.rotation.x = playing.right.elbow;
  al.rotation.set(playing.left.x, playing.left.y, playing.left.z);
  el.rotation.x = playing.left.elbow;
  return true;
}

/** Back to standing straight: the body upright, the knees, ankles and elbows unbent, the arms not turned. */
export function restRig(j: Joints): void {
  if (!j.body.current) return;
  j.body.current.rotation.x = 0;
  j.body.current.position.set(0, 0, 0);
  const [kl, kr] = j.knees.current, [nl, nr] = j.ankles.current, [el, er] = j.elbows.current, [al, ar] = j.arms.current;
  if (kl && kr && nl && nr) kl.rotation.x = kr.rotation.x = nl.rotation.x = nr.rotation.x = 0;
  if (el && er) el.rotation.x = er.rotation.x = 0;
  if (al && ar) al.rotation.y = ar.rotation.y = 0;
}

// What a lifter drinks from between sets, in the right hand: one geometry and one material for everyone's.
const BOTTLE = new CylinderGeometry(0.032, 0.032, 0.2, 10);
const BOTTLE_FINISH = new MeshStandardMaterial({ color: "#5fb3e6", roughness: 0.3, transparent: true, opacity: 0.85 });

/** A water bottle in the hand, hidden until they drink. */
export function Bottle({ ref }: { ref: RefObject<Group | null> }) {
  return (
    <group ref={ref} visible={false} position={[0, -0.3, 0.05]}>
      <mesh geometry={BOTTLE} material={BOTTLE_FINISH} />
    </group>
  );
}

/** Arm poses the touches blend to, from the right shoulder (mirrored for the left): worked out once. */
const reachTo = (x: number, y: number, z: number, pole: [number, number, number]): Reach => armReach(x, y, z, pole[0], pole[1], pole[2], newReach());
export const TO_MOUTH = reachTo(-0.2, 0.17, 0.2, [1, -1, 0]);
export const HIGH_FIVE = reachTo(-0.22, 0.45, 0.42, [1, -0.3, -0.4]);
export const UP = reachTo(-0.04, 0.6, 0.1, [1, 0, -0.2]);
/** Hands on the hips, the elbows out. */
const HIPS = reachTo(-0.1, -0.44, 0.02, [1, 0.1, -0.5]);

/** Turn an arm part of the way to a pose given for the right arm; `side` -1 mirrors it for the left. */
export function blend(arm: Group, elbow: Group, to: Reach, side: number, f: number): void {
  arm.rotation.set(arm.rotation.x + (to.x - arm.rotation.x) * f, arm.rotation.y + (side * to.y - arm.rotation.y) * f, arm.rotation.z + (side * to.z - arm.rotation.z) * f);
  elbow.rotation.x += (to.elbow - elbow.rotation.x) * f;
}

/**
 * A rest between sets on a rig `liftRig` has put in the rest's pose: hands on the hips getting
 * their breath, the arms shaken out, or a sip from the bottle. `t` is the avatar's own clock, for
 * the shaking. How far the bottle is up (0 to 1), to show it.
 */
export function restGesture(j: Joints, lift: LiftPose, t: number): number {
  const f = gestureAt(lift);
  const [al, ar] = j.arms.current, [el, er] = j.elbows.current;
  if (f <= 0 || !al || !ar || !el || !er) return 0;
  if (lift.rest === "breathe") {
    blend(ar, er, HIPS, 1, f);
    blend(al, el, HIPS, -1, f);
    if (j.upper.current) j.upper.current.rotation.x += (0.12 + Math.sin(t * 2.4) * 0.04) * f;
    if (j.head.current) j.head.current.rotation.x = 0.2 * f;
    return 0;
  }
  if (lift.rest === "shake") {
    const shake = Math.sin(t * 21) * f;
    al.rotation.z += -0.14 * shake;
    ar.rotation.z += 0.14 * shake;
    al.rotation.x += 0.1 * shake;
    ar.rotation.x -= 0.1 * shake;
    el.rotation.x = er.rotation.x = -0.2 * f - 0.15 * Math.abs(shake);
    return 0;
  }
  blend(ar, er, TO_MOUTH, 1, f);
  if (j.head.current) j.head.current.rotation.x = -0.3 * f;
  return f;
}

export function turn(from: number, to: number, max: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return from + Math.max(-max, Math.min(max, d));
}

export function Body({ look, legs, knees, ankles, elbows, held = null, arms, card, folder = false, head, upper, flower, tool = null }: {
  look: Look;
  legs: RefObject<[Group | null, Group | null]>;
  /** The legs' and arms' lower joints, for the gym's lifts; straight unless turned. */
  knees?: RefObject<[Group | null, Group | null]>;
  ankles?: RefObject<[Group | null, Group | null]>;
  elbows?: RefObject<[Group | null, Group | null]>;
  /** In the right hand, turning with the forearm: a ping pong paddle. */
  held?: ReactNode;
  arms: RefObject<[Group | null, Group | null]>;
  card: Texture | null;
  folder?: boolean;
  /** To tilt and turn the head. */
  head?: RefObject<Group | null>;
  /** Everything above the hips, to bend forward or back at them. */
  upper?: RefObject<Group | null>;
  /** A flower in the right hand, shown once picked. */
  flower?: RefObject<Group | null>;
  /** What they work with at their craft, in the right hand. */
  tool?: ReactNode;
}) {
  const skin = <meshStandardMaterial color={look.skin} roughness={0.7} />;
  const shirt = <meshStandardMaterial color={look.shirt} roughness={0.8} />;
  const pants = <meshStandardMaterial color={look.pants} roughness={0.85} />;
  return (
    <group>
      {([-1, 1] as const).map((side, i) => (
        <group key={side} ref={(g) => void (legs.current[i] = g)} position={[side * 0.1, 0.86, 0]}>
          {/* The thigh, then the shin and foot from the knee: one straight leg until a knee bends. */}
          <mesh position={[0, -0.215, 0]} castShadow>
            <capsuleGeometry args={[0.085, 0.25, 4, 12]} />
            {pants}
          </mesh>
          <group ref={(g) => void (knees && (knees.current[i] = g))} position={[0, -0.43, 0]}>
            <mesh position={[0, -0.18, 0]} castShadow>
              <capsuleGeometry args={[0.085, 0.19, 4, 12]} />
              {pants}
            </mesh>
            <group ref={(g) => void (ankles && (ankles.current[i] = g))} position={[0, -0.36, 0]}>
              <mesh position={[0, -0.03, 0.05]} castShadow>
                <boxGeometry args={[0.15, 0.08, 0.28]} />
                <meshStandardMaterial color={look.shoes} roughness={0.6} />
              </mesh>
            </group>
          </group>
        </group>
      ))}
      <group ref={upper} position={[0, HIP, 0]}>
        <group position={[0, -HIP, 0]}>
          <mesh position={[0, 1.16, 0]} scale={[look.build, 1, 0.72]} castShadow>
            <capsuleGeometry args={[0.2, 0.34, 6, 16]} />
            {shirt}
          </mesh>
          {/* A small badge in the agent's accent colour. */}
          <mesh position={[0.1 * look.build, 1.3, 0.15]}>
            <circleGeometry args={[0.035, 16]} />
            <meshStandardMaterial color={look.accent} emissive={look.accent} emissiveIntensity={0.25} />
          </mesh>
          {([-1, 1] as const).map((side, i) => (
            <group key={side} ref={(g) => void (arms.current[i] = g)} position={[side * 0.27 * look.build, 1.42, 0]}>
              {/* The upper arm, then the forearm and hand from the elbow. */}
              <mesh position={[0, -0.135, 0]} castShadow>
                <capsuleGeometry args={[0.058, 0.155, 4, 10]} />
                {shirt}
              </mesh>
              <group ref={(g) => void (elbows && (elbows.current[i] = g))} position={[0, -0.27, 0]}>
                <mesh position={[0, -0.135, 0]} castShadow>
                  <capsuleGeometry args={[0.058, 0.155, 4, 10]} />
                  {shirt}
                </mesh>
                <mesh name="hand" position={[0, -0.27, 0]}>
                  <sphereGeometry args={[0.066, 12, 10]} />
                  {skin}
                </mesh>
                {side === 1 ? held : null}
              </group>
              {side === 1 && folder ? (
                <mesh position={[0, -0.6, 0.14]} rotation={[Math.PI / 2 - 0.9, 0, 0]} castShadow>
                  <boxGeometry args={[0.3, 0.38, 0.04]} />
                  <meshStandardMaterial color="#e3b95f" roughness={0.8} />
                </mesh>
              ) : side === 1 && card ? (
                <mesh position={[0, -0.6, 0.12]} rotation={[Math.PI / 2 - 0.9, 0, 0]}>
                  <planeGeometry args={[0.26, 0.26]} />
                  <meshBasicMaterial map={card} toneMapped={false} side={2} />
                </mesh>
              ) : side === 1 && flower ? (
                <group ref={flower} position={[0, -0.62, 0.04]} visible={false}>
                  <mesh position={[0, -0.08, 0]}>
                    <cylinderGeometry args={[0.008, 0.008, 0.2, 5]} />
                    <meshStandardMaterial color="#4f8a3a" />
                  </mesh>
                  <mesh position={[0, -0.19, 0]}>
                    <sphereGeometry args={[0.045, 8, 6]} />
                    <meshStandardMaterial color={look.accent} emissive={look.accent} emissiveIntensity={0.2} />
                  </mesh>
                </group>
              ) : null}
              {side === 1 && !folder && !card ? tool : null}
            </group>
          ))}
          <mesh position={[0, 1.55, 0]}>
            <cylinderGeometry args={[0.06, 0.07, 0.1, 12]} />
            {skin}
          </mesh>
          <group ref={head} position={[0, 1.73, 0]}>
            <mesh castShadow>
              <sphereGeometry args={[0.165, 24, 20]} />
              {skin}
            </mesh>
            {([-1, 1] as const).map((side) => (
              <mesh key={side} position={[side * 0.058, 0.02, 0.152]}>
                <sphereGeometry args={[0.02, 10, 8]} />
                <meshStandardMaterial color="#15171b" roughness={0.3} />
              </mesh>
            ))}
            <mesh position={[0, -0.06, 0.155]} rotation={[0, 0, Math.PI]}>
              <torusGeometry args={[0.035, 0.008, 6, 12, Math.PI]} />
              <meshStandardMaterial color="#6d3b33" />
            </mesh>
            <Hair look={look} />
            <Accessory look={look} />
          </group>
        </group>
      </group>
    </group>
  );
}

function Hair({ look }: { look: Look }) {
  const mat = <meshStandardMaterial color={look.hair} roughness={0.9} />;
  const cap = (
    <mesh position={[0, 0.03, -0.01]} rotation-x={-0.45} scale={[1.06, 1, 1.08]}>
      <sphereGeometry args={[0.17, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.5]} />
      {mat}
    </mesh>
  );
  switch (look.hairStyle) {
    case "bald":
      return null;
    case "short":
      return cap;
    case "long":
      return (
        <group>
          {cap}
          <mesh position={[0, -0.1, -0.08]}>
            <boxGeometry args={[0.34, 0.34, 0.16]} />
            {mat}
          </mesh>
        </group>
      );
    case "bob":
      return (
        <group>
          {cap}
          <mesh position={[0, -0.03, -0.02]} scale={[1.12, 0.8, 1.1]}>
            <sphereGeometry args={[0.17, 20, 14, 0, Math.PI * 2, Math.PI * 0.35, Math.PI * 0.35]} />
            <meshStandardMaterial color={look.hair} roughness={0.9} side={2} />
          </mesh>
        </group>
      );
    case "bun":
      return (
        <group>
          {cap}
          <mesh position={[0, 0.17, -0.1]}>
            <sphereGeometry args={[0.075, 16, 12]} />
            {mat}
          </mesh>
        </group>
      );
    case "spiky":
      return (
        <group>
          {cap}
          {[-0.08, 0, 0.08].flatMap((x) => [-0.05, 0.05].map((z) => (
            <mesh key={`${x}${z}`} position={[x, 0.18, z]} rotation={[z * 3, 0, -x * 3]}>
              <coneGeometry args={[0.04, 0.12, 6]} />
              {mat}
            </mesh>
          )))}
        </group>
      );
    case "curly":
      return (
        <group>
          {Array.from({ length: 11 }, (_, i) => {
            const a = (i / 11) * Math.PI * 2;
            return (
              <mesh key={i} position={[Math.sin(a) * 0.12, 0.1 + (i % 2) * 0.04, Math.cos(a) * 0.12 - 0.02]}>
                <sphereGeometry args={[0.065, 10, 8]} />
                {mat}
              </mesh>
            );
          })}
          <mesh position={[0, 0.15, -0.01]}>
            <sphereGeometry args={[0.09, 12, 10]} />
            {mat}
          </mesh>
        </group>
      );
    case "mohawk":
      return (
        <mesh position={[0, 0.17, -0.01]}>
          <boxGeometry args={[0.05, 0.1, 0.3]} />
          {mat}
        </mesh>
      );
  }
}

function Accessory({ look }: { look: Look }) {
  switch (look.accessory) {
    case "glasses":
      return (
        <group position={[0, 0.02, 0.16]}>
          {([-1, 1] as const).map((side) => (
            <mesh key={side} position={[side * 0.058, 0, 0]}>
              <torusGeometry args={[0.035, 0.007, 6, 16]} />
              <meshStandardMaterial color="#1c1c1c" />
            </mesh>
          ))}
          <mesh>
            <boxGeometry args={[0.05, 0.008, 0.008]} />
            <meshStandardMaterial color="#1c1c1c" />
          </mesh>
        </group>
      );
    case "headphones":
      return (
        <group>
          <mesh rotation={[0, Math.PI / 2, 0]} position={[0, 0.02, 0]}>
            <torusGeometry args={[0.18, 0.018, 8, 24, Math.PI]} />
            <meshStandardMaterial color="#22252b" />
          </mesh>
          {([-1, 1] as const).map((side) => (
            <mesh key={side} position={[side * 0.17, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
              <cylinderGeometry args={[0.06, 0.06, 0.05, 16]} />
              <meshStandardMaterial color={look.accent} />
            </mesh>
          ))}
        </group>
      );
    case "cap":
      return (
        <group position={[0, 0.07, 0]}>
          <mesh>
            <sphereGeometry args={[0.178, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.5]} />
            <meshStandardMaterial color={look.accent} roughness={0.8} />
          </mesh>
          <mesh position={[0, 0, 0.16]} rotation={[-0.15, 0, 0]}>
            <cylinderGeometry args={[0.1, 0.1, 0.015, 20, 1, false, -Math.PI / 2, Math.PI]} />
            <meshStandardMaterial color={look.accent} roughness={0.8} />
          </mesh>
        </group>
      );
    case "beanie":
      return (
        <mesh position={[0, 0.06, 0]} rotation-x={-0.3} scale={[1.1, 1.05, 1.1]}>
          <sphereGeometry args={[0.17, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.55]} />
          <meshStandardMaterial color={look.accent} roughness={0.95} />
        </mesh>
      );
    case "none":
      return null;
  }
}

