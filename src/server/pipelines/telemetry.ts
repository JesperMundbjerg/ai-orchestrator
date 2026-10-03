import type { DatabaseSync } from "node:sqlite";
import type { PipelineDecisionWait, PipelineRun, PipelineTelemetryEvent, PipelineTelemetryQuery, PipelineTelemetryView } from "../../shared/pipeline.ts";

type Kind = PipelineTelemetryEvent["kind"];
type Entry = { kind: Kind | "started"; runId: string | null; teamId: string | null; detail: Record<string, unknown>; at: string };

const PREFIX = "pipeline.telemetry.";
/** Notes waiting for a flush; past this they are counted as dropped, never held up. */
const QUEUE_LIMIT = 500;
/** Telemetry rows kept in events; older ones are pruned. */
const KEEP = 20_000;
/** The same gate result again within this window bumps `repeats` on its row instead of adding one. */
const REPEAT_MS = 10 * 60_000;
const PUBLISHING = new Set(["push", "land", "publish"]);
/** The detail fields' version; bumped when a kind's fields change meaning. */
export const TELEMETRY_SCHEMA = 1;
const STARTED = `${PREFIX}started`;

/**
 * Delivery telemetry, written to events as `pipeline.telemetry.*`. It is never a delivery gate:
 * note() only queues (no I/O, never throws), and the queue is written after the caller's
 * transaction, so a refusal survives the rollback of the request it refused, and a failing write
 * is counted as dropped instead of changing, delaying or aborting anything.
 */
export class PipelineTelemetry {
  private db: DatabaseSync;
  private now: () => Date;
  private queue: Entry[] = [];
  private scheduled = false;
  private recent = new Map<string, { id: number; at: number }>();
  private inserts = 0;
  private queueLimit: number;
  private keep: number;
  dropped = 0;
  constructor(db: DatabaseSync, now: () => Date, limits: { queue?: number; keep?: number } = {}) {
    this.db = db; this.now = now; this.queueLimit = limits.queue ?? QUEUE_LIMIT; this.keep = limits.keep ?? KEEP;
    // Coverage starts when this office first runs with telemetry: one marker, written once and never pruned.
    this.queue.push({ kind: "started", runId: null, teamId: null, detail: { schemaVersion: TELEMETRY_SCHEMA }, at: now().toISOString() }); this.schedule();
  }
  private schedule(): void {
    if (!this.scheduled) { this.scheduled = true; setImmediate(() => { this.scheduled = false; this.flush(); }); }
  }

  note(kind: Kind, runId: string | null, teamId: string | null, detail: Record<string, unknown>): void {
    try {
      if (this.queue.length >= this.queueLimit) { this.dropped++; return; }
      this.queue.push({ kind, runId, teamId, detail, at: this.now().toISOString() }); this.schedule();
    } catch { this.dropped++; }
  }

  /** Writes what is queued. Never throws; inside someone's transaction it waits for the next tick. */
  flush(): void {
    try {
      if (this.db.isTransaction) { if (!this.scheduled) { this.scheduled = true; setTimeout(() => { this.scheduled = false; this.flush(); }, 20); } return; }
    } catch { this.dropped += this.queue.length; this.queue = []; return; }
    for (let entry = this.queue.shift(); entry; entry = this.queue.shift()) {
      try { this.write(entry); } catch { this.dropped++; }
    }
    try { if (this.inserts >= Math.min(200, this.keep)) { this.inserts = 0; this.prune(); } } catch { /* retried after the next batch */ }
  }

  private insert(entry: Entry, kind: Kind | "started", detail: Record<string, unknown>): number {
    this.inserts++;
    const row = this.db.prepare("INSERT INTO events (at, actor, task_id, item_id, kind, detail) VALUES (?, 'office', NULL, NULL, ?, ?)")
      .run(entry.at, PREFIX + kind, JSON.stringify({ runId: entry.runId, teamId: entry.teamId, ...detail }));
    return Number(row.lastInsertRowid);
  }

  private write(entry: Entry): void {
    if (entry.kind === "started") { if (!this.db.prepare("SELECT id FROM events WHERE kind = ? LIMIT 1").get(STARTED)) this.insert(entry, "started", entry.detail); return; }
    if (entry.kind === "gate" || entry.kind === "lease" || entry.kind === "attempt") {
      const key = JSON.stringify([entry.kind, entry.runId, entry.detail]); const at = Date.parse(entry.at); const seen = this.recent.get(key);
      const bumped = seen && at - seen.at < REPEAT_MS && this.db.prepare("UPDATE events SET detail = json_set(detail, '$.repeats', coalesce(json_extract(detail, '$.repeats'), 1) + 1, '$.lastAt', ?) WHERE id = ?").run(entry.at, seen.id).changes;
      if (!bumped) {
        if (this.recent.size > 1000) this.recent.clear();
        this.recent.set(key, { id: this.insert(entry, entry.kind, { ...entry.detail, repeats: 1 }), at });
      }
      if (entry.kind !== "gate") return;
      const d = entry.detail;
      if (entry.runId && d.outcome === "allowed" && d.delivery === "dev" && PUBLISHING.has(String(d.operation))
        && !this.pending(entry.runId).some(p => p.detail.candidate === d.candidate)) {
        this.insert(entry, "publication", { state: "pending", round: d.round, candidate: d.candidate, operation: d.operation, ref: d.ref });
      }
      return;
    }
    if (entry.kind === "publication" && entry.runId) {
      // A resolution closes the run's open pending publications (of one candidate, when named); with none open it records nothing.
      const at = Date.parse(entry.at);
      for (const p of this.pending(entry.runId)) if (entry.detail.candidate === undefined || p.detail.candidate === entry.detail.candidate) {
        this.insert(entry, "publication", { ...entry.detail, state: "resolved", candidate: p.detail.candidate, pendingId: p.id, pendingSince: p.at, waitMs: at - Date.parse(p.at) });
      }
      return;
    }
    this.insert(entry, entry.kind, entry.detail);
  }

  /** A run's publications allowed by a gate and not yet resolved. */
  private pending(runId: string): { id: number; at: string; detail: Record<string, unknown> }[] {
    const rows = this.db.prepare(`SELECT id, at, detail FROM events WHERE kind = '${PREFIX}publication' AND json_extract(detail, '$.runId') = ? ORDER BY id`).all(runId)
      .map(r => ({ id: Number(r.id), at: String(r.at), detail: JSON.parse(String(r.detail)) as Record<string, unknown> }));
    const resolved = new Set(rows.filter(r => r.detail.state === "resolved").map(r => r.detail.pendingId));
    return rows.filter(r => r.detail.state === "pending" && !resolved.has(r.id));
  }

  private prune(): void {
    const edge = this.db.prepare(`SELECT id FROM events WHERE kind LIKE '${PREFIX}%' AND kind != '${STARTED}' ORDER BY id DESC LIMIT 1 OFFSET ${this.keep}`).get();
    if (edge) this.db.prepare(`DELETE FROM events WHERE kind LIKE '${PREFIX}%' AND kind != '${STARTED}' AND id <= ?`).run(Number(edge.id));
  }

  /** Read-only: recorded telemetry, newest first, and the decision waits of the runs asked about. */
  read(query: PipelineTelemetryQuery): PipelineTelemetryView {
    const where = [`kind LIKE '${PREFIX}%'`, `kind != '${STARTED}'`]; const args: string[] = [];
    if (query.kind) { where.push("kind = ?"); args.push(PREFIX + query.kind); }
    if (query.runId) { where.push("json_extract(detail, '$.runId') = ?"); args.push(query.runId); }
    if (query.teamId) { where.push("json_extract(detail, '$.teamId') = ?"); args.push(query.teamId); }
    if (query.since) { where.push("at >= ?"); args.push(query.since); }
    const limit = Math.min(Math.max(query.limit ?? 200, 1), 1000);
    const events = this.db.prepare(`SELECT id, at, kind, detail FROM events WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ${limit}`).all(...args).map(r => {
      const { runId = null, teamId = null, ...detail } = JSON.parse(String(r.detail)) as Record<string, unknown>;
      return { id: Number(r.id), at: String(r.at), kind: String(r.kind).slice(PREFIX.length) as Kind, runId: runId as string | null, teamId: teamId as string | null, detail };
    });
    const started = this.db.prepare("SELECT at, detail FROM events WHERE kind = ? ORDER BY id LIMIT 1").get(STARTED);
    return { coverageStartedAt: started ? String(started.at) : null, coverageSchemaVersion: started ? Number((JSON.parse(String(started.detail)) as { schemaVersion?: number }).schemaVersion) : null, schemaVersion: TELEMETRY_SCHEMA, events, decisionWaits: query.kind ? [] : this.decisionWaits(query, limit), dropped: this.dropped };
  }

  /**
   * Derived, not logged: each founder approval item a run presented waits from its revision's
   * creation to the founder's first Accept or Needs changes on that revision. A discussion
   * message is not an answer. Read straight from the stored run, so reading never closes a run.
   * Derived from history, so it is valid before the coverage marker too.
   */
  private decisionWaits(query: PipelineTelemetryQuery, limit: number): PipelineDecisionWait[] {
    const where: string[] = []; const args: string[] = [];
    if (query.runId) { where.push("b.run_id = ?"); args.push(query.runId); }
    if (query.teamId) { where.push("p.ledger_team_id = ?"); args.push(query.teamId); }
    if (query.since) { where.push("COALESCE(v.created_at, i.created_at) >= ?"); args.push(query.since); }
    const rows = this.db.prepare(`SELECT b.item_id, b.revision, b.run_id, p.snapshot, i.type, i.blocking, COALESCE(v.created_at, i.created_at) AS since
      FROM pipeline_item_bindings b JOIN items i ON i.id = b.item_id JOIN pipeline_runs p ON p.id = b.run_id
      LEFT JOIN item_revisions v ON v.item_id = b.item_id AND v.revision = b.revision
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY since DESC LIMIT ${limit}`).all(...args);
    return rows.map(r => {
      const itemId = String(r.item_id); const revision = Number(r.revision); const since = String(r.since);
      const run = JSON.parse(String(r.snapshot)) as PipelineRun;
      const step = run.steps.find(s => s.evidence.some(e => e.approval?.itemId === itemId && e.approval.revision === revision));
      const reply = this.db.prepare("SELECT id, action, created_at FROM replies WHERE item_id = ? AND revision = ? AND action IN ('accept', 'request_changes') ORDER BY created_at, rowid LIMIT 1").get(itemId, revision);
      const automatic = Boolean(reply && this.db.prepare("SELECT id FROM events WHERE kind = 'reply.queued' AND actor = 'system' AND json_extract(detail, '$.deliveryId') = ?").get(String(reply.id)));
      const answeredAt = reply ? String(reply.created_at) : null;
      return { runId: String(r.run_id), itemId, revision, type: String(r.type), blocking: Boolean(r.blocking), stepId: step?.nodeId ?? null, waitingSince: since,
        answeredAt, action: reply ? reply.action as "accept" | "request_changes" : null, automatic, waitMs: answeredAt ? Date.parse(answeredAt) - Date.parse(since) : null };
    });
  }
}
