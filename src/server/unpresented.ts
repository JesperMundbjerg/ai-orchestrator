// Deterministic presentation bookkeeping. Git is polled once a minute and rechecked before sending; reminders use
// office presence, never a model's judgement. Reminder history survives a service restart.
import type { DatabaseSync } from "node:sqlite";
import type { WorldAgent, WorldState, WorldTeam } from "../shared/types.ts";
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
  db.exec(`CREATE TABLE IF NOT EXISTS whole_team_idle (
    path TEXT PRIMARY KEY, members TEXT, message_after INTEGER,
    notified INTEGER NOT NULL DEFAULT 0, reminded_at INTEGER
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
type TeamIdleHistory = { members: string | null; message_after: number | null; notified: number; reminded_at: number | null };
const MINUTE = 60_000;
const WHOLE_TEAM_IDLE = "Your whole team has been idle for 5 minutes. If the work is done, present it now (inbox milestone). If you are waiting for something from the founder, ask for it (inbox decide, with options or an open question). Otherwise tell the founder in one line what happens next (inbox say founder).";

export class Unpresented {
  private db: DatabaseSync;
  private samples = new Map<string, { at: number; key: string; value: Sample }>();
  private idle = new Map<string, { lead: string; since: number }>();
  private teamIdle = new Map<string, { members: string; since: number }>();
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

  private lastMessage(): number {
    return Number((this.db.prepare("SELECT coalesce(max(rowid), 0) AS n FROM messages").get() as { n: number }).n);
  }

  private saidToFounder(lead: string | null, after: number): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM messages WHERE to_founder = 1 AND from_agent_id = ? AND rowid > ? LIMIT 1").get(lead, after));
  }

  private teamHistory(path: string): TeamIdleHistory | undefined {
    return this.db.prepare("SELECT * FROM whole_team_idle WHERE path = ?").get(path) as TeamIdleHistory | undefined;
  }

  /** Observe every member, including offline/unknown ones. Only observed work rearms the
   * durable latch; a prompt, founder answer, changed crew or restart must not send it again. */
  private wholeTeamReady(team: WorldTeam, path: string, members: WorldAgent[], now: number): boolean {
    const lead = members.find((a) => a.role === "lead");
    if (members.some((a) => a.status === "working")) this.db.prepare("UPDATE whole_team_idle SET notified = 0 WHERE path = ? AND notified = 1").run(path);
    if (!lead || team.status === "blocked" || members.some((a) => !["idle", "done"].includes(a.status) || a.waitingOnYou)) {
      this.teamIdle.delete(path);
      this.db.prepare("UPDATE whole_team_idle SET members = NULL, message_after = NULL WHERE path = ? AND members IS NOT NULL").run(path);
      return false;
    }
    const key = members.map((a) => `${a.id}:${a.role}`).sort().join(",");
    let history = this.teamHistory(path);
    if (history?.members !== key) {
      this.db.prepare(`INSERT INTO whole_team_idle (path, members, message_after) VALUES (?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET members = excluded.members, message_after = excluded.message_after`)
        .run(path, key, this.lastMessage());
      history = this.teamHistory(path)!;
    }
    let idle = this.teamIdle.get(path);
    if (idle?.members !== key) { idle = { members: key, since: now }; this.teamIdle.set(path, idle); }
    // A restart begins five fresh minutes of observation but retains the episode's response
    // cutoff and notification latch, so neither an explanation nor a reminder is forgotten.
    if (history!.notified || now - idle.since < 5 * MINUTE || this.saidToFounder(lead.id, history!.message_after!)) return false;
    const taskIds = new Set(members.flatMap((a) => a.taskIds));
    const open = this.db.prepare(`SELECT i.presented_path, i.task_id, t.cwd FROM items i JOIN tasks t ON t.id = i.task_id
      WHERE i.state IN ('needs_attention', 'snoozed')`).all() as Array<{ presented_path: string | null; task_id: string; cwd: string | null }>;
    // Captured project wins; legacy items without a point are matched by membership or cwd.
    return !open.some((i) => i.presented_path ? i.presented_path === path
      : taskIds.has(i.task_id) || i.cwd === path || i.cwd?.startsWith(`${path}/`));
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
      const members = state.agents.filter((a) => a.teamId === team.id);
      const wholeTeam = this.wholeTeamReady(team, team.path, members, now);
      const lead = members.find((a) => a.role === "lead");
      if (!lead || !["idle", "done"].includes(lead.status) || lead.waitingOnYou || team.status === "blocked") {
        this.idle.delete(team.path);
        continue;
      }
      let idle = this.idle.get(team.path);
      if (idle?.lead !== lead.id) { idle = { lead: lead.id, since: now }; this.idle.set(team.path, idle); }
      if ((!sample?.count && !wholeTeam) || now - idle.since < 5 * MINUTE) continue;
      const history = this.history(team.path);
      const lastReminder = Math.max(history?.reminded_at ?? -Infinity, this.teamHistory(team.path)?.reminded_at ?? -Infinity);
      if (now - lastReminder < 30 * MINUTE) continue;
      const reasons: string[] = wholeTeam ? [WHOLE_TEAM_IDLE] : [];
      if (sample?.count || wholeTeam) {
        // Revalidate before sending: a decision or new commit may have appeared inside the
        // polling window. A whole-team reminder must include newly unpresented work too.
        const fresh = this.sample(team.path, now, true);
        changed ||= (sample?.count ?? 0) !== (fresh?.count ?? 0);
        sample = fresh;
        const openAtHead = sample && this.db.prepare(`SELECT 1 FROM items WHERE presented_path = ? AND presented_head = ?
          AND state IN ('needs_attention', 'snoozed') LIMIT 1`).get(team.path, sample.head);
        const explained = history?.reminded_head === sample?.head && history?.reminded_message != null
          && this.saidToFounder(history.reminded_lead, history.reminded_message);
        if (sample?.count && !openAtHead && !explained) {
          this.db.prepare(`INSERT INTO unpresented_work (path, reminded_head, reminded_at, reminded_lead, reminded_message) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET reminded_head = excluded.reminded_head, reminded_at = excluded.reminded_at,
            reminded_lead = excluded.reminded_lead, reminded_message = excluded.reminded_message`)
            .run(team.path, sample.head, now, lead.id, this.lastMessage());
          reasons.push(`Unpresented work: ${sample.count} ${sample.count === 1 ? "commit" : "commits"} since you last showed the founder (${sample.latest}). Put it in front of the founder now with inbox milestone, even if the project is not finished (--screenshot, --page, or --video), or tell them in one line with inbox say founder why it is not ready yet.`);
        }
      }
      // Set both guards before enqueueing: its broadcast may re-enter office reactions.
      if (wholeTeam) this.db.prepare("UPDATE whole_team_idle SET notified = 1, reminded_at = ? WHERE path = ?").run(now, team.path);
      if (reasons.length) notice(lead.id, reasons.join("\n\n"));
    }
    for (const path of this.idle.keys()) if (!active.has(path)) this.idle.delete(path);
    for (const path of this.samples.keys()) if (!active.has(path)) this.samples.delete(path);
    for (const path of this.teamIdle.keys()) if (!active.has(path)) this.teamIdle.delete(path);
    return changed;
  }
}
