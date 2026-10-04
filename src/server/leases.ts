// The office-run capture lease: one per repository (its Git common dir), shared by all of its
// checkouts, lanes and teams. It enforces the founder's rule of one headless checker at a time
// (probe/take captures, npm run check, full browser tests), so it is mutual exclusion, not a port.
// Whoever asks while it is held joins a FIFO queue and gets an answer at once; when the lease
// passes on, the office tells the next in line through the ordinary delivery path. A hold expires
// after the project's limit (holder and lead are told), a holder whose pane is gone for good loses
// it, and only the repository's standing-team lead can revoke. State is in SQLite, so a restart
// keeps holder and queue. Telemetry and notices go out after the commit and can never change,
// delay or abort a lease operation.

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { DEFAULT_HOLD_MINUTES, MAX_HOLD_MINUTES, type LeaseResource, type LeaseResult, type LeaseView } from "../shared/leases.ts";
import type { Team, WorldAgent } from "../shared/types.ts";
import { InboxError } from "./inbox.ts";
import { repository } from "./pipelines/candidate.ts";

/** A holder or waiter the office sees without a pane this long (while herdr answers) is gone for good. */
export const GONE_MS = 5 * 60_000;
/** A path's repository is looked up again after this long. */
const REPO_CACHE_MS = 5 * 60_000;
const RELEASE = "release with inbox lease release capture";

type Repo = { common: string; root: string; top: string };
type Row = Record<string, unknown>;
type Who = { leaseId: string; agentId: string; name: string; runId: string | null; runTeamId: string | null; reason: string | null };
type Effects = { notices: Array<[string, string]>; notes: Array<{ runId: string | null; teamId: string | null; detail: Record<string, unknown> }>; changed: boolean };
type Place = { repo: string; root: string; resource: LeaseResource };
type Office = { agents: WorldAgent[]; teams: Team[] };

export interface LeaseOffice {
  state(): Office;
  /** Typed to the agent like any office notice. */
  notify(agentId: string, text: string): void;
  /** herdr answers, so an agent shown without a pane really has none. */
  presence(): boolean;
  /** The pipeline lease telemetry; never consulted by a lease decision. */
  telemetry: { note(kind: "lease", runId: string | null, teamId: string | null, detail: Record<string, unknown>): void } | null;
  repository?: (path: string) => Repo;
}

export interface LeaseInput {
  resource: LeaseResource;
  /** A path inside the repository; the caller's own checkout when omitted. */
  path?: string;
}

const str = (v: unknown): string => (v == null ? "" : String(v));
const opt = (v: unknown): string | null => (v == null ? null : String(v));
const clock = (iso: string): string => `${iso.slice(11, 16)} UTC`;

export class Leases {
  private db: DatabaseSync;
  private office: LeaseOffice;
  private now: () => Date;
  private offlineSince = new Map<string, number>();
  private repos = new Map<string, { at: number; repo: Repo | null }>();
  onChange: () => void = () => {};

  constructor(db: DatabaseSync, office: LeaseOffice, now: () => Date = () => new Date()) {
    this.db = db;
    this.office = office;
    this.now = now;
  }

  /** Granted at once when free; otherwise the caller joins the queue and hears its position. Idempotent. */
  acquire(actor: WorldAgent, input: LeaseInput & { run?: string; reason?: string }): LeaseResult {
    const state = this.office.state();
    const place = this.place(actor, input);
    const run = input.run ? this.runFor(actor, input.run) : null;
    return this.op(state, place, (fx) => {
      const lease = this.lease(place);
      if (str(lease.holder_id) === actor.id || this.entry(place, actor.id)) return;
      const who: Who = { leaseId: `cl_${randomUUID()}`, agentId: actor.id, name: actor.name, runId: run?.id ?? null, runTeamId: run?.teamId ?? null, reason: input.reason?.trim() || null };
      const at = this.now().toISOString();
      if (!lease.holder_id) return this.grant(fx, place, who, at, false);
      this.db.prepare(`INSERT INTO capture_lease_queue (repo, resource, lease_id, agent_id, agent_name, run_id, run_team_id, reason, joined_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(place.repo, place.resource, who.leaseId, who.agentId, who.name, who.runId, who.runTeamId, who.reason, at);
      this.note(fx, place, "join", who, { position: this.queue(place).length });
    }, actor);
  }

  /** Only the holder releases; the next in line is granted and told. */
  release(actor: WorldAgent, input: LeaseInput): LeaseResult {
    const state = this.office.state();
    const place = this.place(actor, input);
    return this.op(state, place, (fx) => {
      const lease = this.lease(place);
      if (str(lease.holder_id) !== actor.id) this.notHolder(place, lease, actor, "release");
      this.note(fx, place, "release", this.holder(lease), { heldMs: this.since(lease.granted_at) });
      this.passOn(fx, place);
    }, actor);
  }

  /** Leaves the queue; nothing to do when not in it. */
  leave(actor: WorldAgent, input: LeaseInput): LeaseResult {
    const state = this.office.state();
    const place = this.place(actor, input);
    return this.op(state, place, (fx) => {
      if (str(this.lease(place).holder_id) === actor.id) throw new InboxError(409, "you hold the capture lease: release it with inbox lease release capture", "lease_held");
      const entry = this.entry(place, actor.id);
      if (entry) this.dropEntry(fx, place, entry, "left");
    }, actor);
  }

  /** The holder extends its hold by the project's limit from now. */
  renew(actor: WorldAgent, input: LeaseInput): LeaseResult {
    const state = this.office.state();
    const place = this.place(actor, input);
    return this.op(state, place, (fx) => {
      const lease = this.lease(place);
      if (str(lease.holder_id) !== actor.id) this.notHolder(place, lease, actor, "renew");
      const expiresAt = new Date(this.now().getTime() + this.holdMs(lease)).toISOString();
      this.db.prepare("UPDATE capture_leases SET expires_at = ? WHERE repo = ? AND resource = ?").run(expiresAt, place.repo, place.resource);
      this.note(fx, place, "renew", this.holder(lease), { expiresAt });
    }, actor);
  }

  /** The repository's lead takes the lease from its holder; holder and queue are told, the next is granted. */
  revoke(actor: WorldAgent, input: LeaseInput & { reason: string }): LeaseResult {
    const state = this.office.state();
    const place = this.place(actor, input);
    this.requireLead(actor, place, state, "revoke");
    const reason = input.reason.trim();
    return this.op(state, place, (fx) => {
      const lease = this.lease(place);
      if (!lease.holder_id) throw new InboxError(409, `nobody holds ${this.project(place)}'s capture lease`, "lease_free");
      const holder = this.holder(lease);
      this.note(fx, place, "revoke", holder, { heldMs: this.since(lease.granted_at), reason, by: actor.name, byAgentId: actor.id });
      if (holder.agentId !== actor.id) fx.notices.push([holder.agentId, `${actor.name} revoked your capture lease on ${this.project(place)}: ${reason}. Stop capturing now; ask again with inbox lease acquire capture when you need it.`]);
      const next = this.passOn(fx, place);
      for (const w of this.queue(place)) {
        fx.notices.push([str(w.agent_id), `${actor.name} revoked ${holder.name}'s capture lease on ${this.project(place)} (${reason}). ${next ? `${next.name} has it now` : "It is free"}; you are #${this.position(place, str(w.agent_id))} in line, and the office tells you when it is yours.`]);
      }
    }, actor);
  }

  /** The repository's lead sets how long a hold lasts; it applies to the next grant or renewal. */
  limit(actor: WorldAgent, input: LeaseInput & { minutes: number }): LeaseResult {
    const state = this.office.state();
    const place = this.place(actor, input);
    this.requireLead(actor, place, state, "set the hold limit");
    if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > MAX_HOLD_MINUTES) throw new InboxError(400, `the hold limit is 1–${MAX_HOLD_MINUTES} minutes`);
    return this.op(state, place, (fx) => {
      this.lease(place);
      this.db.prepare("UPDATE capture_leases SET hold_ms = ? WHERE repo = ? AND resource = ?").run(input.minutes * 60_000, place.repo, place.resource);
      fx.changed = true;
    }, actor);
  }

  status(actor: WorldAgent, input: LeaseInput): LeaseResult {
    const state = this.office.state();
    const place = this.place(actor, input);
    return this.op(state, place, () => {}, actor);
  }

  /** A project's lease for its team panel: read-only (expiry waits for the next sweep), null when never used. */
  forTeam(teamId: string): LeaseView | null {
    const state = this.office.state();
    const team = state.teams.find((t) => t.id === teamId);
    if (!team) throw new InboxError(404, "no such team");
    const repo = [team.path, ...team.worktrees].map((p) => (p ? this.repoOf(p) : null)).find(Boolean);
    if (!repo) return null;
    const place: Place = { repo: repo.common, root: repo.root, resource: "capture" };
    if (!this.db.prepare("SELECT 1 FROM capture_leases WHERE repo = ? AND resource = ?").get(place.repo, place.resource)) return null;
    return this.view(place, state);
  }

  /** Expiry and gone holders/waiters for every lease; the service runs it on its 30 s tick. */
  sweep(): void {
    const places = (this.db.prepare("SELECT repo, root, resource FROM capture_leases WHERE holder_id IS NOT NULL OR EXISTS (SELECT 1 FROM capture_lease_queue q WHERE q.repo = capture_leases.repo AND q.resource = capture_leases.resource)").all() as Row[])
      .map((r) => ({ repo: str(r.repo), root: str(r.root), resource: str(r.resource) as LeaseResource }));
    if (!places.length) return;
    const state = this.office.state();
    const fx: Effects = { notices: [], notes: [], changed: false };
    this.tx(() => { for (const p of places) this.sweepOne(fx, p, state); });
    this.apply(fx);
  }

  // ---------------------------------------------------------------------------------------------

  /** One transaction: this lease's sweep, the change, and the answer; effects only after the commit. */
  private op(state: Office, place: Place, change: (fx: Effects) => void, actor: WorldAgent): LeaseResult {
    const fx: Effects = { notices: [], notes: [], changed: false };
    const out = this.tx(() => {
      this.sweepOne(fx, place, state);
      change(fx);
      return this.result(place, state, actor);
    });
    this.apply(fx);
    return out;
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    let out: T;
    try {
      out = fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return out;
  }

  /** Never throws: a failing telemetry write or notice leaves the committed lease as it is. */
  private apply(fx: Effects): void {
    for (const n of fx.notes) {
      try { this.office.telemetry?.note("lease", n.runId, n.teamId, n.detail); } catch { /* telemetry never blocks a lease */ }
    }
    for (const [agentId, text] of fx.notices) {
      try { this.office.notify(agentId, text); } catch (err) { console.error(`capture lease notice: ${(err as Error).message}`); }
    }
    if (fx.changed || fx.notes.length || fx.notices.length) {
      try { this.onChange(); } catch { /* only a redraw */ }
    }
  }

  private sweepOne(fx: Effects, place: Place, state: Office): void {
    const at = this.now().getTime();
    const lease = this.lease(place);
    for (const w of this.queue(place)) if (this.gone(str(w.agent_id), state, at)) this.dropEntry(fx, place, w, "gone");
    if (lease.holder_id) {
      const holder = this.holder(lease);
      if (this.gone(holder.agentId, state, at)) {
        this.note(fx, place, "release", holder, { heldMs: this.since(lease.granted_at), reason: "gone" });
        this.passOn(fx, place);
      } else if (Date.parse(str(lease.expires_at)) <= at) {
        const minutes = Math.round(this.since(lease.granted_at) / 60_000);
        this.note(fx, place, "expire", holder, { heldMs: this.since(lease.granted_at) });
        const next = this.passOn(fx, place);
        const after = next ? `it passed to ${next.name}` : "it is free";
        fx.notices.push([holder.agentId, `Your capture lease on ${this.project(place)} expired after ${minutes} min without a release or renewal, and ${after}. Stop capturing now; ask again with inbox lease acquire capture.`]);
        const lead = this.leadFor(place, state);
        if (lead && lead.agentId !== holder.agentId) fx.notices.push([lead.agentId, `Capture lease: ${holder.name}'s hold on ${this.project(place)} expired after ${minutes} min without a release; ${after}.`]);
      }
    } else if (this.queue(place).length) {
      this.passOn(fx, place);
    }
  }

  /** The office's offline rule (no pane while herdr answers), held for GONE_MS so a restart or switch does not lose a lease. */
  private gone(agentId: string, state: Office, at: number): boolean {
    if (!this.office.presence()) { this.offlineSince.clear(); return false; }
    const agent = state.agents.find((a) => a.id === agentId);
    if (agent?.paneId && agent.status !== "offline") { this.offlineSince.delete(agentId); return false; }
    const since = this.offlineSince.get(agentId);
    if (since === undefined) { this.offlineSince.set(agentId, at); return false; }
    return at - since >= GONE_MS;
  }

  /** Frees the lease and grants the first in line, telling them; returns who got it. */
  private passOn(fx: Effects, place: Place): Who | null {
    const next = this.db.prepare("SELECT * FROM capture_lease_queue WHERE repo = ? AND resource = ? ORDER BY seq LIMIT 1").get(place.repo, place.resource) as Row | undefined;
    if (!next) {
      this.db.prepare(`UPDATE capture_leases SET lease_id = NULL, holder_id = NULL, holder_name = NULL, run_id = NULL, run_team_id = NULL, reason = NULL,
        queued_at = NULL, granted_at = NULL, expires_at = NULL WHERE repo = ? AND resource = ?`).run(place.repo, place.resource);
      fx.changed = true;
      return null;
    }
    this.db.prepare("DELETE FROM capture_lease_queue WHERE seq = ?").run(Number(next.seq));
    const who = this.waiter(next);
    this.grant(fx, place, who, str(next.joined_at), true);
    return who;
  }

  private grant(fx: Effects, place: Place, who: Who, queuedAt: string, tell: boolean): void {
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.holdMs(this.lease(place))).toISOString();
    this.db.prepare(`UPDATE capture_leases SET lease_id = ?, holder_id = ?, holder_name = ?, run_id = ?, run_team_id = ?, reason = ?,
      queued_at = ?, granted_at = ?, expires_at = ? WHERE repo = ? AND resource = ?`)
      .run(who.leaseId, who.agentId, who.name, who.runId, who.runTeamId, who.reason, queuedAt, now.toISOString(), expiresAt, place.repo, place.resource);
    this.note(fx, place, "grant", who, { waitMs: Math.max(0, now.getTime() - Date.parse(queuedAt)), expiresAt });
    if (tell) {
      const minutes = Math.round(this.holdMs(this.lease(place)) / 60_000);
      fx.notices.push([who.agentId, `Capture lease granted: go ahead; ${RELEASE}. It is ${this.project(place)}'s one headless checker (captures, npm run check, browser tests), yours for ${minutes} min until ${clock(expiresAt)}${who.runId ? ` for run ${who.runId}` : ""}; extend with inbox lease renew capture.`]);
    }
  }

  private dropEntry(fx: Effects, place: Place, entry: Row, reason: "left" | "gone"): void {
    this.db.prepare("DELETE FROM capture_lease_queue WHERE seq = ?").run(Number(entry.seq));
    this.note(fx, place, "leave", this.waiter(entry), { reason, waitedMs: this.since(entry.joined_at) });
  }

  private note(fx: Effects, place: Place, action: string, who: Who, extra: Record<string, unknown>): void {
    fx.notes.push({ runId: who.runId, teamId: who.runTeamId, detail: {
      source: "office", action, lease: who.leaseId, holder: who.name, agentId: who.agentId, resource: place.resource, repo: place.repo, ...(who.reason ? { purpose: who.reason } : {}), ...extra,
    } });
  }

  private notHolder(place: Place, lease: Row, actor: WorldAgent, what: string): never {
    const position = this.position(place, actor.id);
    const holder = lease.holder_id ? `${str(lease.holder_name)} holds it` : "nobody holds it";
    throw new InboxError(403, `only the holder can ${what} ${this.project(place)}'s capture lease, and ${holder}${position ? `; you are #${position} in line (leave with inbox lease leave capture)` : ""}`, "lease_not_holder");
  }

  private requireLead(actor: WorldAgent, place: Place, state: Office, what: string): void {
    const lead = this.leadFor(place, state);
    if (lead?.agentId === actor.id) return;
    throw new InboxError(403, lead ? `only ${lead.name}, the lead for ${this.project(place)}, can ${what} its capture lease` : `nobody leads a standing team for ${this.project(place)} (or its main checkout's project), so nobody can ${what} its capture lease`, "lease_lead_required");
  }

  /**
   * The lead of the standing team working in this repository (its path or a lane in it), such as
   * Mission Control; for a repository without one, the lead of the project at its main checkout.
   */
  private leadFor(place: Place, state: Office): { agentId: string; name: string } | null {
    const inRepo = (t: Team) => [t.path, ...t.worktrees].some((p) => p && this.repoOf(p)?.common === place.repo);
    const team = state.teams.find((t) => t.standing && inRepo(t))
      ?? state.teams.find((t) => !t.standing && t.path && this.repoOf(t.path)?.common === place.repo && this.repoOf(t.path)?.top === place.root);
    const lead = team ? state.agents.find((a) => a.teamId === team.id && a.role === "lead") : undefined;
    return lead ? { agentId: lead.id, name: lead.name } : null;
  }

  private runFor(actor: WorldAgent, runId: string): { id: string; teamId: string } {
    const row = this.db.prepare("SELECT team_id, snapshot FROM pipeline_runs WHERE id = ?").get(runId) as Row | undefined;
    if (!row) throw new InboxError(404, `no pipeline run ${runId}`, "lease_run_unknown");
    let teamId = str(row.team_id);
    try { teamId = str((JSON.parse(str(row.snapshot)) as { teamId?: string }).teamId) || teamId; } catch { /* the column says */ }
    if (!actor.teamId || teamId !== actor.teamId) throw new InboxError(403, `run ${runId} belongs to another team`, "lease_run_other_team");
    return { id: runId, teamId };
  }

  private place(actor: WorldAgent, input: LeaseInput): Place {
    const at = input.path ?? actor.cwd;
    if (!at) throw new InboxError(400, "run this inside a checkout of the project, or pass --repo PATH", "lease_repo_unknown");
    const repo = this.repoOf(at);
    if (!repo) throw new InboxError(409, `${at} is not inside a Git checkout`, "lease_repo_unknown");
    return { repo: repo.common, root: repo.root, resource: input.resource };
  }

  private repoOf(path: string): Repo | null {
    const at = this.now().getTime();
    const known = this.repos.get(path);
    if (known && at - known.at < REPO_CACHE_MS) return known.repo;
    let repo: Repo | null = null;
    try { repo = existsSync(path) ? (this.office.repository ?? repository)(path) : null; } catch { repo = null; }
    this.repos.set(path, { at, repo });
    return repo;
  }

  private lease(place: Place): Row {
    this.db.prepare("INSERT OR IGNORE INTO capture_leases (repo, resource, root) VALUES (?, ?, ?)").run(place.repo, place.resource, place.root);
    return this.db.prepare("SELECT * FROM capture_leases WHERE repo = ? AND resource = ?").get(place.repo, place.resource) as Row;
  }

  private queue(place: Place): Row[] {
    return this.db.prepare("SELECT * FROM capture_lease_queue WHERE repo = ? AND resource = ? ORDER BY seq").all(place.repo, place.resource) as Row[];
  }

  private entry(place: Place, agentId: string): Row | undefined {
    return this.db.prepare("SELECT * FROM capture_lease_queue WHERE repo = ? AND resource = ? AND agent_id = ?").get(place.repo, place.resource, agentId) as Row | undefined;
  }

  private position(place: Place, agentId: string): number | null {
    const i = this.queue(place).findIndex((w) => str(w.agent_id) === agentId);
    return i < 0 ? null : i + 1;
  }

  private holder(lease: Row): Who {
    return { leaseId: str(lease.lease_id), agentId: str(lease.holder_id), name: str(lease.holder_name), runId: opt(lease.run_id), runTeamId: opt(lease.run_team_id), reason: opt(lease.reason) };
  }

  private waiter(row: Row): Who {
    return { leaseId: str(row.lease_id), agentId: str(row.agent_id), name: str(row.agent_name), runId: opt(row.run_id), runTeamId: opt(row.run_team_id), reason: opt(row.reason) };
  }

  private holdMs(lease: Row): number {
    return lease.hold_ms == null ? DEFAULT_HOLD_MINUTES * 60_000 : Number(lease.hold_ms);
  }

  private since(iso: unknown): number {
    return Math.max(0, this.now().getTime() - Date.parse(str(iso)));
  }

  private project(place: Place): string {
    return basename(place.root);
  }

  private view(place: Place, state: Office): LeaseView {
    const lease = this.lease(place);
    const name = (id: string, stored: string) => state.agents.find((a) => a.id === id)?.name ?? stored;
    return {
      resource: place.resource, repo: place.repo, root: place.root, project: this.project(place),
      holder: lease.holder_id ? { agentId: str(lease.holder_id), name: name(str(lease.holder_id), str(lease.holder_name)), leaseId: str(lease.lease_id),
        since: str(lease.granted_at), expiresAt: str(lease.expires_at), runId: opt(lease.run_id), reason: opt(lease.reason) } : null,
      queue: this.queue(place).map((w, i) => ({ agentId: str(w.agent_id), name: name(str(w.agent_id), str(w.agent_name)), leaseId: str(w.lease_id),
        position: i + 1, since: str(w.joined_at), runId: opt(w.run_id), reason: opt(w.reason) })),
      holdMinutes: Math.round(this.holdMs(lease) / 60_000),
      lead: this.leadFor(place, state),
    };
  }

  private result(place: Place, state: Office, actor: WorldAgent): LeaseResult {
    const view = this.view(place, state);
    const mine = view.holder?.agentId === actor.id;
    const waiting = view.queue.find((w) => w.agentId === actor.id);
    const you: LeaseResult["you"] = mine ? { state: "held", position: null, leaseId: view.holder!.leaseId }
      : waiting ? { state: "queued", position: waiting.position, leaseId: waiting.leaseId } : { state: "none", position: null, leaseId: null };
    const line = (w: { name: string; runId: string | null }) => `${w.name}${w.runId ? ` (run ${w.runId})` : ""}`;
    const queue = view.queue.length ? ` In line: ${view.queue.map((w) => `${w.position}. ${line(w)}`).join(", ")}.` : " Nobody is waiting.";
    const held = view.holder ? `${line(view.holder)} holds ${view.project}'s capture lease since ${clock(view.holder.since)}, until ${clock(view.holder.expiresAt)}.` : `${view.project}'s capture lease is free.`;
    const text = mine
      ? `You hold ${view.project}'s capture lease (since ${clock(view.holder!.since)}, until ${clock(view.holder!.expiresAt)}${view.holder!.runId ? `, run ${view.holder!.runId}` : ""}): go ahead; ${RELEASE} as soon as you are done, or extend with inbox lease renew capture.${queue}`
      : waiting
        ? `${held} You are #${waiting.position} in line: do not capture or run checks yet; the office tells you when it is yours.${queue}`
        : `${held}${queue}`;
    return { ...view, you, text: `${text} Hold limit ${view.holdMinutes} min${view.lead ? `; lead ${view.lead.name}` : ""}.` };
  }
}
