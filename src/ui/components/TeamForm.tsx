import { useState, type ReactNode } from "react";
import { TEAM_STRUCTURES, type Team, type TeamStructure } from "../../shared/types.ts";

export const STRUCTURE_LABEL: Record<TeamStructure, string> = {
  dispatch: "Lead + crew: the lead divides the work",
  circle: "Peers: they talk it through together",
};

export interface TeamFields {
  name: string;
  structure: TeamStructure;
  purpose: string;
  handsTo: string | null;
}

/** Found a team or change one: its name, how it works, what it is for and who reviews its work. */
export function TeamForm({ initial, teams, submit, onSubmit, extra }: {
  initial?: Team;
  /** Every team, for where this one hands its finished work. */
  teams: Team[];
  submit: string;
  onSubmit: (fields: TeamFields) => void;
  extra?: ReactNode;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [structure, setStructure] = useState<TeamStructure>(initial?.structure ?? "dispatch");
  const [purpose, setPurpose] = useState(initial?.purpose ?? "");
  const [handsTo, setHandsTo] = useState(initial?.handsTo ?? "");
  const others = teams.filter((t) => t.id !== initial?.id);
  return (
    <form
      className="team-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSubmit({ name: name.trim(), structure, purpose: purpose.trim(), handsTo: handsTo || null });
      }}
    >
      <input autoFocus placeholder="Team name, e.g. Mission Control" value={name} onChange={(e) => setName(e.target.value)} />
      {TEAM_STRUCTURES.map((s) => (
        <label key={s} className="radio">
          <input type="radio" name="structure" checked={structure === s} onChange={() => setStructure(s)} />
          {STRUCTURE_LABEL[s]}
        </label>
      ))}
      <textarea rows={2} placeholder="What the team is for; every member is told" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
      <label className="field">
        <span>Hands finished work to</span>
        <select value={handsTo} onChange={(e) => setHandsTo(e.target.value)}>
          <option value="">Nobody: it finishes its own work</option>
          {others.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </label>
      <div className="row">
        <button className="primary small" type="submit" disabled={!name.trim()}>{submit}</button>
        {extra}
      </div>
    </form>
  );
}
