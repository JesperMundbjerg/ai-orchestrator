// The usage meters in the garden: a water tower per limit, filled to how much of it is used.
// Pure: from the garden's plan and the meters it says where each tower stands and how big it is,
// and from a meter and the time what it shows. It knows a meter only by its label and its window,
// never by whose limit it is.
//
//   where    in a row down the east lawn's edge by the clearing, its front first, on ground the
//            planting keeps clear (meterGround), so no tower stands on a path, the clearing, a
//            bench's nook or a park place, nor in front of whoever comes to you
//   size     a weekly limit's tower is big, a 5-hour limit's smaller
//   level    the water stands at the share used; green, amber from AMBER, red from RED; at 100%
//            it runs over the top and drips
//   faded    a reading that is stale or unknown, or whose window has reset since, shows faded;
//            one whose window has reset shows empty until a new reading confirms it
//   ring     round the tower's foot, what is left of the window until it resets

import type { UsageMeter } from "../../shared/types.ts";
import type { Garden, Rect } from "./building.ts";
import type { Vec2 } from "./layout.ts";

/** The water turns amber at this share used, and red at this. */
export const AMBER = 70;
export const RED = 90;

export type Tone = "green" | "amber" | "red";

export const TONES: Record<Tone, string> = { green: "#4fae5c", amber: "#e9a23b", red: "#d9493f" };

/** How long each window runs, from one reset to the next. */
export const WINDOW_MS: Record<UsageMeter["window"], number> = { five_hour: 5 * 3600 * 1000, week: 7 * 24 * 3600 * 1000 };

/** A tower: its radius, and its tank's height. A weekly limit's is big, a 5-hour limit's smaller. */
export const TOWER: Record<UsageMeter["window"], { radius: number; height: number }> = {
  week: { radius: 0.36, height: 1.25 },
  five_hour: { radius: 0.25, height: 0.8 },
};
/** The ring round a tower's foot reaches this far out, as a share of its radius. */
export const RING_OUT = 1.45;
/** Between one tower's ring and the next. */
const GAP = 0.3;
/** The towers keep this far in from the lawn's edges. */
const IN = 0.35;
/** The ground kept for the towers: room for this many of the biggest. */
export const ROOM = 4;

export const toneOf = (percent: number): Tone => (percent >= RED ? "red" : percent >= AMBER ? "amber" : "green");

/**
 * The ground the towers stand on: a strip down the east lawn's side by the clearing, from its
 * front back, with room for ROOM big towers. planting.ts grows nothing here.
 */
export function meterGround(garden: Garden): Rect {
  const east = garden.lawns[1];
  const reach = TOWER.week.radius * RING_OUT;
  const length = ROOM * 2 * reach + (ROOM - 1) * GAP;
  const minX = east.minX + IN;
  const maxZ = east.maxZ - IN;
  return { minX, maxX: minX + 2 * reach, minZ: Math.max(east.minZ + IN, maxZ - length), maxZ };
}

export interface MeterSpot {
  id: string;
  pos: Vec2;
  radius: number;
  height: number;
}

/** Where each meter's tower stands: one behind another from the strip's front, in the order given; those there is no room for are left out. */
export function meterSpots(garden: Garden, meters: readonly UsageMeter[]): MeterSpot[] {
  const ground = meterGround(garden);
  const x = (ground.minX + ground.maxX) / 2;
  const out: MeterSpot[] = [];
  let z = ground.maxZ;
  for (const m of meters) {
    const { radius, height } = TOWER[m.window];
    const reach = radius * RING_OUT;
    if (z - 2 * reach < ground.minZ - 1e-9) break;
    out.push({ id: m.id, pos: [x, z - reach], radius, height });
    z -= 2 * reach + GAP;
  }
  return out;
}

export interface MeterLook {
  /** How full the tank shows, 0 to 1. */
  level: number;
  tone: Tone;
  faded: boolean;
  /** At or past its limit: the water runs over the top. */
  over: boolean;
  /** What is left of the window until it resets, 0 to 1; null when the reset is not known. */
  left: number | null;
  /** What hovering over it says: "Claude week 62%, resets Fri 08:00". */
  label: string;
}

/** A time as the office says it: "Fri 08:00", in the given time zone (the browser's when none is). */
export function when(at: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("weekday")} ${part("hour")}:${part("minute")}`;
}

/** What a meter shows at `now`. */
export function meterLook(m: UsageMeter, now: number, timeZone?: string): MeterLook {
  const resets = m.resetsAt ? Date.parse(m.resetsAt) : NaN;
  const known = Number.isFinite(resets);
  const reset = known && resets <= now;
  const used = m.usedPercent;
  const left = known ? Math.max(0, Math.min(1, (resets - now) / WINDOW_MS[m.window])) : null;
  const resetsAt = known ? when(new Date(resets), timeZone) : null;
  if (used === null) {
    return { level: 0, tone: "green", faded: true, over: false, left, label: `${m.label}: no reading yet` };
  }
  if (reset) {
    // The window started again since the reading; until a new one comes, it shows empty.
    return { level: 0, tone: "green", faded: true, over: false, left: 0, label: `${m.label} reset ${resetsAt}, not yet confirmed` };
  }
  const percent = Math.max(0, Math.round(used));
  const asOf = m.stale && m.asOf ? ` as of ${when(new Date(m.asOf), timeZone)}` : m.stale ? " (stale)" : "";
  const tail = resetsAt ? `, resets ${resetsAt}` : "";
  return {
    level: Math.min(1, used / 100),
    tone: toneOf(used),
    faded: m.stale,
    over: used >= 100,
    left,
    label: `${m.label} ${percent}%${asOf}${tail}`,
  };
}
