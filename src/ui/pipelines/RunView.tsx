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
  const run = runs.find((r) => r.id === selectedId) ?? runs[0];
  return <div className="pipeline-runs">
    <div className="row"><h3>Run ledger</h3><button className="ghost small" disabled={busy} onClick={refresh}>Refresh evidence</button></div>
    <p className="pipeline-help">Each run keeps its own graph and candidate. Editing the team default does not rewrite this evidence. Only the current first mate may complete steps.</p>
    {!run ? <p>No runs yet. The first mate starts a delivery wave with <code>inbox pipeline start</code>.</p> : <>
      <label>Run<select value={run.id} onChange={(event) => onSelect(event.target.value)}>{runs.map((r) => <option key={r.id} value={r.id}>{r.id} · {runSummary(r)}</option>)}</select></label>
      <p><strong>{run.graph.label}</strong> · {runSummary(run)} · {run.state}</p>
      <code>Candidate {run.candidate.head}<br />Round {run.round} · ledger revision {run.revision}<br />First mate {run.leadId ?? "not assigned"}</code>
      <p>{run.rationale || "No branch rationale recorded."}</p>
      <p className="pipeline-help">{Object.entries(run.selections).map(([field, value]) => `${run.graph.fields.find((f) => f.id === field)?.label ?? field}: ${String(value)}`).join(" · ")}</p>
      {run.state !== "delivered" && <p className="pipeline-notice">Not delivered. All active required steps need current evidence; a green ledger is not proof of publication.</p>}
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
    </>}
  </div>;
}
