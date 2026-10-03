// The regulars: a few people from the neighbourhood who come in to use the gym and the ping pong
// table, so the corners are alive when no agent is on a break. Pure, and only ever in the browser:
// there is no server state behind them, they are not agents, and nothing that lists, counts or
// messages agents ever sees them (their placements are kept apart from the plan's agent spots).
//
//   who      a fixed cast of six, each with a name, a look and a home: a gym station or an end of
//            the table. A regular uses their home only while no agent has it; an agent taking it
//            sends them to their place aside: stretching on a mat or at the water cooler in the gym,
//            watching the game by the table
//   partner  a lone idle agent, who has nobody to play with, takes the table, and the regular whose
//            end is free plays them (`partnerLone`); a second agent coming along takes that end
//   touches  between sets a lifter sips from their bottle; after each point the player who did not
//            catch the ball punches the air, and those watching cheer; the two at the cooler high five

import type { BuildingPlan } from "./building.ts";
import { gymCorner, gymSpot, LIFTS, liftAt, PROGRAMS, STATIONS, type Station } from "./gym.ts";
import { lookFor, type Look } from "./look.ts";
import { pingCorner, pingEligible, pingSpot, RALLY, TABLE_X, type End, type PingPong } from "./pingpong.ts";
import type { Spot, Vec2 } from "./spatial.ts";
import type { WorldAgent } from "../../shared/types.ts";

/** What a regular does where they are. */
export type Act = "lift" | "play" | "stretch" | "cooler" | "watch";
type Aside = Exclude<Act, "lift" | "play">;

export interface Regular {
  /** Never an agent's id: the prefix keeps them apart wherever ids meet (the gym's clock, the table's pair). */
  id: string;
  name: string;
  home: { gym: Station } | { pingpong: End };
  aside: Aside;
  /** Their own clothes and hair, over the look their id gives (which keeps its height and build). */
  wear: Partial<Pick<Look, "shirt" | "pants" | "shoes" | "hairStyle" | "accessory" | "accent">>;
}

export const REGULAR_PREFIX = "regular:";

export const CAST: readonly Regular[] = [
  { id: `${REGULAR_PREFIX}freja`, name: "Freja", home: { gym: "platform" }, aside: "stretch", wear: { shirt: "#e4572e", pants: "#1f1f24", shoes: "#f2f2f2", hairStyle: "bun", accessory: "none" } },
  { id: `${REGULAR_PREFIX}kofi`, name: "Kofi", home: { gym: "rack" }, aside: "stretch", wear: { shirt: "#00a6a6", pants: "#2b3240", shoes: "#1b1b1f", hairStyle: "short", accessory: "none" } },
  { id: `${REGULAR_PREFIX}ines`, name: "Ines", home: { gym: "bench" }, aside: "cooler", wear: { shirt: "#9b5de5", pants: "#1f1f24", shoes: "#f2f2f2", hairStyle: "long", accessory: "none" } },
  { id: `${REGULAR_PREFIX}sami`, name: "Sami", home: { gym: "pullup" }, aside: "cooler", wear: { shirt: "#f2c14e", pants: "#3d4a5c", shoes: "#b23a48", hairStyle: "curly", accessory: "beanie" } },
  { id: `${REGULAR_PREFIX}yara`, name: "Yara", home: { pingpong: 0 }, aside: "watch", wear: { shirt: "#f15bb5", pants: "#324d3a", shoes: "#f2f2f2", hairStyle: "bob", accessory: "none" } },
  { id: `${REGULAR_PREFIX}theo`, name: "Theo", home: { pingpong: 1 }, aside: "watch", wear: { shirt: "#4c956c", pants: "#5a4636", shoes: "#1b1b1f", hairStyle: "spiky", accessory: "cap" } },
];

export const isRegular = (id: string) => id.startsWith(REGULAR_PREFIX);

/** A regular's look: their id's, in their own clothes. The height stays their id's, which the gym's bars go by. */
export function regularLook(r: Regular): Look {
  return { ...lookFor(r.id), ...r.wear };
}

/** Where a regular is and what they do there; `partner` is who they high five at the cooler. */
export interface Placement {
  regular: Regular;
  spot: Spot;
  act: Act;
  partner: string | null;
}
export type Regulars = Map<string, Placement>;

// ---------------------------------------------------------------- where they step aside

type Plan = Pick<BuildingPlan, "rooms" | "outline" | "hall">;

/** Each place aside, in its corner's frame (x across, `dz` out from the back wall), and what they face. */
const ASIDE: Record<string, { x: number; dz: number; face: [number, number] }> = {
  // Two mats in front of the gym, the stretchers facing the stations.
  freja: { x: -0.6, dz: 3.05, face: [0, -1] },
  kofi: { x: 0.6, dz: 3.05, face: [0, -1] },
  // The water cooler between them, the two either side facing each other.
  ines: { x: 2.3, dz: 3.0, face: [1, 0] },
  sami: { x: 3.2, dz: 3.0, face: [-1, 0] },
  // Watching from across the lane, either side of the middle so the game stays in view, turned in to the table.
  yara: { x: TABLE_X - 1.0, dz: 3.25, face: [0.25, -1] },
  theo: { x: TABLE_X + 1.0, dz: 3.25, face: [-0.25, -1] },
};
/** The water cooler, behind the two who meet there. */
export const COOLER = { x: 2.75, dz: 3.45 };

const corner = (plan: Plan, r: Regular) => ("gym" in r.home ? gymCorner(plan) : pingCorner(plan));
const facingTo = (from: Vec2, to: Vec2) => Math.atan2(to[0] - from[0], to[1] - from[1]);

/** Where a regular stands aside: in by the corner's way in and along its lane, like everyone there. */
export function asideSpot(plan: Plan, r: Regular): Spot {
  const { at, way, lane, half } = corner(plan, r);
  const a = ASIDE[r.id.slice(REGULAR_PREFIX.length)]!;
  const z = -half + a.dz;
  const pos = at(a.x, z);
  return { pos, facing: facingTo(pos, at(a.x + a.face[0], z + a.face[1])), zone: "lounge", group: "gym" in r.home ? "gym" : "pingpong", approach: way(a.x, lane) };
}

/** Where the water cooler stands, facing the two who meet there. */
export function coolerAt(plan: Plan): { pos: Vec2; facing: number } {
  const { at, half } = gymCorner(plan);
  const pos = at(COOLER.x, -half + COOLER.dz);
  return { pos, facing: facingTo(pos, at(COOLER.x, -half + COOLER.dz - 1)) };
}

/** Where each stretcher's mat lies. */
export function matsAt(plan: Plan): Array<{ pos: Vec2; facing: number }> {
  return CAST.filter((r) => r.aside === "stretch").map((r) => {
    const s = asideSpot(plan, r);
    return { pos: s.pos, facing: s.facing };
  });
}

// ---------------------------------------------------------------- who is where

/**
 * Where every regular is, given where the agents are (`agents`: the plan's spots, agents only). A
 * regular is at their home while no agent has it, and aside otherwise; the two at the cooler are
 * each other's partner only while both are there.
 */
export function placeRegulars(plan: Plan, agents: ReadonlyMap<string, Spot>): Regulars {
  const stations = new Set<Station>();
  const ends = new Set<End>();
  for (const s of agents.values()) {
    if (s.gym) stations.add(s.gym);
    if (s.pingpong !== undefined) ends.add(s.pingpong);
  }
  const out: Regulars = new Map();
  for (const r of CAST) {
    const home = r.home;
    if ("gym" in home && !stations.has(home.gym)) out.set(r.id, { regular: r, spot: gymSpot(plan, home.gym), act: "lift", partner: null });
    else if ("pingpong" in home && !ends.has(home.pingpong)) out.set(r.id, { regular: r, spot: pingSpot(plan, home.pingpong), act: "play", partner: null });
    else out.set(r.id, { regular: r, spot: asideSpot(plan, r), act: r.aside, partner: null });
  }
  const cooler = [...out.values()].filter((p) => p.act === "cooler");
  if (cooler.length === 2) {
    cooler[0]!.partner = cooler[1]!.regular.id;
    cooler[1]!.partner = cooler[0]!.regular.id;
  }
  return out;
}

/**
 * A lone idle agent at the table: when exactly one agent could play (after the games and the gym),
 * they take an end (the one they had, else the first) and a regular plays them. Otherwise nobody,
 * and `choosePingPong` pairs agents as before.
 */
export function partnerLone(plan: BuildingPlan, agents: WorldAgent[], since: ReadonlyMap<string, number>, now: number, before: PingPong = new Map(), busy: ReadonlySet<string> = new Set()): PingPong {
  const eligible = pingEligible(plan, agents, since, now, busy);
  if (eligible.length !== 1) return new Map();
  const id = eligible[0]!;
  return new Map([[id, pingSpot(plan, before.get(id)?.pingpong ?? 0)]]);
}

/** Every station has a regular of its own. */
export const HOMES: ReadonlySet<Station> = new Set(CAST.flatMap((r) => ("gym" in r.home ? [r.home.gym] : [])));
if (STATIONS.some((s) => !HOMES.has(s))) throw new Error("A gym station has no regular");

// ---------------------------------------------------------------- the touches

const smooth = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
/** Up over `rise` seconds from `from`, held, and down over `rise` seconds to `to`. */
const bump = (t: number, from: number, to: number, rise: number) => Math.min(smooth((t - from) / rise), smooth((to - t) / rise));

/** How long a sip takes, the bottle up and down. */
export const SIP = 2.4;

/**
 * How far a lifter's bottle is up to their mouth (0 to 1), this many seconds at their station: once
 * a round, in the rest after the program's last lift, with both hands off the bar.
 */
export function sipAt(station: Station, seconds: number): number {
  if (liftIndex(station, seconds) !== PROGRAMS[station].length - 1) return 0;
  const { lift, t } = liftAt(station, seconds);
  const play = LIFTS[lift];
  // The rest: from the last key that moves to the end of the round.
  const from = play.keys.at(-2)!.at + 0.4;
  if (play.length - from < SIP + 0.2) return 0;
  return bump(t, from, from + SIP, 0.5);
}

/** Which of its program's lifts a station is at. */
function liftIndex(station: Station, seconds: number): number {
  const program = PROGRAMS[station];
  const round = program.reduce((sum, l) => sum + LIFTS[l].length, 0);
  let t = ((Math.max(0, seconds) % round) + round) % round;
  for (let i = 0; i < program.length; i++) {
    if (t < LIFTS[program[i]!].length) return i;
    t -= LIFTS[program[i]!].length;
  }
  return 0;
}

const wrap = (t: number) => ((t % RALLY.length) + RALLY.length) % RALLY.length;

/**
 * A cheer after a point (0 to 1), this many seconds into the rally: the player at `end` who did not
 * catch the last shot punches the air; with no end, someone watching cheers after every point.
 */
export function cheerAt(end: End | null, seconds: number): number {
  const t = wrap(seconds);
  let most = 0;
  for (const h of RALLY.holds) {
    if (end !== null && h.end === end) continue;
    // The round's first hold follows the last point of the round before.
    most = Math.max(most, bump(t, h.t0, h.t0 + 1.3, 0.3));
  }
  return most;
}

/** Every so often the two at the cooler high five, on the office's clock so both do it at once. */
export const HIGH_FIVE_EVERY = 14;
export function highFiveAt(ms: number): number {
  const t = (((ms / 1000) % HIGH_FIVE_EVERY) + HIGH_FIVE_EVERY) % HIGH_FIVE_EVERY;
  return bump(t, 0, 1.1, 0.4);
}

/** A sip from a cup at the cooler, on their own offset so the two don't sip together. */
export function cupAt(ms: number, offset: number): number {
  const t = (((ms / 1000 + offset) % 9) + 9) % 9;
  return bump(t, 4, 4 + SIP, 0.5);
}
