import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AllLeadsResult, WorldState } from "../../shared/types.ts";
import { api } from "../api.ts";
import { SEND_HINT, sendOnEnter } from "../sendKey.ts";
import { AttachedImages, useAttachments } from "./Attach.tsx";
import "./TellAllLeads.css";

/** The same founder broadcast composer in the office and on the Projects board. */
export function TellAllLeads({ world }: { world: WorldState }) {
  const [open, setOpen] = useState(false);
  return <>
    <button className="ghost small" onClick={() => setOpen(true)}>Tell all leads</button>
    {open ? createPortal(<Composer world={world} onClose={() => setOpen(false)} />, document.body) : null}
  </>;
}

function Composer({ world, onClose }: { world: WorldState; onClose: () => void }) {
  const leads = world.agents.filter((a) => a.role === "lead" && world.teams.some((t) => t.id === a.teamId));
  // Freeze the checked list on opening: a newly arrived lead must not silently join a draft.
  const [selected, setSelected] = useState(() => leads.map((a) => a.id));
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AllLeadsResult | null>(null);
  const attachments = useAttachments();
  const dialog = useRef<HTMLDialogElement>(null);
  const inFlight = useRef(false);
  const attempt = useRef<{ signature: string; clientId: string } | null>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const canSend = selected.length > 0 && Boolean(text.trim() || attachments.ids.length) && !attachments.uploading && !sending;
  const send = () => {
    if (!canSend || inFlight.current) return;
    const body = { text, images: attachments.ids, leadIds: selected };
    const signature = JSON.stringify(body);
    if (attempt.current?.signature !== signature) attempt.current = { signature, clientId: crypto.randomUUID() };
    inFlight.current = true;
    setSending(true);
    setError(null);
    api.tellAllLeads({ ...body, clientId: attempt.current.clientId }).then(
      (sent) => { setResult(sent); attachments.clear(); },
      (e: Error) => setError(e.message),
    ).finally(() => { inFlight.current = false; setSending(false); });
  };
  const name = (id: string) => world.agents.find((a) => a.id === id)?.name ?? id;
  const project = (id: string) => world.teams.find((t) => t.id === id)?.name ?? id;
  const noLead = world.teams.filter((t) => !leads.some((a) => a.teamId === t.id));
  return <dialog ref={dialog} className="all-leads-dialog" aria-labelledby="all-leads-title" onCancel={(e) => { e.preventDefault(); if (!sending) onClose(); }} onKeyDown={(e) => e.stopPropagation()}>
    <div className="panel-head">
      <h2 id="all-leads-title">Tell all leads</h2>
      <button className="ghost small" disabled={sending} onClick={onClose} aria-label="Close Tell all leads">✕</button>
    </div>
    {result ? <div role="status">
      <p>Sent to {result.message.deliveries.length} {result.message.deliveries.length === 1 ? "lead" : "leads"}: {result.message.deliveries.map((d) => name(d.agentId)).join(", ")}.</p>
      {result.queuedOffline.length ? <p>Queued for offline leads: {result.queuedOffline.map(name).join(", ")}. They will hear it when back and free.</p> : <p>Each instruction waits until its lead is free.</p>}
      {result.skippedTeams.length ? <p>No lead; skipped: {result.skippedTeams.map(project).join(", ")}.</p> : null}
      <p className="muted">Marked “All-leads broadcast” in each recipient project's thread. Read their answers there or in each lead's conversation.</p>
      <button className="primary small" onClick={onClose}>Done</button>
    </div> : <form className={`instruct${attachments.dragging ? " dropping" : ""}`} {...attachments.drop} onSubmit={(e) => { e.preventDefault(); send(); }}>
      <p className="muted">One instruction to every checked lead, including standing teams. Offline leads stay queued until they return.</p>
      <fieldset disabled={sending} className="all-leads-list">
        <legend>Who will hear it · {selected.length} selected</legend>
        {leads.map((a) => <label key={a.id}>
          <input type="checkbox" checked={selected.includes(a.id)} onChange={(e) => setSelected((ids) => e.target.checked ? [...ids, a.id] : ids.filter((id) => id !== a.id))} />
          <span><strong>{a.name}</strong> · {project(a.teamId!)}{!a.paneId ? <span className="muted"> · offline, will queue</span> : null}</span>
        </label>)}
        {!leads.length ? <p className="muted">No leads yet.</p> : null}
      </fieldset>
      {noLead.length ? <p className="muted small-note">No lead; skipped: {noLead.map((t) => t.name).join(", ")}.</p> : null}
      <textarea autoFocus aria-label="Message to all leads" rows={4} placeholder="What should the leads know or do?" value={text} disabled={sending} onChange={(e) => setText(e.target.value)} onPaste={attachments.onPaste} onKeyDown={sendOnEnter(send)} />
      <AttachedImages attachments={attachments} />
      <div className="row">
        <button type="submit" className="primary small" disabled={!canSend}>{sending ? "Sending…" : `Send to ${selected.length} ${selected.length === 1 ? "lead" : "leads"}`}</button>
        <span className="muted small-note">{SEND_HINT}. Paste or drop images.</span>
      </div>
      {error ? <div className="warn" role="alert">{error}</div> : null}
    </form>}
  </dialog>;
}
