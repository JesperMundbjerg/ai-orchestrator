// The ping pong table, in the south-west corner behind its reading nook. Pure: where the table
// stands, which two idle agents play, and the rally as a baked timeline a frame looks up.
//
//   where    along the corner's outer wall, the way the gym is in the south-east one: the table
//            lengthways along the wall, a player standing off each end, facing each other. They
//            come in by the nook's way in and along a lane in front of the table
//   who      like the gym: idle agents who could be out for a break, never one already playing a
//            game or training; two of them, paired by a hash of their id, and never one alone. A
//            pair stays while both are eligible; one leaving makes room for the next in line
//   what     points served in turn: the ball held, tossed and served (a bounce on the server's
//            side, then on the other), then a rally, each shot bouncing once on the far side, until
//            the last is caught and the catcher serves the next. The ball flies in true parabolas
//            under gravity; each paddle swings back, meets the ball where it is and follows through
//
// Positions are in metres in the table's frame: `a` along it from its middle (player 0 at -a,
// player 1 at +a), y up from the floor, `c` across it.

import type { WorldAgent } from "../../shared/types.ts";
import { readingNooks, type BuildingPlan } from "./building.ts";
import { armReach, cornerFrame, FOOT, FOREARM, HIP, newReach, shoulderFrame, SHIN, THIGH, type Reach } from "./gym.ts";
import { hash, outForABreak } from "./park.ts";
import type { Spot, Vec2 } from "./spatial.ts";

export type End = 0 | 1;
export type PingPong = Map<string, Spot>;

// The table, as the rules have it.
export const TABLE_L = 2.74;
export const TABLE_W = 1.525;
export const TABLE_H = 0.76;
export const NET_H = 0.1525;
export const BALL_R = 0.02;
/** Each player stands this far from the table's middle; their paddle meets the ball this far out. */
export const STAND = 2.2;
export const CONTACT = 1.9;
const HIT_Y = 0.98;
/** The paddle's blade, from the hand along the forearm. */
export const BLADE = 0.15;
const G = 9.81;

// ---------------------------------------------------------------- where

/** The corner: the south-west reading nook's, mirrored like the gym's so its way in is on the same side. */
export function pingCorner(plan: Pick<BuildingPlan, "rooms" | "outline" | "hall">) {
  const frame = cornerFrame(plan, readingNooks(plan).reduce((a, b) => (b.center[1] - b.center[0] > a.center[1] - a.center[0] ? b : a)));
  return { ...frame, lane: -frame.half + 2.75 };
}
/** The table's middle in the corner's frame: back from the way in, along the outer wall. */
export const TABLE_X = -0.6;
export const TABLE_Z = 1.45;

/**
 * The table in the world: its middle, the floor directions along it (towards player 1) and across
 * it, and `yaw`, the turn of a frame (as `place` has it) whose +x runs along it.
 */
export function pingTable(plan: Pick<BuildingPlan, "rooms" | "outline" | "hall">) {
  const { at, half } = pingCorner(plan);
  const center = at(TABLE_X, -half + TABLE_Z);
  const ahead = at(TABLE_X + 1, -half + TABLE_Z), side = at(TABLE_X, -half + TABLE_Z + 1);
  const along: Vec2 = [ahead[0] - center[0], ahead[1] - center[1]];
  const across: Vec2 = [side[0] - center[0], side[1] - center[1]];
  const world = (a: number, c: number): Vec2 => [center[0] + a * along[0] + c * across[0], center[1] + a * along[1] + c * across[1]];
  return { center, along, across, world, yaw: Math.atan2(-along[1], along[0]) };
}

/** Where each player stands, facing the other over the table, and the way there along the lane. */
export function pingSpot(plan: Pick<BuildingPlan, "rooms" | "outline" | "hall">, end: End): Spot {
  const { way, lane } = pingCorner(plan);
  const table = pingTable(plan);
  const dir = end ? -1 : 1;
  const x = TABLE_X - dir * STAND;
  return { pos: table.world(-dir * STAND, 0), facing: Math.atan2(dir * table.along[0], dir * table.along[1]), zone: "lounge", group: "pingpong", approach: way(x, lane), pingpong: end };
}

// ---------------------------------------------------------------- who

/**
 * The two who play: eligible like the gym (idle, not waiting on you nor in line, a project member
 * only once out for a break), never someone `busy` at a game or the gym. A pair stays while both
 * are eligible; if one goes, the other stays at their end and the next in line by a hash of their
 * id takes the free one. Fewer than two: nobody plays.
 */
export function choosePingPong(plan: BuildingPlan, agents: WorldAgent[], since: ReadonlyMap<string, number>, now: number, before: PingPong = new Map(), busy: ReadonlySet<string> = new Set()): PingPong {
  const out = outForABreak(agents, since, now, plan.queue);
  const eligible = agents
    .filter((a) => a.status === "idle" && !a.waitingOnYou && !plan.queue.includes(a.id) && (!a.teamId || out.has(a.id)) && !busy.has(a.id))
    .map((a) => a.id)
    .sort((a, b) => hash(`pingpong:${a}`) - hash(`pingpong:${b}`) || a.localeCompare(b));
  if (eligible.length < 2) return new Map();
  const ends: Array<string | null> = [null, null];
  for (const [id, spot] of before) if (spot.pingpong !== undefined && eligible.includes(id) && !ends[spot.pingpong]) ends[spot.pingpong] = id;
  for (const id of eligible) {
    if (ends[0] && ends[1]) break;
    if (ends.includes(id)) continue;
    ends[ends[0] ? 1 : 0] = id;
  }
  return new Map(ends.map((id, end) => [id!, pingSpot(plan, end as End)]));
}

/** When the rally started: once both players are at their ends, never on the way; one walking off stops it. */
export class PingPlayback {
  private at = new Map<string, number>();
  readonly pair: readonly string[];
  constructor(pair: readonly string[]) {
    this.pair = pair;
  }
  arrive(id: string, ready: boolean, now: number): void {
    if (!this.pair.includes(id)) return;
    if (!ready) this.at.delete(id);
    else if (!this.at.has(id)) this.at.set(id, now);
  }
  /** Seconds into the rally, or null until both are there. */
  seconds(now: number): number | null {
    if (this.pair.length !== 2 || !this.pair.every((id) => this.at.has(id))) return null;
    return Math.max(0, (now - Math.max(...this.pair.map((id) => this.at.get(id)!))) / 1000);
  }
}

// ---------------------------------------------------------------- the rally

/** A stretch of the ball's flight: from one point to the next, `vy` up at the start, under gravity. */
export interface Flight { t0: number; t1: number; a0: number; y0: number; c0: number; a1: number; y1: number; c1: number; vy: number; bounce: boolean }
/** Where a paddle is at `at`; `ease` says how it gets there from the key before. */
interface PaddleKey { at: number; a: number; y: number; c: number; ease: "both" | "in" | "out" }
/** A hit: who, when and where the paddle meets the ball. */
export interface Hit { at: number; end: End; a: number; y: number; c: number; serve: boolean }

export interface Rally {
  /** One round: two points, one served from each end. */
  length: number;
  flights: Flight[];
  hits: Hit[];
  paddles: [PaddleKey[], PaddleKey[]];
  /** While the ball is held between points: from, to and by whom. */
  holds: Array<{ t0: number; t1: number; end: End }>;
}

/** Where the bounces land, and how fast the ball goes along the table, in a rally and a serve. */
const RALLY_BOUNCE = 0.4;
const RALLY_SPEED = 4.5;
const SERVE_BOUNCES: [number, number] = [1.15, 0.9];
const SERVE_SPEED = 4.5;
const SERVE_Y = 1.06;
/** Between points the ball is held this long, then tossed this long before the serve. */
const HOLD = 1.6;
const TOSS = 0.5;
/** Shots in a point, the serve among them: odd, so the one who catches the last serves the next. */
export const SHOTS = 9;
/** Across the table, where each shot of a point is met. */
const ACROSS = [0.12, -0.28, 0.24, -0.1, 0.33, -0.22, 0.05, 0.3, -0.34, 0.18];

const flight = (t0: number, a0: number, y0: number, c0: number, t1: number, a1: number, y1: number, c1: number, bounce: boolean): Flight => {
  const T = t1 - t0;
  return { t0, t1, a0, y0, c0, a1, y1, c1, vy: (y1 - y0 + (G * T * T) / 2) / T, bounce };
};

/** Bake one round of the rally: the ball's flights, the hits, and each paddle's keys. */
export function bakeRally(): Rally {
  const flights: Flight[] = [], hits: Hit[] = [], holds: Rally["holds"] = [];
  const low = TABLE_H + BALL_R;
  let t = 0;
  for (const server of [0, 1] as const) {
    const sign = (end: End) => (end ? 1 : -1);
    const flip = server ? -1 : 1;
    const across = (k: number) => flip * ACROSS[k % ACROSS.length]!;
    // Held on the paddle, then tossed up off it and met on its way down.
    const c0 = across(0);
    holds.push({ t0: t, t1: t + HOLD, end: server });
    t += HOLD;
    const a0 = sign(server) * CONTACT, held = ready(server, c0);
    flights.push(flight(t, held.a, held.y + ON_PADDLE, c0, t + TOSS, a0, SERVE_Y, c0, false));
    t += TOSS;
    // The serve: a bounce on the server's side, then the other's.
    const receiver = (1 - server) as End;
    const b1 = sign(server) * SERVE_BOUNCES[0], b2 = sign(receiver) * SERVE_BOUNCES[1];
    let from = { a: a0, y: SERVE_Y, c: c0 };
    hits.push({ at: t, end: server, ...from, serve: true });
    let to = { a: sign(receiver) * CONTACT, y: HIT_Y, c: across(1) };
    const lerpC = (a: number) => from.c + ((to.c - from.c) * (a - from.a)) / (to.a - from.a);
    const s1 = t + Math.abs(b1 - from.a) / SERVE_SPEED, s2 = s1 + Math.abs(b2 - b1) / SERVE_SPEED, s3 = s2 + Math.abs(to.a - b2) / SERVE_SPEED;
    flights.push(flight(t, from.a, from.y, from.c, s1, b1, low, lerpC(b1), true));
    flights.push(flight(s1, b1, low, lerpC(b1), s2, b2, low, lerpC(b2), true));
    flights.push(flight(s2, b2, low, lerpC(b2), s3, to.a, to.y, to.c, false));
    t = s3;
    // The rally: each shot over the net and once on the far side.
    let hitter = receiver;
    for (let k = 1; k < SHOTS; k++) {
      from = to;
      hits.push({ at: t, end: hitter, ...from, serve: false });
      const other = (1 - hitter) as End;
      to = { a: sign(other) * CONTACT, y: HIT_Y, c: across(k + 1) };
      const b = sign(other) * RALLY_BOUNCE, cb = from.c + ((to.c - from.c) * (b - from.a)) / (to.a - from.a);
      const r1 = t + Math.abs(b - from.a) / RALLY_SPEED, r2 = r1 + Math.abs(to.a - b) / RALLY_SPEED;
      flights.push(flight(t, from.a, from.y, from.c, r1, b, low, cb, true));
      flights.push(flight(r1, b, low, cb, r2, to.a, to.y, to.c, false));
      t = r2;
      hitter = other;
    }
    // The last shot is caught on the paddle: the catcher serves next.
    hits.push({ at: t, end: hitter, ...to, serve: false });
  }
  const length = t;
  return { length, flights, hits, holds, paddles: [paddleKeys(hits, holds, 0, length), paddleKeys(hits, holds, 1, length)] };
}

/** Where a paddle waits, just behind where it meets the ball. */
const ready = (end: End, c: number) => ({ a: (end ? 1 : -1) * (CONTACT + 0.12), y: 0.95, c });
/** The ball held on a paddle sits this far above the blade's middle. */
const ON_PADDLE = BALL_R + 0.005;

/** A paddle's keys: back, through the ball and on at each of its hits, back to ready between, still while holding the ball. */
function paddleKeys(hits: Hit[], holds: Rally["holds"], end: End, length: number): PaddleKey[] {
  const sign = end ? 1 : -1;
  const mine = hits.filter((h) => h.end === end);
  const keys: PaddleKey[] = [];
  // A round ends with player 0 catching the ball, and starts with them bringing it in to serve.
  const last = mine.at(-1)!;
  if (end === 0) keys.push({ at: 0, a: last.a, y: last.y, c: last.c, ease: "both" }, { at: 0.5, ...ready(end, last.c), ease: "out" });
  else keys.push({ at: 0, ...ready(end, mine[0]!.c), ease: "both" });
  for (const h of mine) {
    const hold = holds.find((o) => o.end === end && Math.abs(o.t1 + TOSS - h.at) < 1e-9);
    const caught = Math.abs(h.at - length) < 1e-9 || holds.some((o) => o.end === end && Math.abs(o.t0 - h.at) < 1e-9);
    const prev = keys.at(-1)!;
    if (hold) {
      // Held at ready, then the toss: the paddle drops back and comes through as the ball falls.
      keys.push({ at: hold.t1, ...ready(end, h.c), ease: "both" });
      keys.push({ at: h.at - 0.22, a: h.a + sign * 0.2, y: h.y - 0.1, c: h.c, ease: "both" });
    } else if (h.at - 0.32 > prev.at + 0.05) {
      keys.push({ at: Math.max(prev.at + 0.05, h.at - 0.75), ...ready(end, h.c), ease: "both" });
      keys.push({ at: h.at - 0.32, a: h.a + sign * 0.22, y: h.y - 0.12, c: h.c, ease: "both" });
    }
    keys.push({ at: h.at, a: h.a, y: h.y, c: h.c, ease: "in" });
    if (caught) {
      // A catch: the paddle gives with the ball and brings it in to ready (a round's last, at the start of the next).
      if (h.at + 0.5 < length) keys.push({ at: h.at + 0.5, ...ready(end, h.c), ease: "out" });
    } else {
      keys.push({ at: h.at + 0.2, a: h.a - sign * 0.16, y: h.y + 0.18, c: h.c, ease: "out" });
    }
  }
  if (keys.at(-1)!.at < length - 1e-9) keys.push({ at: length, ...ready(end, mine[0]!.c), ease: "both" });
  return keys;
}

/** Every round is the same, baked once. */
export const RALLY = bakeRally();

/** A player's paddle (where the blade's middle is) and the ball, written into reusable outs. */
export interface Ping { a: number; y: number; c: number }
export const newPing = (): Ping => ({ a: 0, y: 0, c: 0 });

const ease = (u: number) => u * u * (3 - 2 * u);
const wrap = (t: number) => ((t % RALLY.length) + RALLY.length) % RALLY.length;

/** Where an end's paddle is `seconds` into the rally. */
export function paddleAt(end: End, seconds: number, out: Ping): Ping {
  const keys = RALLY.paddles[end];
  const t = wrap(seconds);
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1]!.at <= t) i++;
  const k0 = keys[i]!, k1 = keys[i + 1]!;
  const raw = Math.max(0, Math.min(1, (t - k0.at) / Math.max(1e-6, k1.at - k0.at)));
  // Into the ball speeding up, out of it slowing down: the swing doesn't stop at the ball.
  const u = k1.ease === "in" ? raw * raw : k1.ease === "out" ? 1 - (1 - raw) * (1 - raw) : ease(raw);
  out.a = k0.a + (k1.a - k0.a) * u;
  out.y = k0.y + (k1.y - k0.y) * u;
  out.c = k0.c + (k1.c - k0.c) * u;
  return out;
}

/** Where the ball is `seconds` into the rally: in flight, or held on a paddle between points. */
export function ballAt(seconds: number, out: Ping): Ping {
  const t = wrap(seconds);
  for (const h of RALLY.holds) {
    if (t >= h.t0 && t < h.t1) {
      // Caught on the paddle's face, then settled on it.
      paddleAt(h.end, t, out);
      out.y += ON_PADDLE * ease(Math.min(1, (t - h.t0) / 0.3));
      return out;
    }
  }
  const flights = RALLY.flights;
  let f = flights[0]!;
  for (const g of flights) if (g.t0 <= t) f = g;
  const tau = Math.min(t, f.t1) - f.t0, u = tau / (f.t1 - f.t0);
  out.a = f.a0 + (f.a1 - f.a0) * u;
  out.c = f.c0 + (f.c1 - f.c0) * u;
  out.y = f.y0 + f.vy * tau - (G * tau * tau) / 2;
  return out;
}

/** A player's stance: knees a little bent and leaning in, the same at both ends. */
const STANCE = { t: 0.35, s: 0.35, b: 0.28 };
/** The paddle hand is the right (the rig's +x arm); the body keeps it this far out to the side. */
const REACH_OUT = 0.36;
const ELBOW_OUT: [number, number, number] = [0.8, -1, -0.25];

/** A player's pose: the rig's joints, the root moved across (metres) and down (own units), both arms, the head's turn. */
export interface Player { rootX: number; rootY: number; thigh: number; knee: number; ankle: number; bend: number; right: Reach; left: Reach; head: number }
export const newPlayer = (): Player => ({ rootX: 0, rootY: 0, thigh: 0, knee: 0, ankle: 0, bend: 0, right: newReach(), left: newReach(), head: 0 });

const PADDLE = newPing(), BALL = newPing();
const HAND: [number, number, number] = [0, 0, 0];

/**
 * How a player standing at (x, z), turned `yaw`, stands and swings `seconds` into the rally at their
 * end of `table`: crouched, stepping across to the ball, the paddle's blade where the rally has it
 * and the head turned to the ball.
 */
export function playerPose(table: ReturnType<typeof pingTable>, x: number, z: number, yaw: number, end: End, seconds: number, h: number, build: number, out: Player): Player {
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  // A point of the table's frame, in the player's own (x across, z forward, metres).
  const local = (p: Ping) => {
    const dx = table.center[0] + p.a * table.along[0] + p.c * table.across[0] - x;
    const dz = table.center[1] + p.a * table.along[1] + p.c * table.across[1] - z;
    p.a = dx * cos - dz * sin;
    p.c = dx * sin + dz * cos;
  };
  local(paddleAt(end, seconds, PADDLE));
  local(ballAt(seconds, BALL));
  out.rootX = Math.max(-0.5, Math.min(0.5, PADDLE.a - REACH_OUT * h));
  out.thigh = -STANCE.t; out.knee = STANCE.t + STANCE.s; out.ankle = -STANCE.s; out.bend = STANCE.b;
  out.rootY = THIGH * Math.cos(STANCE.t) + SHIN * Math.cos(STANCE.s) + FOOT - HIP;
  shoulderFrame((PADDLE.a - out.rootX) / h, PADDLE.y / h - out.rootY, PADDLE.c / h, out.bend, build, 1, HAND);
  armReach(HAND[0], HAND[1], HAND[2], ELBOW_OUT[0], ELBOW_OUT[1], ELBOW_OUT[2], out.right, FOREARM + BLADE);
  // The free hand forward and in, for balance.
  armReach(-0.06, -0.38, 0.2, -ELBOW_OUT[0], ELBOW_OUT[1], ELBOW_OUT[2], out.left);
  out.head = Math.max(-0.9, Math.min(0.9, Math.atan2(BALL.a - out.rootX, Math.max(0.2, BALL.c))));
  return out;
}
