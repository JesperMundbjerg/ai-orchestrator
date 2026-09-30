import { useState } from "react";
import type { WorldAgent } from "../../shared/types.ts";
import { api } from "../api.ts";

/** All choices and availability come from the service, never from a harness name. */
export function Effort({ agent }: { agent: WorldAgent }) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const capability = agent.capabilities?.changeEffort;
  const effort = agent.effort;
  const request = effort?.request;
  const pending = request?.state === "pending";
  if (!capability && !effort) return agent.capabilities?.effortUnavailable ? <p className="small-note muted">{agent.capabilities.effortUnavailable}</p> : null;
  return <div className="small-note" onKeyDown={(e) => e.stopPropagation()}>
    <label>Effort {capability ? <select aria-label={`Effort for ${agent.name}`} disabled={sending || pending} value={effort?.current ?? ""} onChange={async (e) => {
      setSending(true); setError("");
      try { await api.setEffort(agent.id, e.target.value); }
      catch (err) { setError((err as Error).message); }
      finally { setSending(false); }
    }}>
      {!effort?.current ? <option value="">Not reported</option> : null}
      {effort?.current && !capability.levels.includes(effort.current) ? <option value={effort.current}>{effort.current}</option> : null}
      {capability.levels.map((level) => <option key={level} value={level}>{level}</option>)}
    </select> : effort?.current ?? "Not reported"}</label>
    <span role="status">{sending ? " · Requesting…" : pending ? ` · ${request.level} pending — applies when free` : request?.state === "confirmed" ? ` · ${request.level} confirmed` : ""}</span>
    {request?.state === "failed" ? <div className="warn">Change failed: {request.error}</div> : null}
    {!capability && agent.capabilities?.effortUnavailable ? <div className="muted">{agent.capabilities.effortUnavailable}</div> : null}
    {error ? <div className="warn" role="alert">{error}</div> : null}
  </div>;
}
