import { useEffect, useState } from "react";
import type { PageComment } from "../../shared/pagecomments.ts";
import { ago } from "../format.ts";

const LABEL: Record<PageComment["status"], string> = {
  queued: "queued", delivered: "delivered", working: "working", fixed: "fixed", declined: "declined", failed: "not delivered",
};
const DELIVERY_CLASS: Record<PageComment["status"], string> = {
  queued: "queued", delivered: "delivered", working: "sending", fixed: "delivered", declined: "failed", failed: "failed",
};
const SHOWN = 10;

/** Where on which page, briefly: its title, else the url without its scheme. */
function pageLine(c: PageComment): string {
  return c.page.title ?? c.page.url?.replace(/^https?:\/\//, "") ?? c.openUrl?.replace(/^https?:\/\//, "") ?? "a page";
}

/** A team's page comments, newest first: the office's own queue, live from its status stream. */
export function PageCommentsSection({ teamId }: { teamId: string }) {
  const [comments, setComments] = useState<PageComment[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => void fetch(`/api/page-comments?team=${encodeURIComponent(teamId)}&limit=${SHOWN}`)
      .then((r) => (r.ok ? r.json() : { comments: [] }))
      .then((out: { comments: PageComment[] }) => { if (alive) setComments(out.comments); })
      .catch(() => {});
    load();
    const source = new EventSource(`/api/page-comments/events?team=${encodeURIComponent(teamId)}&limit=1`);
    source.addEventListener("comment", load);
    return () => { alive = false; source.close(); };
  }, [teamId]);
  if (!comments.length) return null;
  const open = comments.filter((c) => !["fixed", "declined"].includes(c.status)).length;
  return (
    <div>
      <div className="section-label">Page comments{open ? ` · ${open} open` : ""}</div>
      <ul className="order-list">
        {comments.map((c) => (
          <li key={c.id} className="order instruction from-you">
            <div className="order-head">
              <strong>{pageLine(c)}</strong>
              <span className="muted"> · {ago(c.createdAt)}</span>
            </div>
            <div className="order-text">{c.text}</div>
            <div className="order-meta">
              <span className={`delivery ${DELIVERY_CLASS[c.status]}`} title={c.note ?? undefined}>
                {LABEL[c.status]}{c.by ? ` by ${c.by}` : ""}{c.note ? `: ${c.note}` : ""}
              </span>
              {c.openUrl ? <a className="muted" href={c.openUrl} target="_blank" rel="noreferrer"> open</a> : null}
              <span className="muted"> {c.id}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
