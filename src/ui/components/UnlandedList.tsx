import type { UnlandedStage, UnlandedWork } from "../../shared/types.ts";

const FOLDER = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

/** How far the office has taken it, in the founder's words. */
const TOLD: Record<UnlandedStage, string> = {
  watching: "being watched",
  agent: "agent told",
  lead: "lead told",
  founder: "you were told",
};

const sinceText = (iso: string) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

/**
 * Agents that went idle with work that has not reached the team's landing branch: who, in which
 * checkout, how much is uncommitted, how many commits are ahead of the landing branch, since when,
 * and whether the office has told them, their lead or you. A state an agent put on hold says so and
 * why, and nothing more is sent about it. Nothing when all is landed.
 */
export function UnlandedList({ items }: { items: UnlandedWork[] }) {
  if (!items.length) return null;
  return (
    <div className="unlanded" role="group" aria-label="Unlanded work">
      <strong className="small-note">Unlanded work</strong>
      <ul>
        {items.map((u) => (
          <li key={`${u.agentId}:${u.checkout}`} className="small-note">
            <span className="warn">{u.agentName}</span>
            {" in "}
            <code title={u.checkout}>{FOLDER(u.checkout)}</code>
            {u.branch ? <span className="muted"> ({u.branch})</span> : null}
            {": "}
            {u.uncommitted ? `${u.uncommitted} uncommitted` : ""}
            {u.uncommitted && u.ahead ? ", " : ""}
            {u.ahead ? `${u.ahead} ahead of ${u.landing}` : ""}
            {u.held ? (
              <span className="muted" data-held>
                {" · "}since {sinceText(u.since)} · <strong>held</strong> by {u.held.by || "an agent"}: {u.held.reason}
              </span>
            ) : (
              <span className="muted"> · since {sinceText(u.since)} · {TOLD[u.stage]}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
