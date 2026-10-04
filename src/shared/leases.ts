// The office-run capture lease's contract, shared by the service, the CLI and the office UI.

/** The only lease resource so far: a project's one headless checker (probe/take captures, npm run check, browser tests). */
export const LEASE_RESOURCES = ["capture"] as const;
export type LeaseResource = typeof LEASE_RESOURCES[number];
/** A hold lasts this long unless the project's lead set another limit. */
export const DEFAULT_HOLD_MINUTES = 30;
export const MAX_HOLD_MINUTES = 240;
/** `inbox lease acquire --wait` never waits longer than this: agents' tool calls time out. */
export const MAX_WAIT_SECONDS = 120;

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
  holder: LeaseHolder | null;
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

/** The line a project's team panel shows; null while nobody holds or waits. */
export function leaseLine(view: Pick<LeaseView, "holder" | "queue"> | null): string | null {
  if (!view || (!view.holder && !view.queue.length)) return null;
  const waiting = view.queue.length ? ` · ${view.queue.length} waiting` : "";
  return `Capture: ${view.holder?.name ?? "free"}${waiting}`;
}
