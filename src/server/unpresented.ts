// Deterministic presentation bookkeeping. Git is polled once a minute and rechecked before sending; reminders use
// office presence, never a model's judgement. Reminder history survives a service restart.
import type { DatabaseSync } from "node:sqlite";
import type { WorldState } from "../shared/types.ts";
import { checkoutOf, git } from "./worktrees.ts";

export function migrateUnpresented(db: DatabaseSync): void {
  const columns = new Set((db.prepare("PRAGMA table_info(items)").all() as Array<{ name: string }>).map((c) => c.name));
  if (!columns.has("presented_head")) db.exec("ALTER TABLE items ADD COLUMN presented_head TEXT");
  if (!columns.has("presented_path")) db.exec("ALTER TABLE items ADD COLUMN presented_path TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS items_presented ON items (presented_path, presented_head, state)");
  db.exec(`CREATE TABLE IF NOT EXISTS unpresented_work (
    path TEXT PRIMARY KEY, presented_head TEXT,
    reminded_head TEXT, reminded_at INTEGER, reminded_lead TEXT, reminded_message INTEGER
  )`);
}

export interface PresentedPoint { path: string; head: string }
/** A subfolder still means its whole worktree. Missing/deleted repositories do not break posting. */
export function presentedPoint(path: string | null): PresentedPoint | null {
  const checkout = path ? checkoutOf(path) : null;
  if (!checkout?.linked) return null;
  try { return { path: checkout.top, head: git(checkout.top, ["rev-parse", "HEAD"]) }; }
  catch { return null; }
}

/** Called inside submission's transaction, including revisions; the latest submission wins. */
export function recordPresented(db: DatabaseSync, itemId: string, point: PresentedPoint | null, advance = true): void {
  db.prepare("UPDATE items SET presented_head = ?, presented_path = ? WHERE id = ?").run(point?.head ?? null, point?.path ?? null, itemId);
  if (point && advance) db.prepare(`INSERT INTO unpresented_work (path, presented_head) VALUES (?, ?)
    ON CONFLICT(path) DO UPDATE SET presented_head = excluded.presented_head`).run(point.path, point.head);
}

type History = { presented_head: string | null; reminded_head: string | null; reminded_at: number | null; reminded_lead: string | null; reminded_message: number | null };
type Sample = { head: string; count: number; latest: string };
const MINUTE = 60_000;

export class Unpresented {
  private db: DatabaseSync;
  private samples = new Map<string, { at: number; key: string; value: Sample }>();
  private idle = new Map<string, { lead: string; since: number }>();
  constructor(db: DatabaseSync) { this.db = db; }

  private history(path: string): History | undefined {
    return this.db.prepare("SELECT * FROM unpresented_work WHERE path = ?").get(path) as History | undefined;
  }

  count(path: string | null): number { return path ? this.samples.get(path)?.value.count ?? 0 : 0; }

  /** Count HEAD minus both base and presented ancestry (not a linear timestamp comparison).
   * Include base and presented HEAD in the cache key: merges and a new presentation clear it too. */
  sample(path: string, now: number, force = false): Sample | null {
    const previous = this.samples.get(path);
    const presented = this.history(path)?.presented_head ?? "";
    if (!force && previous && now - previous.at < MINUTE && previous.key.endsWith(`:${presented}`)) return previous.value;
    try {
      const checkout = checkoutOf(path);
      if (!checkout?.linked) { this.samples.delete(path); return null; }
      const head = git(path, ["rev-parse", "HEAD"]);
      const base = git(checkout.repoRoot, ["rev-parse", "HEAD"]);
      const key = `${head}:${base}:${presented}`;
      if (previous?.key === key) { previous.at = now; return previous.value; }
      // A pruned old presented commit must not prevent detecting new work after a rewrite.
      let known = false;
      if (presented) { try { git(path, ["cat-file", "-e", `${presented}^{commit}`]); known = true; } catch {} }
      const range = [head, "--not", base, ...(known ? [presented] : [])];
      const count = Number(git(path, ["rev-list", "--count", ...range]));
      const latest = count ? git(path, ["log", "-1", "--format=%h %s", ...range]) : "";
      const value = { head, count, latest };
      this.samples.set(path, { at: now, key, value });
      return value;
    } catch { this.samples.delete(path); return null; }
  }

  /** Called by office reactions and the existing 30-second poll. Returns whether counts changed. */
  tick(state: WorldState, now: number, notice: (leadId: string, text: string) => void): boolean {
    let changed = false;
    const active = new Set<string>();
    for (const team of state.teams) {
      if (team.standing || !team.path) continue;
      active.add(team.path);
      const before = this.count(team.path);
      let sample = this.sample(team.path, now);
      changed ||= before !== this.count(team.path);
      const lead = state.agents.find((a) => a.teamId === team.id && a.role === "lead");
      if (!lead || !["idle", "done"].includes(lead.status) || lead.waitingOnYou || team.status === "blocked") {
        this.idle.delete(team.path);
        continue;
      }
      let idle = this.idle.get(team.path);
      if (idle?.lead !== lead.id) { idle = { lead: lead.id, since: now }; this.idle.set(team.path, idle); }
      if (!sample?.count || now - idle.since < 5 * MINUTE) continue;
      const history = this.history(team.path);
      if (history?.reminded_at != null && now - history.reminded_at < 30 * MINUTE) continue;
      // Revalidate before sending: HEAD may have changed inside the polling window, followed
      // by an open decision (which does not move the presented point or invalidate the cache).
      const fresh = this.sample(team.path, now, true);
      changed ||= sample.count !== (fresh?.count ?? 0);
      sample = fresh;
      if (!sample?.count) continue;
      // Snoozed items are still unanswered. Decisions at HEAD also suppress reminders.
      if (this.db.prepare(`SELECT 1 FROM items WHERE presented_path = ? AND presented_head = ?
          AND state IN ('needs_attention', 'snoozed') LIMIT 1`).get(team.path, sample.head)) continue;
      if (history?.reminded_head === sample.head && history.reminded_message != null && this.db.prepare(
        "SELECT 1 FROM messages WHERE to_founder = 1 AND from_agent_id = ? AND rowid > ? LIMIT 1",
      ).get(history.reminded_lead, history.reminded_message)) continue;
      // Save the guard before enqueueing: enqueue broadcasts and can re-enter office reactions.
      const lastMessage = Number((this.db.prepare("SELECT coalesce(max(rowid), 0) AS n FROM messages").get() as { n: number }).n);
      this.db.prepare(`INSERT INTO unpresented_work (path, reminded_head, reminded_at, reminded_lead, reminded_message) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET reminded_head = excluded.reminded_head, reminded_at = excluded.reminded_at,
        reminded_lead = excluded.reminded_lead, reminded_message = excluded.reminded_message`)
        .run(team.path, sample.head, now, lead.id, lastMessage);
      notice(lead.id, `Unpresented work: ${sample.count} ${sample.count === 1 ? "commit" : "commits"} since you last showed the founder (${sample.latest}). Put it in front of the founder now with inbox milestone, even if the project is not finished (--screenshot, --page, or --video), or tell them in one line with inbox say founder why it is not ready yet.`);
    }
    for (const path of this.idle.keys()) if (!active.has(path)) this.idle.delete(path);
    for (const path of this.samples.keys()) if (!active.has(path)) this.samples.delete(path);
    return changed;
  }
}
