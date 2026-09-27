import type { InboxState } from "../../shared/types.ts";
import { ago, TYPE_LABEL } from "../format.ts";
import { filterCounts, SORT_EXPLANATION, type Entry, type Filter } from "../queue.ts";
import { Owner } from "./Owner.tsx";

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "decide", label: "Decisions" },
  { id: "try", label: "Try it" },
  { id: "milestone", label: "Reviews" },
];

interface Props {
  state: InboxState;
  entries: Entry[];
  filter: Filter;
  onFilter: (f: Filter) => void;
  selectedId: string | null;
  projectId: string | null;
  onSelect: (itemId: string) => void;
  onNext: () => void;
}

export function Queue({ state, entries, filter, onFilter, selectedId, projectId, onSelect, onNext }: Props) {
  const counts = filterCounts(state, projectId);
  return (
    <section className="queue">
      <header className="queue-head">
        <h1>Needs you</h1>
        <button className="primary small" onClick={onNext} disabled={!entries.length}>
          Next <kbd>n</kbd>
        </button>
      </header>
      <div className="chips" role="tablist">
        {FILTERS.map((f) => (
          <button key={f.id} role="tab" aria-selected={filter === f.id} className={filter === f.id ? "chip on" : "chip"} onClick={() => onFilter(f.id)}>
            {f.label} <span className="chip-count">{counts[f.id]}</span>
          </button>
        ))}
      </div>
      <p className="sort-note">{SORT_EXPLANATION}</p>
      <ol className="cards">
        {entries.map((e) => (
          <li key={e.item.id}>
            <ItemCard entry={e} selected={e.item.id === selectedId} onSelect={() => onSelect(e.item.id)} />
          </li>
        ))}
      </ol>
      {!entries.length ? <p className="muted pad">Nothing here{filter !== "all" ? " for this filter" : ""}.</p> : null}
    </section>
  );
}

function ItemCard({ entry: { item, task, project }, selected, onSelect }: { entry: Entry; selected: boolean; onSelect: () => void }) {
  const failed = item.lastReply?.state === "failed";
  return (
    <button className={`card ${selected ? "selected" : ""}`} onClick={onSelect} aria-current={selected}>
      <div className="card-top">
        <span className={`type ${item.type}`}>{TYPE_LABEL[item.type]}</span>
        <span className="card-where">{task.title} · {project.name}</span>
        <span className="card-age">{ago(item.updatedAt)}</span>
      </div>
      <div className="card-body">
        <div className="card-text">
          <div className="card-title">{item.title}</div>
          <div className="card-context">{item.request || item.context || task.lastDecision}</div>
        </div>
        {item.thumbnail ? <img className="thumb" src={item.thumbnail} alt="" loading="lazy" /> : null}
      </div>
      <div className="card-foot">
        <Owner task={task} compact />
        <span className={item.blocking ? "blocking" : "muted"}>{item.blocking ? "Agent waiting on this" : "Agent continuing"}</span>
        {item.revision > 1 ? <span className="muted">rev {item.revision}</span> : null}
        {failed ? <span className="warn">Delivery failed</span> : null}
      </div>
    </button>
  );
}
