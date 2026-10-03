// The office gym, in the south-east corner behind its reading nook. Pure: where the stations
// stand, who of the idle agents trains at which, and every lift as a baked pose a frame looks up.
//
//   where    along the corner's outer wall, on a rubber floor behind the nook's sofa: a pull-up rig,
//            a bench with its uprights, a squat rack and a lifting platform, with a plate tree. Agents
//            come in by the nook's way in and along a lane in front of the stations
//   who      like the lounge games: idle agents who could be out for a break, never one already
//            playing, at most a third of them and one a station, picked by a hash of their id so it
//            is always the same people at the same stations; they stay while they are eligible
//   what     the platform: snatches and clean and jerks; the rack: back and front squats; the bench:
//            bench presses; the rig: pull-ups and hanging knee raises. A lifter does a routine seeded
//            by who they are: three sets, the exercise changing between them where the station has
//            more than one, each set followed by a rest (getting their breath, shaking their arms out
//            or a sip from their bottle; at the bench, sat up on it). A pose is a few joint angles and
//            where the bar is, eased between keyframes, and the hands are put on the bar by a two-bone
//            reach (`armReach`)
//
// Lengths are in the avatar's own units (Avatar.tsx's body before it is scaled to its height):
// hips 0.86 up, shoulders 1.42 up and 0.27 out, arms of two 0.27 halves, thighs 0.43, shins 0.36
// and feet 0.07. Points the bar rests on outside the body (the platform, the hooks, the uprights,
// the pull-up bar) are in metres and divided by the lifter's height, so they meet the equipment.

import type { WorldAgent } from "../../shared/types.ts";
import { place, readingNooks, type BuildingPlan } from "./building.ts";
import { hash, outForABreak } from "./park.ts";
import type { Spot, Vec2 } from "./spatial.ts";

export type Station = "platform" | "rack" | "bench" | "pullup";
export const STATIONS: Station[] = ["platform", "rack", "bench", "pullup"];
export type Lift = "snatch" | "clean" | "squat" | "frontsquat" | "bench" | "pullup" | "kneeraise";

/** At most this share of the idle agents trains, so the garden, the lounge and the nooks keep theirs. */
export const GYM_SHARE = 1 / 3;

// The body, in its own units.
export const HIP = 0.86;
export const SHOULDER_Y = 1.42;
export const SHOULDER_X = 0.27;
export const UPPER_ARM = 0.27;
export const FOREARM = 0.27;
export const THIGH = 0.43;
export const SHIN = 0.36;
export const FOOT = 0.07;
/** From the hips up to the shoulders. */
const TORSO = SHOULDER_Y - HIP;
/** Half the torso's depth: where a bar on the chest or the back sits. */
const CHEST = 0.145;

// The equipment, in metres in a station's frame (+z the way its lifter faces, x across).
export const PLATE_R = 0.225;
/** The platform stands this high off the floor. */
export const PLATFORM_H = 0.02;
export const BAR_LENGTH = 2.2;
/** The bar on the platform, in front of the lifter's shins. */
const FLOOR_Z = 0.17;
/** The squat stand's hooks: just behind the lifter's neck, on uprights either side of them. The lifter steps back this far to squat. */
export const HOOK_Y = 1.4;
export const HOOK_Z = -0.04;
export const WALKOUT = 0.45;
/** The bench: its top, and the uprights the bar rests in over the lifter's head. */
export const BENCH_TOP = 0.45;
export const BENCH_FROM = -1.45;
export const BENCH_TO = -0.15;
export const UPRIGHT_Y = 1.0;
export const UPRIGHT_Z = -1.2;
/** The pull-up bar, a little in front of the lifter. */
export const PULL_Y = 2.35;
export const PULL_Z = 0.04;

// ---------------------------------------------------------------- where

/**
 * A corner's square in its reading nook's frame, x mirrored so the nook's way in is on the same
 * side in every corner: `at` places a point given from the square's middle, the back wall at -half.
 */
export function cornerFrame(plan: Pick<BuildingPlan, "rooms" | "outline" | "hall">, nook: ReturnType<typeof readingNooks>[number]) {
  const half = (plan.outline.maxX - plan.hall.maxX) / 2;
  const at = (x: number, z: number): Vec2 => place(nook.center, nook.facing, [x * nook.side, z]);
  // The corridor down from the nook's way in, on the far side of its sofa.
  const inside = nook.seats[0]!.approach.slice(0, 3);
  const corridor = place([0, 0], -nook.facing, [inside[2]![0] - nook.center[0], inside[2]![1] - nook.center[1]])[0] * nook.side;
  /** The way to (x, z): in by the nook's way in, down the corridor and along `lane` to above it. */
  const way = (x: number, lane: number): Vec2[] => [...inside, at(corridor, lane), at(x, lane)];
  return { nook, half, at, way };
}

/** The corner the gym is in: the south-east reading nook's. */
export function gymCorner(plan: Pick<BuildingPlan, "rooms" | "outline" | "hall">) {
  const frame = cornerFrame(plan, readingNooks(plan).reduce((a, b) => (b.center[0] + b.center[1] > a.center[0] + a.center[1] ? b : a)));
  return { ...frame, lane: -frame.half + 2.4 };
}

/** Each station: across the back wall from the way in, where its lifter stands and what stands round them. */
export const LAYOUT: Record<Station, { x: number; z: number }> = {
  pullup: { x: 3.3, z: 1.1 },
  bench: { x: 1.55, z: 2.0 },
  rack: { x: -0.45, z: 1.3 },
  platform: { x: -2.85, z: 1.15 },
};

/** Where a station's lifter stands, facing out from the wall, and the way there: in by the nook, along the lane. */
export function gymSpot(plan: Pick<BuildingPlan, "rooms" | "outline" | "hall">, station: Station): Spot {
  const { nook, half, at, way, lane } = gymCorner(plan);
  const { x, z } = LAYOUT[station];
  return { pos: at(x, -half + z), facing: nook.facing, zone: "lounge", group: "gym", approach: way(x, lane), gym: station };
}

// ---------------------------------------------------------------- who

export type Gym = Map<string, Spot>;

/**
 * Who trains where. Eligible like the lounge games (idle, not waiting on you nor in line, a project
 * member only once out for a break), and never someone `playing` a game. At most a third of them,
 * one a station; those already there stay while they are eligible, and the rest go by a hash of
 * their id, each to the station they like best that is free.
 */
export function chooseGym(plan: BuildingPlan, agents: WorldAgent[], since: ReadonlyMap<string, number>, now: number, before: Gym = new Map(), playing: ReadonlySet<string> = new Set()): Gym {
  const out = outForABreak(agents, since, now, plan.queue);
  const eligible = agents
    .filter((a) => a.status === "idle" && !a.waitingOnYou && !plan.queue.includes(a.id) && (!a.teamId || out.has(a.id)) && !playing.has(a.id))
    .map((a) => a.id);
  const room = Math.min(STATIONS.length, Math.floor(eligible.length * GYM_SHARE + 1e-9));
  const result: Gym = new Map();
  const free = new Set(STATIONS);
  for (const [id, spot] of before) {
    if (result.size >= room || !eligible.includes(id) || !spot.gym || !free.has(spot.gym)) continue;
    free.delete(spot.gym);
    result.set(id, gymSpot(plan, spot.gym));
  }
  const order = eligible.filter((id) => !result.has(id)).sort((a, b) => hash(`gym:${a}`) - hash(`gym:${b}`) || a.localeCompare(b));
  for (const id of order) {
    if (result.size >= room) break;
    const first = hash(`station:${id}`) % STATIONS.length;
    const station = [0, 1, 2, 3].map((k) => STATIONS[(first + k) % STATIONS.length]!).find((s) => free.has(s))!;
    free.delete(station);
    result.set(id, gymSpot(plan, station));
  }
  return result;
}

/** A lifter's time at a station: where, the seed their routine goes by, and when they leave (ms; Infinity while they stay). */
export interface Visit { station: Station; seed: string; until: number }
export interface Training extends Visit { start: number }

/**
 * When each lifter got to their station, and which: a lift's clock starts once they are there,
 * never on the way, and walking away stops it, so coming back starts the routine again. The bars
 * go by it, so a bar is lifted by whoever is at its station, agent or regular.
 */
export class GymPlayback {
  /** Who is training, where, since when and until when. */
  readonly training = new Map<string, Training>();
  arrive(id: string, ready: boolean, now: number, visit?: Visit): void {
    const was = this.training.get(id);
    if (!ready || !visit) this.training.delete(id);
    else if (!was || was.station !== visit.station || was.seed !== visit.seed) this.training.set(id, { ...visit, start: now });
    else was.until = visit.until;
  }
  /** Seconds they have been training, or null while they are not there. */
  seconds(id: string, now: number): number | null {
    const t = this.training.get(id);
    return t === undefined ? null : Math.max(0, (now - t.start) / 1000);
  }
  /** Who is training at a station, or null. */
  lifterAt(station: Station): string | null {
    for (const [id, t] of this.training) if (t.station === station) return id;
    return null;
  }
  /** A lifter's pose this moment, for one this tall, written into `out`; null while they are not training. */
  pose(id: string, now: number, h: number, out: LiftPose): LiftPose | null {
    const t = this.training.get(id);
    if (!t) return null;
    return sessionPose(t.station, t.seed, Math.max(0, (now - t.start) / 1000), (t.until - t.start) / 1000, h, out);
  }
}

// ---------------------------------------------------------------- what

/** Where the bar is in a keyframe: on something, or held somewhere about the body. */
type Bar = "floor" | "hooks" | "uprights" | "pullbar" | "hang" | "overhead" | "rack" | "back" | "chest" | "lockout";
type V3 = [number, number, number];

/** A keyframe. Legs as how far the thighs come forward (`t`) and the shins lean back (`s`); `b` bends forward at the hips. */
interface Key {
  at: number;
  t: number;
  s: number;
  b: number;
  /** Up on the toes, or off the floor. */
  up: number;
  /** Stepped back from where they stand. */
  back?: number;
  bar: Bar;
  /** 0 hands by the sides, 1 hands on the bar. */
  grip: number;
  /** Where the elbows point, in the shoulders' frame, x outwards. */
  pole: V3;
  /** Hanging from the pull-up bar: the hands this far above the shoulders. */
  hang?: number;
  /** The bar falls here, rather than being eased. */
  fall?: boolean;
}

export interface LiftPlay {
  lift: Lift;
  /** Lying on the bench. */
  lie: boolean;
  /** Half the grip's width. */
  w: number;
  keys: Key[];
  /** One round, rests and all. */
  length: number;
}

const ELBOWS_DOWN: V3 = [0.8, -1, -0.25];
const ELBOWS_FRONT: V3 = [0.35, -0.1, 1];
const ELBOWS_BACK: V3 = [0.5, -1, -0.7];
const ELBOWS_OUT: V3 = [1, 0, -0.45];
const ELBOWS_HANG: V3 = [1, -0.5, 0.35];

const STAND = { t: 0, s: 0, b: 0, up: 0 };
const key = (at: number, pose: { t: number; s: number; b: number; up?: number; back?: number }, bar: Bar, grip: number, pole: V3, more: Partial<Key> = {}): Key =>
  ({ at, t: pose.t, s: pose.s, b: pose.b, up: pose.up ?? 0, back: pose.back ?? 0, bar, grip, pole, ...more });

/** Hold the last keyframe until `at`. */
const hold = (keys: Key[], at: number): Key => ({ ...keys.at(-1)!, at, fall: false });

function snatch(): LiftPlay {
  const keys: Key[] = [];
  const setup = { t: 1.25, s: 0.85, b: 1.15 };
  keys.push(key(0, STAND, "floor", 0, ELBOWS_DOWN));
  keys.push(key(1.0, setup, "floor", 1, ELBOWS_DOWN));
  keys.push(hold(keys, 1.5));
  // Off the floor past the knees, then the hips drive through, up on the toes.
  keys.push(key(1.95, { t: 0.55, s: 0.3, b: 0.75 }, "hang", 1, ELBOWS_DOWN));
  keys.push(key(2.2, { t: 0, s: 0, b: -0.12, up: 0.07 }, "hang", 1, ELBOWS_DOWN));
  // Under it in one go: caught overhead at the bottom of a squat.
  keys.push(key(2.5, { t: 1.3, s: 0.95, b: 0.3 }, "overhead", 1, ELBOWS_DOWN));
  keys.push(hold(keys, 2.9));
  keys.push(key(4.0, STAND, "overhead", 1, ELBOWS_DOWN));
  keys.push(hold(keys, 4.6));
  // Dropped from overhead to the platform; the arms come down after it.
  keys.push(key(5.15, { t: 0.15, s: 0.1, b: 0.1 }, "floor", 0, ELBOWS_DOWN, { fall: true }));
  keys.push(key(5.6, STAND, "floor", 0, ELBOWS_DOWN));
  keys.push(hold(keys, 8.5));
  return { lift: "snatch", lie: false, w: 0.42, keys, length: 8.5 };
}

function clean(): LiftPlay {
  const keys: Key[] = [];
  keys.push(key(0, STAND, "floor", 0, ELBOWS_DOWN));
  keys.push(key(1.0, { t: 1.2, s: 0.85, b: 1.1 }, "floor", 1, ELBOWS_DOWN));
  keys.push(hold(keys, 1.5));
  keys.push(key(1.95, { t: 0.55, s: 0.3, b: 0.75 }, "hang", 1, ELBOWS_DOWN));
  keys.push(key(2.2, { t: 0, s: 0, b: -0.12, up: 0.07 }, "hang", 1, ELBOWS_DOWN));
  // The clean: caught on the shoulders in a front squat, elbows high, and stood up.
  keys.push(key(2.5, { t: 1.3, s: 0.95, b: 0.15 }, "rack", 1, ELBOWS_FRONT));
  keys.push(hold(keys, 2.9));
  keys.push(key(4.0, STAND, "rack", 1, ELBOWS_FRONT));
  keys.push(hold(keys, 4.7));
  // The jerk: dip, drive it overhead, catch it in a short dip and stand.
  keys.push(key(5.0, { t: 0.35, s: 0.35, b: 0 }, "rack", 1, ELBOWS_FRONT));
  keys.push(key(5.25, { ...STAND, up: 0.06 }, "overhead", 1, ELBOWS_DOWN));
  keys.push(key(5.45, { t: 0.35, s: 0.35, b: 0 }, "overhead", 1, ELBOWS_DOWN));
  keys.push(key(6.1, STAND, "overhead", 1, ELBOWS_DOWN));
  keys.push(hold(keys, 6.7));
  keys.push(key(7.25, { t: 0.15, s: 0.1, b: 0.1 }, "floor", 0, ELBOWS_DOWN, { fall: true }));
  keys.push(key(7.7, STAND, "floor", 0, ELBOWS_DOWN));
  keys.push(hold(keys, 11));
  return { lift: "clean", lie: false, w: 0.3, keys, length: 11 };
}

export const REPS = 5;
/** Stood still at the end of a set of squats, bench presses, pull-ups or knee raises, before the rest. */
export const SET_END = 1;

function squat(): LiftPlay {
  const keys: Key[] = [];
  const under = { t: 0.45, s: 0.45, b: 0.15 };
  const out = { ...STAND, b: 0.05, back: WALKOUT };
  const bottom = { t: 1.25, s: 0.85, b: 0.55, back: WALKOUT };
  keys.push(key(0, STAND, "hooks", 0, ELBOWS_BACK));
  keys.push(key(0.8, under, "hooks", 1, ELBOWS_BACK));
  // Up off the hooks, and a step back clear of them.
  keys.push(key(1.4, { ...STAND, b: 0.05 }, "back", 1, ELBOWS_BACK));
  keys.push(key(2.2, out, "back", 1, ELBOWS_BACK));
  keys.push(hold(keys, 2.6));
  let at = 2.6;
  for (let r = 0; r < REPS; r++) {
    keys.push(key((at += 1.2), bottom, "back", 1, ELBOWS_BACK));
    keys.push(key((at += 1.0), out, "back", 1, ELBOWS_BACK));
    keys.push(hold(keys, (at += 0.6)));
  }
  keys.push(key((at += 0.8), { ...STAND, b: 0.05 }, "back", 1, ELBOWS_BACK));
  keys.push(key((at += 0.8), under, "hooks", 1, ELBOWS_BACK));
  keys.push(key((at += 0.6), STAND, "hooks", 0, ELBOWS_BACK));
  keys.push(hold(keys, (at += SET_END)));
  return { lift: "squat", lie: false, w: 0.55, keys, length: at };
}

function frontSquat(): LiftPlay {
  // Stood further back than for a back squat, so the hooks are in front of the neck and the bar
  // comes off them onto the front of the shoulders, elbows high.
  const keys: Key[] = [];
  const IN = 0.2;
  const under = { t: 0.45, s: 0.45, b: 0.05, back: IN };
  const out = { ...STAND, back: IN + WALKOUT };
  const bottom = { t: 1.3, s: 0.95, b: 0.2, back: IN + WALKOUT };
  keys.push(key(0, STAND, "hooks", 0, ELBOWS_FRONT));
  keys.push(key(0.7, { ...STAND, back: IN }, "hooks", 0, ELBOWS_FRONT));
  keys.push(key(1.4, under, "hooks", 1, ELBOWS_FRONT));
  keys.push(key(2.0, { ...STAND, back: IN }, "rack", 1, ELBOWS_FRONT));
  keys.push(key(2.8, out, "rack", 1, ELBOWS_FRONT));
  keys.push(hold(keys, 3.2));
  let at = 3.2;
  for (let r = 0; r < REPS; r++) {
    keys.push(key((at += 1.2), bottom, "rack", 1, ELBOWS_FRONT));
    keys.push(key((at += 1.0), out, "rack", 1, ELBOWS_FRONT));
    keys.push(hold(keys, (at += 0.6)));
  }
  keys.push(key((at += 0.8), { ...STAND, back: IN }, "rack", 1, ELBOWS_FRONT));
  keys.push(key((at += 0.6), under, "hooks", 1, ELBOWS_FRONT));
  keys.push(key((at += 0.6), { ...STAND, back: IN }, "hooks", 0, ELBOWS_FRONT));
  keys.push(key((at += 0.7), STAND, "hooks", 0, ELBOWS_FRONT));
  keys.push(hold(keys, (at += SET_END)));
  return { lift: "frontsquat", lie: false, w: 0.3, keys, length: at };
}

function bench(): LiftPlay {
  const keys: Key[] = [];
  keys.push(key(0, STAND, "uprights", 0, ELBOWS_OUT));
  keys.push(key(1.0, STAND, "uprights", 1, ELBOWS_OUT));
  keys.push(key(1.6, STAND, "lockout", 1, ELBOWS_OUT));
  keys.push(hold(keys, 2.2));
  let at = 2.2;
  for (let r = 0; r < REPS; r++) {
    keys.push(key((at += 1.3), STAND, "chest", 1, ELBOWS_OUT));
    keys.push(hold(keys, (at += 0.3)));
    keys.push(key((at += 0.9), STAND, "lockout", 1, ELBOWS_OUT));
    keys.push(hold(keys, (at += 0.5)));
  }
  keys.push(key((at += 0.7), STAND, "uprights", 1, ELBOWS_OUT));
  keys.push(key((at += 0.5), STAND, "uprights", 0, ELBOWS_OUT));
  keys.push(hold(keys, (at += SET_END)));
  return { lift: "bench", lie: true, w: 0.48, keys, length: at };
}

function pullup(): LiftPlay {
  const keys: Key[] = [];
  const legs = { t: -0.2, s: 0.55, b: 0 };
  keys.push(key(0, STAND, "pullbar", 0, ELBOWS_HANG));
  keys.push(key(0.7, STAND, "pullbar", 0.85, ELBOWS_HANG));
  // Up to hang from it, then each rep's chin over the bar.
  keys.push(key(1.0, legs, "pullbar", 1, ELBOWS_HANG, { hang: 0.5 }));
  keys.push(hold(keys, 1.6));
  let at = 1.6;
  for (let r = 0; r < REPS; r++) {
    keys.push(key((at += 0.9), legs, "pullbar", 1, ELBOWS_HANG, { hang: 0.1 }));
    keys.push(hold(keys, (at += 0.3)));
    keys.push(key((at += 1.0), legs, "pullbar", 1, ELBOWS_HANG, { hang: 0.5 }));
    keys.push(hold(keys, (at += 0.6)));
  }
  keys.push(key((at += 0.5), STAND, "pullbar", 0, ELBOWS_HANG));
  keys.push(hold(keys, (at += SET_END)));
  return { lift: "pullup", lie: false, w: 0.42, keys, length: at };
}

function kneeRaise(): LiftPlay {
  // Hanging from the pull-up bar, the knees drawn up to the chest and lowered again.
  const keys: Key[] = [];
  const down = { t: 0.05, s: 0.05, b: 0 };
  const up = { t: 1.45, s: 0, b: -0.08 };
  keys.push(key(0, STAND, "pullbar", 0, ELBOWS_HANG));
  keys.push(key(0.7, STAND, "pullbar", 0.85, ELBOWS_HANG));
  keys.push(key(1.0, down, "pullbar", 1, ELBOWS_HANG, { hang: 0.5 }));
  keys.push(hold(keys, 1.6));
  let at = 1.6;
  for (let r = 0; r < REPS; r++) {
    keys.push(key((at += 1.0), up, "pullbar", 1, ELBOWS_HANG, { hang: 0.5 }));
    keys.push(hold(keys, (at += 0.4)));
    keys.push(key((at += 1.0), down, "pullbar", 1, ELBOWS_HANG, { hang: 0.5 }));
    keys.push(hold(keys, (at += 0.4)));
  }
  keys.push(key((at += 0.5), STAND, "pullbar", 0, ELBOWS_HANG));
  keys.push(hold(keys, (at += SET_END)));
  return { lift: "kneeraise", lie: false, w: 0.42, keys, length: at };
}

/** Every lift, baked once. */
export const LIFTS: Record<Lift, LiftPlay> = { snatch: snatch(), clean: clean(), squat: squat(), frontsquat: frontSquat(), bench: bench(), pullup: pullup(), kneeraise: kneeRaise() };

/** What each station is for. */
export const EXERCISES: Record<Station, Lift[]> = {
  platform: ["snatch", "clean"],
  rack: ["squat", "frontsquat"],
  bench: ["bench"],
  pullup: ["pullup", "kneeraise"],
};

// ---------------------------------------------------------------- sets and rests

/** What a lifter does with their hands while they rest: get their breath back hands on hips, shake their arms out, or drink. */
export type Gesture = "breathe" | "shake" | "sip";
export const GESTURES: Gesture[] = ["breathe", "shake", "sip"];
/** Sets in a routine, and how long a rest after one lasts (seconds). */
export const SETS = 3;
export const REST_MIN = 6;
export const REST_MAX = 9.5;

/** A stretch of a routine: a set of `reps` of a lift (singles on the platform), or a rest after one. */
export interface Segment { at: number; length: number; lift: Lift; reps: number; rest: Gesture | null }

const routines = new Map<string, Segment[]>();

/**
 * A lifter's routine at a station, the same every time for the same seed: three sets, each followed
 * by a rest. Where the station has two exercises the routine changes over after the first or second
 * set; on the platform a set is two or three singles. The rests last 6 to 9.5 seconds and each has
 * its own gesture.
 */
export function routine(station: Station, seed: string): Segment[] {
  const name = `${station}|${seed}`;
  const known = routines.get(name);
  if (known) return known;
  const h = hash(`routine:${name}`);
  const ex = EXERCISES[station];
  const out: Segment[] = [];
  let at = 0;
  const switchAfter = 1 + ((h >>> 4) & 1);
  for (let j = 0; j < SETS; j++) {
    const lift = ex[((h >>> 1) + (j >= switchAfter ? 1 : 0)) % ex.length]!;
    const reps = station === "platform" ? 2 + ((h >>> (5 + j)) & 1) : 1;
    const set = reps * LIFTS[lift].length;
    out.push({ at, length: set, lift, reps, rest: null });
    at += set;
    const rest = REST_MIN + ((h >>> (8 + 3 * j)) & 7) * 0.5;
    out.push({ at, length: rest, lift, reps: 0, rest: GESTURES[((h >>> 20) + j) % GESTURES.length]! });
    at += rest;
  }
  // A long session asks for few routines (the lifters are few), but a regular's seed changes each visit.
  if (routines.size > 256) routines.clear();
  routines.set(name, out);
  return out;
}

/** Where a lifter is in their routine: in a set (`rest` null, `t` into the lift) or resting (`t` into the rest). */
export interface Session { lift: Lift; t: number; rest: Gesture | null; length: number; done: boolean }
export const newSession = (): Session => ({ lift: "snatch", t: 0, rest: null, length: 0, done: false });

/**
 * Where a lifter is this many seconds into their time at a station. With no `budget` (seconds
 * until they leave) the routine goes round and round. With one, it is done once, and a set that
 * would not be over before they leave is a rest instead, so they never walk off mid-set: once
 * done, they get their breath back until they go.
 */
export function sessionAt(station: Station, seed: string, seconds: number, budget = Infinity, out: Session = newSession()): Session {
  const segs = routine(station, seed);
  const last = segs.at(-1)!;
  let s = Math.max(0, seconds);
  if (!Number.isFinite(budget)) s %= last.at + last.length;
  // Where the routine stops: the first set that would not be over in time, else its end.
  let cut = last.at + last.length;
  for (const seg of segs) if (!seg.rest && seg.at + seg.length > budget) { cut = seg.at; break; }
  let lift = segs[0]!.lift;
  for (const seg of segs) {
    if (seg.at >= cut) break;
    lift = seg.lift;
    if (s >= seg.at + seg.length) continue;
    out.lift = seg.lift;
    out.rest = seg.rest;
    out.length = seg.length;
    out.t = seg.rest ? s - seg.at : (s - seg.at) % LIFTS[seg.lift].length;
    out.done = false;
    return out;
  }
  out.lift = lift;
  out.rest = "breathe";
  out.t = s - cut;
  out.length = Math.max(out.t, budget - cut);
  out.done = true;
  return out;
}

/** A pose: joint angles for the avatar's rig, where the body is, and where the bar is in the station's frame. */
export interface LiftPose {
  lift: Lift;
  /** The avatar's root, raised (or lowered) and moved back from where it stands. */
  rootY: number;
  rootZ: number;
  /** The rig's legs: hip, knee and ankle turns about x. */
  thigh: number;
  knee: number;
  ankle: number;
  /** Bent forward at the hips. */
  bend: number;
  /** Lying on the bench: the body turned onto its back with its middle here. */
  lie: boolean;
  lieY: number;
  lieZ: number;
  /** The bar's middle, and whether it is a bar of the lifter's (the pull-up bar is the rig's). */
  barY: number;
  barZ: number;
  carried: boolean;
  grip: number;
  w: number;
  poleX: number;
  poleY: number;
  poleZ: number;
  /** Anything is moving: a hold or a rest is drawn at the office's resting rate. */
  moving: boolean;
  /** Resting between sets: what the hands do, how far into the rest and how long it is; null in a set. */
  rest: Gesture | null;
  restT: number;
  restLength: number;
  /** Sat up on the bench to rest. */
  sit: boolean;
}

export const newPose = (): LiftPose => ({ lift: "snatch", rootY: 0, rootZ: 0, thigh: 0, knee: 0, ankle: 0, bend: 0, lie: false, lieY: 0, lieZ: 0, barY: 0, barZ: 0, carried: true, grip: 0, w: 0, poleX: 0, poleY: 0, poleZ: 0, moving: false, rest: null, restT: 0, restLength: 0, sit: false });

/** One keyframe made concrete for a lifter this tall; written into `out`. */
function resolve(play: LiftPlay, k: Key, h: number, out: LiftPose): LiftPose {
  out.lift = play.lift;
  out.lie = play.lie;
  out.w = play.w;
  out.grip = k.grip;
  out.poleX = k.pole[0];
  out.poleY = k.pole[1];
  out.poleZ = k.pole[2];
  out.carried = play.lift !== "pullup" && play.lift !== "kneeraise";
  const reach = Math.sqrt(Math.max(0, 0.53 ** 2 - Math.max(0, play.w - SHOULDER_X) ** 2));
  if (play.lie) {
    // On the back on the bench, the shoulders just past the uprights, the feet down on the floor.
    out.lieY = BENCH_TOP / h + CHEST;
    const shoulderZ = UPRIGHT_Z / h + 0.1;
    out.lieZ = shoulderZ + SHOULDER_Y;
    out.rootY = 0; out.rootZ = 0; out.bend = 0;
    out.thigh = 0.45; out.knee = Math.PI / 2 - 0.45; out.ankle = 0;
    const [y, z] = k.bar === "uprights" ? [UPRIGHT_Y / h, UPRIGHT_Z / h] : k.bar === "chest" ? [out.lieY + CHEST + 0.02, shoulderZ + 0.13] : [out.lieY + reach, shoulderZ];
    out.barY = y; out.barZ = z;
    return out;
  }
  out.lieY = 0; out.lieZ = 0;
  const hipY = THIGH * Math.cos(k.t) + SHIN * Math.cos(k.s) + FOOT + k.up;
  out.rootY = k.hang !== undefined ? PULL_Y / h - SHOULDER_Y - k.hang : hipY - HIP;
  // The feet stay where they stand; the hips go back over them.
  out.rootZ = k.hang !== undefined ? 0 : -(THIGH * Math.sin(k.t) - SHIN * Math.sin(k.s)) - (k.back ?? 0) / h;
  out.thigh = -k.t; out.knee = k.t + k.s; out.ankle = -k.s; out.bend = k.b;
  const sy = out.rootY + HIP + TORSO * Math.cos(k.b);
  const sz = out.rootZ + TORSO * Math.sin(k.b);
  const c = Math.cos(k.b), n = Math.sin(k.b);
  switch (k.bar) {
    case "floor": out.barY = (PLATFORM_H + PLATE_R) / h; out.barZ = FLOOR_Z / h; break;
    case "hooks": out.barY = HOOK_Y / h; out.barZ = HOOK_Z / h; break;
    case "pullbar": out.barY = PULL_Y / h; out.barZ = PULL_Z / h; break;
    case "uprights": out.barY = UPRIGHT_Y / h; out.barZ = UPRIGHT_Z / h; break;
    case "hang": {
      // Arms straight down, the bar brushing the thighs.
      const z = Math.max(sz + 0.03, out.rootZ + 0.17);
      const across = Math.max(0, play.w - SHOULDER_X);
      out.barZ = z;
      out.barY = sy - Math.sqrt(Math.max(0, 0.525 ** 2 - across ** 2 - (z - sz) ** 2));
      break;
    }
    case "overhead": out.barY = sy + reach; out.barZ = sz - 0.04; break;
    case "rack": out.barY = sy + 0.03 * c - 0.16 * n; out.barZ = sz + 0.03 * n + 0.16 * c; break;
    case "back": out.barY = sy + 0.06 * c + 0.17 * n; out.barZ = sz + 0.06 * n - 0.17 * c; break;
    default: out.barY = sy; out.barZ = sz;
  }
  return out;
}

const ease = (u: number) => u * u * (3 - 2 * u);
const A = newPose();
const B = newPose();

/** The pose `t` seconds into a lift, for a lifter this tall, written into `out`: eased between its keyframes. */
export function liftPose(lift: Lift, t: number, h: number, out: LiftPose): LiftPose {
  const play = LIFTS[lift];
  const keys = play.keys;
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1]!.at <= t) i++;
  const k0 = keys[i]!, k1 = keys[i + 1]!;
  const raw = Math.max(0, Math.min(1, (t - k0.at) / Math.max(1e-6, k1.at - k0.at)));
  const u = ease(raw);
  resolve(play, k0, h, A);
  resolve(play, k1, h, B);
  const mix = (a: number, b: number, f = u) => a + (b - a) * f;
  out.lift = lift;
  out.lie = play.lie;
  out.carried = A.carried;
  out.w = play.w;
  out.rootY = mix(A.rootY, B.rootY);
  out.rootZ = mix(A.rootZ, B.rootZ);
  out.thigh = mix(A.thigh, B.thigh);
  out.knee = mix(A.knee, B.knee);
  out.ankle = mix(A.ankle, B.ankle);
  out.bend = mix(A.bend, B.bend);
  out.lieY = A.lieY;
  out.lieZ = A.lieZ;
  // A dropped bar falls, faster and faster; the arms follow it down more easily.
  const barU = k1.fall ? raw * raw : u;
  out.barY = mix(A.barY, B.barY, barU);
  out.barZ = mix(A.barZ, B.barZ, barU);
  out.grip = mix(A.grip, B.grip, k1.fall ? Math.min(1, raw * 3) : u);
  out.poleX = mix(A.poleX, B.poleX);
  out.poleY = mix(A.poleY, B.poleY);
  out.poleZ = mix(A.poleZ, B.poleZ);
  out.rest = null;
  out.restT = 0;
  out.restLength = 0;
  out.sit = false;
  out.moving = raw < 1 && (A.rootY !== B.rootY || A.rootZ !== B.rootZ || A.thigh !== B.thigh || A.bend !== B.bend || A.barY !== B.barY || A.barZ !== B.barZ || A.grip !== B.grip);
  return out;
}

/** The bench's seat, from the lifter's feet: hips this far up (metres, over the pad) and back. */
export const SEAT_Y = BENCH_TOP + 0.08;
const SIT_SHIN = -0.1;

/**
 * Sat up on the end of the bench, for a lifter this tall, written into `out`: the hips on the pad,
 * the feet flat on the floor where they stood, leaning on the knees, the bar back in its uprights.
 */
export function sitPose(h: number, out: LiftPose): LiftPose {
  const play = LIFTS.bench;
  resolve(play, play.keys[0]!, h, out);
  const hipY = SEAT_Y / h;
  const t = Math.acos(Math.max(-1, Math.min(1, (hipY - FOOT - SHIN * Math.cos(SIT_SHIN)) / THIGH)));
  out.lie = false;
  out.lieY = 0; out.lieZ = 0;
  out.rootY = hipY - HIP;
  out.rootZ = -(THIGH * Math.sin(t) - SHIN * Math.sin(SIT_SHIN));
  out.thigh = -t; out.knee = t + SIT_SHIN; out.ankle = -SIT_SHIN; out.bend = 0.25;
  out.grip = 0;
  out.moving = false;
  out.sit = true;
  return out;
}

const SESSION = newSession();

/**
 * A lifter's pose this many seconds into their time at a station (see `sessionAt`), for one this
 * tall, written into `out`. Resting, they stand where the set left them, the bar back where it
 * rests and their hands off it; at the bench they sit up on it.
 */
export function sessionPose(station: Station, seed: string, seconds: number, budget: number, h: number, out: LiftPose): LiftPose {
  const at = sessionAt(station, seed, seconds, budget, SESSION);
  if (!at.rest) return liftPose(at.lift, at.t, h, out);
  if (station === "bench") sitPose(h, out);
  else liftPose(at.lift, LIFTS[at.lift].length, h, out);
  out.moving = false;
  out.rest = at.rest;
  out.restT = at.t;
  out.restLength = at.length;
  return out;
}

/** A station's pose after this many seconds there, for an agent: their routine round and round. */
export function stationPose(station: Station, seconds: number, h: number, out: LiftPose, seed: string = station): LiftPose {
  return sessionPose(station, seed, seconds, Infinity, h, out);
}

/** Where a station's bar rests while nobody trains there: where its lifter picks it up. */
export function restingBar(station: Station, out: LiftPose): LiftPose {
  return liftPose(EXERCISES[station][0]!, 0, 1, out);
}

const smooth = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

/**
 * How far into a rest's gesture a lifter is (0 to 1): into it over half a second once the set is
 * put down, held, and out of it before the next set, so the hands are back at their sides to pick
 * the bar up.
 */
export function gestureAt(pose: Pick<LiftPose, "rest" | "restT" | "restLength">): number {
  if (!pose.rest) return 0;
  return Math.min(smooth((pose.restT - 0.6) / 0.5), smooth((pose.restLength - 0.6 - pose.restT) / 0.5));
}

// ---------------------------------------------------------------- the hands on the bar

export interface Reach {
  /** The shoulder's turn, as the rig's Euler angles (x, then y, then z, applied z first). */
  x: number;
  y: number;
  z: number;
  /** The elbow's bend about its own x; negative brings the hand forward. */
  elbow: number;
}

export const newReach = (): Reach => ({ x: 0, y: 0, z: 0, elbow: 0 });

/**
 * Where a hand goes, from its shoulder, in the frame the arms hang in (the upper body's): on the
 * bar as much as the grip is, otherwise by the side. `side` is -1 for the left hand, 1 the right.
 */
export function handTarget(pose: LiftPose, build: number, side: number, out: [number, number, number]): [number, number, number] {
  if (pose.lie) shoulderFrame(0, pose.lieZ - pose.barZ, pose.barY - pose.lieY, 0, build, side, out);
  else shoulderFrame(0, pose.barY - pose.rootY, pose.barZ - pose.rootZ, pose.bend, build, side, out);
  const x = side * (pose.w - SHOULDER_X * build);
  const g = pose.grip;
  out[0] = side * 0.03 + (x - side * 0.03) * g;
  out[1] = -0.53 + (out[1] + 0.53) * g;
  out[2] = 0.04 + (out[2] - 0.04) * g;
  return out;
}

/**
 * A point given from the avatar's feet (x across, y up, z forward, in its own units) as seen from
 * one shoulder, with the upper body bent forward by `bend` at the hips.
 */
export function shoulderFrame(qx: number, qy: number, qz: number, bend: number, build: number, side: number, out: [number, number, number]): [number, number, number] {
  const uy = qy - HIP, uz = qz;
  const c = Math.cos(bend), n = Math.sin(bend);
  out[0] = qx - side * SHOULDER_X * build;
  out[1] = uy * c + uz * n + HIP - SHOULDER_Y;
  out[2] = -uy * n + uz * c;
  return out;
}

/**
 * The shoulder and elbow that put the hand at (tx, ty, tz) from the shoulder, the elbow towards the
 * pole (px, py, pz): a two-bone reach. Out of reach, the arm points straight at it. A longer
 * `forearm` reaches with something held in the hand, along the forearm, instead.
 */
export function armReach(tx: number, ty: number, tz: number, px: number, py: number, pz: number, out: Reach, forearm = FOREARM): Reach {
  const max = UPPER_ARM + forearm - 1e-4;
  let d = Math.hypot(tx, ty, tz);
  if (d < 1e-4) { tx = 0; ty = -1e-4; tz = 0; d = 1e-4; }
  const k = Math.min(1, max / d);
  tx *= k; ty *= k; tz *= k; d = Math.min(d, max);
  const ax = tx / d, ay = ty / d, az = tz / d;
  // The pole, square to the reach.
  let dot = px * ax + py * ay + pz * az;
  let ox = px - dot * ax, oy = py - dot * ay, oz = pz - dot * az;
  let on = Math.hypot(ox, oy, oz);
  if (on < 1e-6) { ox = 0; oy = 0; oz = -1; dot = az; ox -= dot * ax; oy -= dot * ay; oz -= dot * az; on = Math.hypot(ox, oy, oz) || 1; }
  ox /= on; oy /= on; oz /= on;
  const along = (UPPER_ARM ** 2 - forearm ** 2 + d * d) / (2 * d);
  const off = Math.sqrt(Math.max(0, UPPER_ARM ** 2 - along ** 2));
  // The elbow, and the arm's own axes: y up the upper arm, z towards the forearm's bend, x across.
  const ex = ax * along + ox * off, ey = ay * along + oy * off, ez = az * along + oz * off;
  const yx = -ex / UPPER_ARM, yy = -ey / UPPER_ARM, yz = -ez / UPPER_ARM;
  let fx = tx - ex, fy = ty - ey, fz = tz - ez;
  const fd = fx * yx + fy * yy + fz * yz;
  let zx = fx - fd * yx, zy = fy - fd * yy, zz = fz - fd * yz;
  let zn = Math.hypot(zx, zy, zz);
  if (zn < 1e-6) {
    const pd = ox * yx + oy * yy + oz * yz;
    zx = -(ox - pd * yx); zy = -(oy - pd * yy); zz = -(oz - pd * yz);
    zn = Math.hypot(zx, zy, zz) || 1;
  }
  zx /= zn; zy /= zn; zz /= zn;
  const xx = yy * zz - yz * zy;
  // Euler XYZ from the columns (x, y, z): m13 = zx, m23 = zy, m33 = zz, m12 = yx, m11 = xx.
  out.y = Math.asin(Math.max(-1, Math.min(1, zx)));
  if (Math.abs(zx) < 0.9999999) {
    out.x = Math.atan2(-zy, zz);
    out.z = Math.atan2(-yx, xx);
  } else {
    out.x = Math.atan2(yz, yy);
    out.z = 0;
  }
  fx = tx - ex; fy = ty - ey; fz = tz - ez;
  const cos = Math.max(-1, Math.min(1, -(fx * yx + fy * yy + fz * yz) / forearm));
  out.elbow = -Math.acos(cos);
  return out;
}

/** Where a reach puts the hand, from the shoulder: the rig's own sums, for checking. */
export function handFrom(r: Reach, forearm = FOREARM): [number, number, number] {
  // Upper arm and forearm in the arm's frame, then the shoulder's turn (Rx Ry Rz).
  const v: [number, number, number] = [0, -UPPER_ARM - forearm * Math.cos(r.elbow), -forearm * Math.sin(r.elbow)];
  const rz = (p: [number, number, number], a: number): [number, number, number] => [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a), p[2]];
  const ry = (p: [number, number, number], a: number): [number, number, number] => [p[0] * Math.cos(a) + p[2] * Math.sin(a), p[1], -p[0] * Math.sin(a) + p[2] * Math.cos(a)];
  const rx = (p: [number, number, number], a: number): [number, number, number] => [p[0], p[1] * Math.cos(a) - p[2] * Math.sin(a), p[1] * Math.sin(a) + p[2] * Math.cos(a)];
  return rx(ry(rz(v, r.z), r.y), r.x);
}
