// The QA agent the office starts itself: the founder picks a model from the crew catalog, and the office starts a
// new agent on it in a workspace of its own, the way it starts a project's lead, with the QA guide as its brief.
// The office records which agent it started, so it closes only that one when the founder picks another model or
// none; an agent the office did not start is never closed. Starting calls no model: herdr starts the harness.
import type { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { CrewCatalog, CrewChoice } from "../shared/crewtree.ts";
import { modelLabel } from "../shared/models.ts";
import { QA_GUIDE } from "../shared/qa.ts";
import type { Harness, QaModel } from "../shared/types.ts";
import { startFlags } from "./crewtree.ts";
import { InboxError } from "./inbox.ts";
import { agentId, briefArgument, hookSettings, INBOX_BIN, liveIdentity, type LiveAgent } from "./world.ts";

/** What starting a QA agent needs from herdr. */
export interface QaAgentSource {
  available(): boolean;
  live(): LiveAgent[];
  openPane(cwd: string, beside: string | null, label: string): Promise<string>;
  startAgent(paneId: string, name: string, harness: Harness, args: string[]): Promise<void>;
  closePane(paneId: string): Promise<void>;
  refresh?(): Promise<void>;
}

/** An agent the office started as QA agent. */
export interface StartedQaAgent {
  agentId: string;
  paneId: string;
  /** Its herdr name. */
  name: string;
  model: QaModel;
}

/** The checkout the service runs from: trusted by both harnesses, unlike a new folder, which stops at a trust prompt. */
export const OFFICE_CHECKOUT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");

export function qaModels(catalog: CrewCatalog): QaModel[] {
  return catalog.harnesses.flatMap((h) => h.models.flatMap((m) => h.efforts.map((effort) => ({
    harness: h.id, model: m.id, effort, label: `${m.label || modelLabel(m.id)} · ${effort} (${h.label})`, group: h.label,
  }))));
}

/**
 * Flags that start a harness without its file-editing tools: QA decides, it never changes code, so its read-only status is
 * structural rather than promised. Bash stays, for `inbox` and the learnings, so this lowers the risk rather than removing it.
 */
export function readOnlyFlags(harness: Harness): string[] {
  return harness === "pi" ? ["--exclude-tools", "edit,write"] : ["--disallowedTools", "Edit,Write,NotebookEdit"];
}

export function qaBrief(learnings: string | null, model: QaModel): string {
  return [
    `The office started you as its QA agent, on ${model.label}. \`inbox\` below is ${INBOX_BIN}.`,
    "Office notices that start with \"QA:\" tell you questions or the founder's answers wait for you: then follow the loop below until `inbox qa next` has nothing left, and wait for the next notice. Do nothing else in between, and do not answer acknowledgments.",
    learnings ? `Your learnings are in ${learnings}.` : "",
    "You run without file-editing tools: you decide, you never change code. Write your learnings with Bash (for example `cat > FILE <<'EOF'`).",
    QA_GUIDE,
  ].filter(Boolean).join("\n");
}

export class QaAgents {
  private db: DatabaseSync;
  source: QaAgentSource | null;
  private catalog: () => CrewCatalog;
  private learnings: string | null;
  private cwd: string;

  constructor(db: DatabaseSync, source: QaAgentSource | null, opts: { catalog: () => CrewCatalog; learnings: string | null; cwd?: string }) {
    this.db = db;
    this.source = source;
    this.catalog = opts.catalog;
    this.learnings = opts.learnings;
    this.cwd = opts.cwd ?? OFFICE_CHECKOUT;
  }

  models(): QaModel[] {
    return qaModels(this.catalog());
  }

  /** The catalog's entry for a choice; anything else is refused, so only what the crew guide can run is started. */
  model(choice: CrewChoice): QaModel {
    const found = this.models().find((m) => m.harness === choice.harness && m.model === choice.model && m.effort === choice.effort);
    if (!found) throw new InboxError(400, `${choice.harness} ${choice.model} at ${choice.effort} effort is not in the crew catalog`);
    return found;
  }

  /** The QA agent the office started and still has designated, or null. */
  started(): StartedQaAgent | null {
    const row = this.db.prepare("SELECT qa_started FROM auto_approve WHERE singleton = 1").get();
    return row?.qa_started ? JSON.parse(String(row.qa_started)) as StartedQaAgent : null;
  }

  record(agent: StartedQaAgent | null): void {
    this.db.prepare("UPDATE auto_approve SET qa_started = ? WHERE singleton = 1").run(agent ? JSON.stringify(agent) : null);
  }

  /**
   * Starts a new agent on `model` in a workspace of its own and resolves with it once it runs. On failure its
   * pane is closed again and nothing is recorded; the error says why.
   */
  async start(model: QaModel): Promise<StartedQaAgent> {
    const source = this.source;
    if (!source?.available()) throw new InboxError(409, "the office starts its QA agent through herdr, and herdr is not running");
    const harness = model.harness as Harness;
    const name = `qa-${model.model.split("/").pop()!.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.slice(0, 26).replace(/-+$/, "") + `-${randomBytes(2).toString("hex")}`;
    let paneId: string;
    try {
      paneId = await source.openPane(this.cwd, null, `QA · ${model.label}`);
    } catch (err) {
      throw new InboxError(502, `herdr could not open a pane for the QA agent: ${(err as Error).message}`);
    }
    const args = [...startFlags(model), ...readOnlyFlags(harness), ...(harness === "claude" ? hookSettings(this.cwd) : []), "--append-system-prompt", briefArgument(qaBrief(this.learnings, model))];
    let failure: Error | null = null;
    try { await source.startAgent(paneId, name, harness, args); } catch (err) { failure = err as Error; }
    // herdr may give up waiting for it to look ready while it runs all the same, as with a lead.
    await source.refresh?.().catch(() => {});
    const live = source.live().find((a) => a.paneId === paneId && a.harness === harness);
    if (!live) {
      await source.closePane(paneId).catch(() => {});
      throw new InboxError(502, `the QA agent on ${model.label} did not start${failure ? ` (herdr: ${failure.message})` : ""}`);
    }
    return { agentId: agentId(liveIdentity(live)), paneId, name, model };
  }

  /** Closes an agent the office started, only while its pane still runs that agent. */
  async close(agent: StartedQaAgent): Promise<void> {
    if (!this.source) return;
    await this.source.refresh?.().catch(() => {});
    if (!this.source.live().some((a) => a.paneId === agent.paneId && agentId(liveIdentity(a)) === agent.agentId)) return;
    await this.source.closePane(agent.paneId).catch((err: Error) => console.error(`QA agent ${agent.name}: ${err.message}`));
  }
}
