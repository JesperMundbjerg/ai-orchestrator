import { useState } from "react";
import type { ItemDetail, ReplyAction } from "../../shared/types.ts";
import { api } from "../api.ts";
import { deliveryLabel, snoozeChoices } from "../format.ts";
import { enterPlan, SEND_HINT, sendOnEnter } from "../sendKey.ts";
import { AttachedImages, useAttachments, type Attachments } from "./Attach.tsx";
import { recommendedOption } from "./decision.ts";

/**
 * The answer area. Each type has one primary action; Discuss and Later are always there, and a
 * choice never prevents writing more. Each send carries a fresh delivery id, so a retried
 * request cannot become a second answer.
 */
export function Respond({ detail, onNext, onDone, onOpenPreview, onAnswered, othersWaiting = onNext !== null }: { detail: ItemDetail; onNext: (() => void) | null; onDone?: () => void; onOpenPreview: () => void; onAnswered?: () => void; othersWaiting?: boolean }) {
  const { item, replies } = detail;
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"answer" | "discuss">("answer");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showLater, setShowLater] = useState(false);
  const [showNote, setShowNote] = useState(false);
  const recommended = recommendedOption(item.options, item.recommendation);
  const attachments = useAttachments();
  const last = replies.at(-1);
  // Something to say: words, or images you pasted or dropped. Nothing is sent while an image is still uploading.
  const said = Boolean(text.trim() || attachments.ids.length);
  const waiting = busy || attachments.uploading;

  const send = async (action: ReplyAction, extra: { choice?: string } = {}) => {
    setBusy(true);
    setError(null);
    try {
      await api.answer(item.id, { id: crypto.randomUUID(), revision: item.revision, action, text, images: attachments.ids, ...extra });
      setText("");
      attachments.clear();
      setMode("answer");
      if (item.type === "decide") onAnswered?.();
      else onDone?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Snoozing or marking handled also moves on, but only once the service has said yes.
  const putAside = async (request: Promise<unknown>) => {
    setError(null);
    try {
      await request;
      onDone?.();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (item.state === "answer_queued" || item.state === "delivered") {
    return (
      <footer className={`respond answered${attachments.dragging ? " dropping" : ""}`} {...attachments.drop}>
        {last ? <div className={`delivery ${last.state}`}>{deliveryLabel(last)}</div> : null}
        <div className="row">
          <button className="ghost small" onClick={() => setMode("discuss")}>Add a message</button>
          {onNext ? <button className="primary small" onClick={onNext}>Next needing you <kbd>n</kbd></button> : null}
        </div>
        {mode === "discuss" ? <Discuss text={text} setText={setText} attachments={attachments} busy={waiting} said={said} onSend={() => void send("discuss")} onCancel={() => setMode("answer")} /> : null}
        {error ? <div className="warn">{error}</div> : null}
      </footer>
    );
  }

  // A decision with no options is an open question: the words are the answer.
  const open = item.type === "decide" && !item.options.length;

  // Enter in the note box does the highlighted action; when that needs words or a choice that
  // are missing, or a note is typed on an item that is approved, Enter does nothing.
  const kind = item.type === "decide" ? (open ? "answer" : "choose") : "approve";
  const label = open ? "Answer" : item.type === "decide" ? "Send decision" : item.type === "milestone" ? "Accept milestone" : "Approve";
  const enter = enterPlan(kind, label, { text, choice: null, said }, item.type === "milestone" ? "Request changes" : "Needs changes");
  const run = () => (kind === "answer" ? void send("answer") : kind === "approve" ? void send("accept") : undefined);
  const submit = waiting || !enter.enabled ? undefined : run;

  const note = (
    <>
      <textarea
        className="note"
        aria-label={open ? "Your answer" : "Optional note"}
        placeholder={open ? "Write your answer. Paste or drop images to show it." : item.type === "decide" ? "Add a note (optional). Paste or drop images to show it." : "Add a note (optional to approve, required if it needs changes). Paste or drop images to show it."}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={attachments.onPaste}
        onKeyDown={sendOnEnter(() => submit?.())}
        rows={open ? 4 : 2}
      />
      <div className="muted small-note">{kind === "choose" ? "Choose an option above to send with this note · Shift+Enter for a new line" : enter.hint}</div>
      <AttachedImages attachments={attachments} />
    </>
  );

  const secondary = (
    <span className="secondary">
      <button className="ghost" onClick={() => setMode("discuss")}>{item.type === "decide" && item.options.length ? "Other / discuss" : "Discuss"}</button>
      {othersWaiting ? <button className="ghost" onClick={() => void putAside(api.backOfQueue(item.id))} title="Keep waiting on you, but show the others first. Nothing is sent to the agent.">Back of queue <kbd>b</kbd></button> : null}
      <span className="later">
        <button className="ghost" onClick={() => setShowLater(!showLater)} aria-expanded={showLater}>Later ▾</button>
        {showLater ? (
          <span className="menu">
            {snoozeChoices().map((c) => (
              <button key={c.label} onClick={() => void putAside(api.snooze(item.id, c.until))}>Snooze {c.label}</button>
            ))}
            <button onClick={() => void putAside(api.resolve(item.id))} title="Hide this item; the task itself is not marked finished">Mark handled</button>
          </span>
        ) : null}
      </span>
    </span>
  );

  return (
    <footer className={`respond${attachments.dragging ? " dropping" : ""}`} {...attachments.drop}>
      {last?.state === "failed" || last?.state === "stale" ? <div className={`delivery ${last.state}`}>{deliveryLabel(last)}</div> : null}
      {mode === "discuss" ? (
        <Discuss text={text} setText={setText} attachments={attachments} busy={waiting} said={said} onSend={() => void send("discuss")} onCancel={() => setMode("answer")} />
      ) : (
        <>
          {item.type === "decide" ? (
            <>
              {item.recommendation && !recommended ? <p className="recommendation">Recommended: {item.recommendation}</p> : null}
              {open ? null : <div className="options" aria-label="Choose an answer">
                {item.options.map((o) => (
                  <button key={o.id} disabled={waiting} className={`option ${recommended === o.id ? "recommended" : ""}`} onClick={() => void send("choose", { choice: o.id })}>
                    <span className="option-label">{o.label}{recommended === o.id ? <span className="recommend-badge">Recommended</span> : null}</span>
                    {o.consequence ? <span className="option-consequence">{o.consequence}</span> : null}
                    {recommended === o.id ? <span className="option-reason">{item.recommendation}</span> : null}
                  </button>
                ))}
              </div>}
              {open || showNote ? note : <AttachedImages attachments={attachments} />}
              <div className="row decision-secondary">
                {open ? <button className="primary" disabled={!text.trim() || waiting} onClick={() => void send("answer")}>Answer</button> : (
                  <button className="ghost" aria-expanded={showNote} onClick={() => setShowNote(!showNote)}>Add a note</button>
                )}
                {secondary}
              </div>
            </>
          ) : null}
          {item.type === "try" ? (
            <>
              {note}
              <div className="row">
                <button className="ghost" onClick={onOpenPreview}>Try it</button>
                <button className="primary" disabled={waiting} onClick={() => void send("accept")}>Approve</button>
                <button className="ghost" disabled={waiting || !said} onClick={() => void send("request_changes")}>Needs changes</button>
                {secondary}
              </div>
            </>
          ) : null}
          {item.type === "milestone" ? (
            <>
              {note}
              <div className="row">
                <button className="primary" disabled={waiting} onClick={() => void send("accept")}>Accept milestone</button>
                <button className="ghost" disabled={waiting || !said} onClick={() => void send("request_changes")}>Request changes</button>
                {secondary}
              </div>
            </>
          ) : null}
        </>
      )}
      {error ? <div className="warn" role="alert">{error}</div> : null}
    </footer>
  );
}

function Discuss({ text, setText, attachments, busy, said, onSend, onCancel }: {
  text: string; setText: (t: string) => void; attachments: Attachments; busy: boolean; said: boolean; onSend: () => void; onCancel: () => void;
}) {
  return (
    <div className="discuss">
      <textarea
        autoFocus
        className="note"
        placeholder="Write to the agent that owns this work… Paste or drop images to show it."
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={attachments.onPaste}
        onKeyDown={sendOnEnter(() => !busy && said && onSend())}
        rows={4}
      />
      <div className="muted small-note">{SEND_HINT}</div>
      <AttachedImages attachments={attachments} />
      <div className="row">
        <button className="primary" disabled={busy || !said} onClick={onSend}>Send to the agent</button>
        <button className="ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
