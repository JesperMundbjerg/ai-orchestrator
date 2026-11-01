// `inbox lease …`: the office-run capture lease (one headless checker per repository, FIFO).
// Answers at once; --wait polls briefly (capped), because agents' tool calls time out.

import { parseArgs } from "node:util";
import { call } from "../shared/agent-client.ts";
import { LEASE_RESOURCES, MAX_CAPACITY, MAX_WAIT_SECONDS, type LeaseResource, type LeaseResult } from "../shared/leases.ts";
import type { SessionInput } from "../shared/types.ts";

export const LEASE_HELP = `  inbox lease acquire capture [--run RUN] [--reason TEXT] [--wait SEC]
                                  the project's headless checker (captures, npm run check, browser tests), shared by every
                                  checkout, lane and team of the repository: yours at once when a slot is free (one slot unless
                                  its lead raised the capacity), else you join the queue and the office tells you when it is
                                  yours. Exits 0 when you hold it, 3 while you wait in line
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
  const wait = action === "acquire" && flags.wait ? Math.min(Math.max(Number(flags.wait) || 0, 0), MAX_WAIT_SECONDS) : 0;
  // Asking again is idempotent: it keeps the caller's place and answers where it stands now.
  for (const until = Date.now() + wait * 1000; result.you.state === "queued" && Date.now() < until;) {
    await new Promise((done) => setTimeout(done, Math.min(2000, Math.max(until - Date.now(), 0))));
    result = await call<LeaseResult>("/api/agent/lease/acquire", body);
  }
  console.log(flags.json ? JSON.stringify(result, null, 2) : result.text);
  if (action === "acquire" && result.you.state !== "held") process.exitCode = 3;
}
