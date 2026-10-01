import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { ItemDetailView } from "./components/ItemDetail.tsx";
import { CrewGuide } from "./components/CrewGuide.tsx";
import { DecisionSheet } from "./components/DecisionSheet.tsx";
import { MachineWarning } from "./components/MachineWarning.tsx";
import { Queue } from "./components/Queue.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { TaskBoard } from "./components/TaskBoard.tsx";
import { TeamBoard } from "./components/TeamBoard.tsx";
import { useChangeSignal, useInboxState, useItemDetail, useRoute } from "./hooks.ts";
import { needsYou, nextNeeding, type Filter } from "./queue.ts";

// The 3D office is loaded only when opened, so the inbox stays light.
const WorldView = lazy(() => import("./world/WorldView.tsx").then((m) => ({ default: m.WorldView })));

export function App() {
  const tick = useChangeSignal();
  const { state, error } = useInboxState(tick);
  const [route, navigate] = useRoute();
  const [filter, setFilter] = useState<Filter>("all");
  const detail = useItemDetail(route.itemId, tick);
  const queue = useMemo(() => (state ? needsYou(state, filter, route.projectId) : []), [state, filter, route.projectId]);

  const selectedItem = state?.items.find((item) => item.id === route.itemId);
  const decisionSheet = route.view === "needs" && (selectedItem?.type === "decide" || (!route.itemId && (filter === "all" || filter === "decide")));

  const openNext = () => {
    const id = nextNeeding(queue, route.itemId);
    if (id) navigate({ view: "needs", itemId: id });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (route.view === "world" || route.view === "teams" || route.view === "crew" || e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return;
      const currentId = (e.target as HTMLElement).closest<HTMLElement>("[data-decision-id]")?.dataset.decisionId ?? route.itemId;
      if (e.key === "n") {
        const id = nextNeeding(queue, currentId);
        if (id) navigate({ view: "needs", itemId: id });
      }
      if ((e.key === "j" || e.key === "k") && queue.length) {
        const at = queue.findIndex((q) => q.item.id === currentId);
        const next = queue[Math.min(queue.length - 1, Math.max(0, at + (e.key === "j" ? 1 : -1)))];
        if (next) navigate({ view: "needs", itemId: next.item.id });
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  if (!state) {
    return <div className="empty-page">{error ? `The inbox service is not answering (${error}). Start it with npm start.` : "Loading…"}</div>;
  }

  if (route.view === "world") {
    return (
      <Suspense fallback={<div className="empty-page">Opening the office…</div>}>
        <WorldView state={state} tick={tick} onLeave={() => navigate({ view: "needs", itemId: null })} />
        {/* Under the office's top bar, drawn here so the office itself need not know about the machine. */}
        <MachineWarning tick={tick} floating />
      </Suspense>
    );
  }

  return (
    <div className={`app${decisionSheet ? " decisions-app" : ""}`}>
      <Sidebar state={state} route={route} navigate={navigate} />
      {decisionSheet ? (
        <DecisionSheet key={route.projectId ?? "all"} state={state} tick={tick} projectId={route.projectId} selectedId={route.itemId} onOpen={(itemId) => navigate({ itemId })} />
      ) : route.view === "needs" ? (
        <>
          <Queue
            state={state}
            entries={queue}
            filter={filter}
            onFilter={setFilter}
            selectedId={route.itemId}
            projectId={route.projectId}
            onSelect={(itemId) => navigate({ itemId })}
            onNext={openNext}
          />
          <main className="detail">
            {detail ? (
              <ItemDetailView key={detail.item.id} detail={detail} onNext={queue.length > 1 ? openNext : null} />
            ) : (
              <div className="empty-detail">
                {queue.length ? (
                  <button className="primary" onClick={openNext}>Open the next item needing you <kbd>n</kbd></button>
                ) : (
                  <p>Nothing needs you right now. Agents keep working; new results will appear here.</p>
                )}
              </div>
            )}
          </main>
        </>
      ) : route.view === "crew" ? (
        <CrewGuide tick={tick} onBack={() => navigate({ view: "teams", itemId: null })} />
      ) : route.view === "teams" ? (
        <TeamBoard state={state} tick={tick} onOffice={() => navigate({ view: "world", itemId: null })} onCrewGuide={() => navigate({ view: "crew", itemId: null })} />
      ) : (
        <TaskBoard state={state} parked={route.view === "parked"} projectId={route.projectId} onOpenItem={(itemId) => navigate({ view: "needs", itemId })} />
      )}
    </div>
  );
}
