import type { DatabaseSync } from "node:sqlite";

/**
 * The founder's standing decision on one item revision: the latest Accept or Needs changes.
 * A message ("discuss") is conversation, never a decision, so it neither grants nor revokes.
 * `automatic` is approve-all's answer, which no pipeline approval accepts.
 */
export function founderDecision(db: DatabaseSync, itemId: string, revision: number): { action: "accept" | "request_changes"; automatic: boolean; stale: boolean } | null {
  const reply = db.prepare("SELECT id, action, state FROM replies WHERE item_id = ? AND revision = ? AND action IN ('accept', 'request_changes') ORDER BY rowid DESC LIMIT 1").get(itemId, revision);
  if (!reply) return null;
  const automatic = Boolean(db.prepare("SELECT id FROM events WHERE kind = 'reply.queued' AND actor = 'system' AND json_extract(detail, '$.deliveryId') = ?").get(String(reply.id)));
  return { action: reply.action === "accept" ? "accept" : "request_changes", automatic, stale: reply.state === "stale" };
}

/** The pipeline run that presented this item revision to the founder, if any. */
export function presentedBy(db: DatabaseSync, itemId: string, revision: number): { runId: string; fingerprint: string } | null {
  const row = db.prepare("SELECT run_id, fingerprint FROM pipeline_item_bindings WHERE item_id = ? AND revision = ?").get(itemId, revision);
  return row ? { runId: String(row.run_id), fingerprint: String(row.fingerprint) } : null;
}
