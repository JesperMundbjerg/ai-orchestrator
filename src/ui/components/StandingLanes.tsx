import { useState } from "react";
import type { StandingLane } from "../../shared/types.ts";
import { api } from "../api.ts";

const STATE_WORD: Record<StandingLane["state"], string> = {
  checking: "is being checked",
  connected: "is connected",
  disconnected: "is disconnected",
  busy: "is busy",
  unknown: "cannot be confirmed",
};

/** "fysiklab/mission-control is disconnected" */
export function laneLine(lane: StandingLane): string {
  return `${lane.project}/${lane.lane} ${STATE_WORD[lane.state]}`;
}

function holder(lane: StandingLane): string {
  const r = lane.registered;
  if (!r) return "No session is registered for it.";
  const who = r.agentName ? `${r.agentName}${r.role === "lead" && r.teamName ? `, lead of ${r.teamName}` : r.teamName ? ` on ${r.teamName}` : ""}` : null;
  const turn = lane.lastTurnAt ? ` Last completed turn ${clock(lane.lastTurnAt)}.` : "";
  return `Registered: session ${r.session.slice(0, 8)}${r.pane ? ` in pane ${r.pane}` : ""}${who ? ` (${who})` : ""}${r.running ? "" : ", not running"}.${turn}`;
}

const clock = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "?");

function recoveryLine(lane: StandingLane): string | null {
  const r = lane.recovery;
  if (!r) return null;
  const what = {
    running: "is running",
    attached: `attached at ${clock(r.at)}: a check since shows session ${r.session.slice(0, 8)} connected in pane ${r.pane} with a fresh heartbeat`,
    busy: "not done, busy",
    unavailable: "not done, unavailable",
    refused: "refused",
    failed: "failed",
  }[r.state];
  return `Recovery onto ${r.agentName} ${what}${r.reason ? `: ${r.reason}` : ""}${r.log ? ` (log: ${r.log})` : ""}`;
}

/** One lane that needs you: what is wrong, who holds it, and an explicit Recover onto someone running in its checkout. */
function LaneRow({ lane, onDone }: { lane: StandingLane; onDone: () => void }) {
  const preferred = lane.candidates.find((c) => c.agentId === lane.registered?.agentId) ?? lane.candidates[0];
  const [target, setTarget] = useState(preferred?.agentId ?? "");
  const [error, setError] = useState<string | null>(null);
  const running = lane.recovery?.state === "running";
  const chosen = lane.candidates.some((c) => c.agentId === target) ? target : preferred?.agentId ?? "";
  const recover = () => {
    setError(null);
    api.recoverLane(lane.project, lane.lane, chosen).then(onDone, (e: Error) => setError(e.message));
  };
  const note = recoveryLine(lane);
  return (
    <li className="standing-lane">
      <span>
        <strong>{laneLine(lane)}</strong>
        <br />
        <span className="muted small-note">{[lane.reason, holder(lane)].filter(Boolean).join(" · ")}</span>
        {note ? <><br /><span className="small-note">{note}</span></> : null}
        {error ? <><br /><span className="warn small-note">{error}</span></> : null}
      </span>
      {lane.state !== "connected" && lane.candidates.length ? (
        <span className="row">
          <select value={chosen} onChange={(e) => setTarget(e.target.value)} disabled={running} aria-label={`Recover ${lane.lane} onto`}>
            {lane.candidates.map((c) => <option key={c.agentId} value={c.agentId}>{c.name} (lead of {c.teamName})</option>)}
          </select>
          <button className="small" onClick={recover} disabled={running || !chosen} title="Runs the project's own attach command for this lead's session. Nobody is renamed or made lead.">
            {running ? "Recovering…" : "Recover"}
          </button>
        </span>
      ) : lane.state !== "connected" ? <span className="muted small-note">No team lead runs in its checkout to recover it onto; who leads is your choice.</span> : null}
    </li>
  );
}

/**
 * A project's standing lanes that are not connected, at the top of the board, whether or not their
 * team's lead is online: the founder sees a disconnected dispatcher without it hiding behind a lead.
 */
export function StandingLanes({ lanes, onChanged }: { lanes: StandingLane[]; onChanged: () => void }) {
  // Red only for a lane that is not connected; a connected one stays, calmly, while it carries the outcome of a recovery you asked for.
  const wrong = lanes.filter((l) => l.state !== "connected");
  const recovered = lanes.filter((l) => l.state === "connected" && l.recovery);
  const block = (shown: StandingLane[], className: string) => shown.length ? (
    <div className={className} role="status">
      <ul>
        {shown.map((l) => <LaneRow key={`${l.project}/${l.lane}`} lane={l} onDone={onChanged} />)}
      </ul>
    </div>
  ) : null;
  if (!wrong.length && !recovered.length) return null;
  return <>{block(wrong, "machine-warning standing-lanes")}{block(recovered, "machine-warning calm standing-lanes")}</>;
}

/** The lanes each agent is the registered running session of, for marking it where agents are listed. */
export function heldLanes(lanes: StandingLane[]): Map<string, string[]> {
  const held = new Map<string, string[]>();
  for (const l of lanes) {
    const id = l.registered?.running ? l.registered.agentId : null;
    if (id) held.set(id, [...(held.get(id) ?? []), `${l.project}/${l.lane}`]);
  }
  return held;
}
