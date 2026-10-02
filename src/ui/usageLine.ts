import type { UsageMeter, UsageShare } from "../shared/types.ts";

/** 820, 4.2k, 340k, 1.2M: tokens as a person reads them. */
export function compactTokens(n: number): string {
  const trim = (v: number) => String(Math.round(v * 10) / 10);
  if (n >= 999_950) return `${trim(n / 1e6)}M`;
  if (n >= 9_950) return `${Math.round(n / 1e3)}k`;
  if (n >= 1000) return `${trim(n / 1e3)}k`;
  return String(Math.round(n));
}

/** Whole percents of a limit; under one is "<1%" rather than a "0%" that reads as nothing used. */
export function sharePercent(share: number): string {
  return share < 0.5 ? "<1%" : `≈${Math.round(share)}%`;
}

/**
 * The quiet line for an agent's or a project's use this week: "≈4% of Claude week · 1.2M tokens".
 * Each part names the weekly meter it was scaled by, by the label the service gave it, and a team
 * that used two harnesses shows both. Tokens alone when no weekly reading could scale them;
 * nothing at all when there are none.
 */
export function usageLine(use: UsageShare | undefined, meters: UsageMeter[]): string | null {
  if (!use || !(use.tokens > 0)) return null;
  const tokens = `${compactTokens(use.tokens)} ${Math.round(use.tokens) === 1 ? "token" : "tokens"}`;
  const labelOf = (id: string) => meters.find((m) => m.id === id)?.label;
  const parts = use.share === null ? [] : use.parts.filter((p) => p.share !== null && labelOf(p.meter));
  if (!parts.length) return tokens;
  return `${parts.map((p) => `${sharePercent(p.share!)} of ${labelOf(p.meter)}`).join(" + ")} · ${tokens}`;
}
