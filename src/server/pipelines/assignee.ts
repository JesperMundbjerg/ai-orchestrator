import type { PipelineNode } from "../../shared/pipeline.ts";
import { inboxCommand } from "../../shared/pipeline-cli.ts";
import type { WorldAgent } from "../../shared/types.ts";
import { InboxError } from "../inbox.ts";

/** An agent as a refusal names it; `known` is false for an id the office has no record of. */
export type Named = { id: string; name: string; offline: boolean; known: boolean };

/**
 * Why a crew member may not report a step assigned to someone else, with what unblocks it: who holds
 * the step (name, id, offline) and the exact command the first mate runs to hand it to this actor.
 * Given only when the reporter is not provably the assignee's session (sameSession): a resumed session
 * under a new agent id whose session the office never saw, a forked session, or someone else.
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

/**
 * Whether a reporter is provably the session a step was assigned to: both session keys known and equal,
 * which means the same harness and the same session id (db.ts sessionKey). A forked session has a new id,
 * and an unknown one proves nothing, so neither is the assignee.
 */
export function sameSession(held: string | null | undefined, reporter: string | null): boolean {
  return Boolean(held && reporter && held === reporter);
}
