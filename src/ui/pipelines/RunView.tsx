import type { PipelineEvidence, PipelineRun } from "../../shared/pipeline.ts";
import { archivedText, nodeBinding } from "../../shared/pipeline.ts";
import { runSummary, safeEvidenceUrl, stepState } from "./model.ts";

function Evidence({ evidence, failsAsOnBase }: { evidence: PipelineEvidence; failsAsOnBase: boolean }) {
  const fileUrl = "fileUrl" in evidence && typeof evidence.fileUrl === "string" ? evidence.fileUrl : undefined;
  const url = safeEvidenceUrl(fileUrl) ?? safeEvidenceUrl(evidence.url);
  return <li>
    <strong>{evidence.kind}</strong> · {evidence.summary}
    {url && <> · <a href={url} target="_blank" rel="noopener noreferrer">Open evidence ↗</a></>}
    {evidence.approval && <> · <a href={`/#/needs?item=${encodeURIComponent(evidence.approval.itemId)}`} target="_blank" rel="noopener noreferrer">Approval · revision {evidence.approval.revision}</a></>}
    {evidence.review && <> · <a href="/#/teams" target="_blank" rel="noopener noreferrer">Review {evidence.review.workId} · round {evidence.review.round}</a></>}
    {evidence.path && <code>{evidence.path}</code>}
    {evidence.command && <code>{evidence.command} · exit {evidence.exitCode ?? "not recorded"}</code>}
    {evidence.onBase && <> · <span className="pipeline-baseline">Base record · ran on base {evidence.ranOn?.slice(0, 10) ?? "unknown"}</span></>}
    {!evidence.onBase && evidence.kind === "check" && evidence.exitCode !== 0 && <> · <span className="pipeline-baseline">{failsAsOnBase ? `fails as on base · exit ${evidence.exitCode}` : `failed · exit ${evidence.exitCode}`}</span></>}
    {" "}<small className="pipeline-evidence-by muted">Recorded by {evidence.byAgentId} · round {evidence.round} · {evidence.binding ?? "candidate"}-bound</small>
  </li>;
}

export function RunView({ runs, selectedId, onSelect, refresh, busy }: {
  runs: PipelineRun[]; selectedId: string; onSelect: (id: string) => void; refresh: () => void; busy: boolean;
}) {
  const ordered = [...runs].sort((a, b) => Number(a.state !== "open" || !!a.archived) - Number(b.state !== "open" || !!b.archived));
  const run = ordered.find((r) => r.id === selectedId) ?? ordered[0];
  return <div className="pipeline-runs">
    <div className="row"><h3>Run ledger</h3><button className="ghost small" disabled={busy} onClick={refresh}>Refresh evidence</button></div>
    <p className="pipeline-help">Each run keeps its own graph and candidate. Editing the team default does not rewrite this evidence. Only the current first mate may complete steps.</p>
    {!run ? <p>No runs yet. The first mate starts a delivery wave with <code>inbox pipeline start</code>.</p> : <>
      <nav className="pipeline-run-ledger" aria-label="Runs">{ordered.map((r) => <button key={r.id} className={`ghost pipeline-run-entry${r.state === "abandoned" || r.archived ? " pipeline-abandoned" : ""}`} aria-pressed={r.id === run.id} onClick={() => onSelect(r.id)}>
        <span>{r.id} · {r.state} · {runSummary(r)}</span>
        {r.abandonment && <small>Abandoned: {r.abandonment.notes}</small>}
        {r.archived && <small>Archived: {archivedText(r.archived)}</small>}
      </button>)}</nav>
      <section className={run.state === "abandoned" || run.archived ? "pipeline-abandoned" : undefined} aria-label="Selected run">
      <p><strong>{run.graph.label}</strong> · {runSummary(run)} · {run.state}</p>
      {run.abandonment && <p>Abandoned: {run.abandonment.notes} · recorded by {run.abandonment.byAgentId}</p>}
      {run.archived && <p>Archived: {archivedText(run.archived)} · {run.archived.at}. Kept as recorded; it can never be edited or delivered.</p>}
      <code>Base {run.candidate.base}<br />Candidate {run.candidate.head}<br />Round {run.round} · ledger revision {run.revision}<br />First mate {run.leadId ?? "not assigned"}</code>
      {!!run.rebases?.length && <details><summary>Re-base history ({run.rebases.length})</summary><ul>{run.rebases.map((r, i) => <li key={i}>
        <code>{r.oldBase} → {r.newBase}</code> · {r.notes}<br /><small>Recorded by {r.byAgentId} · {r.at}</small>
      </li>)}</ul></details>}
      <p>{run.rationale || "No branch rationale recorded."}</p>
      <p className="pipeline-help">{Object.entries(run.selections).map(([field, value]) => `${run.graph.fields.find((f) => f.id === field)?.label ?? field}: ${String(value)}`).join(" · ")}</p>
      {run.state === "open" && !run.archived && <p className="pipeline-notice">Not delivered. All active required steps need current evidence; a green ledger is not proof of publication.</p>}
      <ol>{run.graph.nodes.map((node) => {
        const step = run.steps.find((s) => s.nodeId === node.id);
        const status = stepState(step, run);
        return <li className="pipeline-run-step" key={node.id}>
          <header><strong>{node.label}</strong><span className={`pipeline-state ${status}${step?.baselineFailures?.length ? " baseline" : ""}`}>{status === "skipped" ? "not on branch" : status}{step?.baselineFailures?.length && (status === "done" || (status === "waiting" && step.state === "reported")) ? " · fails as on base" : ""}</span></header>
          <small className="muted">{nodeBinding(node) === "run" ? "Run-bound · this round and selected scope" : "Candidate-bound · final intended bytes"}</small>
          <p className="pipeline-help">{step?.state === "inactive" ? "Not on the selected branch" : status === "abandoned" ? "Never done: the run was abandoned" : status === "archived" ? "Never done: the run was archived with its team" : step?.state === "blocked" ? "Waiting for prerequisites" : step?.state === "reported" ? "Report received; waiting for the first mate" : step?.state === "ready" ? "Ready for evidence" : status === "stale" ? (step?.problems?.length ? `Not counted (the delivery gate refuses it too): ${step.problems.join("; ")}` : "Candidate or run changed; evidence must be revalidated") : status === "done" ? "Completion recorded by the first mate" : "Waiting for the first mate"}{step?.assignedTo ? ` · assigned to ${step.assignedTo}` : ""}</p>
          {step?.notes && <p>{step.notes}</p>}
          {step?.evidence.length ? <ul>{step.evidence.map((evidence) => <Evidence key={evidence.id} evidence={evidence} failsAsOnBase={Boolean(step.baselineFailures?.some(f => f.startsWith(`\`${evidence.command?.trim()}\` exit ${evidence.exitCode} `)))} />)}</ul> : <span className="muted">No evidence recorded.</span>}
        </li>;
      })}</ol>
      </section>
    </>}
  </div>;
}
