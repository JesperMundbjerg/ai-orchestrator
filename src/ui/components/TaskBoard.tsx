import type { InboxState, Task } from "../../shared/types.ts";
import { api } from "../api.ts";
import { ago, deliveryLabel, TYPE_LABEL } from "../format.ts";
import { openItemsOf } from "../queue.ts";
import { Brief } from "./ItemDetail.tsx";
import { Owner } from "./Owner.tsx";

/** Working and Parked: the tasks themselves, rather than what needs the user. */
export function TaskBoard({ state, parked, projectId, onOpenItem }: { state: InboxState; parked: boolean; projectId: string | null; onOpenItem: (itemId: string) => void }) {
  const tasks = state.tasks.filter((t) => t.parked === parked && (!projectId || t.projectId === projectId));
  const projects = state.projects.filter((p) => tasks.some((t) => t.projectId === p.id));
  return (
    <main className="board">
      <header className="board-head">
        <h1>{parked ? "Parked" : "Working"}</h1>
        <p className="muted">
          {parked
            ? "You set these aside. Their agents are not paused; their items stay out of Needs you until you unpark them."
            : "What each agent is on, its last meaningful update and the next milestone to expect."}
        </p>
      </header>
      {projects.map((p) => (
        <section key={p.id} className="board-project">
          <h2>{p.name}</h2>
          <div className="task-grid">
            {tasks.filter((t) => t.projectId === p.id).map((t) => (
              <TaskCard key={t.id} task={t} state={state} onOpenItem={onOpenItem} />
            ))}
          </div>
        </section>
      ))}
      {!tasks.length ? <p className="muted pad">{parked ? "Nothing parked." : "No agent has registered work yet. An agent joins by submitting its first review item."}</p> : null}
    </main>
  );
}

function TaskCard({ task, state, onOpenItem }: { task: Task; state: InboxState; onOpenItem: (itemId: string) => void }) {
  const items = openItemsOf(state, task.id);
  return (
    <article className="task">
      <header className="task-head">
        <h3>{task.title}</h3>
        <Owner task={task} />
      </header>
      <Brief task={task} />
      <div className="task-updated muted">Last update {ago(task.updatedAt)}</div>
      {items.length ? (
        <ul className="task-items">
          {items.map((i) => (
            <li key={i.id}>
              <button className="link" onClick={() => onOpenItem(i.id)}>
                <span className={`type ${i.type}`}>{TYPE_LABEL[i.type]}</span> {i.title}
              </button>
              <span className="muted">{i.state === "needs_attention" ? "needs you" : i.state === "snoozed" ? "snoozed" : i.lastReply ? deliveryLabel(i.lastReply) : i.state}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <footer className="row">
        <button className="ghost small" onClick={() => void api.updateTask(task.id, { parked: !task.parked })}>{task.parked ? "Unpark" : "Park"}</button>
        {task.capabilities.openConversation ? <button className="ghost small" onClick={() => void api.openConversation(task.id)}>Open conversation</button> : null}
      </footer>
    </article>
  );
}
