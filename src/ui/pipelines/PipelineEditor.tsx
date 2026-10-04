import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PipelineDefinition, PipelineGraph, PipelineLayout, PipelinePalette, PipelineTeamView } from "../../shared/pipeline.ts";
import { pipelineApi, PipelineRequestError } from "./api.ts";
import { Canvas } from "./Canvas.tsx";
import { Inspector } from "./Inspector.tsx";
import { RunView } from "./RunView.tsx";
import { WaiverList } from "./WaiverList.tsx";
import { builtins, connect, graphWarnings, mergeProblems, nodeFromDefinition, positionsFor, removeNode } from "./model.ts";
import { tidyLayout } from "./layout.ts";
import { useChangeSignal } from "../hooks.ts";
import "./pipelines.css";

const emptyGraph = (teamId: string, teamName: string): PipelineGraph => ({ version: 1, id: `team-${teamId}`, label: `${teamName} delivery`, fields: [], nodes: [], edges: [], entry: "" });

export default function PipelineEditor({ teamId, teamName, onClose }: { teamId: string; teamName: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const tick = useChangeSignal();
  const [view, setView] = useState<PipelineTeamView | null>(null);
  const [palette, setPalette] = useState<PipelinePalette | null>(null);
  const [graph, setGraph] = useState<PipelineGraph>(() => emptyGraph(teamId, teamName));
  const [layout, setLayout] = useState<PipelineLayout>({});
  const [graphDirty, setGraphDirty] = useState(false);
  const [layoutDirty, setLayoutDirty] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<"canvas" | "list" | "run">("canvas");
  const [selectedRun, setSelectedRun] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState("");
  const dirty = graphDirty || layoutDirty;
  const apply = useCallback((next: PipelineTeamView) => {
    const nextGraph = next.graph ?? emptyGraph(teamId, teamName);
    setView(next); setGraph(nextGraph); setLayout(positionsFor(nextGraph, next.layout));
    setGraphDirty(false); setLayoutDirty(false); setSelected(null); setConflict(false); setError(null);
  }, [teamId, teamName]);
  const fail = (reason: unknown) => {
    setError(reason instanceof Error ? reason.message : String(reason));
    if (reason instanceof PipelineRequestError && reason.status === 409) setConflict(true);
  };
  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [next, entries] = await Promise.all([pipelineApi.team(teamId), pipelineApi.palette(teamId)]);
      apply(next); setPalette(entries);
    } catch (reason) { fail(reason); } finally { setBusy(false); }
  }, [teamId, apply]);
  useEffect(() => { void load(); }, [load]);
  // The office's changed SSE signal (also bumped on reconnect) invalidates the
  // ledger. Adopt runs only: live updates must never discard drafts or advance
  // their optimistic policy/layout locks behind the user's back.
  useEffect(() => {
    if (busy) return;
    let live = true;
    pipelineApi.team(teamId).then((next) => {
      if (!live) return;
      setView((current) => current ? { ...current, runs: next.runs } : current);
      setRunsError(null);
    }, (reason: unknown) => {
      if (live) setRunsError(`Live evidence refresh failed; displayed runs may be outdated. ${reason instanceof Error ? reason.message : String(reason)}`);
    });
    return () => { live = false; };
  }, [teamId, tick, busy]);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  const close = () => { if (!busy && (!dirty || window.confirm("Discard unsaved pipeline and layout changes?"))) onClose(); };
  const changeGraph = (next: PipelineGraph) => { if (!busy) { setGraph(next); setGraphDirty(true); setNotice(""); } };
  const changeLayout = (next: PipelineLayout) => { if (!busy) { setLayout(next); setLayoutDirty(true); setNotice(""); } };
  const add = (definition: PipelineDefinition) => {
    const id = `n-${crypto.randomUUID()}`;
    const node = nodeFromDefinition(definition, id);
    changeGraph({ ...graph, nodes: [...graph.nodes, node], entry: graph.entry || id,
      fields: node.kind === "condition" ? [...graph.fields, { id: node.field!, label: definition.label, type: "boolean" }] : graph.fields });
    changeLayout({ ...layout, [id]: { x: (graph.nodes.length % 3) * 280, y: Math.floor(graph.nodes.length / 3) * 180 } });
    setSelected(id);
  };
  const wire = (from: string, to: string, port?: string) => changeGraph(connect(graph, from, to, port));
  const remove = (ids: string[], edgeIds: string[] = []) => {
    const next = ids.reduce((current, id) => removeNode(current, id), graph);
    changeGraph({ ...next, edges: next.edges.filter((edge) => !edgeIds.includes(edge.id)) });
    if (ids.length) { const positions = { ...layout }; ids.forEach((id) => delete positions[id]); changeLayout(positions); }
    if (selected && ids.includes(selected)) setSelected(null);
  };
  const saveGraph = async () => {
    if (!view) return;
    setBusy(true); setError(null);
    try {
      const next = await pipelineApi.save(teamId, { expectedRevision: view.revision, graph });
      setView({ ...next, layoutRevision: view.layoutRevision }); setGraph(next.graph ?? graph); setGraphDirty(false); setConflict(false);
      setNotice("Team override saved. Existing runs keep their snapshots.");
    } catch (reason) { fail(reason); } finally { setBusy(false); }
  };
  const saveLayout = async () => {
    if (!view) return;
    setBusy(true); setError(null);
    try {
      const next = await pipelineApi.layout(teamId, { expectedRevision: view.layoutRevision, positions: layout });
      // A layout response must not silently adopt a concurrently changed policy revision.
      setView({ ...view, layoutRevision: next.layoutRevision, layout: next.layout });
      setLayoutDirty(false); setNotice("Layout saved. Inheritance and evidence are unchanged.");
    } catch (reason) { fail(reason); } finally { setBusy(false); }
  };
  const reset = async () => {
    if (!view || !window.confirm("Reset this team's policy to the repo default? Unsaved policy edits will be discarded. Layout and existing run snapshots stay separate.")) return;
    setBusy(true); setError(null);
    try {
      const next = await pipelineApi.save(teamId, { expectedRevision: view.revision, graph: null });
      setView({ ...next, layoutRevision: view.layoutRevision }); setGraph(next.graph ?? emptyGraph(teamId, teamName)); setGraphDirty(false); setSelected(null); setConflict(false);
      setLayout(positionsFor(next.graph ?? emptyGraph(teamId, teamName), layout));
      setNotice("Reset to repo default. Existing runs were not rewritten.");
    } catch (reason) { fail(reason); } finally { setBusy(false); }
  };
  const refreshRuns = async () => {
    setBusy(true); setError(null);
    try { const next = await pipelineApi.team(teamId); setView((current) => current ? { ...current, runs: next.runs } : current); setRunsError(null); }
    catch (reason) { fail(reason); } finally { setBusy(false); }
  };
  const exportProposal = () => {
    const blob = new Blob([JSON.stringify({ pipeline: graph }, null, 2) + "\n"], { type: "application/json" });
    const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
    anchor.href = url; anchor.download = "pipeline-proposal.json"; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice("Exported a proposed orchestrator.json pipeline field. The repository was not changed.");
  };
  const problems = mergeProblems(view?.problems, palette?.problems);
  const warnings = graph.nodes.length ? graphWarnings(graph) : [];
  const node = graph.nodes.find((n) => n.id === selected);
  const definitions = [...(palette?.entries ?? []), ...builtins.filter((d) => !palette?.entries.some((e) => e.id === d.id))];
  const matches = definitions.filter((d) => `${d.label} ${d.description} ${d.path ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  return createPortal(<dialog ref={dialog} className="pipeline-dialog" aria-label={`Pipeline for ${teamName}`} onCancel={(event) => { event.preventDefault(); close(); }} onKeyDown={(event) => event.stopPropagation()}>
    <div className="pipeline-editor" aria-busy={busy}>
      <header className="pipeline-head"><div><h2>{teamName} · Pipeline</h2><p>Plan the obligations. The first mate owns the run.</p></div>
        {view && <span className="pipeline-badge">{view.source === "repo" ? "Inherited from repo" : view.source === "team" ? "Team override" : "No repo default"}{graphDirty ? " · edited" : ""}</span>}
        <button className="ghost small" onClick={close} disabled={busy} aria-label="Close pipeline">Close <kbd>Esc</kbd></button>
      </header>
      <nav className="pipeline-toolbar" aria-label="Pipeline views">
        {(["canvas", "list", "run"] as const).map((tab) => <button className="ghost small" key={tab} aria-pressed={mode === tab} onClick={() => setMode(tab)}>{tab === "canvas" ? "Canvas" : tab === "list" ? "List & keyboard" : `Runs${view?.runs.length ? ` (${view.runs.length})` : ""}`}</button>)}
        <span className="spacer" />
        {mode !== "run" && <><button className="ghost small" disabled={busy || !graph.nodes.length} onClick={() => { changeLayout(tidyLayout(graph)); setNotice("Layout tidied top-down. Save layout to keep it; policy and evidence are unchanged."); }}>Tidy layout</button><button className="ghost small" disabled={busy || graphDirty || !layoutDirty || !view || conflict} onClick={() => void saveLayout()}>Save layout</button><button className="primary small" disabled={busy || !graphDirty || !graph.nodes.length || warnings.length > 0 || !view || conflict} onClick={() => void saveGraph()}>Save team override</button></>}
      </nav>
      {error && <div className="pipeline-notice warn" role="alert">{conflict ? "Another editor changed this pipeline. Your draft is still here. Export it or reload; nothing was overwritten. " : ""}{error} <button className="ghost small" disabled={busy} onClick={() => { if (!dirty || window.confirm("Reload from the office and discard your unsaved edits?")) void load(); }}>Reload from office</button></div>}
      {mode === "run" && runsError && <p className="pipeline-notice warn" role="alert">{runsError}</p>}
      {notice && <p className="pipeline-notice" role="status">{notice}</p>}
      {problems.length ? <div className="pipeline-notice" role="alert"><strong>Office validation / discovery</strong><ul>{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul></div> : null}
      {mode !== "run" && warnings.length > 0 && <div className="pipeline-notice warn" role="alert"><strong>Draft warnings</strong><ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}
      {!view ? <div className="pipeline-empty">{busy ? "Loading the team pipeline…" : "Pipeline unavailable. No local mock or default has been substituted."}</div> : mode === "run" ? <><RunView runs={view.runs} selectedId={selectedRun} onSelect={setSelectedRun} refresh={() => void refreshRuns()} busy={busy} /><WaiverList teamId={teamId} tick={tick} /></> : <div className="pipeline-body">
        <aside className="pipeline-palette" aria-label="Step palette"><h3>Add a step</h3><p className="pipeline-help">Choose a repo definition or a built-in obligation.</p><input type="search" aria-label="Search discovered steps" placeholder="Find a step…" value={query} onChange={(event) => setQuery(event.target.value)} />
          {(["agent", "skill", "command", "builtin"] as const).map((kind) => <section key={kind}><h4>{kind === "builtin" ? "Built-ins" : `Repo ${kind}s`}</h4><div className="pipeline-palette-items">{matches.filter((d) => d.kind === kind).map((definition) => <button className="pipeline-palette-item" disabled={busy} key={definition.id} title={[definition.description, definition.path, definition.hash].filter(Boolean).join("\n")} onClick={() => add(definition)}>{definition.label}<small>{definition.description || definition.path}</small></button>)}</div>{!matches.some((d) => d.kind === kind) && <p className="pipeline-help">{query ? "No matches" : "None discovered"}</p>}</section>)}
        </aside>
        <section className="pipeline-canvas" aria-label="Pipeline graph">{mode === "canvas" ? <Canvas graph={graph} layout={layout} selected={selected} disabled={busy} onSelect={setSelected} onLayout={changeLayout} onConnect={wire} onDelete={remove} /> : <div className="pipeline-list"><h3>Steps & connections</h3><p className="pipeline-help">Select a step to edit its position, branches and connections without dragging.</p><ol>{graph.nodes.map((n) => <li key={n.id} className={selected === n.id ? "selected" : ""}><button className="link" onClick={() => setSelected(n.id)}><strong>{n.label}</strong><br /><small>{n.kind}{graph.entry === n.id ? " · entry" : ""} · {n.evidence?.join(" + ") || "no evidence rule"}</small></button></li>)}</ol><h4>All connections</h4>{graph.edges.map((edge) => <div className="pipeline-edge" key={edge.id}><span>{graph.nodes.find((n) => n.id === edge.from)?.label ?? edge.from} {edge.port ? `(${edge.port})` : ""} → {graph.nodes.find((n) => n.id === edge.to)?.label ?? edge.to}</span><button className="ghost small" disabled={busy} onClick={() => changeGraph({ ...graph, edges: graph.edges.filter((e) => e.id !== edge.id) })} aria-label={`Delete connection ${edge.id}`}>×</button></div>)}</div>}
          {!graph.nodes.length && <div className="pipeline-empty" style={{ position: "absolute", inset: "30% 10%", pointerEvents: "none" }}>Start with a step from the palette. Connect obligations to a delivery boundary.</div>}
        </section>
        <aside className="pipeline-inspector" aria-label="Pipeline inspector">{node ? <><button className="ghost small" style={{ marginBottom: 14 }} onClick={() => setSelected(null)}>← Team policy</button><Inspector key={node.id} graph={graph} node={node} layout={layout} disabled={busy} onGraph={changeGraph} onLayout={changeLayout} onConnect={wire} onRemove={() => remove([node.id])} /></> : <><h3>Team policy</h3><label>Pipeline name<input value={graph.label} disabled={busy} onChange={(event) => changeGraph({ ...graph, label: event.target.value })} /></label><p className="pipeline-help">Select a step to inspect its evidence rule. Drag handles to connect steps, or use List & keyboard.</p><p className="pipeline-help">Layout is saved separately: moving steps never freezes inheritance or invalidates evidence.</p>{view.repoRoot && <code className="pipeline-source">{view.repoRoot}</code>}<h4>Repo inheritance</h4><button className="ghost small" disabled={busy || view.source !== "team" || conflict} onClick={() => void reset()}>Reset to repo default</button><p className="pipeline-help">Policy changes affect new runs. Existing runs keep their graph snapshots.</p><button className="ghost small" onClick={exportProposal} disabled={!graph.nodes.length}>Export repo proposal</button><p className="pipeline-help">Downloads the proposed pipeline field; never writes the repo.</p>{graph.pathRules?.length ? <><h4>Path guards · preserved</h4>{graph.pathRules.map((rule, index) => <p className="pipeline-help" key={index}>{rule.message}</p>)}</> : null}</>}</aside>
      </div>}
      <footer className="pipeline-foot"><p>{view ? `Policy revision ${view.revision} · Layout revision ${view.layoutRevision}` : "Office connection required"}{dirty ? ` · Unsaved ${[graphDirty ? "policy" : "", layoutDirty ? "layout" : ""].filter(Boolean).join(" + ")}` : ""}</p><span className="spacer" /><p>Client warnings are advisory. The office validates every save and delivery.</p></footer>
    </div>
  </dialog>, document.body);
}
