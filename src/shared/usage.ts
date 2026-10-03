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
  /** What the same reply said of the account's credits, which Codex spends once a plan limit is reached. */
  credits?: CodexCredits;
}

/**
 * Codex's credits as a reply or rollout gives them: `x-codex-credits-has-credits`, `-unlimited`
 * and `-balance` in the headers, `rate_limits.credits` ({has_credits, unlimited, balance}) in a
 * rollout. Null where it said nothing.
 */
export interface CodexCredits {
  hasCredits: boolean | null;
  unlimited: boolean | null;
  balance: number | null;
}

const flag = (v: unknown): boolean | null => {
  if (typeof v === "boolean") return v;
  const s = typeof v === "string" ? v.trim().toLowerCase() : typeof v === "number" ? String(v) : "";
  return s === "true" || s === "1" ? true : s === "false" || s === "0" ? false : null;
};

/** Credits from what Codex wrote, field by field; null when it said nothing of them. */
export function codexCredits(raw: { has_credits?: unknown; unlimited?: unknown; balance?: unknown } | null | undefined): CodexCredits | null {
  if (!raw || typeof raw !== "object") return null;
  const balance = typeof raw.balance === "number" || (typeof raw.balance === "string" && raw.balance.trim()) ? Number(raw.balance) : NaN;
  const c = { hasCredits: flag(raw.has_credits), unlimited: flag(raw.unlimited), balance: Number.isFinite(balance) ? balance : null };
  return c.hasCredits === null && c.unlimited === null && c.balance === null ? null : c;
}

/** Whether credits remain: true with credits, a positive balance or unlimited ones; false when Codex says none; null when unknown. */
export function creditsLeft(c: CodexCredits | null | undefined): boolean | null {
  if (!c) return null;
  if (c.unlimited || c.hasCredits || (c.balance !== null && c.balance > 0)) return true;
  return c.hasCredits === false || c.balance !== null ? false : null;
}

/** The `x-codex-*` rate-limit headers of one reply, as readings, each carrying the reply's credits; none when the reply has no limits. */
export function codexHeaderReadings(headers: Record<string, string | undefined>, now = Date.now()): LimitReading[] {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const out: LimitReading[] = [];
  const credits = codexCredits({ has_credits: h["x-codex-credits-has-credits"], unlimited: h["x-codex-credits-unlimited"], balance: h["x-codex-credits-balance"] });
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
      ...(credits ? { credits } : {}),
    });
  }
  return out;
}

