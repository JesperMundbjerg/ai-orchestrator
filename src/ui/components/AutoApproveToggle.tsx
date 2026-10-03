import { useEffect, useState } from "react";
import type { AutoApproveState, AutomationMode, QaAgentView, QaModel, QaSummary } from "../../shared/types.ts";
import { api } from "../api.ts";

const MODES: Array<{ mode: AutomationMode; label: string; title: string }> = [
  { mode: "off", label: "Off", title: "You answer everything. With a QA model picked, the office starts a QA agent that predicts your answers without sending them, and the header shows how often it agreed with you." },
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
          title={shown === "off"
            ? "The office starts a QA agent on this model. It predicts your answers without sending them, so you can see how often it agrees with you."
            : "The office starts a QA agent on this model to answer for you; QA answers turn on once it runs."}
          onChange={(e) => {
            const picked = models.find((m) => key(m) === e.target.value);
            if (picked) void set(shown!, picked);
            else if (!e.target.value) void set(shown!, null);
          }}>
          <option value="" disabled={shown === "qa"}>{shown === "qa" && !qa ? "Choose a model…" : "none"}</option>
          {qa && !running ? <option value="other" disabled>{qa.agentName ?? "an agent no longer in the office"}</option> : null}
          {groups.map((g) => <optgroup key={g} label={g}>
            {models.filter((m) => m.group === g).map((m) => <option key={key(m)} value={key(m)}>{m.label}</option>)}
          </optgroup>)}
        </select>
      </label>
    ) : null}
    {running || qa ? <QaAgentStatus running={running} qa={qa} /> : null}
    {state?.mode === "qa" && qa ? (
      <span className={`auto-approve-count qa-status${qa.online ? "" : " offline"}`} role="status">
        <strong>{qa.withQa} with QA agent</strong>
        {qa.online ? null : ` · ${qa.agentName ?? "QA agent"} is offline: everything is yours`}
        {` · ${qa.answered} answered · ${qa.overridden} overridden`}
      </span>
    ) : null}
    {state?.mode === "off" && qa ? <Predictions qa={qa} /> : null}
    {state?.qaError ? <span role="alert" className="error">{state.qaError}</span> : null}
    {error ? <span role="alert" className="error">{error}</span> : null}
  </div>;
}

/** The QA agent the office runs: its model and whether it is starting, online or offline. */
function QaAgentStatus({ running, qa }: { running: QaAgentView | null; qa: QaSummary | null }) {
  const status = running?.status ?? (qa?.online ? "online" : "offline");
  const who = running ? running.model.label : qa?.agentName ?? "an agent no longer in the office";
  return <span className={`auto-approve-count qa-agent-status ${status}`} role="status" aria-label="QA agent"
    title={running ? `${qa?.agentName ? `${qa.agentName}, ` : ""}started by the office` : "Chosen earlier; the office did not start it and never closes it."}>
    QA agent: {who} · {status}
  </span>;
}

/** Manual mode: the QA agent predicts your answers without sending them; how often it agreed with you. */
function Predictions({ qa }: { qa: QaSummary }) {
  const { predicted = 0, judged = 0, agreed = 0, toJudge = 0 } = qa;
  const rate = judged ? ` (${Math.round((agreed / judged) * 100)}%)` : "";
  return <span className="auto-approve-count qa-predictions" role="status"
    title={`${qa.agentName ?? "The QA agent"} predicts what you will answer. Its predictions are never sent and never count as your answer; once you answer, they are compared with yours.`}>
    QA predicted {predicted} · agreed {agreed} of {judged}{rate}{toJudge ? ` · ${toJudge} to judge` : ""}
  </span>;
}
