import { useState } from "react";
import { DELIVERY_LABEL } from "../../shared/harnesses.ts";
import type { Evidence, ItemDetail } from "../../shared/types.ts";
import { api } from "../api.ts";
import { ACTION_LABEL, ago, clock, deliveryLabel, TYPE_LABEL } from "../format.ts";
import { Owner } from "./Owner.tsx";
import { Respond } from "./Respond.tsx";

type Tab = "context" | "screenshots" | "preview" | "conversation";

export function ItemDetailView({ detail, onNext }: { detail: ItemDetail; onNext: (() => void) | null }) {
  const { item, task, project, evidence, replies } = detail;
  const current = evidence.filter((e) => e.revision === item.revision);
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "context", label: "Context" },
    ...(evidence.length ? [{ id: "screenshots" as const, label: `Screenshots ${current.length ? `(${current.length})` : ""}` }] : []),
    ...(item.preview ? [{ id: "preview" as const, label: "Live preview" }] : []),
    ...(replies.length || item.revision > 1 ? [{ id: "conversation" as const, label: "Conversation" }] : []),
  ];
  const [tab, setTab] = useState<Tab>(current.some((e) => e.kind === "image") ? "screenshots" : "context");
  const [openError, setOpenError] = useState<string | null>(null);
  const activeTab = tabs.some((t) => t.id === tab) ? tab : "context";

  const openConversation = () =>
    api.openConversation(task.id).then(() => setOpenError(null), (e: Error) => setOpenError(e.message));

  return (
    <article className="item">
      <header className="item-head">
        <div className="item-where">
          <span>{task.title} · {project.name}</span>
          <Owner task={task} />
          {task.capabilities.openConversation ? (
            <button className="ghost small" onClick={openConversation} title="Bring this agent's terminal to the front in herdr">
              Open conversation
            </button>
          ) : null}
        </div>
        {openError ? <div className="warn">{openError}</div> : null}
        <div className="item-kind">
          <span className={`type ${item.type}`}>{TYPE_LABEL[item.type]}</span>
          {item.state === "needs_attention" ? (
            <span className={item.blocking ? "blocking" : "muted"}>{item.blocking ? "The agent is waiting on this" : "The agent carries on meanwhile"}</span>
          ) : null}
          <span className="muted">revision {item.revision} · {ago(item.updatedAt)}</span>
        </div>
        <h2>{item.title}</h2>
        {item.request ? <p className="request">{item.request}</p> : null}
      </header>

      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={activeTab === t.id} className={activeTab === t.id ? "tab on" : "tab"} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="tab-body">
        {activeTab === "context" ? <ContextTab detail={detail} /> : null}
        {activeTab === "screenshots" ? <EvidenceTab evidence={evidence} revision={item.revision} /> : null}
        {activeTab === "preview" && item.preview ? <PreviewTab itemId={item.id} url={item.preview.url} viewport={item.preview.viewport} setup={item.preview.setup} /> : null}
        {activeTab === "conversation" ? <ConversationTab detail={detail} /> : null}
      </div>

      <Respond detail={detail} onNext={onNext} onOpenPreview={() => setTab("preview")} />
      <p className="route-note">{DELIVERY_LABEL[task.capabilities.reply]}.</p>
    </article>
  );
}

function ContextTab({ detail: { item, task } }: { detail: ItemDetail }) {
  return (
    <div className="context">
      {item.context ? <Prose text={item.context} /> : null}
      {item.check ? (
        <div className="callout">
          <div className="callout-label">What to try</div>
          <Prose text={item.check} />
        </div>
      ) : null}
      {item.recommendation ? (
        <div className="callout recommend">
          <div className="callout-label">Agent's recommendation</div>
          <Prose text={item.recommendation} />
        </div>
      ) : null}
      <Brief task={task} />
    </div>
  );
}

/** The task's compact brief: the user's own decisions stay visible and editable. */
export function Brief({ task }: { task: ItemDetail["task"] }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task);
  const rows: Array<[keyof typeof task, string]> = [
    ["objective", "Objective"],
    ["lastDecision", "Latest decision"],
    ["lastAcceptedMilestone", "Last accepted milestone"],
    ["activity", "Doing now"],
    ["nextMilestone", "Next milestone"],
  ];
  if (editing) {
    return (
      <form
        className="brief editing"
        onSubmit={(e) => {
          e.preventDefault();
          const patch = Object.fromEntries(rows.map(([k]) => [k, draft[k]]));
          void api.updateTask(task.id, patch).then(() => setEditing(false));
        }}
      >
        <div className="brief-head">Task brief</div>
        {rows.map(([key, label]) => (
          <label key={key}>
            <span>{label}</span>
            <input value={String(draft[key] ?? "")} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
          </label>
        ))}
        <div className="row">
          <button className="primary small" type="submit">Save brief</button>
          <button className="ghost small" type="button" onClick={() => setEditing(false)}>Cancel</button>
        </div>
      </form>
    );
  }
  return (
    <dl className="brief">
      <div className="brief-head">
        Task brief
        <button className="ghost small" onClick={() => (setDraft(task), setEditing(true))}>Edit</button>
      </div>
      {rows.map(([key, label]) =>
        task[key] ? (
          <div key={key} className="brief-row">
            <dt>{label}</dt>
            <dd>{String(task[key])}</dd>
          </div>
        ) : null,
      )}
    </dl>
  );
}

function EvidenceTab({ evidence, revision }: { evidence: Evidence[]; revision: number }) {
  const [zoom, setZoom] = useState<Evidence | null>(null);
  return (
    <div className="evidence">
      {evidence.map((e) => (
        <figure key={e.id} className={e.revision === revision ? "" : "older"}>
          {e.kind === "image" ? (
            <button className="shot" onClick={() => setZoom(e)} aria-label={`Enlarge ${e.caption || "screenshot"}`}>
              <img src={e.href} alt={e.caption} loading="lazy" />
            </button>
          ) : (
            <a className="doc" href={e.href} target="_blank" rel="noreferrer">{e.kind === "url" ? e.href : "Open document"}</a>
          )}
          <figcaption>
            {e.caption}
            <span className="muted">
              {e.revision === revision ? "" : `revision ${e.revision} · `}captured {clock(e.capturedAt)}{e.sourceRevision ? ` · ${e.sourceRevision}` : ""}
            </span>
          </figcaption>
        </figure>
      ))}
      {zoom ? (
        <div className="lightbox" role="dialog" onClick={() => setZoom(null)}>
          <img src={zoom.href} alt={zoom.caption} />
        </div>
      ) : null}
    </div>
  );
}

function PreviewTab({ itemId, url, viewport, setup }: { itemId: string; url: string; viewport: "desktop" | "phone" | null; setup: string }) {
  const [check, setCheck] = useState<{ reachable: boolean; status: number | null; checkedAt: string } | null>(null);
  const [embed, setEmbed] = useState(true);
  const runCheck = () => api.checkPreview(itemId).then(setCheck);
  return (
    <div className="preview">
      <div className="preview-bar">
        <code>{url}</code>
        <a className="primary small" href={url} target="_blank" rel="noreferrer">Open ↗</a>
        <button className="ghost small" onClick={runCheck}>Check it is up</button>
        <button className="ghost small" onClick={() => setEmbed(!embed)}>{embed ? "Hide embed" : "Embed here"}</button>
        {check ? (
          <span className={check.reachable ? "ok" : "warn"}>
            {check.reachable ? `Answering (${check.status})` : "Not answering — the preview may be stopped"} · {clock(check.checkedAt)}
          </span>
        ) : null}
      </div>
      {setup ? <p className="muted">Setup: {setup}</p> : null}
      <p className="muted small-note">The preview is live and may have moved on since the screenshots were taken.</p>
      {embed ? <iframe className={`frame ${viewport ?? "desktop"}`} src={url} title="Live preview" /> : null}
    </div>
  );
}

function ConversationTab({ detail: { history, replies } }: { detail: ItemDetail }) {
  const byId = new Map(replies.map((r) => [r.id, r]));
  return (
    <ol className="thread">
      {history.map((h) => {
        const reply = typeof h.detail.deliveryId === "string" ? byId.get(h.detail.deliveryId) : undefined;
        if (h.kind === "reply.queued" && reply) {
          return (
            <li key={h.id} className="msg user">
              <div className="msg-head">You · {ACTION_LABEL[reply.action]} · {clock(h.at)} · revision {reply.revision}</div>
              {reply.choice ? <div className="msg-choice">Option {reply.choice.toUpperCase()}</div> : null}
              {reply.text ? <Prose text={reply.text} /> : null}
              <div className={`delivery ${reply.state}`}>{deliveryLabel(reply)}</div>
              {reply.state === "failed" ? <button className="ghost small" onClick={() => void api.retry(reply.id)}>Retry delivery</button> : null}
            </li>
          );
        }
        const text = EVENT_TEXT[h.kind];
        return text ? (
          <li key={h.id} className="msg system">
            {text(h.detail)} · {clock(h.at)}
          </li>
        ) : null;
      })}
    </ol>
  );
}

const EVENT_TEXT: Record<string, (d: Record<string, unknown>) => string> = {
  "item.submitted": () => "The agent asked",
  "item.revised": (d) => `The agent revised this to revision ${d.revision}${d.staleReplies ? "; your earlier unsent answer was held back" : ""}`,
  "reply.delivered": () => "The agent received your answer",
  "reply.failed": (d) => `Delivery failed: ${d.error}`,
  "item.snoozed": (d) => `Snoozed until ${clock(String(d.until))}`,
  "item.woke": () => "Back from snooze",
  "item.resolved": () => "Marked handled",
  "item.withdrawn": () => "The agent withdrew this request",
};

function Prose({ text }: { text: string }) {
  return (
    <div className="prose">
      {text.split(/\n{2,}/).map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </div>
  );
}
