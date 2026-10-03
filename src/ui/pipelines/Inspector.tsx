import { useState } from "react";
import type { PipelineEvidenceKind, PipelineField, PipelineGraph, PipelineLayout, PipelineNode } from "../../shared/pipeline.ts";
import { ports } from "./model.ts";
import { nodeBinding } from "../../shared/pipeline.ts";

const evidenceKinds: PipelineEvidenceKind[] = ["report", "check", "artifact", "review", "approval"];
export function Inspector({ graph, node, layout, disabled, onGraph, onLayout, onConnect, onRemove }: {
  graph: PipelineGraph; node: PipelineNode; layout: PipelineLayout; disabled: boolean;
  onGraph: (graph: PipelineGraph) => void; onLayout: (positions: PipelineLayout) => void;
  onConnect: (from: string, to: string, port?: string) => void; onRemove: () => void;
}) {
  const [target, setTarget] = useState("");
  const [branch, setBranch] = useState("");
  const field = graph.fields.find((f) => f.id === node.field);
  const update = (patch: Partial<PipelineNode>) => onGraph({ ...graph, nodes: graph.nodes.map((n) => n.id === node.id ? { ...n, ...patch } : n) });
  const updateField = (patch: Partial<PipelineField>) => {
    if (field) onGraph({ ...graph, fields: graph.fields.map((f) => f.id === field.id ? { ...f, ...patch } : f) });
  };
  const choices = ports(graph, node);
  const chosenBranch = choices.includes(branch) ? branch : choices[0];
  const outgoing = graph.edges.filter((edge) => edge.from === node.id);
  return <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
    <h3>Step inspector</h3>
    <span className="pipeline-badge">Required on the chosen branches</span>
    <p className="pipeline-help">Every activated step is required. All selected evidence kinds are needed; only the first mate records completion.</p>
    <label>Step name<input value={node.label} onChange={(event) => update({ label: event.target.value })} /></label>
    <span className="pipeline-source">{node.source ?? "Custom step"}</span>
    <label><input type="checkbox" checked={graph.entry === node.id} onChange={(event) => onGraph({ ...graph, entry: event.target.checked ? node.id : "" })} /> Entry step</label>
    {node.kind === "condition" ? <>
      <label>Condition field<select aria-label="Condition field" value={node.field ?? ""} onChange={(event) => update({ field: event.target.value })}>
        <option value="">Choose a field</option>{graph.fields.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
      </select></label>
      {field && <>
        <label>Branch question<input value={field.label} onChange={(event) => updateField({ label: event.target.value })} /></label>
        <label>Branch type<select aria-label="Branch type" value={field.type} onChange={(event) => updateField(event.target.value === "boolean" ? { type: "boolean", options: undefined } : { type: "enum", options: ["if", "else"] })}><option value="boolean">Boolean · true / false</option><option value="enum">Named branches</option></select></label>
        {field.type === "enum" && <label>Branch labels · one per line<textarea key={`${field.id}-${field.type}`} defaultValue={field.options?.join("\n")} onBlur={(event) => updateField({ options: [...new Set(event.target.value.split("\n").map((s) => s.trim()).filter(Boolean))] })} /></label>}
        <p className="pipeline-help">Changing a shared field affects every condition using it. Reconnect removed branches.</p>
      </>}
    </> : <>
      <h4>Evidence rule · all of</h4>
      {evidenceKinds.map((kind) => <label key={kind}><input type="checkbox" disabled={node.kind === "approval" && kind === "approval"} checked={node.evidence?.includes(kind) ?? false} onChange={(event) => update({ evidence: event.target.checked ? [...(node.evidence ?? []), kind] : node.evidence?.filter((k) => k !== kind) })} /> {kind}</label>)}
    </>}
    {node.kind === "step" && <label>Evidence binding<select aria-label="Evidence binding" value={nodeBinding(node)} onChange={(event) => update({ binding: event.target.value as PipelineNode["binding"] })}>
      <option value="candidate">Candidate · final intended bytes</option>
      <option value="run" disabled={node.evidence?.some(k => ["check", "review", "approval"].includes(k))}>Run · planning for this round and scope</option>
    </select></label>}
    {node.kind === "condition" && <p className="pipeline-help">Branch selections describe the run, not candidate bytes.</p>}
    {node.kind === "delivery" && <label>Delivery boundary<select aria-label="Delivery boundary" value={node.delivery ?? "handoff"} onChange={(event) => update({ delivery: event.target.value as PipelineNode["delivery"] })}><option value="handoff">Hand off to a team</option><option value="review">Accept a team's result</option><option value="dev">Deliver to dev</option></select></label>}
    <label>Instructions / evidence guidance<textarea value={node.instructions ?? ""} onChange={(event) => update({ instructions: event.target.value || undefined })} /></label>
    <p className="pipeline-help">Guidance only. The office never executes these instructions.</p>
    <h4>Position · layout only</h4>
    <div className="pipeline-coordinates">{(["x", "y"] as const).map((axis) => <label key={axis}>{axis.toUpperCase()}<input type="number" value={Math.round(layout[node.id]?.[axis] ?? 0)} onChange={(event) => {
      const value = event.target.valueAsNumber;
      if (Number.isFinite(value)) onLayout({ ...layout, [node.id]: { ...(layout[node.id] ?? { x: 0, y: 0 }), [axis]: value } });
    }} /></label>)}</div>
    <h4>Connections</h4>
    {outgoing.map((edge) => <div className="pipeline-edge" key={edge.id}><span>{edge.port ? `${edge.port} → ` : "→ "}{graph.nodes.find((n) => n.id === edge.to)?.label ?? `Missing: ${edge.to}`}{edge.when ? ` (${edge.when.field} = ${String(edge.when.equals)})` : ""}</span><button className="ghost small" onClick={() => onGraph({ ...graph, edges: graph.edges.filter((e) => e.id !== edge.id) })} aria-label={`Delete connection ${edge.id}`}>×</button></div>)}
    {node.kind !== "delivery" && <>
      {node.kind === "condition" && <label>From branch<select aria-label="From branch" value={chosenBranch ?? ""} onChange={(event) => setBranch(event.target.value)}>{choices.map((port) => <option key={port}>{port}</option>)}</select></label>}
      <label>Connect to<select aria-label="Connect to" value={target} onChange={(event) => setTarget(event.target.value)}><option value="">Choose a step</option>{graph.nodes.filter((n) => n.id !== node.id).map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}</select></label>
      <button className="ghost small" disabled={!target || (node.kind === "condition" && !chosenBranch)} onClick={() => onConnect(node.id, target, node.kind === "condition" ? chosenBranch : undefined)}>Add connection</button>
    </>}
    <h4>Remove</h4><button className="ghost small danger" onClick={onRemove}>Delete step and its connections</button>
  </fieldset>;
}
