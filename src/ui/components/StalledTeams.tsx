import type { TeamStall, WorldTeam } from "../../shared/types.ts";
import { ago } from "../format.ts";

/** "Mission Control has no lead online; blocking: Cosmology, ECG." */
export function stallLine(stall: TeamStall): string {
  return `${stall.teamName} has no lead online; blocking: ${stall.blocking.join(", ")}`;
}

function stallDetail(stall: TeamStall): string {
  const who = stall.leadName ? `${stall.leadName} is offline` : "Nobody leads it";
  const ask = stall.candidates.length ? "Your decision is in Needs you." : "Nobody else is on it to make lead.";
  return `${who} · ${stall.waiting} waiting, the oldest from ${ago(stall.since)} · ${ask}`;
}

/** Teams nobody can move, at the top of the board: the founder sees them without walking the office. */
export function StalledTeams({ teams }: { teams: WorldTeam[] }) {
  const stalled = teams.flatMap((t) => t.stalled ?? []);
  if (!stalled.length) return null;
  return (
    <div className="machine-warning stalled-teams" role="status">
      <ul>
        {stalled.map((s) => (
          <li key={s.teamId}>
            <span><strong>{stallLine(s)}</strong><br /><span className="muted small-note">{stallDetail(s)}</span></span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One line on the team's own column or panel. */
export function StalledNote({ team }: { team: WorldTeam }) {
  return team.stalled ? <span className="warn small-note stalled-note">No lead online; blocking: {team.stalled.blocking.join(", ")}</span> : null;
}
