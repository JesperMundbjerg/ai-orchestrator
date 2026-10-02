// The usage meters in the garden: a bird feeder per limit, holding what is left of it.
// Pure: from the garden's plan and the meters it says where each feeder stands and how big it is,
// and from a meter and the time what it shows and how many birds come. It knows a meter only by
// its label and its window, never by whose limit it is.
//
//   where    in a row down the east lawn's edge by the clearing, its front first, on ground the
//            planting keeps clear (meterGround), so no feeder stands on a path, the clearing, a
//            bench's nook or a park place, nor in front of whoever comes to you
//   size     a weekly limit's feeder is big, a 5-hour limit's smaller
//   seed     the glass holds what is left (100 − used%): full at the reset, empty at the limit;
//            the seed keeps its own colour, and a band round the post says green, amber from
//            AMBER used, red from RED
//   birds    a few perch and peck while seed is left, fewer as it runs low, none when it is
//            empty; then a few seeds lie on the ground under it
//   faded    a reading that is stale or unknown, or whose window has reset since, shows faded;
//            one whose window has reset shows full until a new reading confirms it; an unknown
//            one shows an empty glass and no birds, but no fallen seed either
//   ring     on the ground round the post, the share of the limit left (100 − used%), in the
//            feeder's tone; it animates with the seed. The hover/pin label says when it resets

import type { UsageMeter } from "../../shared/types.ts";
import type { Garden, Rect } from "./building.ts";
import type { Vec2 } from "./spatial.ts";

/** The band on the post turns amber at this share used, and red at this. */
export const AMBER = 70;
export const RED = 90;

export type Tone = "green" | "amber" | "red";

export const TONES: Record<Tone, string> = { green: "#4fae5c", amber: "#e9a23b", red: "#d9493f" };

/**
 * A feeder: the ground round its post (where birds peck and the usage ring lies), its glass's
 * radius and height, and the post's height up to the tray. A weekly limit's is big, a 5-hour limit's smaller.
 */
export const FEEDER: Record<UsageMeter["window"], { radius: number; glass: number; height: number; post: number }> = {
  week: { radius: 0.36, glass: 0.15, height: 0.46, post: 0.95 },
  five_hour: { radius: 0.27, glass: 0.11, height: 0.32, post: 0.72 },
};
/** The ring round a feeder's post reaches this far out, as a share of its radius. */
export const RING_OUT = 1.45;
/** The most birds at a feeder at once: at a full one. */
export const BIRDS: Record<UsageMeter["window"], number> = { week: 3, five_hour: 2 };
/** Between one feeder's ring and the next. */
const GAP = 0.3;
/** The feeders keep this far in from the lawn's edges. */
const IN = 0.35;
/** The ground kept for the feeders: room for this many of the biggest. */
export const ROOM = 4;

export const toneOf = (percent: number): Tone => (percent >= RED ? "red" : percent >= AMBER ? "amber" : "green");

/**
 * The ground the feeders stand on: a strip down the east lawn's side by the clearing, from its
 * front back, with room for ROOM big feeders. planting.ts grows nothing here.
 */
export function meterGround(garden: Garden): Rect {
  const east = garden.lawns[1];
  const reach = FEEDER.week.radius * RING_OUT;
  const length = ROOM * 2 * reach + (ROOM - 1) * GAP;
  const minX = east.minX + IN;
  const maxZ = east.maxZ - IN;
  return { minX, maxX: minX + 2 * reach, minZ: Math.max(east.minZ + IN, maxZ - length), maxZ };
}

export interface MeterSpot {
  id: string;
  pos: Vec2;
  /** The ground round the post; the usage ring lies just outside it. */
  radius: number;
  /** The glass's radius and height, and the post's height up to the tray. */
  glass: number;
  height: number;
  post: number;
}

/** Where each meter's feeder stands: one behind another from the strip's front, in the order given; those there is no room for are left out. */
export function meterSpots(garden: Garden, meters: readonly UsageMeter[]): MeterSpot[] {
  const ground = meterGround(garden);
  const x = (ground.minX + ground.maxX) / 2;
  const out: MeterSpot[] = [];
  let z = ground.maxZ;
  for (const m of meters) {
    const size = FEEDER[m.window];
    const reach = size.radius * RING_OUT;
    if (z - 2 * reach < ground.minZ - 1e-9) break;
    out.push({ id: m.id, pos: [x, z - reach], ...size });
    z -= 2 * reach + GAP;
  }
  return out;
}

export interface MeterLook {
  /** How full the glass shows: what is left, 0 to 1. */
  seed: number;
  tone: Tone;
  faded: boolean;
  /** At or past its limit: the glass is empty, no birds come, and a few seeds lie on the ground. */
  empty: boolean;
  /** How many birds are at the feeder. */
  birds: number;
  /** Share of the limit left, 0 to 1, matching the seed; null when usage is unknown. */
  left: number | null;
  /** What hovering over or pinning it says: "Claude week · 76% used · resets in 10 h". */
  label: string;
}

/** How many birds come to a feeder of this window with this much seed left: none to an empty one, one to the last of it, all of them to a full one. */
export const birdsAt = (seed: number, window: UsageMeter["window"]): number => (seed <= 0 ? 0 : Math.min(BIRDS[window], Math.ceil(seed * BIRDS[window] - 1e-9)));

/** A time as the office says it: "Fri 08:00", in the given time zone (the browser's when none is). */
export function when(at: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("weekday")} ${part("hour")}:${part("minute")}`;
}

/** A reset countdown rounded up, so a future reset never says zero minutes. */
function resetIn(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `${hours} h`;
  const remainder = hours % 24;
  return `${Math.floor(hours / 24)} d${remainder ? ` ${remainder} h` : ""}`;
}

/** What a meter shows at `now`. */
export function meterLook(m: UsageMeter, now: number, timeZone?: string): MeterLook {
  const resets = m.resetsAt ? Date.parse(m.resetsAt) : NaN;
  const known = Number.isFinite(resets);
  const reset = known && resets <= now;
  const used = m.usedPercent;
  const resetsAt = known ? when(new Date(resets), timeZone) : null;
  const tail = known ? (reset ? ` · reset ${resetsAt}` : ` · resets in ${resetIn(resets - now)}`) : "";
  if (used === null) {
    return { seed: 0, tone: "green", faded: true, empty: false, birds: 0, left: null, label: `${m.label}: no reading yet${tail}` };
  }
  if (reset) {
    // The window started again since the reading; until a new one comes, it shows full.
    return { seed: 1, tone: "green", faded: true, empty: false, birds: birdsAt(1, m.window), left: 1, label: `${m.label} reset ${resetsAt}, not yet confirmed` };
  }
  const percent = Math.max(0, Math.round(used));
  const asOf = m.stale && m.asOf ? ` as of ${when(new Date(m.asOf), timeZone)}` : m.stale ? " (stale)" : "";
  const seed = Math.max(0, Math.min(1, (100 - used) / 100));
  return {
    seed,
    tone: toneOf(used),
    faded: m.stale,
    empty: seed === 0,
    birds: birdsAt(seed, m.window),
    left: seed,
    label: `${m.label} · ${percent}% used${asOf}${tail}`,
  };
}

/** How far the tray reaches out from the post, as a share of the glass's radius, and how thick it is. */
export const TRAY = 1.55;
export const TRAY_THICK = 0.035;

/** Where a bird is at a feeder: on the ground (y 0) or on the tray's rim, facing `yaw` (0 is +z). */
export interface Perch {
  pos: Vec2;
  y: number;
  yaw: number;
  /** Pecking on the ground, or eating from the tray. */
  on: "tray" | "ground";
  /** The feeder's post, which a bird on the ground hops round. */
  post: Vec2;
}

/**
 * Where the birds at a feeder are: the first on the tray's rim facing the seed, the next pecking
 * on the ground in front of it, the third on the tray's far side; every one inside the feeder's
 * ground, so none stands on its ring or beyond.
 */
export function perches(spot: MeterSpot, n: number): Perch[] {
  const [x, z] = spot.pos;
  const rim = spot.glass * TRAY;
  const out: Perch[] = [];
  const places: Array<{ a: number; on: Perch["on"] }> = [
    { a: 0.5, on: "tray" },
    { a: -0.7, on: "ground" },
    { a: Math.PI - 0.3, on: "tray" },
  ];
  for (const { a, on } of places.slice(0, n)) {
    const r = on === "tray" ? rim : spot.radius * 0.62;
    const pos: Vec2 = [x + Math.sin(a) * r, z + Math.cos(a) * r];
    // On the tray it faces the glass; on the ground it faces along the ring, round the post.
    out.push({ pos, y: on === "tray" ? spot.post + TRAY_THICK : 0, yaw: on === "tray" ? a + Math.PI : a + Math.PI / 2, on, post: spot.pos });
  }
  return out;
}

/** The seeds lying on the ground under an empty feeder: a few, scattered round the post's foot, the same every time. */
export function fallenSeeds(spot: MeterSpot, count = 14): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < count; i++) {
    const a = i * 2.39996 + 0.4;
    const r = spot.radius * (0.18 + 0.55 * ((i * 0.618) % 1));
    out.push([spot.pos[0] + Math.sin(a) * r, spot.pos[1] + Math.cos(a) * r]);
  }
  return out;
}
