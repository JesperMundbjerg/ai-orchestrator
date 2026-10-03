import { useMemo, useRef, useState } from "react";
import { Background, Controls, Handle, Position, ReactFlow, useUpdateNodeInternals, type Node, type NodeProps, type NodeChange, type ReactFlowInstance } from "@xyflow/react";
import { useEffect } from "react";
import type { PipelineGraph, PipelineLayout, PipelineNode } from "../../shared/pipeline.ts";
import { ports } from "./model.ts";
import { cardSize } from "./layout.ts";

// Very tall repo graphs need a genuine overview, including on a narrow phone.
const minZoom = .005;
const fitOptions = { padding: .25, minZoom, maxZoom: 1.8 };
import "@xyflow/react/dist/style.css";

type StepNode = Node<{ step: PipelineNode; ports: string[]; size: { width: number; height: number } }, "pipeline">;
function Step({ id, data, selected }: NodeProps<StepNode>) {
  const update = useUpdateNodeInternals();
  const signature = data.ports.join("\0");
  useEffect(() => { update(id); }, [id, signature, update]);
  return <div style={data.size} className={`pipeline-node ${data.step.kind === "delivery" ? "terminal" : data.step.kind} ${selected ? "selected" : ""}`}>
    <Handle type="target" position={Position.Top} aria-label={`Connect into ${data.step.label}`} />
    <span className="pipeline-kind">{data.step.kind === "delivery" ? "Delivery boundary" : data.step.kind}</span>
    <strong>{data.step.label}</strong>
    <span className="pipeline-node-rule">{data.step.evidence?.join(" + ") || (data.step.kind === "condition" ? "First mate chooses" : "Lead-owned step")}</span>
    {data.step.kind === "condition" ? <div className="pipeline-ports">{data.ports.map((port) => <div key={port} className="pipeline-port">
      {port}<Handle type="source" position={Position.Bottom} id={port} aria-label={`${data.step.label}: ${port}`} />
    </div>)}</div> : data.step.kind !== "delivery" && <Handle type="source" position={Position.Bottom} aria-label={`Connect from ${data.step.label}`} />}
  </div>;
}
const nodeTypes = { pipeline: Step };

export function Canvas({ graph, layout, selected, onSelect, onLayout, onConnect, onDelete, disabled }: {
  graph: PipelineGraph; layout: PipelineLayout; selected: string | null; disabled: boolean;
  onSelect: (id: string | null) => void;
  onLayout: (positions: PipelineLayout) => void;
  onConnect: (from: string, to: string, port?: string) => void;
  onDelete: (nodeIds: string[], edgeIds: string[]) => void;
}) {
  const [selectedEdges, setSelectedEdges] = useState<string[]>([]);
  const container = useRef<HTMLDivElement>(null);
  const flow = useRef<ReactFlowInstance<StepNode>>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const resize = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => { void flow.current?.fitView(fitOptions); }, 100);
    });
    if (container.current) resize.observe(container.current);
    return () => { clearTimeout(timer); resize.disconnect(); };
  }, []);
  const nodes = useMemo<StepNode[]>(() => graph.nodes.map((step) => ({
    id: step.id, type: "pipeline", position: layout[step.id] ?? { x: 0, y: 0 }, selected: selected === step.id,
    data: { step, ports: ports(graph, step), size: cardSize(graph, step) }, ariaLabel: `${step.label}, ${step.kind}`,
  })), [graph, layout, selected]);
  const edges = useMemo(() => graph.edges.map((edge) => ({
    id: edge.id, source: edge.from, target: edge.to, sourceHandle: edge.port, selected: selectedEdges.includes(edge.id),
    label: [edge.port, edge.when ? `${edge.when.field} = ${String(edge.when.equals)}` : null].filter(Boolean).join(" · "),
  })), [graph.edges, selectedEdges]);
  const changeNodes = (changes: NodeChange<StepNode>[]) => {
    const positions = { ...layout };
    let moved = false;
    for (const change of changes) {
      if (change.type === "position" && change.position && !disabled) { positions[change.id] = change.position; moved = true; }
      if (change.type === "select" && change.selected) onSelect(change.id);
      else if (change.type === "select" && change.id === selected) onSelect(null);
    }
    if (moved) onLayout(positions);
  };
  return <div ref={container} style={{ width: "100%", height: "100%" }} onKeyDown={(event) => {
    if (!disabled && ["Delete", "Backspace"].includes(event.key) && !(event.target as HTMLElement).closest("input, textarea, select")) {
      event.preventDefault();
      void flow.current?.deleteElements({ nodes: nodes.filter((node) => node.selected), edges: edges.filter((edge) => edge.selected) });
    }
  }}><ReactFlow<StepNode> onInit={(instance) => { flow.current = instance; }} nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={changeNodes}
    onNodeClick={(_, node) => onSelect(node.id)} onPaneClick={() => onSelect(null)}
    onConnect={(connection) => onConnect(connection.source, connection.target, connection.sourceHandle ?? undefined)}
    onEdgesChange={(changes) => setSelectedEdges((selectedIds) => changes.reduce((ids, change) => change.type === "select" ? (change.selected ? [...new Set([...ids, change.id])] : ids.filter((id) => id !== change.id)) : ids, selectedIds))}
    onEdgeClick={() => onSelect(null)}
    onDelete={({ nodes: deletedNodes, edges: deletedEdges }) => onDelete(deletedNodes.map((node) => node.id), deletedEdges.map((edge) => edge.id))}
    nodesDraggable={!disabled} nodesConnectable={!disabled} elementsSelectable={!disabled}
    deleteKeyCode={null} fitView fitViewOptions={fitOptions} minZoom={minZoom} maxZoom={1.8}>
    <Background gap={22} size={1} color="var(--line)" /><Controls showInteractive={false} fitViewOptions={fitOptions} />
  </ReactFlow></div>;
}
