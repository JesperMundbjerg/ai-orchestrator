import { useEffect, useRef, useState } from "react";
import type { InboxState } from "../../shared/types.ts";
import { useItemDetail } from "../hooks.ts";
import { needsYou } from "../queue.ts";
import { ItemDetailView } from "./ItemDetail.tsx";
import { decisionAnswer } from "./decision.ts";

/** Keep this visit's receipts in place as the live queue loses answered items. */
export function DecisionSheet({ state, tick, projectId, selectedId, onOpen }: {
  state: InboxState; tick: number; projectId: string | null; selectedId: string | null; onOpen: (id: string) => void;
}) {
  const waiting = needsYou(state, "decide", projectId);
  const [seen, setSeen] = useState(() => waiting.map(({ item }) => item.id));
  const root = useRef<HTMLElement>(null);
  const completion = useRef<HTMLParagraphElement>(null);
  const ids = [...new Set([...seen, ...waiting.map(({ item }) => item.id), ...(selectedId ? [selectedId] : [])])];
  useEffect(() => {
    if (ids.some((id) => !seen.includes(id))) setSeen(ids);
  }, [ids.join("|")]);
  const visible = ids.filter((id) => {
    const item = state.items.find((item) => item.id === id);
    const task = state.tasks.find((task) => task.id === item?.taskId);
    return item && task && !task.parked && ["needs_attention", "answer_queued", "delivered"].includes(item.state);
  });
  const focus = (id: string) => {
    const heading = document.getElementById(`question-${id}`);
    if (!heading || !root.current?.contains(heading)) return;
    heading.focus({ preventScroll: true });
    heading.closest("article")?.scrollIntoView({ block: "start", behavior: "instant" });
  };
  const advance = (id: string) => {
    const at = visible.indexOf(id);
    const next = [...visible.slice(at + 1), ...visible.slice(0, at)].find((other) => waiting.some(({ item }) => item.id === other));
    if (next) { focus(next); onOpen(next); }
    else completion.current?.focus();
  };
  const other = needsYou(state, "all", projectId).filter(({ item }) => item.type !== "decide");
  return (
    <main className="decision-sheet" ref={root} aria-label="Decisions">
      <div className="decision-sheet-inner">
        <header className="decision-sheet-head">
          <h1>Questions for you</h1>
          <p ref={completion} tabIndex={-1} role="status">{waiting.length ? `${waiting.length} remaining` : "All caught up"}</p>
        </header>
        {visible.map((id) => <SheetCard key={id} id={id} tick={tick} selected={id === selectedId} onReady={() => focus(id)} onNext={() => advance(id)} />)}
        {other.length ? <section className="decision-other"><h2>Also waiting for you</h2>{other.map(({ item }) => (
          <button className="ghost" key={item.id} onClick={() => onOpen(item.id)}><span className={`type ${item.type}`}>{item.type === "try" ? "Try it" : "Milestone"}</span>{item.title}</button>
        ))}</section> : null}
      </div>
    </main>
  );
}

function SheetCard({ id, tick, selected, onReady, onNext }: { id: string; tick: number; selected: boolean; onReady: () => void; onNext: () => void }) {
  const [refresh, setRefresh] = useState(0);
  const detail = useItemDetail(id, tick + refresh);
  const advance = useRef(false);
  const focused = useRef(false);
  useEffect(() => {
    if (selected && detail && !focused.current) { onReady(); focused.current = true; }
    if (!selected) focused.current = false;
    if (advance.current && detail && decisionAnswer(detail) !== null) { advance.current = false; onNext(); }
  });
  return detail ? <ItemDetailView detail={detail} onNext={onNext} onAnswered={() => { advance.current = true; setRefresh((r) => r + 1); }} /> : <p className="muted">Loading question…</p>;
}
