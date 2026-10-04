import { Component, lazy, Suspense, useEffect, useState, type ErrorInfo, type ReactNode } from "react";
import { browserEnvironment, describeLoadFailure, importWithRecovery, rememberReopen, takeReopen } from "./load.ts";

// Neither the canvas library nor its styles enter the board/office's initial bundle.
let requestedBy = "";
const loadEditor = () => lazy(() => {
  const env = browserEnvironment();
  return importWithRecovery(() => import("./PipelineEditor.tsx"), { ...env, reload: () => { rememberReopen(env.storage, requestedBy, env.now()); env.reload(); } });
});
// React caches a rejected lazy forever; a failed one is replaced when its notice is closed.
let PipelineEditor = loadEditor();

class LoadBoundary extends Component<{ children: ReactNode; close: () => void }, { error: unknown; failed: boolean }> {
  state = { error: null as unknown, failed: false };
  static getDerivedStateFromError(error: unknown) { return { error, failed: true }; }
  componentDidCatch(error: unknown, info: ErrorInfo) { console.error("Pipeline editor failed:", error, info.componentStack); }
  render() {
    if (!this.state.failed) return this.props.children;
    const notice = describeLoadFailure(this.state.error);
    return <span role="alert" data-failure={notice.kind}>{notice.message} <small>{notice.detail}</small>{" "}
      {notice.canReload && <button className="ghost small" onClick={() => window.location.reload()}>Reload page</button>}{" "}
      <button className="ghost small" onClick={() => { PipelineEditor = loadEditor(); this.props.close(); }}>Close</button></span>;
  }
}

export function PipelineButton({ teamId, teamName }: { teamId: string; teamName: string }) {
  const [open, setOpen] = useState(false);
  // After the one automatic reload for a stale chunk, come back to the editor the founder asked for.
  useEffect(() => { const env = browserEnvironment(); if (takeReopen(env.storage, teamId, env.now())) { requestedBy = teamId; setOpen(true); } }, [teamId]);
  return <>
    <button className="ghost small" onClick={() => { requestedBy = teamId; setOpen(true); }} aria-label={`Pipeline for ${teamName}`}>Pipeline</button>
    {open && <LoadBoundary close={() => setOpen(false)}><Suspense fallback={<span role="status">Loading pipeline…</span>}>
      <PipelineEditor teamId={teamId} teamName={teamName} onClose={() => setOpen(false)} />
    </Suspense></LoadBoundary>}
  </>;
}
