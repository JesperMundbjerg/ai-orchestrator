// A plan's usage limits as a harness is told them in the headers of its replies; shared by the
// service and the Pi extension, which forwards Codex's.

import type { UsageMeter } from "./types.ts";

/** One reading as a source gives it. */
export interface LimitReading {
  window?: UsageMeter["window"];
  /** Codex says its windows in minutes: 300 is the 5-hour one, 10080 the week. */
  windowMinutes?: number;
  usedPercent: number;
  /** ISO, epoch seconds or epoch milliseconds. */
  resetsAt?: string | number | null;
}

/** The `x-codex-*` rate-limit headers of one reply, as readings; none when the reply has none. */
export function codexHeaderReadings(headers: Record<string, string | undefined>, now = Date.now()): LimitReading[] {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const out: LimitReading[] = [];
  for (const which of ["primary", "secondary"]) {
    const used = Number(h[`x-codex-${which}-used-percent`]);
    if (h[`x-codex-${which}-used-percent`] === undefined || !Number.isFinite(used)) continue;
    const minutes = Number(h[`x-codex-${which}-window-minutes`]);
    const after = Number(h[`x-codex-${which}-reset-after-seconds`]);
    const at = h[`x-codex-${which}-reset-at`];
    out.push({
      usedPercent: used,
      windowMinutes: Number.isFinite(minutes) ? minutes : undefined,
      resetsAt: at ? at : Number.isFinite(after) ? new Date(now + after * 1000).toISOString() : null,
    });
  }
  return out;
}

