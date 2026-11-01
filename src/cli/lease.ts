// `inbox lease …`: the office-run capture lease (one headless checker per repository, FIFO).
// Answers at once; --wait keeps asking (idempotent re-acquire keeps the place in line) until it holds the lease or the
// deadline passes, up to MAX_WAIT_SECONDS. A poll that times out or cannot reach the office does not end the wait.

import { parseArgs } from "node:util";
import { AgentClientError, call } from "../shared/agent-client.ts";
import { LEASE_RESOURCES, MAX_CAPACITY, MAX_WAIT_SECONDS, type LeaseResource, type LeaseResult } from "../shared/leases.ts";
import type { SessionInput } from "../shared/types.ts";

export const LEASE_HELP = `  inbox lease acquire capture [--run RUN] [--reason TEXT] [--wait SEC]
                                  the project's headless checker (captures, npm run check, browser tests), shared by every
                                  checkout, lane and team of the repository: yours at once when a slot is free (one slot unless
                                  its lead raised the capacity), else you join the queue and the office tells you when it is
                                  yours. Exits 0 when you hold it, 3 while you wait in line. --wait SEC keeps asking until you
                                  hold it or SEC seconds pass (at most 7200 = 2 h; more is capped, and it says so). A slow or
                                  restarting office does not end the wait; a refusal (not your team, unknown run) does
  inbox lease release capture     done: the next in line gets your slot and is told
  inbox lease renew capture       extend your hold by the project's limit (default 30 min); an expired hold passes on
  inbox lease leave capture       leave the queue
  inbox lease status capture      holders, since, expiry, run, capacity and queue
  inbox lease revoke capture --reason TEXT [--holder NAME]
                                  the project's lead only: take it from a holder (--holder names which when several hold it);
                                  holder and queue are told
  inbox lease limit capture --minutes N          the project's lead only: how long a hold lasts
  inbox lease capacity capture N                 the project's lead only: how many agents may hold it at once (1–10, default 1).
                                  Raising it grants waiters at once; lowering it never revokes a holder, it only stops granting
                                  until the holders are below it
      common: --repo PATH (a checkout of the repository; default: where you run it)  --json`;

const ACTIONS = ["acquire", "release", "leave", "renew", "status", "revoke", "limit", "capacity"] as const;
const OPTIONS = {
  run: { type: "string" }, reason: { type: "string" }, wait: { type: "string" }, repo: { type: "string" }, minutes: { type: "string" }, holder: { type: "string" },
  json: { type: "boolean" }, harness: { type: "string" }, session: { type: "string" }, help: { type: "boolean", short: "h" },
} as const;

/** The arguments after `lease` when it is the command, also behind --harness/--session; else null. */
export function leaseArgs(argv: string[]): string[] | null {
  let i = 0;
  while (argv[i] === "--harness" || argv[i] === "--session") i += 2;
  return argv[i] === "lease" ? [...argv.slice(0, i), ...argv.slice(i + 1)] : null;
}

export async function leaseCommand(argv: string[], session: (harness?: string, sessionId?: string) => SessionInput): Promise<void> {
  const { values: flags, positionals } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
  const [action, resource, count] = positionals;
  if (!action || flags.help) return console.log(LEASE_HELP);
  if (!ACTIONS.includes(action as typeof ACTIONS[number])) throw new Error(`inbox lease ${action}: use ${ACTIONS.join(", ")}`);
  if (!LEASE_RESOURCES.includes(resource as LeaseResource)) throw new Error(`inbox lease ${action} needs the resource: ${LEASE_RESOURCES.join(" or ")}`);
  const body: Record<string, unknown> = { session: session(flags.harness, flags.session), resource, repo: flags.repo };
  if (action === "acquire") Object.assign(body, { run: flags.run, reason: flags.reason });
  if (action === "revoke") {
    if (!flags.reason?.trim()) throw new Error("inbox lease revoke needs --reason TEXT: the holder and queue are told why");
    body.reason = flags.reason;
    if (flags.holder?.trim()) body.holder = flags.holder.trim();
  }
  if (action === "capacity") {
    const capacity = Number(count);
    if (!count || !Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) throw new Error(`inbox lease capacity ${resource} N needs a whole number from 1 to ${MAX_CAPACITY}`);
    body.capacity = capacity;
  }
  if (action === "limit") {
    const minutes = Number(flags.minutes);
    if (!Number.isInteger(minutes) || minutes < 1) throw new Error("inbox lease limit needs --minutes N");
    body.minutes = minutes;
  }
  let result = await call<LeaseResult>(`/api/agent/lease/${action}`, body);
  if (action === "acquire" && flags.wait) {
    const waited = await waitForLease(result, () => call<LeaseResult>("/api/agent/lease/acquire", body), waitSeconds(flags.wait, (line) => console.error(line)));
    result = waited.result;
    if (waited.polls) console.error(`inbox lease: waited ${formatWaited(waited.waitedMs)}; ${result.you.state === "held" ? "you hold it now" : "still in line"}.`);
  }
  console.log(flags.json ? JSON.stringify(result, null, 2) : result.text);
  if (action === "acquire" && result.you.state !== "held") process.exitCode = 3;
}

/** The seconds `--wait` asks for, at most MAX_WAIT_SECONDS; asking for more is said on `log`, with the cap. */
export function waitSeconds(flag: string, log: (line: string) => void): number {
  const asked = Math.max(Number(flag) || 0, 0);
  if (asked > MAX_WAIT_SECONDS) log(`inbox lease: --wait ${flag} is capped at ${MAX_WAIT_SECONDS} s (${MAX_WAIT_SECONDS / 3600} hours); waiting that long at most.`);
  return Math.min(asked, MAX_WAIT_SECONDS);
}

/** Poll every 2 s, every 5 s once the wait is a minute old, to spare the office. */
export const POLL_FAST_MS = 2000;
export const POLL_SLOW_MS = 5000;
export const POLL_SLOW_AFTER_MS = 60_000;

export interface WaitEnv {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}
const realEnv: WaitEnv = { now: Date.now, sleep: (ms) => new Promise((done) => setTimeout(done, ms)), log: (line) => console.error(line) };

/** Not an answer from the office: it was slow, unreachable (restarting) or failing on its side. A refusal (4xx) is not. */
export function isTransient(err: unknown): boolean {
  if (!(err instanceof AgentClientError)) return false;
  return err.kind === "timeout" || err.kind === "transport" || (err.kind === "http" && (err.status ?? 0) >= 500);
}

/**
 * Keep asking (`poll` is the idempotent re-acquire) while `first` says queued, until held or `waitSeconds` pass.
 * A transient failure is logged once per streak and the wait goes on; any other error ends it at once.
 * The last poll is at the deadline.
 */
export async function waitForLease(first: LeaseResult, poll: () => Promise<LeaseResult>, waitSeconds: number, env: WaitEnv = realEnv): Promise<{ result: LeaseResult; waitedMs: number; polls: number }> {
  const start = env.now();
  const until = start + waitSeconds * 1000;
  let result = first;
  let polls = 0;
  let failing = false;
  while (result.you.state === "queued" && env.now() < until) {
    const elapsed = env.now() - start;
    await env.sleep(Math.min(elapsed < POLL_SLOW_AFTER_MS ? POLL_FAST_MS : POLL_SLOW_MS, Math.max(until - env.now(), 0)));
    polls++;
    try {
      result = await poll();
      if (failing) env.log("inbox lease: the office answers again; still waiting.");
      failing = false;
    } catch (err) {
      if (!isTransient(err)) throw err;
      if (!failing) env.log(`inbox lease: ${err instanceof Error ? err.message : "poll failed"}; still waiting (your place in line is kept).`);
      failing = true;
    }
  }
  return { result, waitedMs: env.now() - start, polls };
}

function formatWaited(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}
