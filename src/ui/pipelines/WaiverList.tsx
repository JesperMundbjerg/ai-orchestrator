import { useEffect, useState } from "react";
import type { PipelineWaiver } from "../../shared/waiver.ts";
import { pipelineApi } from "./api.ts";

const STATE: Record<PipelineWaiver["state"], { label: string; tone: string }> = {
  requested: { label: "waiting for you", tone: "stale" },
  granted: { label: "granted", tone: "done" },
  used: { label: "used", tone: "skipped" },
  expired: { label: "expired", tone: "skipped" },
  refused: { label: "refused", tone: "skipped" },
};

/** The repository's exact-SHA repair waivers: what the founder allowed outside a run, and what became of it. */
export function WaiverList({ teamId, tick }: { teamId: string; tick: number }) {
  const [waivers, setWaivers] = useState<PipelineWaiver[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    pipelineApi.waivers(teamId).then((w) => { if (live) { setWaivers(w); setError(null); } }, (e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [teamId, tick]);
  if (error) return <p className="pipeline-notice warn" role="alert">Waivers unavailable: {error}</p>;
  if (!waivers?.length) return null;
  return <section className="pipeline-runs" aria-label="Repair waivers">
    <h3>Repair waivers</h3>
    <p className="pipeline-help">Each allows one exact commit to one branch, once, without a run, and only while that branch is where the diff was taken from. Only your own Allow grants one.</p>
    <ul>{waivers.map((w) => <li key={w.id}>
      <span className={`pipeline-state ${STATE[w.state].tone}`}>{STATE[w.state].label}</span>{" "}
      <code>{w.candidate.slice(0, 10)}</code> → <strong>{w.ref}</strong> · {w.reason}
      <br /><small className="muted">
        Waiver {w.id} · asked by {w.requestedBy} ({w.requesterRole}) {w.requestedAt}
        {w.decidedAt && ` · ${w.state === "refused" ? "refused" : "allowed"} ${w.decidedAt}`}
        {w.usedAt && ` · used by ${w.usedBy} ${w.usedAt}`}
        {(w.state === "granted" || w.state === "requested") && ` · lapses ${w.expiresAt}`}
        {` · base ${w.base.slice(0, 10)} on ${w.targetRef}`}
      </small>
      <details><summary>Diff stat</summary><pre>{w.diffStat}</pre></details>
    </li>)}</ul>
  </section>;
}
