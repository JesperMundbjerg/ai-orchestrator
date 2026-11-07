import { useEffect, useState } from "react";
import { isDoneComment, type PageComment } from "../../shared/pagecomments.ts";
import { ago } from "../format.ts";
import { useWritingBox } from "../writingBox.ts";

const LABEL: Record<PageComment["status"], string> = {
  held: "held in a group", queued: "queued", delivered: "delivered", working: "working", asked: "asked",
  fixed: "fixed", declined: "declined", withdrawn: "withdrawn", failed: "not delivered",
};
const DELIVERY_CLASS: Record<PageComment["status"], string> = {
  held: "queued", queued: "queued", delivered: "delivered", working: "sending", asked: "sending",
  fixed: "delivered", declined: "failed", withdrawn: "failed", failed: "failed",
};
// Done comments are collapsed, so fetch deep enough that they cannot push open ones out of view (the route allows 500).
const FETCH = 500;

/** Where on which page, briefly: its title, else the url without its scheme. */
function pageLine(c: PageComment): string {
  return c.page.title ?? c.page.url?.replace(/^https?:\/\//, "") ?? c.openUrl?.replace(/^https?:\/\//, "") ?? "a page";
}

const post = async (path: string, body: unknown) => {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `request failed (${res.status})`);
};

/** The founder's check of a fix: verified, or still wrong with what is wrong (that opens a follow-up comment). */
function VerifyFix({ comment }: { comment: PageComment }) {
  const [wrong, setWrong] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const verify = async (verdict: "verified" | "still-wrong") => {
    setBusy(true); setError(null);
    try { await post(`/api/page-comments/${comment.id}/verify`, { verdict, ...(verdict === "still-wrong" && wrong?.trim() ? { note: wrong } : {}) }); setWrong(null); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="order-verify" style={{ display: "flex", flexDirection: "column", gap: 6, margin: "6px 0" }}>
      {wrong === null ? (
        <div className="order-meta">
          <button type="button" disabled={busy} onClick={() => void verify("verified")}>Verified</button>
          <button type="button" disabled={busy} onClick={() => setWrong("")}>Still wrong…</button>
        </div>
      ) : (
        <>
          <textarea aria-label={`What is still wrong with ${comment.id}`} value={wrong} onChange={(e) => setWrong(e.target.value)} placeholder="What is still wrong?" rows={2} style={{ width: "100%", font: "inherit" }} />
          <div className="order-meta">
            <button type="button" className="primary" disabled={busy} onClick={() => void verify("still-wrong")}>Send back as a follow-up</button>
            <button type="button" disabled={busy} onClick={() => setWrong(null)}>Cancel</button>
          </div>
        </>
      )}
      {error ? <span className="delivery failed">{error}</span> : null}
    </div>
  );
}

/** The lead's open question, answered here by the founder just as the page would. */
function AnswerQuestion({ comment }: { comment: PageComment }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useWritingBox(text, setText);
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true); setError(null);
    try {
      await post(`/api/page-comments/${comment.id}/answer`, { text });
      setText("");
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="order-question" style={{ display: "flex", flexDirection: "column", gap: 6, margin: "6px 0" }}>
      <div><strong>{comment.by ?? "The lead"} asks:</strong> {comment.question}</div>
      <textarea aria-label={`Answer the question on ${comment.id}`} {...box} placeholder="Answer for the page" rows={2} style={{ width: "100%", font: "inherit" }} />
      <div className="order-meta">
        <button type="button" className="primary" disabled={busy || !text.trim()} onClick={() => void send()}>Answer</button>
        {error ? <span className="delivery failed"> {error}</span> : null}
      </div>
    </div>
  );
}

/** One comment as a list row. */
function renderComment(c: PageComment) {
  return (
    <li key={c.id} className="order instruction from-you">
      <div className="order-head">
        <strong>{pageLine(c)}</strong>
        {c.kind ? <span className="muted"> · {c.kind}</span> : null}
        <span className="muted"> · {ago(c.createdAt)}</span>
      </div>
      <div className="order-text">{c.text}</div>
      {c.status === "asked" && c.question ? <AnswerQuestion comment={c} /> : null}
      {c.status === "fixed" && !c.verification ? <VerifyFix comment={c} /> : null}
      {c.status !== "asked" && c.answer ? <div className="order-text muted">Asked: {c.question} · Answered: {c.answer}</div> : null}
      <div className="order-meta">
        <span className={`delivery ${DELIVERY_CLASS[c.status]}`} title={c.note ?? undefined}>
          {LABEL[c.status]}{c.by ? ` by ${c.by}` : ""}{c.note ? `: ${c.note}` : ""}
        </span>
        {c.verification ? <span className={`delivery ${c.verification === "verified" ? "delivered" : "failed"}`}>{c.verification === "verified" ? "verified" : "still wrong"}</span> : null}
        {c.openUrl ? <a className="muted" href={c.openUrl} target="_blank" rel="noreferrer"> open</a> : null}
        <span className="muted"> {c.id}{c.groupId ? ` · group ${c.groupId}` : ""}{c.revision ? ` · edited ${c.revision}×` : ""}{c.followsUp ? ` · follows up ${c.followsUp}` : ""}{c.followUps.length ? ` · followed up by ${c.followUps.join(", ")}` : ""}</span>
      </div>
    </li>
  );
}

/** A team's page comments, newest first: the office's own queue, live from its status stream. */
export function PageCommentsSection({ teamId }: { teamId: string }) {
  const [comments, setComments] = useState<PageComment[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => void fetch(`/api/page-comments?team=${encodeURIComponent(teamId)}&limit=${FETCH}`)
      .then((r) => (r.ok ? r.json() : { comments: [] }))
      .then((out: { comments: PageComment[] }) => { if (alive) setComments(out.comments); })
      .catch(() => {});
    load();
    const source = new EventSource(`/api/page-comments/events?team=${encodeURIComponent(teamId)}&limit=1`);
    source.addEventListener("comment", load);
    return () => { alive = false; source.close(); };
  }, [teamId]);
  if (!comments.length) return null;
  const done = comments.filter(isDoneComment);
  const todo = comments.filter((c) => !isDoneComment(c));
  const open = todo.filter((c) => c.status !== "fixed").length;
  const asked = todo.filter((c) => c.status === "asked").length;
  return (
    <div>
      <div className="section-label">Page comments{open ? ` · ${open} open` : ""}{asked ? ` · ${asked} asked` : ""}</div>
      {todo.length ? <ul className="order-list">{todo.map(renderComment)}</ul> : null}
      {done.length ? (
        <details className="muted">
          <summary>{done.length} done</summary>
          <ul className="order-list">{done.map(renderComment)}</ul>
        </details>
      ) : null}
    </div>
  );
}
