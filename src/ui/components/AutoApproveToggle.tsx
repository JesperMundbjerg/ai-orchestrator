import { useEffect, useState } from "react";
import type { AutoApproveState, AutomationMode, QaModel } from "../../shared/types.ts";
import { api } from "../api.ts";

const MODES: Array<{ mode: AutomationMode; label: string; title: string }> = [
  { mode: "off", label: "Off", title: "You answer everything. With a QA model picked, the office starts a QA agent that predicts your answers without sending them." },
  { mode: "approve_all", label: "Approve all", title: "Accept milestones and try-it checks; choose clearly recommended options. Open questions and decisions without a clear recommendation still need you. Works while the inbox is closed." },
  { mode: "qa", label: "QA answers", title: "A QA agent the office starts on the model you pick decides for you, with a reason and what it learned from your past answers. Its answers are marked as its own and you can override them. While it is offline, everything is yours again; nothing is answered automatically." },
];

const key = (m: { harness: string; model: string; effort: string }) => `${m.harness}|${m.model}|${m.effort}`;

/** Both headers show the same persisted server setting, never a local-only switch. */
export function AutoApproveToggle({ tick }: { tick: number }) {
  const [state, setState] = useState<AutoApproveState | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.autoApprove().then((s) => { if (live) { setState(s); setError(null); } }, (e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [tick]);

  const qa = state?.qa ?? null;
  const running = state?.qaAgent ?? null;
  const starting = running?.status === "starting";
  const set = async (mode: AutomationMode, qaModel?: QaModel | null) => {
    if (!state || busy) return;
    // QA answers need an agent first; picking its model starts one, and QA answers turn on once it runs.
    if (mode === "qa" && qaModel === undefined && !qa && !starting) { setPicking(true); return; }
    setBusy(true);
    try {
      const choice = qaModel ? { harness: qaModel.harness, model: qaModel.model, effort: qaModel.effort } : qaModel;
      setState(await api.setAutoApprove(mode, choice)); setPicking(false); setError(null);
    }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const shown = picking ? "qa" : (starting && running.mode) || state?.mode;
  // The picker serves both manual mode (the QA agent predicts) and QA answers (it answers).
  const choosing = state && (shown === "off" || shown === "qa");
  const models = state?.qaModels ?? [];
  const groups = [...new Set(models.map((m) => m.group))];
  const value = running ? key(running.model) : qa ? "other" : "";
  const status = running?.status ?? (qa?.online ? "online" : qa ? "offline" : "not selected");
  const detail = qa ? state?.mode === "off"
    ? ` · predicted ${qa.predicted ?? 0} · agreed ${qa.agreed ?? 0} of ${qa.judged ?? 0}${qa.judged ? ` (${Math.round(((qa.agreed ?? 0) / qa.judged) * 100)}%)` : ""}${qa.toJudge ? ` · ${qa.toJudge} to judge` : ""}`
    : state?.mode === "qa" ? ` · ${qa.withQa} with QA agent · ${qa.answered} answered · ${qa.overridden} overridden` : ""
    : "";
  const dropdownTitle = `${status}${detail}. ${shown === "off"
    ? "The QA agent predicts your answers without sending them."
    : "The QA agent answers for you when QA answers is on."}`;
  return <div className="auto-approve-control">
    <div className="automation-modes" role="radiogroup" aria-label="Who answers for you">
      {MODES.map((m) => (
        <button key={m.mode} role="radio" aria-checked={shown === m.mode} title={m.title} disabled={!state || busy}
          className={`auto-approve-toggle small${shown === m.mode && m.mode !== "off" ? " is-on" : ""}${shown === m.mode ? " is-chosen" : ""}`}
          onClick={() => void set(m.mode)}>
          {m.mode !== "off" ? <span className="auto-approve-dot" aria-hidden="true" /> : null}{m.label}
        </button>
      ))}
    </div>
    {state?.mode === "approve_all" && !starting ? <span className="auto-approve-count">{state.count} auto-answered</span> : null}
    {choosing ? (
      <label className="qa-predict small">{shown === "off" ? "Predict with" : "QA agent on"}
        <select className="qa-agent small" aria-label="QA model" disabled={busy || starting} value={value}
          title={dropdownTitle}
          onChange={(e) => {
            const picked = models.find((m) => key(m) === e.target.value);
            if (picked) void set(shown!, picked);
            else if (!e.target.value) void set(shown!, null);
          }}>
          <option value="" disabled={shown === "qa"}>{shown === "qa" && !qa ? "Choose a model…" : "none"}</option>
          {qa && !running ? <option value="other" disabled>{qa.agentName ?? "an agent no longer in the office"} ({qa.online ? "online" : "offline"})</option> : null}
          {groups.map((g) => <optgroup key={g} label={g}>
            {models.filter((m) => m.group === g).map((m) => <option key={key(m)} value={key(m)}>{m.label}{running && key(running.model) === key(m) && running.status !== "online" ? ` (${running.status})` : null}</option>)}
          </optgroup>)}
        </select>
      </label>
    ) : null}
    {state?.qaError ? <span role="alert" className="error">{state.qaError}</span> : null}
    {error ? <span role="alert" className="error">{error}</span> : null}
  </div>;
}

