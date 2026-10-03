// The founder-only exact-SHA repair waiver. An agent (the lead, or anyone on a team with no lead
// online) asks; the founder sees one inbox decision naming the repository, the target ref, the
// exact commit, its diff against the target and the reason. Only the founder's own "Allow" grants
// it: approve-all never answers it and a message never revokes it. A grant allows exactly that
// commit to exactly that ref in that repository, once, while the ref still points where the diff
// was taken from, for 24 hours. Delivery that names no pipeline run asks this module, never the
// run gate. Every step is an event. The table is the record: rows are never deleted.
import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { Inbox } from "../inbox.ts";
import { InboxError } from "../inbox.ts";
import { requestFingerprint } from "../db.ts";
import type { WorldAgent, WorldState } from "../../shared/types.ts";
import type { PipelineWaiver, WaiverGateInput, WaiverGateResult, WaiverRequestInput, WaiverState } from "../../shared/waiver.ts";
import { git, repository } from "./candidate.ts";

/** An unanswered request, and a granted waiver, each lapse after this long. */
export const WAIVER_TTL_MS = 24 * 60 * 60_000;
/** After its first allowed gate call, the same delivery's later boundaries (tool preflight, then Git's pre-push, or land then publish) stay allowed this long. */
export const WAIVER_FOLLOW_UP_MS = 15 * 60_000;
/** The founder sees the whole diff stat, and the diff itself up to this many characters. */
const DIFF_SHOWN = 40_000;
const ALLOW = "allow";
const REFUSE = "refuse";

/** Migration 11: the waiver ledger. Appended to MIGRATIONS; never part of adoptLegacy. */
export function migrateWaivers(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS pipeline_waivers (
    id TEXT PRIMARY KEY, repo_common TEXT NOT NULL, repo_root TEXT NOT NULL,
    ref TEXT NOT NULL, target_ref TEXT NOT NULL, candidate TEXT NOT NULL, base TEXT NOT NULL,
    diff_stat TEXT NOT NULL, diff_sha256 TEXT NOT NULL, reason TEXT NOT NULL,
    requested_by TEXT NOT NULL, requested_team_id TEXT, requester_role TEXT NOT NULL CHECK (requester_role IN ('lead', 'crew')),
    client_id TEXT NOT NULL, fingerprint TEXT NOT NULL, item_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('requested', 'granted', 'refused', 'used', 'expired')),
    requested_at TEXT NOT NULL, decided_at TEXT, decided_reply TEXT, expires_at TEXT NOT NULL,
    used_at TEXT, used_by TEXT, used_until TEXT,
    UNIQUE (requested_by, client_id)
  );
  CREATE INDEX IF NOT EXISTS pipeline_waivers_target ON pipeline_waivers (repo_common, ref, candidate);
  CREATE INDEX IF NOT EXISTS pipeline_waivers_item ON pipeline_waivers (item_id);`);
}

/** Whether an inbox item is a waiver request: approve-all must leave it for the founder. */
export function isWaiverItem(db: DatabaseSync, itemId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM pipeline_waivers WHERE item_id = ?").get(itemId));
}

/** The office's own inbox session for one repository's waiver requests; never typed anywhere. */
export function waiverSession(repoCommon: string) {
  return { harness: "manual", sessionId: `office:waivers:${createHash("sha256").update(repoCommon).digest("hex").slice(0, 16)}` } as const;
}

/** `dev`, `refs/heads/dev`, `origin/dev` and `refs/remotes/origin/dev` all name the branch `dev`. */
export function waiverRef(ref: string): string {
  const name = ref.trim().replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/origin\//, "").replace(/^origin\//, "");
  if (!name || name.startsWith("-") || !/^[\w./-]+$/.test(name) || name.includes("..")) throw new InboxError(400, "name the target as a simple branch, such as dev");
  return name;
}

type Row = Record<string, unknown>;
const text = (v: unknown): string | null => (v == null ? null : String(v));
function toWaiver(r: Row): PipelineWaiver {
  return {
    id: String(r.id), repoCommon: String(r.repo_common), repoRoot: String(r.repo_root), ref: String(r.ref), targetRef: String(r.target_ref),
    candidate: String(r.candidate), base: String(r.base), diffStat: String(r.diff_stat), diffSha256: String(r.diff_sha256), reason: String(r.reason),
    requestedBy: String(r.requested_by), requestedTeamId: text(r.requested_team_id), requesterRole: r.requester_role === "lead" ? "lead" : "crew",
    itemId: text(r.item_id), state: String(r.state) as WaiverState, requestedAt: String(r.requested_at), decidedAt: text(r.decided_at),
    decidedReply: text(r.decided_reply), expiresAt: String(r.expires_at), usedAt: text(r.used_at), usedBy: text(r.used_by), usedUntil: text(r.used_until),
  };
}
const short = (sha: string) => sha.slice(0, 10);

export class Waivers {
  private db: DatabaseSync;
  private world: () => WorldState;
  private now: () => Date;
  /** The service redraws on this. */
  changed: () => void = () => {};
  /** The inbox the founder's decisions live in; the service wires it in. */
  inbox: Pick<Inbox, "submit" | "acknowledge" | "closeItem" | "item"> | null = null;

  constructor(db: DatabaseSync, world: () => WorldState, now: () => Date = () => new Date()) {
    this.db = db; this.world = world; this.now = now;
  }

  private event(actor: "agent" | "user" | "system", kind: string, waiver: PipelineWaiver, detail: Record<string, unknown> = {}): void {
    this.db.prepare("INSERT INTO events (at, actor, task_id, item_id, kind, detail) VALUES (?, ?, NULL, ?, ?, ?)")
      .run(this.now().toISOString(), actor, waiver.itemId, `pipeline.waiver.${kind}`, JSON.stringify({ waiverId: waiver.id, repo: waiver.repoRoot, ref: waiver.ref, candidate: waiver.candidate, base: waiver.base, ...detail }));
  }
  private row(id: string): PipelineWaiver {
    const r = this.db.prepare("SELECT * FROM pipeline_waivers WHERE id = ?").get(id);
    if (!r) throw new InboxError(404, `no waiver ${id}`);
    return toWaiver(r as Row);
  }

  /** Asks the founder. Returns the waiver; an exact retry with the same clientId returns the same one. */
  request(actor: WorldAgent, input: WaiverRequestInput): PipelineWaiver {
    if (!this.inbox) throw new InboxError(503, "waivers need the inbox");
    const reason = input.reason?.trim() ?? "";
    if (!reason) throw new InboxError(400, "a waiver needs a reason the founder can judge");
    if (!input.clientId?.trim()) throw new InboxError(400, "a waiver request needs a clientId");
    const fingerprint = requestFingerprint(["waiver", actor.id, input.repo, input.ref, input.candidate, reason]);
    const earlier = this.db.prepare("SELECT * FROM pipeline_waivers WHERE requested_by = ? AND client_id = ?").get(actor.id, input.clientId) as Row | undefined;
    if (earlier) {
      if (earlier.fingerprint !== fingerprint) throw new InboxError(409, "clientId was used for another waiver request", "replay_conflict");
      return toWaiver(earlier);
    }

    const state = this.world();
    const lead = actor.teamId ? state.agents.find((a) => a.teamId === actor.teamId && a.role === "lead") ?? null : null;
    const role = actor.role === "lead" && actor.teamId ? "lead" : "crew";
    if (role === "crew" && lead && lead.status !== "offline") {
      throw new InboxError(403, `Only the lead asks for a waiver while one is online; ask ${lead.name}.`, "pipeline_lead_required");
    }

    const repo = repository(input.repo);
    const ref = waiverRef(input.ref);
    if (["main", "master"].includes(ref)) throw new InboxError(409, "a waiver is for the integration branch; main/master releases have no waiver", "pipeline_waiver_ref");
    if (!/^[0-9a-f]{7,64}$/i.test(input.candidate.trim())) throw new InboxError(400, "name the exact commit id, not a branch or ref");
    const candidate = git(repo.top, ["rev-parse", "--verify", `${input.candidate.trim()}^{commit}`]);
    const targetRef = this.targetRef(repo.top, ref);
    if (!targetRef) throw new InboxError(409, `${ref} does not exist in ${repo.root} (neither origin/${ref} nor a local ${ref})`, "pipeline_waiver_ref");
    const base = git(repo.top, ["rev-parse", "--verify", `${targetRef}^{commit}`]);
    if (base === candidate) throw new InboxError(409, `${ref} already points to ${short(candidate)}`, "pipeline_waiver_noop");
    try { git(repo.top, ["merge-base", "--is-ancestor", base, candidate]); }
    catch { throw new InboxError(409, `${short(candidate)} does not build on ${ref} (${short(base)}): a waiver never rewinds or rewrites the branch`, "pipeline_waiver_not_descendant"); }

    // The same commit, branch and starting point already waiting for the founder is one question, not two.
    const open = this.db.prepare("SELECT * FROM pipeline_waivers WHERE repo_common = ? AND ref = ? AND candidate = ? AND base = ? AND state = 'requested'").get(repo.common, ref, candidate, base) as Row | undefined;
    if (open) return toWaiver(open);

    const diffArgs = ["diff", "--no-ext-diff", "--no-textconv", "--no-color"];
    const diffStat = git(repo.top, [...diffArgs, "--stat", base, candidate]);
    const diff = git(repo.top, [...diffArgs, base, candidate]);
    const id = randomUUID().slice(0, 8);
    const now = this.now();
    const expiresAt = new Date(now.getTime() + WAIVER_TTL_MS).toISOString();
    const name = basename(repo.root);
    const shown = diff.length > DIFF_SHOWN ? `${diff.slice(0, DIFF_SHOWN)}\n… (${diff.length - DIFF_SHOWN} more characters not shown; the stat above is complete)` : diff;
    const fence = "`".repeat(Math.max(3, ...[...diff.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    const who = `${actor.name} (${role === "lead" ? "lead" : `crew; ${lead ? `${lead.name}, the lead, is offline` : "the team has no lead"}`})`;
    let waiver: PipelineWaiver | null = null;
    this.inbox.submit({
      session: waiverSession(repo.common), project: { name, root: repo.root }, task: { title: "Repair waivers" },
      item: {
        key: `waiver-${id}`, type: "decide", blocking: true,
        title: `Allow ${short(candidate)} to ${ref} in ${name}, once?`,
        request: `${who} asks to deliver exactly commit ${candidate} to ${ref} in ${repo.root} without a pipeline run.\n\nReason: ${reason}`,
        context: [
          `Diff of ${short(candidate)} against ${ref} as it is now (${targetRef} at ${base}):`,
          `${fence}\n${diffStat}\n${fence}`, `${fence}diff\n${shown}\n${fence}`,
          `Allowing records a single-use waiver for exactly this commit to ${ref} in this repository. It works only while ${ref} still points to ${short(base)}, for one delivery, and lapses 24 hours after you allow it (unanswered, this request lapses at ${expiresAt}). Approve all never answers this, and a message here does not change your choice.`,
        ].join("\n\n"),
        options: [
          { id: ALLOW, label: "Allow this commit once", consequence: `${short(candidate)} may be delivered to ${ref} once, without a pipeline run, while ${ref} is still at ${short(base)}.` },
          { id: REFUSE, label: "Refuse", consequence: "Nothing is allowed; the repair goes through an ordinary pipeline run." },
        ],
      },
    }, ({ itemId }) => {
      // Inside the submission's transaction: approve-all sees a waiver item from its first moment.
      this.db.prepare(`INSERT INTO pipeline_waivers (id, repo_common, repo_root, ref, target_ref, candidate, base, diff_stat, diff_sha256, reason,
        requested_by, requested_team_id, requester_role, client_id, fingerprint, item_id, state, requested_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?)`)
        .run(id, repo.common, repo.root, ref, targetRef, candidate, base, diffStat, createHash("sha256").update(diff).digest("hex"), reason,
          actor.id, actor.teamId, role, input.clientId, fingerprint, itemId, now.toISOString(), expiresAt);
      waiver = this.row(id);
      this.event("agent", "requested", waiver, { agentId: actor.id, role, reason, clientId: input.clientId });
    });
    this.changed();
    return waiver!;
  }

  /** Where the founder saw the branch: the remote-tracking ref when there is one, else the local branch. */
  private targetRef(top: string, ref: string): string | null {
    for (const name of [`refs/remotes/origin/${ref}`, `refs/heads/${ref}`]) {
      try { git(top, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`]); return name; } catch { /* try the next */ }
    }
    return null;
  }

  /**
   * Applies the founder's answers and lapses expired waivers. Only an explicit choice on the item
   * counts: approve-all is refused and messages change nothing. Runs on the office's tick and
   * before every read or gate, so no answer waits on timing.
   */
  sync(): void {
    const now = this.now();
    let changed = false;
    for (const r of this.db.prepare("SELECT * FROM pipeline_waivers WHERE state IN ('requested', 'granted')").all() as Row[]) {
      const waiver = toWaiver(r);
      if (waiver.state === "granted") {
        if (Date.parse(waiver.expiresAt) > now.getTime()) continue;
        this.db.prepare("UPDATE pipeline_waivers SET state = 'expired' WHERE id = ? AND state = 'granted'").run(waiver.id);
        this.event("system", "expired", waiver, { unused: true });
        changed = true; continue;
      }
      if (this.decide(waiver)) { changed = true; continue; }
      if (Date.parse(waiver.expiresAt) <= now.getTime()) {
        this.db.prepare("UPDATE pipeline_waivers SET state = 'expired' WHERE id = ? AND state = 'requested'").run(waiver.id);
        this.event("system", "expired", waiver, { unanswered: true });
        this.close(waiver, "withdrawn");
        changed = true;
      }
    }
    if (changed) this.changed();
  }

  /** The founder's queued answers on one request, oldest first. Returns whether it was decided. */
  private decide(waiver: PipelineWaiver): boolean {
    if (!waiver.itemId || !this.inbox) return false;
    const session = waiverSession(waiver.repoCommon);
    const replies = this.db.prepare("SELECT id, action, choice, text, created_at FROM replies WHERE item_id = ? AND state = 'queued' ORDER BY rowid").all(waiver.itemId) as Row[];
    const notes: string[] = [];
    for (const reply of replies) {
      const id = String(reply.id);
      const automatic = Boolean(this.db.prepare("SELECT id FROM events WHERE kind = 'reply.queued' AND actor = 'system' AND json_extract(detail, '$.deliveryId') = ?").get(id));
      if (automatic) { this.inbox.acknowledge(session, id, "Approve all cannot answer a waiver; only the founder's own choice counts."); continue; }
      this.inbox.acknowledge(session, id);
      // A message is conversation, never a decision.
      if (reply.action !== "choose" || (reply.choice !== ALLOW && reply.choice !== REFUSE)) { if (reply.text) notes.push(String(reply.text)); continue; }
      // The founder decided when they answered, whenever the office got to it.
      const at = new Date(String(reply.created_at));
      if (reply.choice === ALLOW) {
        const expiresAt = new Date(at.getTime() + WAIVER_TTL_MS).toISOString();
        this.db.prepare("UPDATE pipeline_waivers SET state = 'granted', decided_at = ?, decided_reply = ?, expires_at = ? WHERE id = ? AND state = 'requested'").run(at.toISOString(), id, expiresAt, waiver.id);
        this.event("user", "granted", waiver, { replyId: id, expiresAt });
      } else {
        this.db.prepare("UPDATE pipeline_waivers SET state = 'refused', decided_at = ?, decided_reply = ? WHERE id = ? AND state = 'requested'").run(at.toISOString(), id, waiver.id);
        this.event("user", "refused", waiver, { replyId: id });
      }
      this.close(waiver, "resolved");
      return true;
    }
    if (notes.length) this.reask(waiver, notes);
    return false;
  }

  /** A message took the request out of Needs you without deciding it: put it back, as a new revision that says so. */
  private reask(waiver: PipelineWaiver, notes: string[]): void {
    const item = this.inbox!.item(waiver.itemId!);
    if (item.state === "withdrawn" || item.state === "resolved") return;
    const context = `${item.context.replace(/\n\nYou wrote: [\s\S]*$/, "")}\n\nYou wrote: ${notes.map((n) => `“${n}”`).join(" ")} Nobody reads messages here: choose Allow or Refuse.`;
    this.inbox!.submit({
      session: waiverSession(waiver.repoCommon), project: { name: basename(waiver.repoRoot), root: waiver.repoRoot }, task: { title: "Repair waivers" },
      item: { key: item.key, type: "decide", blocking: true, title: item.title, request: item.request, context, options: item.options },
    });
  }

  private close(waiver: PipelineWaiver, outcome: "withdrawn" | "resolved"): void {
    if (!waiver.itemId || !this.inbox) return;
    try { this.inbox.closeItem(waiverSession(waiver.repoCommon), waiver.itemId, outcome); } catch { /* already closed */ }
  }

  /**
   * A protected delivery that names no pipeline run. Allowed only by a live founder-granted waiver
   * for exactly this repository, ref and commit, while the ref still points to the waiver's base.
   * The first allow consumes it; that delivery's later boundaries stay allowed for a short
   * follow-up window, and nothing is allowed once the ref has moved.
   */
  gate(actor: WorldAgent, input: WaiverGateInput): WaiverGateResult {
    this.sync();
    const refuse = (reasons: string[], waiverId: string | null = null, candidate = input.candidate): WaiverGateResult => {
      this.db.prepare("INSERT INTO events (at, actor, task_id, item_id, kind, detail) VALUES (?, 'agent', NULL, NULL, 'pipeline.waiver.gate_refused', ?)")
        .run(this.now().toISOString(), JSON.stringify({ agentId: actor.id, waiverId, request: input, reasons }));
      return { allowed: false, waiverId, candidate, reasons };
    };
    if (input.operation === "pr" || input.operation === "merge") return refuse(["a waiver allows a push, land or publish of one commit, never a PR or merge"]);
    let repo: ReturnType<typeof repository>; let ref: string; let candidate: string;
    try { repo = repository(input.repo); ref = waiverRef(input.ref); } catch { return refuse(["no pipeline run named, and the repository or ref is unavailable"]); }
    if (!/^[0-9a-f]{7,64}$/i.test(input.candidate)) return refuse(["no pipeline run named, and a waiver needs the exact commit id"]);
    try { candidate = git(repo.top, ["rev-parse", "--verify", `${input.candidate}^{commit}`]); } catch { return refuse([`commit ${input.candidate} is not in this repository`]); }

    const rows = (this.db.prepare("SELECT * FROM pipeline_waivers WHERE repo_common = ? AND candidate = ? ORDER BY requested_at").all(repo.common, candidate) as Row[]).map(toWaiver);
    const mine = rows.filter((w) => w.ref === ref);
    const reasons: string[] = [];
    for (const w of mine) {
      if (w.state === "requested") { reasons.push(`waiver ${w.id} is still waiting for the founder`); continue; }
      if (w.state === "refused") { reasons.push(`the founder refused waiver ${w.id}`); continue; }
      if (w.state === "expired") { reasons.push(`waiver ${w.id} expired at ${w.expiresAt}`); continue; }
      let current: string;
      try { current = git(repo.top, ["rev-parse", "--verify", `${w.targetRef}^{commit}`]); } catch { reasons.push(`waiver ${w.id}: ${w.targetRef} is unavailable`); continue; }
      const now = this.now();
      if (w.state === "used") {
        if (current === w.candidate) { reasons.push(`waiver ${w.id} was used at ${w.usedAt}: ${ref} already points to it`); continue; }
        if (now.getTime() > Date.parse(w.usedUntil ?? w.usedAt ?? "")) { reasons.push(`waiver ${w.id} was used at ${w.usedAt}; it allows one delivery`); continue; }
      }
      if (current !== w.base) {
        reasons.push(`${ref} moved since the founder saw the diff (${w.targetRef} was ${short(w.base)}, now ${short(current)}); ask for a new waiver`);
        continue;
      }
      if (w.state === "granted") {
        const usedUntil = new Date(Math.min(now.getTime() + WAIVER_FOLLOW_UP_MS, Date.parse(w.expiresAt))).toISOString();
        this.db.prepare("UPDATE pipeline_waivers SET state = 'used', used_at = ?, used_by = ?, used_until = ? WHERE id = ? AND state = 'granted'").run(now.toISOString(), actor.id, usedUntil, w.id);
        this.event("agent", "used", w, { agentId: actor.id, operation: input.operation ?? null, usedUntil });
        this.changed();
      } else {
        this.event("agent", "allowed", w, { agentId: actor.id, operation: input.operation ?? null, followUp: true });
      }
      return { allowed: true, waiverId: w.id, candidate, reasons: [] };
    }
    if (!mine.length) {
      const elsewhere = rows.filter((w) => w.state === "granted" || w.state === "used").map((w) => w.ref);
      reasons.push(`name the pipeline run, or have the founder grant a waiver: none allows ${short(candidate)} to ${ref} in this repository${elsewhere.length ? ` (a waiver for this commit names ${[...new Set(elsewhere)].join(", ")}, not ${ref})` : ""}`);
    }
    return refuse(reasons, mine.at(-1)?.id ?? null, candidate);
  }

  /** Waivers for one repository (any of its checkouts), newest first; all of them without one. */
  list(repo?: string | null): PipelineWaiver[] {
    this.sync();
    if (repo === null) return [];
    const common = repo ? (() => { try { return repository(repo).common; } catch { return null; } })() : undefined;
    if (common === null) return [];
    const rows = common === undefined ? this.db.prepare("SELECT * FROM pipeline_waivers ORDER BY requested_at DESC LIMIT 50").all()
      : this.db.prepare("SELECT * FROM pipeline_waivers WHERE repo_common = ? ORDER BY requested_at DESC LIMIT 50").all(common);
    return (rows as Row[]).map(toWaiver);
  }
}
