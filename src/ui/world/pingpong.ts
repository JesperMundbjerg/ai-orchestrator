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
  const eligible = pingEligible(plan, agents, since, now, busy);
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

/** Who could play, in the order they are paired: idle, out for a break, not busy elsewhere. */
export function pingEligible(plan: BuildingPlan, agents: WorldAgent[], since: ReadonlyMap<string, number>, now: number, busy: ReadonlySet<string> = new Set()): string[] {
  const out = outForABreak(agents, since, now, plan.queue);
  return agents
    .filter((a) => a.status === "idle" && !a.waitingOnYou && !plan.queue.includes(a.id) && (!a.teamId || out.has(a.id)) && !busy.has(a.id))
    .map((a) => a.id)
    .sort((a, b) => hash(`pingpong:${a}`) - hash(`pingpong:${b}`) || a.localeCompare(b));
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

/**
 * A stretch of the ball's flight from one point to the next, `vy` up at the start, falling at `g`:
 * gravity in the air, none rolling on the table (`roll`, slowing to a stop as it goes).
 */
export interface Flight { t0: number; t1: number; a0: number; y0: number; c0: number; a1: number; y1: number; c1: number; vy: number; g: number; bounce: boolean; roll: boolean }
type Ease = "both" | "in" | "out";
/** Where a paddle is at `at`; `ease` says how it gets there from the key before. */
interface Key { at: number; a: number; y: number; c: number; ease: Ease }
/** Where the free hand holds the ball, `w` of the way from hanging by the side to there. */
interface HandKey extends Key { w: number }
/** A step in towards the table (metres; back is negative) and a lean further over it, eased between. */
interface StepKey { at: number; z: number; b: number }
/** A hit: who, when and where the paddle meets the ball. */
export interface Hit { at: number; end: End; a: number; y: number; c: number; serve: boolean }
/** While the ball is in someone's free hand: from, to, whose, and who won the point it ended, if it ended one. */
export interface Hold { t0: number; t1: number; end: End; winner?: End }
/** How a point ends: a ball the receiver can't get to, one hit long past the end, or one into the net. */
export type Ending = "miss" | "long" | "net";
export interface Point { t0: number; t1: number; server: End; shots: number; ending: Ending; winner: End }

export interface Rally {
  /** First the server picks the ball up off the table, while both settle into their stance... */
  intro: number;
  /** ...then the match plays through to `length`, and round again from `intro`. */
  length: number;
  flights: Flight[];
  hits: Hit[];
  holds: Hold[];
  points: Point[];
  paddles: [Key[], Key[]];
  hands: [HandKey[], HandKey[]];
  steps: [StepKey[], StepKey[]];
}

const LOW = TABLE_H + BALL_R;
const NET_TOP = TABLE_H + NET_H + BALL_R;
/** Which way along the table an end is, and the table's `c` of a point `x` metres to its player's right. */
const sgn = (end: End) => (end ? 1 : -1);
const side = (end: End, x: number) => (end ? -x : x);
/** The table's `a` of a point `fwd` metres in front of where an end's player stands. */
const fwdA = (end: End, fwd: number) => sgn(end) * (STAND - fwd);
/** The paddle hand is the right; the body keeps it this far out to the side. */
const REACH_OUT = 0.36;
/** The ball held in the free hand sits this far above the hand. */
export const ON_HAND = 0.035;
/** Where the server holds the ball before tossing it: in front, a little to the left, at the chest. */
const HOLD_AT = { fwd: 0.36, x: -0.12, y: 1.05 };
/** The toss: the hand comes up this far and lets go; the ball is met this long after. */
const TOSS_UP = 0.14;
const TOSS = 0.55;
/** The ball lying on the table before anyone plays, on player 0's side by their free hand. */
export const BALL_REST = { a: -(TABLE_L / 2 - 0.12), y: LOW, c: -0.2 };
/** The players ease into their stance over this long, as play starts. */
const SETTLE = 0.6;
/** How fast a player shuffles across to the ball, on average (m/s). */
const ACROSS_SPEED = 1.5;
/** At least this many points before the match goes round again, served alternately by whoever has the ball. */
const POINTS = 24;

const flight = (t0: number, a0: number, y0: number, c0: number, t1: number, a1: number, y1: number, c1: number, bounce: boolean): Flight => {
  const T = t1 - t0;
  return { t0, t1, a0, y0, c0, a1, y1, c1, vy: (y1 - y0 + (G * T * T) / 2) / T, g: G, bounce, roll: false };
};
const yAt = (f: Flight, t: number) => { const tau = t - f.t0; return f.y0 + f.vy * tau - (f.g * tau * tau) / 2; };
/** The ball's height where a flight crosses `a`, if it does. */
const heightAt = (f: Flight, a: number) => ((a - f.a0) * (a - f.a1) > 0 ? null : yAt(f, f.t0 + ((f.t1 - f.t0) * (a - f.a0)) / (f.a1 - f.a0)));
const apex = (f: Flight) => { const T = Math.min(f.t1 - f.t0, Math.max(0, f.vy / f.g)); return yAt(f, f.t0 + T); };

/** Numbers in [0, 1) from a seed, one after another: the same seed, the same match. */
function seeded(seed: string) {
  // mulberry32, from the seed's hash: consecutive numbers that don't follow each other.
  let state = hash(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Bake the match: a pick-up, then points served in turn by whoever has the ball, each a seeded
 * number of shots of their own speed, arc, landing and reach, ending in a miss, a long ball or the
 * net. The ball flies in true parabolas and bounces believably; whoever ends up with it catches it in
 * their free hand (or picks it off the table's edge) and serves the next after a breath.
 */
export function bakeRally(seed = "pingpong"): Rally {
  const r = seeded(seed);
  const between = (lo: number, hi: number) => lo + (hi - lo) * r();
  const flights: Flight[] = [], hits: Hit[] = [], holds: Hold[] = [], points: Point[] = [];
  const paddles: Rally["paddles"] = [[], []], hands: Rally["hands"] = [[], []], steps: Rally["steps"] = [[], []];

  // Each track only goes forward: a key too close behind the last is left out.
  const key = <K extends { at: number }>(keys: K[], k: K) => { if (!keys.length || k.at > keys.at(-1)!.at + 1e-3) keys.push(k); };
  const home = (end: End, fwd = 0.18): Omit<Key, "at" | "ease"> => ({ a: fwdA(end, fwd), y: 0.95, c: side(end, REACH_OUT) });
  const held = (end: End) => ({ a: fwdA(end, HOLD_AT.fwd), y: HOLD_AT.y, c: side(end, HOLD_AT.x) });
  /** How far in to step and lean to get the paddle (`hand` false) or the free hand to a point. */
  const reach = (end: End, p: { a: number; y: number }, hand: boolean) => {
    const fwd = STAND - Math.abs(p.a), z = Math.max(-0.25, Math.min(hand ? 0.45 : 0.4, fwd - (hand ? 0.45 : 0.3)));
    // Lower, and further than the step, they lean over to it.
    return { z, b: hand ? Math.max(0, Math.min(0.75, (0.95 - p.y) * 1.8 + Math.max(0, fwd - z - 0.45))) : 0 };
  };
  const step = (end: End, at: number, z: number, b: number, lead = 0.3) => {
    key(steps[end], { at: at - lead, z, b });
    key(steps[end], { at: at + 0.15, z, b });
  };
  /** Both players back where a point starts: the server holding the ball, both paddles home, standing square. */
  const square = (at: number, server: End) => {
    for (const end of [0, 1] as const) {
      key(paddles[end], { at, ...home(end), ease: "both" });
      key(steps[end], { at, z: 0, b: 0 });
      key(hands[end], { at, ...held(end), w: end === server ? 1 : 0, ease: "both" });
    }
  };
  const returns = new Set<Key>();
  /** A swing: ready in line with the ball, back, through it at `at` and on, and home again. */
  const swing = (end: End, at: number, p: { a: number; y: number; c: number }, missing = false) => {
    const s = sgn(end), keys = paddles[end], fwd = STAND - Math.abs(p.a);
    const { z, b } = reach(end, p, false);
    // Not all the way home after the last shot if this one comes too soon after it.
    if (returns.has(keys.at(-1)!) && keys.at(-1)!.at > at - 0.95) keys.pop();
    const last = keys.at(-1)!;
    if (missing) {
      // Going for one out of reach: as far across as a shuffle gets them in the time, and no further.
      const most = ACROSS_SPEED * Math.max(0, at - 0.35 - last.at);
      const c = last.c + Math.max(-most, Math.min(most, p.c - last.c));
      // And only a lunge: the body stays square for the free hand to take the ball as it goes by.
      p = { ...p, c: side(end, Math.max(-0.05, side(end, c))) };
    }
    if (at - 0.3 > last.at + 0.05) {
      const ready = Math.max(last.at + 0.05 + Math.abs(p.c - last.c) / ACROSS_SPEED, at - 0.75);
      if (ready < at - 0.35) key(keys, { at: ready, ...home(end, fwd - 0.12), c: p.c, ease: "both" });
      // Back and down, out to the side: never into their own shoulder, however close in it's met.
      key(keys, { at: at - 0.3, a: fwdA(end, Math.max(fwd - 0.22, z + 0.2)), y: Math.max(0.82, Math.min(p.y - 0.12, 1.02)), c: p.c + side(end, 0.1), ease: "both" });
    }
    key(keys, { at, ...p, ease: "in" });
    // On through, up and forward, but never up past the shoulder close to it.
    key(keys, { at: at + 0.2, a: p.a - s * 0.18, y: Math.min(p.y + 0.18, 1.2), c: p.c, ease: "out" });
    const back: Key = { at: at + 0.7, ...home(end, Math.max(0.18, z + 0.2)), c: p.c, ease: "both" };
    key(keys, back);
    returns.add(back);
    step(end, at, z, b);
  };
  /** The free hand takes the ball at `at` where it is, gives with it along `dir`, and brings it in to hold. */
  const take = (end: End, at: number, p: { a: number; y: number; c: number }, dir: [number, number, number], stepIn = true) => {
    const keys = hands[end];
    key(keys, { at: Math.max(keys.at(-1)!.at + 0.05, at - 0.45), ...p, w: 0, ease: "both" });
    key(keys, { at, ...p, w: 1, ease: "both" });
    const give = { a: p.a + dir[0] * 0.06, y: p.y + dir[1] * 0.06, c: p.c + dir[2] * 0.06 };
    key(keys, { at: at + 0.15, ...give, w: 1, ease: "out" });
    // The paddle home first, so the body is square again by the time the ball is held in front of it.
    const paddle = paddles[end];
    if (returns.has(paddle.at(-1)!) && paddle.at(-1)!.at > at - 0.3) paddle.pop();
    const { z, b } = reach(end, p, true);
    // Leaning in for it, the paddle hand low and out of the way.
    if (stepIn) key(paddle, { at, ...home(end, z + 0.25), y: 0.85, ease: "both" });
    const across = side(end, paddle.at(-1)!.c) - REACH_OUT;
    const squared = Math.max(at + 0.5, paddle.at(-1)!.at + 0.1 + Math.abs(across) / ACROSS_SPEED);
    key(paddle, { at: squared, ...home(end), ease: "both" });
    // The ball goes across with the body as it squares up, and then in to hold.
    const hold = held(end), shift = side(end, -Math.max(-0.5, Math.min(0.5, across)));
    key(keys, { at: squared, a: (give.a + hold.a) / 2, y: (give.y + hold.y) / 2, c: give.c + shift, w: 1, ease: "both" });
    key(keys, { at: squared + 0.35, ...hold, w: 1, ease: "both" });
    if (stepIn) step(end, at, z, b, 0.4);
    key(steps[end], { at: squared + 0.35, z: 0, b: 0 });
    return squared + 0.35;
  };

  // The pick-up: player 0 steps in, takes the ball off the table and holds it to serve.
  const intro = 2.1, grab = 1.05;
  for (const end of [0, 1] as const) {
    key(paddles[end], { at: 0, ...home(end), ease: "both" });
    key(steps[end], { at: 0, z: 0, b: 0 });
    key(hands[end], { at: 0, ...(end === 0 ? BALL_REST : held(end)), w: 0, ease: "both" });
  }
  take(0, grab, BALL_REST, [0, 1, 0]);
  holds.push({ t0: grab, t1: intro, end: 0 });
  square(intro, 0);

  let t = intro, server: End = 0;
  for (let k = 0; k < 200 && (k < POINTS || server !== 0); k++) {
    const start = t, receiver = (1 - server) as End;
    // A breath with the ball, then the toss: up off the hand and met on its way down.
    const release = t + between(0.6, 1.5);
    holds.push({ t0: t, t1: release, end: server });
    const hand = held(server);
    key(hands[server], { at: release - 0.22, ...hand, w: 1, ease: "both" });
    key(hands[server], { at: release, ...hand, y: hand.y + TOSS_UP, w: 1, ease: "in" });
    key(hands[server], { at: release + 0.2, ...hand, y: hand.y + TOSS_UP + 0.06, w: 1, ease: "out" });
    key(hands[server], { at: release + 0.65, ...hand, y: hand.y + TOSS_UP + 0.06, w: 0, ease: "both" });
    const contact = { a: fwdA(server, 0.32), y: between(0.95, 1.02), c: side(server, between(0.3, 0.4)) };
    flights.push(flight(release, hand.a, hand.y + TOSS_UP, hand.c, release + TOSS, contact.a, contact.y, contact.c, false));
    t = release + TOSS;

    // The shots: the serve (on the server's side, then the other's), then each once on the far side.
    const roll = r(), ending: Ending = roll < 0.5 ? "miss" : roll < 0.75 ? "long" : "net";
    // Mostly short points, now and then a long one; a serve is returned at least once before a miss.
    const shots = (ending === "miss" ? 2 : 1) + Math.floor(r() * r() * 12);
    let from = contact, hitter: End = server, settled = 0;
    const lastX: [number, number] = [REACH_OUT, REACH_OUT];
    for (let n = 1; n <= shots; n++) {
      const to = (1 - hitter) as End, s = sgn(to);
      hits.push({ at: t, end: hitter, ...from, serve: n === 1 });
      swing(hitter, t, from);
      const missed = n === shots && ending === "miss";
      const out: Flight[] = [];
      for (let tries = 0; ; tries++) {
        if (tries === 400) throw new Error(`no shot fits after ${from.a.toFixed(2)}`);
        out.length = 0;
        // Where it's met (or, missed, caught by the free hand beside them), and how fast and where it lands.
        const fwd = missed ? between(0.12, 0.25) : n === 1 ? between(0.25, 0.7) : between(0.08, 0.55);
        const x = missed ? between(-0.6, -0.45) : between(-0.08, 0.75);
        // No further across than a shuffle gets them from the last one they hit.
        if (!missed && Math.abs(x - lastX[to]) > 0.5) continue;
        const lob = n > 1 && r() < 0.15;
        const v = n === 1 ? between(3, 4.2) : lob ? between(2.6, 3.3) : between(3.4, 6);
        const next = { a: fwdA(to, fwd), c: side(to, x) };
        const along = (a: number) => from.c + ((next.c - from.c) * (a - from.a)) / (next.a - from.a);
        let at = t, a = from.a, y = from.y, vy = 0;
        const fly = (a1: number, y1: number, speed: number, bounce: boolean) => {
          const f = flight(at, a, y, along(a), at + Math.abs(a1 - a) / speed, a1, y1, along(a1), bounce);
          out.push(f);
          at = f.t1; a = a1; y = y1; vy = f.vy - G * (f.t1 - f.t0);
          return f;
        };
        if (n === 1) {
          // The serve: down onto the server's side, up and over the net onto the other's.
          const f1 = fly(sgn(hitter) * between(0.6, 1.15), LOW, v, true);
          const up = -vy * between(0.8, 0.9), T = (2 * up) / G;
          const b2 = a + s * v * T;
          if (Math.sign(b2) !== s || Math.abs(b2) < 0.3 || Math.abs(b2) > TABLE_L / 2 - 0.12) continue;
          const f2 = { ...flight(at, a, LOW, along(a), at + T, b2, LOW, along(b2), true), vy: up };
          out.push(f2);
          at = f2.t1; a = b2; vy = -up;
          if (f1.vy > 3 || (heightAt(f2, 0) ?? 0) < NET_TOP + 0.02) continue;
        } else {
          const f1 = fly(s * between(0.3, 1.15), LOW, v, true);
          if ((heightAt(f1, 0) ?? 0) < NET_TOP + 0.025 || apex(f1) > 2) continue;
        }
        // Off the table: up at a little less than it came down, on to where it's met.
        const up = -vy * between(0.8, 0.9), speed = v * 0.92, T = Math.abs(next.a - a) / speed;
        const f = { ...flight(at, a, LOW, along(a), at + T, next.a, 0, next.c, false), vy: up };
        f.y1 = yAt(f, f.t1);
        if (Math.abs(along(a)) > TABLE_W / 2 - 0.08) continue;
        // One that gets past them goes by about chest high, a little higher the longer nothing fits (from a high, deep
        // hit it can't come down that low), up to where a long ball is caught.
        const above = missed ? 1.08 + 0.22 * Math.min(1, tries / 200) : 1.22;
        if (f.t1 - f.t0 < 0.08 || (missed ? f.y1 < 0.92 || f.y1 > above : f.y1 < (n === 1 ? 0.74 : 0.8) || f.y1 > above)) continue;
        out.push(f);
        break;
      }
      flights.push(...out);
      const last = out.at(-1)!;
      t = last.t1;
      from = { a: last.a1, y: last.y1, c: last.c1 };
      lastX[to] = side(to, from.c);
      if (missed) {
        // Too late: a half-hearted backhand lunges after it as it slips past, and the free hand gets it.
        const plane = fwdA(to, 0.3), at = last.t0 + ((last.t1 - last.t0) * (plane - last.a0)) / (last.a1 - last.a0);
        swing(to, at, { a: plane, y: yAt(last, at) - 0.05, c: last.c0 + ((last.c1 - last.c0) * (plane - last.a0)) / (last.a1 - last.a0) + side(to, -0.17) }, true);
        const T = last.t1 - last.t0;
        settled = take(to, t, from, [s, (last.vy - G * T) * 0.1, ((last.c1 - last.c0) / T) * 0.1], false);
      }
      hitter = to;
    }
    let catcher: End, winner: End;
    if (ending === "miss") {
      catcher = hitter;
      winner = (1 - hitter) as End;
    } else {
      // The last one to reach it hits it long, past the far end, or into the net.
      const to = (1 - hitter) as End, s = sgn(to);
      hits.push({ at: t, end: hitter, ...from, serve: false });
      swing(hitter, t, from);
      for (let tries = 0; ; tries++) {
        if (tries === 400) throw new Error(`no ${ending} fits after ${from.a.toFixed(2)}`);
        const out: Flight[] = [];
        if (ending === "long") {
          // Over the far end without touching the table: the other lets it go and takes it in their free hand.
          const q = { a: fwdA(to, between(0.2, 0.42)), y: between(0.95, 1.3), c: side(to, between(-0.35, -0.1)) };
          const f = flight(t, from.a, from.y, from.c, t + Math.abs(q.a - from.a) / between(4.2, 5.8), q.a, q.y, q.c, false);
          if ((heightAt(f, 0) ?? 0) < NET_TOP + 0.025 || (heightAt(f, s * (TABLE_L / 2)) ?? 0) < LOW + 0.05 || apex(f) > 2) continue;
          out.push(f);
          flights.push(...out);
          settled = take(to, f.t1, q, [s, (f.vy - G * (f.t1 - f.t0)) * 0.1, 0]);
          t = f.t1;
          catcher = to;
          winner = to;
        } else {
          // Into the net: it drops back on the hitter's side, bounces smaller and smaller, rolls off their end into their free hand.
          const back = sgn(hitter);
          const n = { a: back * (BALL_R + 0.003), y: LOW + between(0.04, 0.11), c: side(hitter, between(-0.32, -0.08)) };
          const f = flight(t, from.a, from.y, from.c, t + Math.abs(n.a - from.a) / between(4, 5.5), n.a, n.y, n.c, false);
          if (apex(f) > 1.6) continue;
          out.push(f);
          const u = between(1.3, 1.8);
          let at = f.t1, a = n.a, fall = Math.sqrt((2 * (n.y - LOW)) / G);
          out.push({ ...flight(at, a, n.y, n.c, at + fall, a + back * u * fall, LOW, n.c, true), vy: 0 });
          at += fall; a += back * u * fall;
          let up = G * fall * 0.75;
          while (up > 0.4) {
            const T = (2 * up) / G;
            out.push({ ...flight(at, a, LOW, n.c, at + T, a + back * u * T, LOW, n.c, true), vy: up });
            at += T; a += back * u * T; up *= 0.75;
          }
          const edge = back * (TABLE_L / 2);
          if (Math.abs(a) > TABLE_L / 2 - 0.1) continue;
          // Rolling slows it to the edge, where it tips off and falls into the hand.
          const rolling = (2 * Math.abs(edge - a)) / u;
          out.push({ t0: at, t1: at + rolling, a0: a, y0: LOW, c0: n.c, a1: edge, y1: LOW, c1: n.c, vy: 0, g: 0, bounce: false, roll: true });
          at += rolling;
          const drop = between(0.01, 0.03), T = Math.sqrt((2 * drop) / G), tip = 0.25;
          const q = { a: edge + back * tip * T, y: LOW - drop, c: n.c };
          out.push({ ...flight(at, edge, LOW, n.c, at + T, q.a, q.y, q.c, false), vy: 0 });
          flights.push(...out);
          settled = take(hitter, at + T, q, [back, 0.5, 0]);
          t = at + T;
          catcher = hitter;
          winner = to;
        }
        break;
      }
    }
    // Brought in to hold, a cheer from the winner, and the catcher serves the next.
    const next = Math.max(t + 0.9, settled + 0.05);
    holds.push({ t0: t, t1: next, end: catcher!, winner: winner! });
    points.push({ t0: start, t1: next, server, shots, ending, winner: winner! });
    t = next;
    server = catcher!;
    square(t, server);
  }
  return { intro, length: t, flights, hits, holds, points, paddles, hands, steps };
}

/** The match, baked once. */
export const RALLY = bakeRally();

/** Seconds since play started, as a moment of the match: the pick-up once, then round and round. */
export function rallyTime(seconds: number, rally: Rally = RALLY): number {
  if (seconds < rally.length) return Math.max(0, seconds);
  const loop = rally.length - rally.intro;
  return rally.intro + ((((seconds - rally.intro) % loop) + loop) % loop);
}

/** A player's paddle (where the blade's middle is) and the ball, written into reusable outs. */
export interface Ping { a: number; y: number; c: number }
export const newPing = (): Ping => ({ a: 0, y: 0, c: 0 });

const ease = (u: number) => u * u * (3 - 2 * u);
const shape = (e: Ease, u: number) => (e === "in" ? u * u : e === "out" ? 1 - (1 - u) * (1 - u) : ease(u));
/** The last of `items` starting by `t`, by halves. */
function seek<K>(items: K[], t: number, at: (k: K) => number): number {
  let lo = 0, hi = items.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (at(items[mid]!) <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
const keyAt = (k: { at: number }) => k.at;
/** Between the keys either side of `t`: the first index and how far along. */
function between2<K extends { at: number; ease?: Ease }>(keys: K[], t: number): [K, K, number] {
  const i = Math.min(seek(keys, t, keyAt), keys.length - 2);
  const k0 = keys[i]!, k1 = keys[i + 1]!;
  const raw = Math.max(0, Math.min(1, (t - k0.at) / Math.max(1e-6, k1.at - k0.at)));
  return [k0, k1, shape(k1.ease ?? "both", raw)];
}

/** Where an end's paddle is `seconds` into play (of the baked match, or another `rally`). */
export function paddleAt(end: End, seconds: number, out: Ping, rally: Rally = RALLY): Ping {
  const [k0, k1, u] = between2(rally.paddles[end], rallyTime(seconds, rally));
  out.a = k0.a + (k1.a - k0.a) * u;
  out.y = k0.y + (k1.y - k0.y) * u;
  out.c = k0.c + (k1.c - k0.c) * u;
  return out;
}

/** Where an end's free hand would have the ball, and how far it is from hanging (0) to there (1). */
export interface Hand extends Ping { w: number }
export const newHand = (): Hand => ({ a: 0, y: 0, c: 0, w: 0 });
export function handAt(end: End, seconds: number, out: Hand, rally: Rally = RALLY): Hand {
  const [k0, k1, u] = between2(rally.hands[end], rallyTime(seconds, rally));
  out.a = k0.a + (k1.a - k0.a) * u;
  out.y = k0.y + (k1.y - k0.y) * u;
  out.c = k0.c + (k1.c - k0.c) * u;
  out.w = k0.w + (k1.w - k0.w) * u;
  return out;
}

/** How far an end's player has stepped in (metres) and leans further over, `seconds` into play. */
export function stepAt(end: End, seconds: number, out: { z: number; b: number }, rally: Rally = RALLY): { z: number; b: number } {
  const keys = rally.steps[end], t = rallyTime(seconds, rally);
  const i = Math.min(seek(keys, t, keyAt), keys.length - 2);
  const k0 = keys[i]!, k1 = keys[i + 1]!;
  const u = ease(Math.max(0, Math.min(1, (t - k0.at) / Math.max(1e-6, k1.at - k0.at))));
  out.z = k0.z + (k1.z - k0.z) * u;
  out.b = k0.b + (k1.b - k0.b) * u;
  return out;
}

/** Where the ball is `seconds` into play: lying on the table, in flight, rolling, or in someone's hand. */
export function ballAt(seconds: number, out: Ping, rally: Rally = RALLY): Ping {
  const t = rallyTime(seconds, rally);
  if (t < rally.holds[0]!.t0) return Object.assign(out, BALL_REST);
  for (const h of rally.holds) {
    if (t >= h.t0 && t < h.t1) {
      handAt(h.end, t, HELD, rally);
      out.a = HELD.a; out.y = HELD.y; out.c = HELD.c;
      return out;
    }
  }
  const f = rally.flights[seek(rally.flights, t, (f) => f.t0)]!;
  const tau = Math.min(t, f.t1) - f.t0, raw = tau / (f.t1 - f.t0);
  const u = f.roll ? 1 - (1 - raw) * (1 - raw) : raw;
  out.a = f.a0 + (f.a1 - f.a0) * u;
  out.c = f.c0 + (f.c1 - f.c0) * u;
  out.y = f.y0 + f.vy * tau - (f.g * tau * tau) / 2;
  return out;
}

/** A player's stance: knees a little bent and leaning in, the same at both ends. */
const STANCE = { t: 0.35, s: 0.35, b: 0.28 };
const ELBOW_OUT: [number, number, number] = [0.8, -1, -0.25];
/** The free hand forward and in, for balance, when it has nothing to do. */
const FREE: [number, number, number] = [-0.06, -0.38, 0.2];

/**
 * A player's pose: the rig's joints, the root moved across and in (metres) and down (own units), the
 * legs apart in a step (`stride`), both arms, the head's turn.
 */
export interface Player { rootX: number; rootY: number; rootZ: number; stride: number; thigh: number; knee: number; ankle: number; bend: number; right: Reach; left: Reach; head: number }
export const newPlayer = (): Player => ({ rootX: 0, rootY: 0, rootZ: 0, stride: 0, thigh: 0, knee: 0, ankle: 0, bend: 0, right: newReach(), left: newReach(), head: 0 });

const PADDLE = newPing(), BALL = newPing(), HELD = newHand(), FREE_HAND = newHand(), STEP = { z: 0, b: 0 };
const HAND: [number, number, number] = [0, 0, 0], LEFT: [number, number, number] = [0, 0, 0];

/**
 * How a player standing at (x, z), turned `yaw`, stands and plays `seconds` into play at their end of
 * `table`: crouched, stepping across and in to the ball, the paddle's blade where the rally has it,
 * the free hand catching, holding and tossing the ball, and the head turned to it. As play starts
 * they ease into it from standing.
 */
export function playerPose(table: ReturnType<typeof pingTable>, x: number, z: number, yaw: number, end: End, seconds: number, h: number, build: number, out: Player, rally: Rally = RALLY): Player {
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  stepAt(end, seconds, STEP, rally);
  // A point of the table's frame, in the player's own (x across, z forward, metres), from where they have stepped to.
  const local = (p: Ping) => {
    const dx = table.center[0] + p.a * table.along[0] + p.c * table.across[0] - x;
    const dz = table.center[1] + p.a * table.along[1] + p.c * table.across[1] - z;
    p.a = dx * cos - dz * sin;
    p.c = dx * sin + dz * cos - STEP.z;
  };
  local(paddleAt(end, seconds, PADDLE, rally));
  local(ballAt(seconds, BALL, rally));
  local(handAt(end, seconds, FREE_HAND, rally));
  out.rootX = Math.max(-0.5, Math.min(0.5, PADDLE.a - REACH_OUT * h));
  out.rootZ = STEP.z;
  out.stride = STEP.z * 0.9;
  // Leaning over for a ball, they bend their knees too; the taller, the further.
  const over = STEP.b * (1 + 4 * (h - 1));
  const thigh = STANCE.t + 0.6 * over, shin = STANCE.s + 0.6 * over;
  out.thigh = -thigh; out.knee = thigh + shin; out.ankle = -shin; out.bend = STANCE.b + over;
  out.rootY = THIGH * Math.cos(thigh) + SHIN * Math.cos(shin) + FOOT - HIP;
  shoulderFrame((PADDLE.a - out.rootX) / h, PADDLE.y / h - out.rootY, PADDLE.c / h, out.bend, build, 1, HAND);
  armReach(HAND[0], HAND[1], HAND[2], ELBOW_OUT[0], ELBOW_OUT[1], ELBOW_OUT[2], out.right, FOREARM + BLADE);
  // The free hand: by the side for balance, or out to where the ball is.
  const w = FREE_HAND.w;
  shoulderFrame((FREE_HAND.a - out.rootX) / h, (FREE_HAND.y - ON_HAND) / h - out.rootY, FREE_HAND.c / h, out.bend, build, -1, LEFT);
  for (let i = 0; i < 3; i++) LEFT[i] = FREE[i]! + (LEFT[i]! - FREE[i]!) * w;
  armReach(LEFT[0], LEFT[1], LEFT[2], -ELBOW_OUT[0], ELBOW_OUT[1], ELBOW_OUT[2], out.left);
  out.head = Math.max(-0.9, Math.min(0.9, Math.atan2(BALL.a - out.rootX, Math.max(0.2, BALL.c))));
  if (seconds < SETTLE) {
    // Into the stance from standing tall, arms by the side.
    const f = ease(Math.max(0, seconds) / SETTLE);
    out.rootX *= f; out.rootY *= f; out.rootZ *= f; out.stride *= f;
    out.thigh *= f; out.knee *= f; out.ankle *= f; out.bend *= f; out.head *= f;
    for (const arm of [out.right, out.left]) { arm.x *= f; arm.y *= f; arm.z *= f; arm.elbow *= f; }
  }
  return out;
}
