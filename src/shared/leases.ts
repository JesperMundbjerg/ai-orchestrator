// The office-run capture lease's contract, shared by the service, the CLI and the office UI.

/** The only lease resource so far: a project's one headless checker (probe/take captures, npm run check, browser tests). */
export const LEASE_RESOURCES = ["capture"] as const;
export type LeaseResource = typeof LEASE_RESOURCES[number];
/** A hold lasts this long unless the project's lead set another limit. */
export const DEFAULT_HOLD_MINUTES = 30;
export const MAX_HOLD_MINUTES = 240;
/** `inbox lease acquire --wait` never waits longer than this: agents' tool calls time out. */
export const MAX_WAIT_SECONDS = 120;
/** How many agents hold a lease at once unless its lead set another capacity. */
export const DEFAULT_CAPACITY = 1;
export const MAX_CAPACITY = 10;

export interface LeaseHolder {
  agentId: string;
  name: string;
  leaseId: string;
  since: string;
  expiresAt: string;
  runId: string | null;
  reason: string | null;
}
export interface LeaseWaiter {
  agentId: string;
  name: string;
  leaseId: string;
  /** 1 is next. */
  position: number;
  since: string;
  runId: string | null;
  reason: string | null;
}
export interface LeaseView {
  resource: LeaseResource;
  /** The repository's Git common dir: every checkout, lane and team of it shares this lease. */
  repo: string;
  /** Its main checkout. */
  root: string;
  project: string;
  /** The longest-standing holder, or null while nobody holds it; the same as holders[0]. */
  holder: LeaseHolder | null;
  /** Everyone holding it now, in grant order; at most `capacity`, fewer after a lowering. */
  holders: LeaseHolder[];
  /** How many may hold it at once (1 unless the lead set more). */
  capacity: number;
  queue: LeaseWaiter[];
  holdMinutes: number;
  /** The lead of the standing team for this repository: the only one who may revoke or set the limit. */
  lead: { agentId: string; name: string } | null;
}
/** What every lease request answers: the lease, where the caller stands, and a line to print. */
export interface LeaseResult extends LeaseView {
  you: { state: "held" | "queued" | "none"; position: number | null; leaseId: string | null };
  text: string;
}

/** The line a project's team panel shows (every holder, and the slots when it holds several); null while nobody holds or waits. */
export function leaseLine(view: Pick<LeaseView, "holders" | "capacity" | "queue"> | null): string | null {
  if (!view || (!view.holders.length && !view.queue.length)) return null;
  const slots = view.capacity > 1 ? ` · ${view.holders.length} of ${view.capacity} slots` : "";
  const waiting = view.queue.length ? ` · ${view.queue.length} waiting` : "";
  return `Capture: ${view.holders.map((h) => h.name).join(", ") || "free"}${slots}${waiting}`;
}
