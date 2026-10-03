import { useEffect, useState } from "react";
import type { AutoApproveState, AutomationMode, QaSummary, WorldAgent } from "../../shared/types.ts";
import { api } from "../api.ts";

const MODES: Array<{ mode: AutomationMode; label: string; title: string }> = [
  { mode: "off", label: "Off", title: "You answer everything. With a QA agent chosen, it predicts your answers without sending them, and the header shows how often it agreed with you." },
  { mode: "approve_all", label: "Approve all", title: "Accept milestones and try-it checks; choose clearly recommended options. Open questions and decisions without a clear recommendation still need you. Works while the inbox is closed." },
  { mode: "qa", label: "QA answers", title: "An office agent you choose decides for you, with a reason and what it learned from your past answers. Its answers are marked as its own and you can override them. While it is offline, everything is yours again; nothing is answered automatically." },
];

/** Both headers show the same persisted server setting, never a local-only switch. */
export function AutoApproveToggle({ tick }: { tick: number }) {
  const [state, setState] = useState<AutoApproveState | null>(null);
  const [agents, setAgents] = useState<WorldAgent[]>([]);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.autoApprove().then((s) => { if (live) { setState(s); setError(null); } }, (e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [tick]);
  // Both QA answers and manual mode (which predicts with it) choose the QA agent.
  const choosing = picking || state?.mode === "qa" || state?.mode === "off";
  useEffect(() => {
    if (!choosing) return;
    let live = true;
    api.world().then((w) => { if (live) setAgents(w.agents); }, () => {});
    return () => { live = false; };
  }, [choosing, tick]);

  const set = async (mode: AutomationMode, agentId?: string | null) => {
    if (!state || busy) return;
    // QA answers need an agent first; choosing one turns them on.
    if (mode === "qa" && !agentId && !state.qa) { setPicking(true); return; }
    setBusy(true);
    try { setState(await api.setAutoApprove(mode, agentId)); setPicking(false); setError(null); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const qa = state?.qa ?? null;
  const shown = picking ? "qa" : state?.mode;
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
    {state?.mode === "approve_all" ? <span className="auto-approve-count">{state.count} auto-answered</span> : null}
    {shown === "off" && state ? (
      <label className="qa-predict small">Predict with
        <select className="qa-agent small" aria-label="Predict with" disabled={busy} value={qa?.agentId ?? ""}
          title="An office agent that predicts your answers without sending them, so you can see how often it agrees with you."
          onChange={(e) => void set("off", e.target.value || null)}>
          <option value="">none</option>
          {qa && !agents.some((a) => a.id === qa.agentId) ? <option value={qa.agentId}>{qa.agentName ?? "an agent no longer in the office"}</option> : null}
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}{a.status === "offline" ? " (offline)" : ""}</option>)}
        </select>
      </label>
    ) : choosing ? (
      <select className="qa-agent small" aria-label="QA agent" disabled={!state || busy} value={qa?.agentId ?? ""}
        onChange={(e) => { if (e.target.value) void set("qa", e.target.value); }}>
        {!qa ? <option value="">Choose the QA agent…</option> : null}
        {qa && !agents.some((a) => a.id === qa.agentId) ? <option value={qa.agentId}>{qa.agentName ?? "an agent no longer in the office"}</option> : null}
        {agents.map((a) => <option key={a.id} value={a.id}>{a.name}{a.status === "offline" ? " (offline)" : ""}</option>)}
      </select>
    ) : null}
    {state?.mode === "qa" && qa ? (
      <span className={`auto-approve-count qa-status${qa.online ? "" : " offline"}`} role="status">
        <strong>{qa.withQa} with QA agent</strong>
        {qa.online ? null : ` · ${qa.agentName ?? "QA agent"} is offline: everything is yours`}
        {` · ${qa.answered} answered · ${qa.overridden} overridden`}
      </span>
    ) : null}
    {state?.mode === "off" && qa ? <Predictions qa={qa} /> : null}
    {error ? <span role="alert" className="error">{error}</span> : null}
  </div>;
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
