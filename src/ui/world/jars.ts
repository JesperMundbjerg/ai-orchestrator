// Project use this week, not remaining allowance: two jars beside the lead's craft place.
// All jars use ONE scale (the busiest visible project's total), even across different meters.
import type { UsageShare, UsageView } from "../../shared/types.ts";
import { compactTokens, sharePercent } from "../usageLine.ts";
import { onFloor } from "./crafts.ts";
import type { Corner, Vec2 } from "./spatial.ts";

export const JAR = { radius: 0.13, height: 0.38, base: 0.89, spacing: 0.36 };
export interface JarLook {
  id: string;
  label: string;
  tokens: number | null;
  fill: number;
  text: string;
}
export interface JarSpot {
  teamId: string;
  pos: Vec2;
  facing: number;
  jars: JarLook[];
}
const count = (n: number) => Number.isFinite(n) ? Math.max(0, n) : 0;

/** Never infer tokens from percentage shares: each limit and token weight can differ. */
export function meterTokens(use: UsageShare | undefined, id: string): number | null {
  if (!use || use.tokens === 0) return 0;
  const part = use.parts.find((p) => p.meter === id);
  if (!part) return use.parts.every((p) => p.tokens !== undefined) && use.parts.length ? 0 : null;
  if (part.tokens !== undefined) return count(part.tokens);
  // An older service's single-meter total is unambiguous; mixed totals are not.
  return use.parts.length === 1 ? count(use.tokens) : null;
}

export function jarLook(id: string, label: string, use: UsageShare | undefined, busiest: number): JarLook {
  const tokens = meterTokens(use, id);
  const share = use?.parts.find((p) => p.meter === id)?.share;
  const percent = tokens === 0 ? "0%" : share == null ? "share unavailable" : sharePercent(share);
  return {
    id, label, tokens,
    fill: tokens === null || busiest <= 0 ? 0 : Math.min(1, tokens / busiest),
    text: `${label} · ${tokens === null ? "token split unavailable" : `${compactTokens(tokens)} tokens`} · ${percent}`,
  };
}

/** A small side table beside (not on top of) the lead's piece. It stays off both side aisles,
 * the approach behind the lead and the crew lanes; the same placement works in either plan. */
export function jarSpots(corners: Corner[], usage: UsageView | undefined): JarSpot[] {
  const weekly = [...(usage?.meters ?? [])].filter((m) => m.window === "week").sort((a, b) => a.id.localeCompare(b.id)).slice(0, 2);
  const busiest = Math.max(0, ...corners.map((c) => count(usage?.teams[c.team.id]?.tokens ?? 0)));
  return corners.flatMap((c) => {
    const desk = c.desks.find((d) => d.kind === "lead");
    if (!desk || !weekly.length) return [];
    return [{ teamId: c.team.id, pos: onFloor(desk, [1.55, 0]), facing: desk.facing,
      jars: weekly.map((m) => jarLook(m.id, m.label, usage?.teams[c.team.id], busiest)) }];
  });
}

/** Monotonic, finite settling; no ticking once the value arrives. */
export function settleFill(shown: number, target: number, delta: number): number {
  if (Math.abs(shown - target) < 0.001) return target;
  return shown + (target - shown) * Math.min(1, Math.max(0, delta) * 5);
}
