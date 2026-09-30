import { useState } from "react";
import type { ItemDetail, ReplyAction } from "../../shared/types.ts";
import { api } from "../api.ts";
import { deliveryLabel, snoozeChoices } from "../format.ts";
import { AttachedImages, useAttachments, type Attachments } from "./Attach.tsx";

/**
 * The answer area. Each type has one primary action; Discuss and Later are always there, and a
 * choice never prevents writing more. Each send carries a fresh delivery id, so a retried
 * request cannot become a second answer.
 */
export function Respond({ detail, onNext, onOpenPreview }: { detail: ItemDetail; onNext: (() => void) | null; onOpenPreview: () => void }) {
  const { item, replies } = detail;
  const [choice, setChoice] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"answer" | "discuss">("answer");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showLater, setShowLater] = useState(false);
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
      setChoice(null);
      setMode("answer");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
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

  const note = (
    <>
      <textarea
        className="note"
        placeholder={item.type === "milestone" ? "What should change? (required to request changes) Paste or drop images to show it." : "Add a note (optional). Paste or drop images to show it."}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={attachments.onPaste}
        rows={2}
      />
      <AttachedImages attachments={attachments} />
    </>
  );

  const secondary = (
    <span className="secondary">
      <button className="ghost" onClick={() => setMode("discuss")}>Discuss</button>
      <span className="later">
        <button className="ghost" onClick={() => setShowLater(!showLater)} aria-expanded={showLater}>Later ▾</button>
        {showLater ? (
          <span className="menu">
            {snoozeChoices().map((c) => (
              <button key={c.label} onClick={() => void api.snooze(item.id, c.until).then(() => onNext?.())}>Snooze {c.label}</button>
            ))}
            <button onClick={() => void api.resolve(item.id).then(() => onNext?.())} title="Hide this item; the task itself is not marked finished">Mark handled</button>
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
              {item.recommendation ? <p className="recommendation">Agent recommends: {item.recommendation}</p> : null}
              <div className="options" role="radiogroup">
                {item.options.map((o) => (
                  <button key={o.id} role="radio" aria-checked={choice === o.id} className={`option ${choice === o.id ? "on" : ""}`} onClick={() => setChoice(o.id)}>
                    <span className="option-label">
                      <span className="option-key">{o.id.toUpperCase()}</span> {o.label}
                    </span>
                    {o.consequence ? <span className="option-consequence">{o.consequence}</span> : null}
                  </button>
                ))}
              </div>
              {note}
              <div className="row">
                <button className="primary" disabled={!choice || waiting} onClick={() => choice && void send("choose", { choice })}>Send decision</button>
                {secondary}
              </div>
            </>
          ) : null}
          {item.type === "try" ? (
            <>
              {note}
              <div className="row">
                <button className="primary" onClick={onOpenPreview}>Try it</button>
                <button className="ghost" disabled={waiting} onClick={() => void send("tried")}>Tried it — send note</button>
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
      {error ? <div className="warn">{error}</div> : null}
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
        rows={4}
      />
      <AttachedImages attachments={attachments} />
      <div className="row">
        <button className="primary" disabled={busy || !said} onClick={onSend}>Send to the agent</button>
        <button className="ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
