import { useEffect, useState } from "react";
import { api } from "../api.ts";

/** Both headers show the same persisted server setting, never a local-only switch. */
export function AutoApproveToggle({ tick }: { tick: number }) {
  const [state, setState] = useState<{ enabled: boolean; count: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.autoApprove().then((s) => { if (live) { setState(s); setError(null); } }, (e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [tick]);
  const toggle = async () => {
    if (!state || busy) return;
    setBusy(true);
    try { setState(await api.setAutoApprove(!state.enabled)); setError(null); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="auto-approve-control">
    <button className={`auto-approve-toggle small${state?.enabled ? " is-on" : ""}`} role="switch" aria-checked={state?.enabled ?? false}
      disabled={!state || busy} onClick={() => void toggle()}
      title="Accept milestones and try-it checks; choose clearly recommended options. Open questions and decisions without a clear recommendation still need you. Works while the inbox is closed.">
      <span className="auto-approve-dot" aria-hidden="true" /> Approve all · {state?.enabled ? "On" : "Off"}
      {state ? <span className="auto-approve-count">{state.count} auto-answered</span> : null}
    </button>
    {error ? <span role="alert" className="error">{error}</span> : null}
  </div>;
}
