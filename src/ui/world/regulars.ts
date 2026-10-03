// The regulars: a few people from the neighbourhood who come in to use the gym and the ping pong
// table, so the corners are alive when no agent is on a break. Pure, and only ever in the browser:
// there is no server state behind them, they are not agents, and nothing that lists, counts or
// messages agents ever sees them (their placements are kept apart from the plan's agent spots).
//
//   who      a fixed cast of six, each with a name, a look and a home: a gym station or an end of
//            the table, where they start and which stands for them at the table's clock
//   when     they move round on the office's clock (`scheduleRegulars`), seeded so it is the same in
//            every browser. Two play at the table and four use the gym. In the gym they move on every
//            visit (a minute) round its five roles, the four stations and a break, each to a
//            different role every time. The gym and the table are across the building from each
//            other, so the table changes over more slowly: after each shift (five visits) one player
//            hands over to someone from the gym, and over six shifts everyone plays. Nobody is ever
//            at a station or an end an agent has, nor two at one. A break, or a station an agent has,
//            is spent stretching or sitting on a mat, or sipping and chatting at the water cooler;
//            an end an agent has, watching the game
//   partner  a lone idle agent, who has nobody to play with, takes the table, and whichever regular
//            has the free end plays them (`partnerLone`); a second agent coming along takes that end
//   touches  between sets a lifter rests (gym.ts); after each point the player who did not catch
//            the ball punches the air, and those watching cheer; the two at the cooler high five

import type { BuildingPlan } from "./building.ts";
import { gymCorner, gymSpot, STATIONS, type Station, type Visit } from "./gym.ts";
import { hash } from "./park.ts";
import { lookFor, type Look } from "./look.ts";
import { pingCorner, pingEligible, pingSpot, RALLY, rallyTime, TABLE_X, type End, type PingPong } from "./pingpong.ts";
import type { Spot, Vec2 } from "./spatial.ts";
import type { WorldAgent } from "../../shared/types.ts";

/** What a regular does where they are. */
export type Act = "lift" | "play" | "stretch" | "sit" | "cooler" | "watch";
type Aside = "stretch" | "cooler" | "watch";

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
  { id: `${REGULAR_PREFIX}ottilie`, name: "Ottilie", home: { gym: "platform" }, aside: "stretch", wear: { shirt: "#e4572e", pants: "#1f1f24", shoes: "#f2f2f2", hairStyle: "bun", accessory: "none" } },
  { id: `${REGULAR_PREFIX}kwabena`, name: "Kwabena", home: { gym: "rack" }, aside: "stretch", wear: { shirt: "#00a6a6", pants: "#2b3240", shoes: "#1b1b1f", hairStyle: "short", accessory: "none" } },
  { id: `${REGULAR_PREFIX}marisol`, name: "Marisol", home: { gym: "bench" }, aside: "cooler", wear: { shirt: "#9b5de5", pants: "#1f1f24", shoes: "#f2f2f2", hairStyle: "long", accessory: "none" } },
  { id: `${REGULAR_PREFIX}thandiwe`, name: "Thandiwe", home: { gym: "pullup" }, aside: "cooler", wear: { shirt: "#f2c14e", pants: "#3d4a5c", shoes: "#b23a48", hairStyle: "curly", accessory: "beanie" } },
  { id: `${REGULAR_PREFIX}brigitta`, name: "Brigitta", home: { pingpong: 0 }, aside: "watch", wear: { shirt: "#f15bb5", pants: "#324d3a", shoes: "#f2f2f2", hairStyle: "bob", accessory: "none" } },
  { id: `${REGULAR_PREFIX}ignatius`, name: "Ignatius", home: { pingpong: 1 }, aside: "watch", wear: { shirt: "#4c956c", pants: "#5a4636", shoes: "#1b1b1f", hairStyle: "spiky", accessory: "cap" } },
];

export const isRegular = (id: string) => id.startsWith(REGULAR_PREFIX);

/** A regular's look: their id's, in their own clothes. The height stays their id's, which the gym's bars go by. */
export function regularLook(r: Regular): Look {
  return { ...lookFor(r.id), ...r.wear };
}

/**
 * Where a regular is and what they do there; `partner` is who they high five at the cooler. A
 * lifter's `visit` says which routine they do and when they leave for their next role.
 */
export interface Placement {
  regular: Regular;
  spot: Spot;
  act: Act;
  partner: string | null;
  visit?: Visit;
}
export type Regulars = Map<string, Placement>;

// ---------------------------------------------------------------- where they step aside

type Plan = Pick<BuildingPlan, "rooms" | "outline" | "hall">;

/** A place aside: two mats in front of the gym, either side of the water cooler, or watching the table. */
export type Place = "mat0" | "mat1" | "cooler0" | "cooler1" | "watch0" | "watch1";
/** Each place aside, in its corner's frame (x across, `dz` out from the back wall), and what they face. */
const PLACES: Record<Place, { gym: boolean; x: number; dz: number; face: [number, number] }> = {
  // Two mats in front of the gym, facing the stations.
  mat0: { gym: true, x: -0.6, dz: 3.05, face: [0, -1] },
  mat1: { gym: true, x: 0.6, dz: 3.05, face: [0, -1] },
  // The water cooler between them, the two either side facing each other.
  cooler0: { gym: true, x: 2.3, dz: 3.0, face: [1, 0] },
  cooler1: { gym: true, x: 3.2, dz: 3.0, face: [-1, 0] },
  // Watching from across the lane, either side of the middle so the game stays in view, turned in to the table.
  watch0: { gym: false, x: TABLE_X - 1.0, dz: 3.25, face: [0.25, -1] },
  watch1: { gym: false, x: TABLE_X + 1.0, dz: 3.25, face: [-0.25, -1] },
};
/** Where each regular stood aside before they moved round, and still goes when the table and the gym are all agents'. */
const ASIDE: Record<string, Place> = { ottilie: "mat0", kwabena: "mat1", marisol: "cooler0", thandiwe: "cooler1", brigitta: "watch0", ignatius: "watch1" };
/** The water cooler, behind the two who meet there. */
export const COOLER = { x: 2.75, dz: 3.45 };

const facingTo = (from: Vec2, to: Vec2) => Math.atan2(to[0] - from[0], to[1] - from[1]);

/** A place aside: in by the corner's way in and along its lane, like everyone there. */
export function placeSpot(plan: Plan, place: Place): Spot {
  const p = PLACES[place];
  const { at, way, lane, half } = p.gym ? gymCorner(plan) : pingCorner(plan);
  const z = -half + p.dz;
  const pos = at(p.x, z);
  return { pos, facing: facingTo(pos, at(p.x + p.face[0], z + p.face[1])), zone: "lounge", group: p.gym ? "gym" : "pingpong", approach: way(p.x, lane) };
}

/** Where a regular stood aside from their home. */
export function asideSpot(plan: Plan, r: Regular): Spot {
  return placeSpot(plan, ASIDE[r.id.slice(REGULAR_PREFIX.length)]!);
}

/**
 * The way from one place to another in the same corner (the gym's, or the table's): up to the
 * corner's lane, along it and down to the new place, each leg the last of an approach the corner's
 * own ways in already take. Null between corners, where the office's routes go.
 */
export function cornerWalk(from: Spot, to: Spot): Vec2[] | null {
  if (from.group !== to.group || (from.group !== "gym" && from.group !== "pingpong")) return null;
  const a = from.approach.at(-1), b = to.approach.at(-1);
  if (!a || !b) return null;
  return [a, b, to.pos];
}

/** Where the water cooler stands, facing the two who meet there. */
export function coolerAt(plan: Plan): { pos: Vec2; facing: number } {
  const { at, half } = gymCorner(plan);
  const pos = at(COOLER.x, -half + COOLER.dz);
  return { pos, facing: facingTo(pos, at(COOLER.x, -half + COOLER.dz - 1)) };
}

/** Where each mat lies. */
export function matsAt(plan: Plan): Array<{ pos: Vec2; facing: number }> {
  return (["mat0", "mat1"] as const).map((m) => {
    const s = placeSpot(plan, m);
    return { pos: s.pos, facing: s.facing };
  });
}

// ---------------------------------------------------------------- who is where

/**
 * Where every regular would be with nobody moving round: at their home while no agent has it, and
 * aside otherwise, given where the agents are (`agents`: the plan's spots, agents only). The
 * office puts them on its stage this way, so whoever is at a free end of the table plays on the
 * clock of that end's home regular (see `scheduleRegulars` for where they actually are).
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
  pairAtCooler(out);
  return out;
}

function pairAtCooler(out: Regulars): void {
  const cooler = [...out.values()].filter((p) => p.act === "cooler");
  if (cooler.length === 2) {
    cooler[0]!.partner = cooler[1]!.regular.id;
    cooler[1]!.partner = cooler[0]!.regular.id;
  }
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

// ---------------------------------------------------------------- moving round

/** How long a visit lasts, in seconds: everyone in the gym moves on to their next role together. */
export const VISIT = 60;
/** Visits in a shift at the table: one of its two players hands over to someone from the gym after each. */
export const SHIFT = 5;
/** A role in the gym: a station or a break. */
export type GymRole = Station | "break";
/** The gym's roles, in the order a regular goes round them. */
export const GYM_ROLES: readonly GymRole[] = ["platform", "rack", "bench", "pullup", "break"];
/** Who comes to the table in turn; each keeps the same end, so the one staying on never moves. */
const TABLE_ORDER = ["brigitta", "ignatius", "ottilie", "marisol", "kwabena", "thandiwe"].map((n) => `${REGULAR_PREFIX}${n}`);
if (TABLE_ORDER.length !== CAST.length || CAST.some((r) => !TABLE_ORDER.includes(r.id))) throw new Error("Every regular takes a turn at the table");

/** The visit at this moment on the office's clock (ms), the same in every browser. */
export const visitAt = (ms: number) => Math.floor(ms / (VISIT * 1000));
const shiftOf = (visit: number) => Math.floor(visit / SHIFT);

/**
 * How far round the gym's roles everyone has moved by a visit: one more each visit, and every other
 * visit (seeded) two more again, so the step is 1, 3 or -1 (of five) and never brings anyone back
 * to the role they just had.
 */
export const shiftAt = (visit: number) => visit + 2 * (hash(`regulars:${visit}`) & 1);

/** The two at the table in a visit, by end. */
export function tableAt(visit: number): [string, string] {
  const j = ((shiftOf(visit) % TABLE_ORDER.length) + TABLE_ORDER.length) % TABLE_ORDER.length;
  const a = j, b = (j + 1) % TABLE_ORDER.length;
  // Each keeps the end their place in the order gives them.
  return a % 2 === 0 ? [TABLE_ORDER[a]!, TABLE_ORDER[b]!] : [TABLE_ORDER[b]!, TABLE_ORDER[a]!];
}

/**
 * Each regular's role in a visit: an end of the table, or a role in the gym. The four in the gym
 * keep their places in its round (`(q + j) mod 4`, q their turn after the table's two in shift j)
 * when the table changes over: whoever comes from the table takes the place of whoever went to it,
 * so nobody has the same role twice in a row then either.
 */
export function rolesAt(visit: number): Map<string, GymRole | End> {
  const table = tableAt(visit);
  const j = shiftOf(visit), size = TABLE_ORDER.length;
  const n = GYM_ROLES.length, k = shiftAt(visit);
  const out = new Map<string, GymRole | End>();
  table.forEach((id, end) => out.set(id, end as End));
  for (let q = 0; q < size - 2; q++) {
    const id = TABLE_ORDER[(((j + 2 + q) % size) + size) % size]!;
    const seat = (((q + j) % (size - 2)) + size - 2) % (size - 2);
    out.set(id, GYM_ROLES[(((seat + k) % n) + n) % n]!);
  }
  return new Map(CAST.map((r) => [r.id, out.get(r.id)!] as const));
}

/**
 * Where every regular is in a visit, given where the agents are (`agents`: the plan's spots,
 * agents only). Each takes their role (`rolesAt`) unless an agent has it. In the gym, someone on a
 * break or whose station an agent has goes to the mats or the cooler, two or more of them to the
 * cooler together first, in a seeded order. At the table, someone whose end an agent has watches
 * the game; the other plays on, so a lone agent always has someone to play.
 */
export function scheduleRegulars(plan: Plan, agents: ReadonlyMap<string, Spot>, visit: number): Regulars {
  const stations = new Set<Station>();
  const ends = new Set<End>();
  for (const [id, s] of agents) {
    if (isRegular(id)) continue;
    if (s.gym) stations.add(s.gym);
    if (s.pingpong !== undefined) ends.add(s.pingpong);
  }
  const roles = rolesAt(visit);
  const until = (visit + 1) * VISIT * 1000;
  const out: Regulars = new Map();
  const resting: Regular[] = [];
  const watching: Regular[] = [];
  for (const r of CAST) {
    const role = roles.get(r.id)!;
    if (typeof role === "number") {
      if (ends.has(role)) watching.push(r);
      else out.set(r.id, { regular: r, spot: pingSpot(plan, role), act: "play", partner: null });
    } else if (role === "break" || stations.has(role)) resting.push(r);
    else out.set(r.id, { regular: r, spot: gymSpot(plan, role), act: "lift", partner: null, visit: { station: role, seed: `${r.id}:${visit}`, until } });
  }
  resting.sort((a, b) => hash(`aside:${visit}:${a.id}`) - hash(`aside:${visit}:${b.id}`) || a.id.localeCompare(b.id));
  const places: Place[] = resting.length > 1 ? ["cooler0", "cooler1", "mat0", "mat1"] : hash(`places:${visit}`) & 1 ? ["mat0"] : ["cooler0"];
  resting.forEach((r, i) => {
    const place = places[i]!;
    const act: Act = place.startsWith("mat") ? (hash(`mat:${visit}:${r.id}`) & 1 ? "sit" : "stretch") : "cooler";
    out.set(r.id, { regular: r, spot: placeSpot(plan, place), act, partner: null });
  });
  watching.forEach((r, i) => out.set(r.id, { regular: r, spot: placeSpot(plan, (["watch0", "watch1"] as const)[i]!), act: "watch", partner: null }));
  pairAtCooler(out);
  // In the cast's order, like `placeRegulars`.
  return new Map(CAST.map((r) => [r.id, out.get(r.id)!] as const));
}

// ---------------------------------------------------------------- the touches

const smooth = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
/** Up over `rise` seconds from `from`, held, and down over `rise` seconds to `to`. */
const bump = (t: number, from: number, to: number, rise: number) => Math.min(smooth((t - from) / rise), smooth((to - t) / rise));

/** How long a sip at the cooler takes, the cup up and down. */
export const SIP = 2.4;

/**
 * A cheer after a point (0 to 1), this many seconds into play: the player at `end` who won it punches
 * the air; with no end, someone watching cheers after every point.
 */
export function cheerAt(end: End | null, seconds: number): number {
  const t = rallyTime(seconds);
  let most = 0;
  for (const h of RALLY.holds) {
    if (h.winner === undefined || (end !== null && h.winner !== end)) continue;
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
