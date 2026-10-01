import { useState } from "react";
import type { SwitchesView, WorldAgent } from "../../shared/types.ts";
import { api } from "../api.ts";

/**
 * Moving an agent to the other harness, and how far that has got. What it can go to, its label and
 * why it cannot, all come from the service, so nothing here knows a harness.
 */
export function SwitchHarness({ agent, switches, compact = false }: { agent: WorldAgent; switches: SwitchesView | undefined; compact?: boolean }) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const offer = switches?.offers[agent.id];
  const latest = switches?.recent.filter((s) => s.agentId === agent.id).at(-1);
  const active = latest && latest.step !== "done" && latest.step !== "failed" ? latest : null;
  if (!offer && !latest) return null;
  const start = async () => {
    if (!offer) return;
    const how = agent.paneId ? `${agent.name} writes a handoff, then a` : "A";
    if (!window.confirm(`Switch ${agent.name} to ${offer.label} (${offer.model}, ${offer.effort} effort)?\n\n${how} ${offer.label} session takes over as ${agent.name}, with the same team, role and messages, and the old pane is closed.`)) return;
    setSending(true);
    setError("");
    try { await api.switchAgent(agent.id); }
    catch (err) { setError((err as Error).message); }
    finally { setSending(false); }
  };
  return (
    <div className={`switch-harness${compact ? " compact" : ""}`} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      {active ? (
        <span role="status" className="switch-progress"><span className="switch-dot" />{compact ? `To ${active.toLabel}: ` : `Switching to ${active.toLabel}: `}{active.says}</span>
      ) : offer ? (
        <button
          className="ghost small"
          disabled={sending || !!offer.refused}
          title={offer.refused ?? `${offer.label}, ${offer.model} at ${offer.effort} effort, as the crew guide pairs it`}
          onClick={() => void start()}
        >
          {sending ? "Starting…" : `Switch to ${offer.label}`}
        </button>
      ) : null}
      {!active && latest?.step === "failed" ? <div className="warn">{latest.says}</div> : null}
      {!active && latest?.step === "done" && !compact ? <div className="muted">{latest.says}.</div> : null}
      {error ? <div className="warn" role="alert">{error}</div> : null}
    </div>
  );
}
