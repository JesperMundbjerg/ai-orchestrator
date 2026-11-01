// The founder's opt-in inbox rule. Nothing here touches office work, switches or messages.
import type { DatabaseSync } from "node:sqlite";
import { recommendedOption } from "../shared/recommended-option.ts";
import type { Item } from "../shared/types.ts";
import { Inbox } from "./inbox.ts";
import { presentedBy } from "./pipelines/approval.ts";
import { isWaiverItem } from "./pipelines/waiver.ts";

export interface AutoApproveState { enabled: boolean; count: number }

export function autoAnswer(item: Item): { action: "accept" | "choose"; choice?: string } | null {
  if (item.type === "milestone" || item.type === "try") return { action: "accept" };
  if (item.type !== "decide" || item.options.length < 2) return null;
  const choice = recommendedOption(item.options, item.recommendation);
  return choice ? { action: "choose", choice } : null;
}

export class AutoApprove {
  private db: DatabaseSync;
  private inbox: Inbox;

  constructor(db: DatabaseSync, inbox: Inbox) {
    this.db = db;
    this.inbox = inbox;
    inbox.onSubmitted = (id) => this.answer(id);
  }

  private enabled(): boolean {
    return Boolean(this.db.prepare("SELECT enabled FROM auto_approve WHERE singleton = 1").get()!.enabled);
  }

  state(): AutoApproveState {
    // The answer and its provenance commit together. Count revisions, including stale replies,
    // not delivery attempts; neither retries nor service restarts inflate this lifetime count.
    const count = this.db.prepare(`SELECT count(*) AS n FROM events
      WHERE kind = 'reply.queued' AND json_extract(detail, '$.autoApproved') = 1`).get()!;
    return { enabled: this.enabled(), count: Number(count.n) };
  }

  setEnabled(enabled: boolean): AutoApproveState {
    this.db.prepare("UPDATE auto_approve SET enabled = ? WHERE singleton = 1").run(enabled ? 1 : 0);
    this.sweep();
    this.inbox.onChange("auto-approve");
    return this.state();
  }

  /** Also run at service startup: an interruption between submit and answer loses nothing. */
  sweep(): void {
    if (!this.enabled()) return;
    const rows = this.db.prepare("SELECT id FROM items WHERE state IN ('needs_attention', 'snoozed') ORDER BY created_at, id").all();
    for (const row of rows) this.answer(String(row.id));
  }

  private answer(id: string): void {
    if (!this.enabled()) return;
    const item = this.inbox.item(id);
    if (item.state !== "needs_attention" && item.state !== "snoozed") return;
    // Failed/uncertain deliveries require explicit Retry. Never manufacture a second answer
    // for the same revision, even if it returned to Needs you after a failed delivery.
    if (this.db.prepare("SELECT id FROM replies WHERE item_id = ? AND revision = ? LIMIT 1").get(id, item.revision)) return;
    // A pipeline's "Founder approves" step needs the founder's own acceptance: leave it waiting for them.
    if (presentedBy(this.db, id, item.revision)) return;
    // An exact-SHA repair waiver is the founder's own call, always.
    if (isWaiverItem(this.db, id)) return;
    const answer = autoAnswer(item);
    if (!answer) return;
    this.inbox.answer(id, {
      id: `approve-all:${id}:${item.revision}`, revision: item.revision, ...answer,
      text: "Auto-approved (approve all).",
    }, "approve_all");
  }
}
