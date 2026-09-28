import type { InboxState } from "../../shared/types.ts";
import { api } from "../api.ts";
import type { Route, View } from "../hooks.ts";
import { needsYou } from "../queue.ts";

const VIEWS: Array<{ view: Exclude<View, "world" | "teams">; label: string }> = [
  { view: "needs", label: "Needs you" },
  { view: "working", label: "Working" },
  { view: "parked", label: "Parked" },
];

export function Sidebar({ state, route, navigate }: { state: InboxState; route: Route; navigate: (r: Partial<Route>) => void }) {
  const counts: Record<Exclude<View, "world" | "teams">, number> = {
    needs: needsYou(state, "all", route.projectId).length,
    working: state.tasks.filter((t) => !t.parked && (!route.projectId || t.projectId === route.projectId)).length,
    parked: state.tasks.filter((t) => t.parked && (!route.projectId || t.projectId === route.projectId)).length,
  };
  const waiting = (projectId: string) => needsYou(state, "all", projectId).length;

  return (
    <nav className="sidebar">
      <div className="brand">Review Inbox</div>
      <ul className="views">
        {VIEWS.map(({ view, label }) => (
          <li key={view}>
            <button className={route.view === view ? "active" : ""} onClick={() => navigate({ view, itemId: null })}>
              <span>{label}</span>
              <span className={`count ${view === "needs" && counts.needs ? "hot" : ""}`}>{counts[view]}</span>
            </button>
          </li>
        ))}
      </ul>

      <ul className="views">
        <li>
          <button className={route.view === "teams" ? "active" : ""} onClick={() => navigate({ view: "teams", itemId: null })}>
            <span>Teams</span>
          </button>
        </li>
      </ul>

      <button className="office-link" onClick={() => navigate({ view: "world", itemId: null })}>
        Walk into the office <span aria-hidden>→</span>
      </button>

      <div className="section-label">Projects</div>
      <ul className="projects">
        <li>
          <button className={!route.projectId ? "active" : ""} onClick={() => navigate({ projectId: null, itemId: null })}>
            <span>All projects</span>
          </button>
        </li>
        {state.projects.map((p) => (
          <li key={p.id} className="project-row">
            <button className={route.projectId === p.id ? "active" : ""} onClick={() => navigate({ projectId: p.id, itemId: null })} title={p.root ?? undefined}>
              <span>{p.name}</span>
              {waiting(p.id) ? <span className="count hot">{waiting(p.id)}</span> : null}
            </button>
            <button
              className={`pin ${p.pinned ? "on" : ""}`}
              aria-label={p.pinned ? `Unpin ${p.name}` : `Pin ${p.name} to the top of the queue`}
              title={p.pinned ? "Pinned to the top of the queue" : "Pin to the top of the queue"}
              onClick={() => void api.pin(p.id, !p.pinned)}
            >
              ★
            </button>
          </li>
        ))}
      </ul>

      <div className="sidebar-foot">
        <span className={`dot ${state.herdr === "connected" ? "idle" : "offline"}`} />
        {state.herdr === "connected" ? "herdr connected" : "herdr not running: no live status"}
        <div className="keys"><kbd>n</kbd> next needing you · <kbd>j</kbd>/<kbd>k</kbd> move</div>
      </div>
    </nav>
  );
}
