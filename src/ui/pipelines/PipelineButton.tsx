import { Component, lazy, Suspense, useState, type ReactNode } from "react";

// Neither the canvas library nor its styles enter the board/office's initial bundle.
const PipelineEditor = lazy(() => import("./PipelineEditor.tsx"));

class LoadBoundary extends Component<{ children: ReactNode; close: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <span role="alert">Pipeline editor could not load. <button className="ghost small" onClick={this.props.close}>Close</button></span> : this.props.children;
  }
}

export function PipelineButton({ teamId, teamName }: { teamId: string; teamName: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <button className="ghost small" onClick={() => setOpen(true)} aria-label={`Pipeline for ${teamName}`}>Pipeline</button>
    {open && <LoadBoundary close={() => setOpen(false)}><Suspense fallback={<span role="status">Loading pipeline…</span>}>
      <PipelineEditor teamId={teamId} teamName={teamName} onClose={() => setOpen(false)} />
    </Suspense></LoadBoundary>}
  </>;
}
