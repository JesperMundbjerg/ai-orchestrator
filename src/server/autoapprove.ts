// The founder's opt-in inbox rule: Off, Approve all, or QA answers. Nothing here touches office work, switches or messages
// beyond one ordinary office notice telling the QA agent that questions wait for it.
import type { DatabaseSync } from "node:sqlite";
import { recommendedOption } from "../shared/recommended-option.ts";
import type { CrewChoice } from "../shared/crewtree.ts";
import type { AutoApproveState, AutomationMode, Item, QaAgentView, QaModel } from "../shared/types.ts";
import { Inbox, InboxError } from "./inbox.ts";
import { presentedBy } from "./pipelines/approval.ts";
import { isWaiverItem } from "./pipelines/waiver.ts";
import { QaDesk } from "./qa.ts";
import type { QaAgents } from "./qa-agent.ts";

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
  /** Starts the QA agent on the model the founder picks; the service wires it. Without it, no model can be picked. */
  agents: QaAgents | null = null;
  /** The QA agent the office is starting now, and the setting that applies once it runs. */
  private starting: { model: QaModel; mode: AutomationMode } | null = null;
  /** Why the last start failed; cleared by the next choice. */
  private failed: string | null = null;
  /** Settles once a start has finished (for tests and shutdown); null when nothing starts. */
  startup: Promise<void> | null = null;

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
    return { enabled: mode === "approve_all", count: Number(count.n), mode, qa: this.qa.summary(), qaModels: this.agents?.models() ?? [], qaAgent: this.qaAgent(), qaError: this.failed };
  }

  private qaAgent(): QaAgentView | null {
    if (this.starting) return { model: this.starting.model, status: "starting", agentId: null, mode: this.starting.mode };
    const started = this.agents?.started();
    if (!started || started.agentId !== this.qa.agentId()) return null;
    return { model: started.model, status: this.qa.office?.agent(started.agentId)?.online ? "online" : "offline", agentId: started.agentId };
  }

  /** The older on/off switch: on is Approve all, off is off. */
  setEnabled(enabled: boolean): AutoApproveState {
    return this.setMode(enabled ? "approve_all" : "off");
  }

  /**
   * `qaModel` has the office start a new QA agent on that model and designate it once it runs, replacing the one
   * it started before; null clears the QA agent and closes the one the office started. `agentId` designates an
   * agent already in the office instead. Clearing also stops predictions in manual mode.
   */
  setMode(mode: AutomationMode, agentId?: string | null, qaModel?: CrewChoice | null): AutoApproveState {
    if (agentId !== undefined && qaModel !== undefined) throw new InboxError(400, "give a model to start or an agent, not both");
    if (this.starting && (agentId !== undefined || qaModel !== undefined)) throw new InboxError(409, `the QA agent on ${this.starting.model.label} is starting; choose again once it runs`);
    if (qaModel) {
      if (!this.agents) throw new InboxError(404, "this service runs without the office, so it cannot start a QA agent");
      const model = this.agents.model(qaModel);
      this.failed = null;
      // QA answers need their agent: until it runs, the setting stays as it was (and stays so if it never does).
      const now = mode === "qa" && !this.qa.agentId() ? this.mode() : mode;
      this.starting = { model, mode };
      this.startup = this.startQa(model).finally(() => { this.startup = null; });
      return this.apply(now);
    }
    if (this.starting && agentId === undefined) {
      // A setting chosen while the QA agent starts is the one that applies once it runs; QA answers wait for it.
      this.starting.mode = mode;
      if (mode === "qa" && !this.qa.agentId()) { this.inbox.onChange("auto-approve"); return this.state(); }
      return this.apply(mode);
    }
    const none = agentId === null || qaModel === null;
    if (mode === "qa" && (none || (agentId === undefined && !this.qa.agentId()))) throw new InboxError(400, "choose the model the QA agent runs on");
    if (agentId !== undefined || none) {
      this.qa.choose(none ? null : agentId!);
      this.failed = null;
      // Whatever the founder chose instead, the agent the office started is no longer the QA agent.
      this.retire();
    }
    return this.apply(mode);
  }

  private async startQa(model: QaModel): Promise<void> {
    try {
      const started = await this.agents!.start(model);
      const before = this.agents!.started();
      this.qa.designate(started.agentId);
      this.agents!.record(started);
      const { mode } = this.starting!;
      this.starting = null;
      this.apply(mode);
      if (before && before.agentId !== started.agentId) await this.agents!.close(before);
    } catch (err) {
      this.starting = null;
      this.failed = (err as Error).message;
      this.inbox.onChange("auto-approve");
    }
  }

  /** Forgets the agent the office started, and closes it, unless it is still the QA agent. */
  private retire(): void {
    const started = this.agents?.started();
    if (!started || started.agentId === this.qa.agentId()) return;
    this.agents!.record(null);
    void this.agents!.close(started);
  }

  private apply(mode: AutomationMode): AutoApproveState {
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
