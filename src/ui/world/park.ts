// The building's garden as a park for whoever has nothing to do. Pure: from the plan, who is idle
// and the time it says who goes out to the garden and what each does there, the same every time
// for the same inputs, so the tests can check it.
//
//   who      agents on no project, and project members (crew or lead) idle for IDLE_MS; a
//            member who just finished a turn, is working, at a prompt or waiting on you stays
//            at their desk, and walks back to it as soon as they are busy again
//   what     sitting on a bench, looking up at a tree, picking a flower, watching the ducks at
//            the pond, chatting with another in pairs across the path, stretching, or strolling
//            round the walk
//   where    places along the walk, just off its middle line, each on a path facing what it is
//            for; no two within GAP of each other, none by a bench or where the trail or the way
//            in meets the walk. Benches' seats are the benches'; strollers take no place
//   when     everyone takes up something new every PASTIME_MS, not all at once but in SHIFTS
//            staggered through the minute; until then they stay where they are (the office
//            passes back what it had), so someone coming, going or changing moves nobody else.
//            A stroller joins the walk at the same point, their own, whenever they stroll

import type { WorldAgent } from "../../shared/types.ts";
import { benchSeats, intoGarden, onEdge, seatSpot, strollSpot, type BuildingPlan, type Garden, type Rect } from "./building.ts";
import { yawTo, type Pose, type Spot, type Vec2 } from "./spatial.ts";
import { benchNook, plantGarden } from "./planting.ts";

/** A project member idle this long goes out to the garden. */
export const IDLE_MS = 60 * 1000;
/** Each agent in the garden takes up something new this often. */
export const PASTIME_MS = 60 * 1000;
const SHIFTS = 6;

export type Pastime = "sit" | "tree" | "flower" | "ducks" | "chat" | "stretch" | "stroll";

/** What someone takes up, as often as it comes up here. */
const PASTIMES: Pastime[] = ["sit", "sit", "tree", "tree", "flower", "flower", "stroll", "stroll", "chat", "chat", "stretch", "ducks"];
/** What they do instead when there is no place left for it; strolling always has room. */
const FALLBACK: Pastime[] = ["sit", "tree", "flower", "ducks", "stretch", "stroll"];

/** Standing places stand this far off the walk's middle line, where strollers walk past. */
export const OFF = 0.55;
const CHAT_OFF = 0.5;
/** Places this far apart along the walk are tried; the ones taken are at least GAP apart, but for two chatting. */
const STEP = 0.5;
export const GAP = 1.1;

const POSE: Record<"tree" | "flower" | "ducks" | "chat" | "stretch", Pose> = { tree: "look", flower: "pick", ducks: "watch", chat: "chat", stretch: "stretch" };

/** A hash of a string, the same every time: FNV-1a. */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/**
 * The project members who go out to the garden: idle (not working, not at a prompt, not just
 * finished a turn, not waiting on you, not in line) since at least IDLE_MS before `now`, by
 * `idleSince`; one it does not know counts as just idle.
 */
export function outForABreak(agents: WorldAgent[], idleSince: ReadonlyMap<string, number>, now: number, queue: readonly string[] = []): Set<string> {
  const queued = new Set(queue);
  return new Set(
    agents
      .filter((a) => a.teamId && a.status === "idle" && !a.waitingOnYou && !queued.has(a.id) && now - (idleSince.get(a.id) ?? now) >= IDLE_MS)
      .map((a) => a.id),
  );
}

/** Which pastime an agent is at: its turn, when that began, and when the next begins. Agents change in SHIFTS, not all at once. */
export function shiftOf(id: string, now: number): { turn: number; since: number; next: number } {
  const off = ((hash(id) % SHIFTS) * PASTIME_MS) / SHIFTS;
  const turn = Math.floor((now + off) / PASTIME_MS);
  return { turn, since: turn * PASTIME_MS - off, next: (turn + 1) * PASTIME_MS - off };
}

export interface ParkPlaces {
  seats: Spot[];
  tree: Spot[];
  flower: Spot[];
  ducks: Spot[];
  stretch: Spot[];
  /** Two facing each other across the path. */
  chat: Array<[Spot, Spot]>;
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const away = (r: Rect, [x, z]: Vec2) => Math.hypot(Math.max(r.minX - x, 0, x - r.maxX), Math.max(r.minZ - z, 0, z - r.maxZ));
/** How squarely what is at `to` lies off the path from `p`, the way `n` points: 1 straight ahead. */
const toward = (p: Vec2, n: Vec2, to: Vec2) => ((to[0] - p[0]) * n[0] + (to[1] - p[1]) * n[1]) / (dist(p, to) || 1);

let cached: { key: string; places: ParkPlaces } | null = null;

/**
 * The places in the garden for each pastime. Along each side of the walk, just off its middle
 * line on either side, facing out: by a flower on the bed's edge, below a tree standing back in
 * a bed, by the pond, or across the path from someone to talk with; any of them for a stretch.
 * They are handed out by turns, so the garden has some of every kind, all at least GAP apart.
 */
export function parkPlaces(garden: Garden, loop: Rect): ParkPlaces {
  const key = JSON.stringify([garden.area, loop]);
  if (cached?.key === key) return cached.places;
  const planting = plantGarden(garden);
  const { walk, pond } = garden;
  const nooks = garden.benches.map(benchNook);
  const flowers = planting.plants.filter((p) => p.kind === "flowers");
  const corners: Vec2[] = [[walk.minX, walk.minZ], [walk.maxX, walk.minZ], [walk.maxX, walk.maxZ], [walk.minX, walk.maxZ]];
  const spot = (pos: Vec2, facing: number, pose: Pose): Spot => ({ pos, facing, zone: "garden", group: "garden", approach: intoGarden(garden, loop, onEdge(walk, pos)), pose });

  const lists: Record<"ducks" | "tree" | "flower" | "chat" | "stretch", Spot[][]> = { ducks: [], tree: [], flower: [], chat: [], stretch: [] };
  corners.forEach((a, i) => {
    const b = corners[(i + 1) % 4]!;
    const length = dist(a, b);
    const d: Vec2 = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    const across = a[1] === b[1];
    for (let s = 0.7; s <= length - 0.7; s += STEP) {
      const q: Vec2 = [a[0] + d[0] * s, a[1] + d[1] * s];
      // Clear of where the trail through the inner bed and the way in meet the walk.
      if (across && Math.abs(q[0]) < 1.4) continue;
      const sides = ([1, -1] as const).map((side) => {
        const n: Vec2 = [-d[1] * side, d[0] * side];
        const p: Vec2 = [q[0] + n[0] * OFF, q[1] + n[1] * OFF];
        return { n, p, ok: nooks.every((nk) => away(nk, p) > 0.35) && !inside(garden.clearing, p) };
      });
      for (const { n, p, ok } of sides) {
        if (!ok) continue;
        const nearest = <T extends { pos: Vec2 }>(xs: T[], lo: number, hi: number, square: number) =>
          xs.filter((x) => dist(p, x.pos) >= lo && dist(p, x.pos) <= hi && toward(p, n, x.pos) >= square).sort((x, y) => dist(p, x.pos) - dist(p, y.pos))[0];
        const f = nearest(flowers, 0, 1.1, 0.7);
        if (f) lists.flower.push([spot(p, yawTo(p, f.pos), POSE.flower)]);
        const t = nearest(planting.trees, 1.2, 3.5, 0.8);
        if (t) lists.tree.push([spot(p, yawTo(p, t.pos), POSE.tree)]);
        if (dist(p, pond.center) - pond.radius < 3 && toward(p, n, pond.center) >= 0.6) lists.ducks.push([spot(p, yawTo(p, pond.center), POSE.ducks)]);
        lists.stretch.push([spot(p, yawTo(p, [p[0] + n[0], p[1] + n[1]]), POSE.stretch)]);
      }
      if (sides.every((x) => x.ok)) {
        // A little nearer each other than the others stand, so whoever comes over to them stays on the path too.
        const [l, r] = sides.map((x) => [q[0] + x.n[0] * CHAT_OFF, q[1] + x.n[1] * CHAT_OFF]) as [Vec2, Vec2];
        lists.chat.push([spot(l, yawTo(l, r), POSE.chat), spot(r, yawTo(r, l), POSE.chat)]);
      }
    }
  });

  // By turns, a place of each kind, keeping every place GAP from those already taken.
  const taken: Vec2[] = benchSeats(garden).map((s) => s.pos);
  const out: ParkPlaces = { seats: benchSeats(garden).map((s) => seatSpot(garden, loop, s)), tree: [], flower: [], ducks: [], stretch: [], chat: [] };
  const kinds = ["ducks", "tree", "flower", "chat", "stretch"] as const;
  const next = Object.fromEntries(kinds.map((k) => [k, 0])) as Record<(typeof kinds)[number], number>;
  for (let more = true; more; ) {
    more = false;
    for (const kind of kinds) {
      const list = lists[kind];
      while (next[kind] < list.length) {
        const group = list[next[kind]++]!;
        if (!group.every((s) => taken.every((t) => dist(t, s.pos) >= GAP))) continue;
        taken.push(...group.map((s) => s.pos));
        if (kind === "chat") out.chat.push(group as [Spot, Spot]);
        else out[kind].push(group[0]!);
        more = true;
        break;
      }
    }
  }
  cached = { key, places: out };
  return out;
}

const inside = (r: Rect, [x, z]: Vec2) => x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ;

/** Who is where in the garden, and in which of their turns they went there. */
export type Park = Map<string, { turn: number; spot: Spot }>;

/**
 * What each of `who` is doing in the garden by `now`, and where. Whoever `before` has in the
 * garden in the same turn stays where they are, and a pair chatting stays while both do. The
 * rest choose in the order they settled (the later of coming out, by `since`, and their turn
 * beginning): each wants the pastime their turn says, and the free place of it their turn likes
 * best, or else the next pastime with room. Two who want to chat are paired, in that order; one
 * left without a partner does something else.
 */
export function parkSpots(garden: Garden, loop: Rect, who: readonly string[], now: number, since: ReadonlyMap<string, number> = new Map(), before: Park = new Map()): Park {
  const places = parkPlaces(garden, loop);
  const settled = (id: string) => Math.max(shiftOf(id, now).since, since.get(id) ?? -Infinity);
  const same = (a: Spot, b: Spot) => a.pos[0] === b.pos[0] && a.pos[1] === b.pos[1];
  const out: Park = new Map();
  // Those staying put: same turn, and a place this garden still has; chatting only in twos.
  const stay = new Map<string, Spot>();
  for (const id of who) {
    const was = before.get(id);
    if (was && was.turn === shiftOf(id, now).turn && !was.spot.stroll) stay.set(id, was.spot);
  }
  for (const [id, spot] of stay) {
    if (spot.pose !== "chat") continue;
    const pair = places.chat.find((p) => p.some((s) => same(s, spot)));
    const other = pair?.find((s) => !same(s, spot));
    if (!other || ![...stay].some(([o, s]) => o !== id && same(s, other))) stay.delete(id);
  }
  const all = [...places.seats, ...places.tree, ...places.flower, ...places.ducks, ...places.stretch, ...places.chat.flat()];
  for (const [id, spot] of stay) {
    const here = all.find((s) => same(s, spot) && s.pose === spot.pose && !!s.sit === !!spot.sit);
    if (here) out.set(id, { turn: shiftOf(id, now).turn, spot: here });
  }
  const held = [...out.values()].map((x) => x.spot);
  const open = (xs: Spot[]) => xs.filter((s) => !held.some((h) => same(h, s)));
  const order = who.filter((id) => !out.has(id)).sort((a, b) => settled(a) - settled(b) || (a < b ? -1 : a > b ? 1 : 0));
  const free: Record<Exclude<Pastime, "chat" | "stroll">, Spot[]> = {
    sit: open(places.seats),
    tree: open(places.tree),
    flower: open(places.flower),
    ducks: open(places.ducks),
    stretch: open(places.stretch),
  };
  const pairs = places.chat.filter((p) => open(p).length === 2);
  const best = <T>(xs: T[], key: string, at: (x: T) => Vec2): T | undefined => {
    let pick: T | undefined;
    let score = Infinity;
    for (const x of xs) {
      const h = hash(`${key}@${at(x).map((v) => v.toFixed(2)).join(",")}`);
      if (h < score) (score = h), (pick = x);
    }
    if (pick !== undefined) xs.splice(xs.indexOf(pick), 1);
    return pick;
  };
  let waiting: { id: string; pair: [Spot, Spot] } | null = null;
  const settle = (id: string, key: string, wants: Pastime[]) => {
    const put = (spot: Spot) => void out.set(id, { turn: shiftOf(id, now).turn, spot });
    for (const kind of wants) {
      // Each stroller joins the walk at their own point.
      if (kind === "stroll") return put(strollSpot(garden, loop, hash(id) / 2 ** 32));
      if (kind === "chat") {
        if (waiting) {
          put(waiting.pair[1]);
          waiting = null;
          return;
        }
        const pair = best(pairs, key, (p) => p[0].pos);
        if (!pair) continue;
        put(pair[0]);
        waiting = { id, pair };
        return;
      }
      const spot = best(free[kind], key, (s) => s.pos);
      if (spot) return put(spot);
    }
  };
  for (const id of order) {
    const key = `${id}:${shiftOf(id, now).turn}`;
    const want = PASTIMES[hash(key) % PASTIMES.length]!;
    settle(id, key, [want, ...FALLBACK.filter((k) => k !== want)]);
  }
  // Nobody to talk to: they give the place back and do something else.
  const lone = waiting as { id: string; pair: [Spot, Spot] } | null;
  if (lone) {
    out.delete(lone.id);
    pairs.push(lone.pair);
    settle(lone.id, `${lone.id}:alone`, FALLBACK);
  }
  return out;
}

/** Who is in the garden in this plan: everyone it puts there, and the members out for a break. */
export function inPark(plan: BuildingPlan, out: ReadonlySet<string>): string[] {
  const queued = new Set(plan.queue);
  return [...plan.spots.entries()].filter(([id, s]) => !queued.has(id) && (s.zone === "garden" || out.has(id))).map(([id]) => id);
}

/** The plan with everyone in the garden at what they are doing by `now`, and who is where; their desks stay theirs. */
export function parkPlan(plan: BuildingPlan, out: ReadonlySet<string>, now: number, since?: ReadonlyMap<string, number>, before?: Park): { plan: BuildingPlan; park: Park } {
  const who = inPark(plan, out);
  if (!who.length) return { plan, park: new Map() };
  const park = parkSpots(plan.garden, plan.loop, who, now, since, before);
  const spots = new Map(plan.spots);
  for (const [id, { spot }] of park) spots.set(id, spot);
  return { plan: { ...plan, spots }, park };
}

/** When the next of them takes up something new. */
export function nextPastime(who: readonly string[], now: number): number {
  return Math.min(...who.map((id) => shiftOf(id, now).next));
}
