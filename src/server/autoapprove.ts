// The founder's opt-in inbox rule: Off, Approve all, or QA answers. Nothing here touches office work, switches or messages
// beyond one ordinary office notice telling the QA agent that questions wait for it.
import type { DatabaseSync } from "node:sqlite";
import { recommendedOption } from "../shared/recommended-option.ts";
import type { AutoApproveState, AutomationMode, Item } from "../shared/types.ts";
import { Inbox, InboxError } from "./inbox.ts";
import { presentedBy } from "./pipelines/approval.ts";
import { isWaiverItem } from "./pipelines/waiver.ts";
import { QaDesk } from "./qa.ts";

export type { AutoApproveState };

export function autoAnswer(item: Item): { action: "accept" | "choose"; choice?: string } | null {
  if (item.type === "milestone" || item.type === "try") return { action: "accept" };
  if (item.type !== "decide" || item.options.length < 2) return null;
  const choice = recommendedOption(item.options, item.recommendation);
  return choice ? { action: "choose", choice } : null;
}

export class AutoApprove {
  private db: DatabaseSync;
  private inbox: Inbox;
  /** The QA agent's side of QA answers; the office port is wired by the service. */
  readonly qa: QaDesk;

  constructor(db: DatabaseSync, inbox: Inbox, learningsDir: string | null = null) {
    this.db = db;
    this.inbox = inbox;
    this.qa = new QaDesk(db, inbox, learningsDir);
    inbox.onSubmitted = (id) => this.answer(id);
    // A founder answer is something for the QA agent to learn from.
    inbox.onAnswered = (_id, by) => { if (by === "founder") this.qa.offer(); };
  }

  mode(): AutomationMode {
    return this.db.prepare("SELECT mode FROM auto_approve WHERE singleton = 1").get()!.mode as AutomationMode;
  }

  state(): AutoApproveState {
    // The answer and its provenance commit together. Count revisions, including stale replies,
    // not delivery attempts; neither retries nor service restarts inflate this lifetime count.
    const count = this.db.prepare(`SELECT count(*) AS n FROM events
      WHERE kind = 'reply.queued' AND json_extract(detail, '$.autoApproved') = 1`).get()!;
    const mode = this.mode();
    return { enabled: mode === "approve_all", count: Number(count.n), mode, qa: this.qa.summary() };
  }

  /** The older on/off switch: on is Approve all, off is off. */
  setEnabled(enabled: boolean): AutoApproveState {
    return this.setMode(enabled ? "approve_all" : "off");
  }

  /** `agentId` chooses the QA agent (null clears it, which also stops predictions in manual mode). */
  setMode(mode: AutomationMode, agentId?: string | null): AutoApproveState {
    if (mode === "qa" && (agentId === null || (agentId === undefined && !this.qa.agentId()))) throw new InboxError(400, "choose the agent that answers as QA");
    if (agentId !== undefined) this.qa.choose(agentId);
    this.db.prepare("UPDATE auto_approve SET mode = ?, enabled = ? WHERE singleton = 1").run(mode, mode === "approve_all" ? 1 : 0);
    // The QA agent learns in manual mode too, where it predicts.
    if (mode === "qa" || (mode === "off" && this.qa.agentId())) this.qa.prepareLearnings();
    this.sweep();
    this.inbox.onChange("auto-approve");
    return this.state();
  }

  /** Also run at service startup: an interruption between submit and answer loses nothing. */
  sweep(): void {
    const mode = this.mode();
    // QA answers, or manual mode with a QA agent chosen (it predicts): the QA agent is told, nothing is answered.
    if (mode !== "approve_all") return this.qa.offer();
    const rows = this.db.prepare("SELECT id FROM items WHERE state IN ('needs_attention', 'snoozed') ORDER BY created_at, id").all();
    for (const row of rows) this.answer(String(row.id));
  }

  private answer(id: string): void {
    const mode = this.mode();
    // QA answers never answer anything here: the QA agent is told, and the item waits for it or for you.
    // In manual mode the chosen QA agent is told too, but only to predict your answer.
    if (mode !== "approve_all") return this.qa.offer();
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
