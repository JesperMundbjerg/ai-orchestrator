import { useState } from "react";
import { DELIVERY_LABEL } from "../../shared/harnesses.ts";
import type { Evidence, ItemDetail, QaPrediction } from "../../shared/types.ts";
import { api } from "../api.ts";
import { actionLabel, ago, clock, deliveryLabel, TYPE_LABEL } from "../format.ts";
import { Images } from "./Attach.tsx";
import { Owner } from "./Owner.tsx";
import { PageWalk } from "./PageWalk.tsx";
import { Respond } from "./Respond.tsx";
import { VideoEvidence } from "./VideoEvidence.tsx";
import { decisionAnswer } from "./decision.ts";

type Tab = "context" | "screenshots" | "pages" | "conversation";

/** onDone moves on once any response to the item has been accepted; without it, onNext does. */
export function ItemDetailView({ detail, onNext, onDone, onAnswered, othersWaiting }: { detail: ItemDetail; onNext: (() => void) | null; onDone?: () => void; onAnswered?: () => void; othersWaiting?: boolean }) {
  const { item, task, project, evidence, replies } = detail;
  const current = evidence.filter((e) => e.revision === item.revision);
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "context", label: "Context" },
    ...(evidence.length ? [{ id: "screenshots" as const, label: `${evidence.some((e) => e.kind === "video") ? "Evidence" : "Screenshots"} ${current.length ? `(${current.length})` : ""}` }] : []),
    ...(item.pages.length ? [{ id: "pages" as const, label: item.pages.length > 1 ? `Pages (${item.pages.length})` : "Live preview" }] : []),
    ...(replies.length || item.revision > 1 ? [{ id: "conversation" as const, label: "Conversation" }] : []),
  ];
  // A walkthrough is what the agent wants you to see first.
  const [tab, setTab] = useState<Tab>(item.pages.length > 1 ? "pages" : current.some((e) => e.kind === "image" || e.kind === "video") ? "screenshots" : "context");
  const [openError, setOpenError] = useState<string | null>(null);
  const [expandedAnswer, setExpandedAnswer] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const activeTab = tabs.some((t) => t.id === tab) ? tab : "context";

  const openConversation = () =>
    api.openConversation(task.id).then(() => setOpenError(null), (e: Error) => setOpenError(e.message));

  if (item.type === "decide") {
    const answer = decisionAnswer(detail);
    const collapsed = answer !== null && !expandedAnswer;
    // A QA agent's answer never reads as the founder's own, even collapsed.
    const byQa = detail.replies.findLast((r) => r.revision === item.revision && r.state !== "stale" && r.state !== "failed")?.answeredBy === "qa_agent";
    return (
      <article data-decision-id={item.id} className={`item decision-card${collapsed ? " collapsed" : ""}`} aria-label={collapsed ? item.title : undefined} aria-labelledby={collapsed ? undefined : `question-${item.id}`}>
        {collapsed ? (
          <button className="decision-receipt" onClick={() => setExpandedAnswer(true)} title={item.title}>
            <span className="receipt-question">{item.title}</span><span className="receipt-answer">{byQa ? "QA agent answered" : "Answered"}: {answer}</span><span aria-hidden>⌄</span>
          </button>
        ) : (
          <>
            <header className="decision-head">
              <p className="decision-asker">{project.name} · {task.presence?.name ?? task.presence?.title ?? task.title}</p>
              <h2 id={`question-${item.id}`} tabIndex={-1}>{item.title}</h2>
              {item.request ? <p className="decision-request" title={item.request}>{item.request}</p> : null}
            </header>
            <Respond key={item.revision} detail={detail} onNext={onNext} onDone={onDone ?? onNext ?? undefined} othersWaiting={othersWaiting} onOpenPreview={() => (setDetailsOpen(true), setTab("pages"))} onAnswered={() => { setDetailsOpen(false); setExpandedAnswer(false); onAnswered?.(); }} />
            {answer !== null ? <button className="link small" onClick={() => setExpandedAnswer(false)}>Collapse answer</button> : null}
          </>
        )}
        <details className="decision-details" open={detailsOpen} onToggle={(e) => setDetailsOpen(e.currentTarget.open)}>
          <summary>Details</summary>
          {detailsOpen ? <>
            <div className="item-where"><span>{task.title} · {project.name}</span><Owner task={task} />
              {task.capabilities.openConversation ? <button className="ghost small" onClick={openConversation}>Open conversation</button> : null}
            </div>
            {openError ? <p className="warn">{openError}</p> : null}
            <p className="muted small-note">Revision {item.revision} · {ago(item.updatedAt)} · {item.blocking ? "The agent is waiting on this" : "The agent carries on meanwhile"}</p>
            <p className="muted small-note">{item.request}</p>
            <p className="route-note">{DELIVERY_LABEL[task.capabilities.reply]}.</p>
            <div className="tabs" role="tablist">
              {tabs.map((t) => <button key={t.id} role="tab" aria-selected={activeTab === t.id} className={activeTab === t.id ? "tab on" : "tab"} onClick={() => setTab(t.id)}>{t.label}</button>)}
            </div>
            <div className="tab-body">
              {activeTab === "context" ? <ContextTab detail={detail} /> : null}
              {activeTab === "screenshots" ? <EvidenceTab evidence={evidence} revision={item.revision} /> : null}
              {activeTab === "pages" ? <PageWalk itemId={item.id} pages={item.pages} viewport={item.preview?.viewport ?? null} setup={item.preview?.setup ?? ""} /> : null}
              {activeTab === "conversation" ? <ConversationTab detail={detail} /> : null}
            </div>
          </> : null}
        </details>
      </article>
    );
  }

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
          {detail.withQa ? <span className="with-qa" title="The QA agent decides this for you; answer it yourself any time and yours counts.">With QA agent</span> : null}
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
        {activeTab === "pages" ? <PageWalk itemId={item.id} pages={item.pages} viewport={item.preview?.viewport ?? null} setup={item.preview?.setup ?? ""} /> : null}
        {activeTab === "conversation" ? <ConversationTab detail={detail} /> : null}
      </div>

      <Respond detail={detail} onNext={onNext} onDone={onDone ?? onNext ?? undefined} othersWaiting={othersWaiting} onOpenPreview={() => setTab("pages")} />
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
          {e.kind === "video" ? <VideoEvidence evidence={e} /> : e.kind === "image" ? (
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

/** Never "You" for an answer someone else gave on your behalf. */
function answeredBy(detail: Record<string, unknown>): string {
  const qa = detail.qaAgent as { name?: string } | undefined;
  if (qa) return `QA agent · ${qa.name ?? "unknown"}`;
  if (detail.autoApproved) return "Approve all";
  return detail.overridesQa ? "You · overriding the QA agent" : "You";
}

const VERDICT: Record<NonNullable<QaPrediction["verdict"]>, string> = { match: "agreed with you", mismatch: "differed from you", needs_judging: "the QA agent has yet to judge it" };

/** What the QA agent predicted in manual mode: never sent, collapsed, and only shown once you have answered. */
function Prediction({ prediction: p, type }: { prediction: QaPrediction; type: ItemDetail["item"]["type"] }) {
  return (
    <details className={`qa-prediction ${p.verdict ?? ""}`}>
      <summary>QA prediction (not sent){p.verdict ? ` · ${VERDICT[p.verdict]}` : ""}</summary>
      <div className="msg-head">{actionLabel(p.action, type)}{p.choice ? ` · Option ${p.choice.toUpperCase()}` : ""}</div>
      {p.text ? <Prose text={p.text} /> : null}
      <p className="muted small-note">Why: {p.reason}{p.learnings.length ? ` · Learnings: ${p.learnings.join(", ")}` : ""}</p>
    </details>
  );
}

function ConversationTab({ detail: { item, history, replies, qaPredictions = [] } }: { detail: ItemDetail }) {
  const byId = new Map(replies.map((r) => [r.id, r]));
  // Each prediction once, under your first answer to its revision (the service sends it only after you answered).
  const unshown = new Map(qaPredictions.map((p) => [p.revision, p]));
  return (
    <ol className="thread">
      {history.map((h) => {
        const reply = typeof h.detail.deliveryId === "string" ? byId.get(h.detail.deliveryId) : undefined;
        if (h.kind === "reply.queued" && reply) {
          const prediction = reply.answeredBy === "founder" ? unshown.get(reply.revision) : undefined;
          if (prediction) unshown.delete(reply.revision);
          return (
            <li key={h.id} className="msg user">
              <div className="msg-head">{answeredBy(h.detail)} · {actionLabel(reply.action, item.type)} · {clock(h.at)} · revision {reply.revision}</div>
              {reply.choice ? <div className="msg-choice">Option {reply.choice.toUpperCase()}</div> : null}
              {reply.text ? <Prose text={reply.text} /> : null}
              <Images ids={reply.images} />
              <div className={`delivery ${reply.state}`}>{deliveryLabel(reply)}</div>
              {reply.state === "failed" ? <button className="ghost small" onClick={() => void api.retry(reply.id)}>Retry delivery</button> : null}
              {prediction ? <Prediction prediction={prediction} type={item.type} /> : null}
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
  "item.backqueued": () => "Put at the back of the queue; still waiting on you",
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
