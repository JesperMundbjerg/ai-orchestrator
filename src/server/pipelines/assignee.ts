import type { PipelineNode } from "../../shared/pipeline.ts";
import { inboxCommand } from "../../shared/pipeline-cli.ts";
import type { WorldAgent } from "../../shared/types.ts";
import { InboxError } from "../inbox.ts";

/** An agent as a refusal names it; `known` is false for an id the office has no record of. */
export type Named = { id: string; name: string; offline: boolean; known: boolean };

/**
 * Why a crew member may not report a step assigned to someone else, with what unblocks it: who holds
 * the step (name, id, offline) and the exact command the first mate runs to hand it to this actor.
 * A resumed session can come back under a new agent id; the office cannot prove it is the same
 * session (an agent id is not tied to a harness session id), so it never moves the step itself.
 */
export function notAssignee(runId: string, node: Pick<PipelineNode, "id" | "label">, actor: WorldAgent, assignee: Named | null, lead: Named | null): InboxError {
  const holder = !assignee ? "is not assigned to anyone"
    : !assignee.known ? `is assigned to ${assignee.id}, an agent the office no longer knows`
    : `is assigned to ${assignee.name} (${assignee.id})${assignee.offline ? ", who is offline" : ""}`;
  const by = lead ? `your first mate ${lead.name} (${lead.id})` : "this team's first mate";
  const command = inboxCommand(`pipeline assign ${runId} ${node.id} ${actor.id}`);
  return new InboxError(403, `report only your assigned step: ${node.label} (${node.id}) ${holder}, not to you, ${actor.name} (${actor.id}). `
    + `If you are taking it over (for example after a resumed session gave you a new id), ask ${by} to reassign it to you: ${command}`, "pipeline_not_assignee");
}
