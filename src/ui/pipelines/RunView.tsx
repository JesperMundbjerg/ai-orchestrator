import type { PipelineEvidence, PipelineRun } from "../../shared/pipeline.ts";
import { runSummary, safeEvidenceUrl, stepState } from "./model.ts";

function Evidence({ evidence }: { evidence: PipelineEvidence }) {
  const fileUrl = "fileUrl" in evidence && typeof evidence.fileUrl === "string" ? evidence.fileUrl : undefined;
  const url = safeEvidenceUrl(fileUrl) ?? safeEvidenceUrl(evidence.url);
  return <li>
    <strong>{evidence.kind}</strong> · {evidence.summary}
    {url && <> · <a href={url} target="_blank" rel="noopener noreferrer">Open evidence ↗</a></>}
    {evidence.approval && <> · <a href={`/#/needs?item=${encodeURIComponent(evidence.approval.itemId)}`} target="_blank" rel="noopener noreferrer">Approval · revision {evidence.approval.revision}</a></>}
    {evidence.review && <> · <a href="/#/teams" target="_blank" rel="noopener noreferrer">Review {evidence.review.workId} · round {evidence.review.round}</a></>}
    {evidence.path && <code>{evidence.path}</code>}
    {evidence.command && <code>{evidence.command} · exit {evidence.exitCode ?? "not recorded"}</code>}
    {" "}<small className="pipeline-evidence-by muted">Recorded by {evidence.byAgentId} · round {evidence.round}</small>
  </li>;
}

export function RunView({ runs, selectedId, onSelect, refresh, busy }: {
  runs: PipelineRun[]; selectedId: string; onSelect: (id: string) => void; refresh: () => void; busy: boolean;
}) {
  const ordered = [...runs].sort((a, b) => Number(a.state !== "open") - Number(b.state !== "open"));
  const run = ordered.find((r) => r.id === selectedId) ?? ordered[0];
  return <div className="pipeline-runs">
    <div className="row"><h3>Run ledger</h3><button className="ghost small" disabled={busy} onClick={refresh}>Refresh evidence</button></div>
    <p className="pipeline-help">Each run keeps its own graph and candidate. Editing the team default does not rewrite this evidence. Only the current first mate may complete steps.</p>
    {!run ? <p>No runs yet. The first mate starts a delivery wave with <code>inbox pipeline start</code>.</p> : <>
      <nav className="pipeline-run-ledger" aria-label="Runs">{ordered.map((r) => <button key={r.id} className={`ghost pipeline-run-entry${r.state === "abandoned" ? " pipeline-abandoned" : ""}`} aria-pressed={r.id === run.id} onClick={() => onSelect(r.id)}>
        <span>{r.id} · {r.state} · {runSummary(r)}</span>
        {r.abandonment && <small>Abandoned: {r.abandonment.notes}</small>}
      </button>)}</nav>
      <section className={run.state === "abandoned" ? "pipeline-abandoned" : undefined} aria-label="Selected run">
      <p><strong>{run.graph.label}</strong> · {runSummary(run)} · {run.state}</p>
      {run.abandonment && <p>Abandoned: {run.abandonment.notes} · recorded by {run.abandonment.byAgentId}</p>}
      <code>Base {run.candidate.base}<br />Candidate {run.candidate.head}<br />Round {run.round} · ledger revision {run.revision}<br />First mate {run.leadId ?? "not assigned"}</code>
      {!!run.rebases?.length && <details><summary>Re-base history ({run.rebases.length})</summary><ul>{run.rebases.map((r, i) => <li key={i}>
        <code>{r.oldBase} → {r.newBase}</code> · {r.notes}<br /><small>Recorded by {r.byAgentId} · {r.at}</small>
      </li>)}</ul></details>}
      <p>{run.rationale || "No branch rationale recorded."}</p>
      <p className="pipeline-help">{Object.entries(run.selections).map(([field, value]) => `${run.graph.fields.find((f) => f.id === field)?.label ?? field}: ${String(value)}`).join(" · ")}</p>
      {run.state === "open" && <p className="pipeline-notice">Not delivered. All active required steps need current evidence; a green ledger is not proof of publication.</p>}
      <ol>{run.graph.nodes.map((node) => {
        const step = run.steps.find((s) => s.nodeId === node.id);
        const status = stepState(step);
        return <li className="pipeline-run-step" key={node.id}>
          <header><strong>{node.label}</strong><span className={`pipeline-state ${status}`}>{status === "skipped" ? "not on branch" : status}</span></header>
          <p className="pipeline-help">{step?.state === "inactive" ? "Not on the selected branch" : step?.state === "blocked" ? "Waiting for prerequisites" : step?.state === "reported" ? "Report received; waiting for the first mate" : step?.state === "ready" ? "Ready for evidence" : status === "stale" ? "Candidate or run changed; evidence must be revalidated" : status === "done" ? "Completion recorded by the first mate" : "Waiting for the first mate"}{step?.assignedTo ? ` · assigned to ${step.assignedTo}` : ""}</p>
          {step?.notes && <p>{step.notes}</p>}
          {step?.evidence.length ? <ul>{step.evidence.map((evidence) => <Evidence key={evidence.id} evidence={evidence} />)}</ul> : <span className="muted">No evidence recorded.</span>}
        </li>;
      })}</ol>
      </section>
    </>}
  </div>;
}
