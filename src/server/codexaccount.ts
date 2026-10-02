// Codex's limits as the account itself reports them: the one account call the office makes, with
// the founder's ChatGPT login that the codex CLI keeps in ~/.codex/auth.json, to the one usage
// endpoint the CLI's own /usage reads. It is a read of numbers, not a model call. auth.json is only
// ever read here: a token is never refreshed (that would rotate it and could log the founder out of
// Codex), never written, never logged or stored, and goes to this one host and no other.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LimitReading } from "../shared/usage.ts";

export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const CODEX_AUTH_PATH = join(homedir(), ".codex/auth.json");

/** What the office needs of an HTTP call, so tests never reach the network. */
export type AccountFetcher = (url: string, headers: Record<string, string>) => Promise<{ status: number; json: () => Promise<unknown> }>;

/** The real call: one GET, to the URL given, with no redirect followed (a redirect could carry the token elsewhere). */
export const fetchAccount: AccountFetcher = (url, headers) =>
  fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(15_000) });

type Json = Record<string, any>;

/** The login in auth.json, or null when there is none (an API key, not signed in) or the token has expired. */
function login(path: string, now: number): { token: string; accountId: string | null } | null {
  let auth: Json;
  try {
    auth = JSON.parse(readFileSync(path, "utf8")) as Json;
  } catch {
    return null;
  }
  const token = auth.tokens?.access_token;
  if (typeof token !== "string" || !token) return null;
  try {
    const exp = Number(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")).exp);
    if (Number.isFinite(exp) && exp * 1000 <= now) return null;
  } catch {
    // not a JWT we can read: the endpoint will say
  }
  const id = auth.tokens?.account_id;
  return { token, accountId: typeof id === "string" && id ? id : null };
}

/** The windows of a usage reply: each by its length in minutes, so the office maps them, not primary or secondary. */
export function accountReadings(body: unknown, now: number): LimitReading[] {
  const limit = (body as Json | null)?.rate_limit as Json | undefined;
  const out: LimitReading[] = [];
  for (const w of [limit?.primary_window, limit?.secondary_window] as (Json | undefined)[]) {
    const used = Number(w?.used_percent);
    const seconds = Number(w?.limit_window_seconds);
    if (!w || w.used_percent === null || !Number.isFinite(used) || !(seconds > 0)) continue;
    const at = Number(w.reset_at);
    const after = Number(w.reset_after_seconds);
    out.push({
      usedPercent: used,
      windowMinutes: seconds / 60,
      resetsAt: at > 0 ? at : Number.isFinite(after) ? new Date(now + after * 1000).toISOString() : null,
    });
  }
  return out;
}

/** One read of the account's limits; empty when there is no usable login, or the call fails or is refused. Never throws. */
export async function readCodexAccount(path: string, fetcher: AccountFetcher, now: number): Promise<LimitReading[]> {
  const who = login(path, now);
  if (!who) return [];
  try {
    const res = await fetcher(CODEX_USAGE_URL, {
      Authorization: `Bearer ${who.token}`,
      ...(who.accountId ? { "ChatGPT-Account-Id": who.accountId } : {}),
      Accept: "application/json",
      "User-Agent": "review-inbox",
    });
    if (res.status !== 200) return [];
    return accountReadings(await res.json(), now);
  } catch {
    return [];
  }
}
