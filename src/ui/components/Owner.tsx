import { DELIVERY_LABEL, HARNESS_INFO } from "../../shared/harnesses.ts";
import type { Task } from "../../shared/types.ts";
import { PRESENCE_LABEL } from "../format.ts";

/** Who owns the work: the agent's name, its harness and, when herdr sees it, whether it is working. */
export function Owner({ task, compact = false }: { task: Task; compact?: boolean }) {
  const status = task.presence?.status;
  const name = task.presence?.name ?? task.presence?.title ?? null;
  return (
    <span className="owner" title={`${HARNESS_INFO[task.binding.harness].label} session ${task.binding.sessionId}\n${DELIVERY_LABEL[task.capabilities.reply]}`}>
      <span className={`dot ${status ?? "offline"}`} />
      {name && !compact ? <span className="owner-name">{name}</span> : null}
      <span className="harness">{HARNESS_INFO[task.binding.harness].label}</span>
      {!compact ? <span className="muted">{status ? PRESENCE_LABEL[status] : "not open in herdr"}</span> : null}
    </span>
  );
}
