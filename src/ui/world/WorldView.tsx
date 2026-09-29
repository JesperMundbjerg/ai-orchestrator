import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import type { InboxState, ItemType, WorldState, WorldTeam } from "../../shared/types.ts";
import { api } from "../api.ts";
import { useItemDetail } from "../hooks.ts";
import { needsYou } from "../queue.ts";
import { Avatar } from "./Avatar.tsx";
import { ENTRANCE, planOffice, queueOrder, SPAWN, type OfficePlan, type Vec2 } from "./layout.ts";
import { Office } from "./Office.tsx";
import { AgentPanel, AnswerModal, Legend, TeamPanel, TeamsPanel } from "./Panels.tsx";
import { Helpers } from "./Helpers.tsx";
import { Player, type FlyTarget } from "./Player.tsx";
import { plan as planTalk, type Bubble, type Visit } from "./visits.ts";

export interface Waiting {
  count: number;
  type: ItemType;
  itemIds: string[];
}

const START: FlyTarget = { pos: SPAWN, yaw: 0, seq: 0 };

/**
 * The office: every agent as a person you can walk up to. Each project (and standing team) has its own corner, the
 * rest wait in the lounge, and anyone with something for you queues at your desk.
 */
export function WorldView({ state, tick, onLeave }: { state: InboxState; tick: number; onLeave: () => void }) {
  const [world, setWorld] = useState<WorldState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [openTeam, setOpenTeam] = useState<string | null>(null);
  const [answering, setAnswering] = useState<string | null>(null);
  const [fly, setFly] = useState<FlyTarget | null>(null);
  const detail = useItemDetail(answering, tick);

  useEffect(() => {
    let live = true;
    api.world().then((w) => live && (setWorld(w), setError(null)), (e: Error) => live && setError(e.message));
    return () => void (live = false);
  }, [tick]);

  const entries = useMemo(() => needsYou(state, "all", null), [state]);
  const queue = useMemo(() => (world ? queueOrder(world.agents, entries.map((e) => e.task.id)) : []), [world, entries]);
  const plan = useMemo(() => (world ? planOffice(world.agents, world.teams, queue) : null), [world, queue]);
  const waiting = useMemo(() => {
    const out = new Map<string, Waiting>();
    if (!world) return out;
    const byTask = new Map(world.agents.flatMap((a) => a.taskIds.map((t) => [t, a.id] as const)));
    for (const e of entries) {
      const id = byTask.get(e.task.id);
      if (!id) continue;
      const w = out.get(id) ?? { count: 0, type: e.item.type, itemIds: [] };
      w.count++;
      w.itemIds.push(e.item.id);
      out.set(id, w);
    }
    return out;
  }, [world, entries]);

  // Agents already here when the office opens are at their places; later arrivals walk in.
  const known = useRef<Set<string> | null>(null);
  const arrivals = useMemo(() => {
    const out = new Set<string>();
    if (!world) return out;
    if (known.current) for (const a of world.agents) if (!known.current.has(a.id)) out.add(a.id);
    known.current = new Set([...(known.current ?? []), ...world.agents.map((a) => a.id)]);
    return out;
  }, [world]);

  const talk = useTalk(world, plan);
  const agents = useMemo(() => new Map((world?.agents ?? []).map((a) => [a.id, a])), [world]);
  const teams = useMemo(() => new Map((world?.teams ?? []).map((t) => [t.id, t])), [world]);
  const selectedAgent = selected ? agents.get(selected) ?? null : null;
  const shownTeam = !selectedAgent && openTeam ? teams.get(openTeam) ?? null : null;
  const nextItem = entries.find((e) => e.item.id !== answering)?.item.id ?? null;

  const select = (id: string) => {
    setSelected(id);
    const w = waiting.get(id);
    if (w) setAnswering(w.itemIds[0]!);
  };
  const flyTo = (pos: Vec2, yaw: number) => setFly((f) => ({ pos, yaw, seq: (f?.seq ?? 0) + 1 }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || (e.target as HTMLElement).closest("input, textarea, select")) return;
      if (answering) setAnswering(null);
      else if (selected) setSelected(null);
      else setOpenTeam(null);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [answering, selected]);

  if (!world || !plan) {
    return <div className="empty-page">{error ? `The office did not open (${error}).` : "Opening the office…"}</div>;
  }

  return (
    <div className="world">
      <Canvas shadows camera={{ fov: 62, near: 0.1, far: 160 }} onPointerMissed={() => setSelected(null)}>
        <Scene plan={plan} world={world} agents={agents} teams={teams} waiting={waiting} arrivals={arrivals} talk={talk} selected={selected} onSelect={select} fly={fly} />
      </Canvas>

      <header className="world-top">
        <button className="ghost small" onClick={onLeave}>← Inbox</button>
        <strong>Office</strong>
        <span className="muted">
          {world.agents.length} {world.agents.length === 1 ? "agent" : "agents"} · {world.herdr === "connected" ? "live from herdr" : "herdr not running: no live status"}
        </span>
        <span className="spacer" />
        <button className="ghost small" onClick={() => flyTo(SPAWN, 0)}>Your desk</button>
        {entries.length ? (
          <button className="primary small" onClick={() => setAnswering(entries[0]!.item.id)}>
            {queue.length} in line · answer the first
          </button>
        ) : (
          <span className="muted">Nobody is waiting for you</span>
        )}
      </header>

      <TeamsPanel
        world={world}
        plan={plan}
        agents={agents}
        onOpen={(id, pos, yaw) => {
          setSelected(null);
          setOpenTeam(id);
          flyTo(pos, yaw);
        }}
      />
      {shownTeam ? (
        <TeamPanel
          key={shownTeam.id}
          team={shownTeam}
          world={world}
          agents={agents}
          state={state}
          waiting={waiting}
          onAgent={setSelected}
          onAnswer={setAnswering}
          onClose={() => setOpenTeam(null)}
        />
      ) : null}
      {selectedAgent ? (
        <AgentPanel
          key={selectedAgent.id}
          agent={selectedAgent}
          world={world}
          state={state}
          waiting={waiting.get(selectedAgent.id) ?? null}
          onAnswer={setAnswering}
          onGo={() => {
            const spot = plan.spots.get(selectedAgent.id);
            if (spot) flyTo([spot.pos[0] + Math.sin(spot.facing) * 2.6, spot.pos[1] + Math.cos(spot.facing) * 2.6], -spot.facing);
          }}
          onClose={() => setSelected(null)}
          onTeam={openTeam && selectedAgent.teamId === openTeam ? () => setSelected(null) : null}
        />
      ) : null}
      <Legend />
      <p className="world-hint">
        <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> walk · <kbd>Shift</kbd> run · drag to turn · scroll or <kbd>+</kbd><kbd>−</kbd> to zoom · click someone
      </p>
      {detail ? (
        <AnswerModal
          detail={detail}
          agent={[...waiting.entries()].find(([, w]) => w.itemIds.includes(detail.item.id))?.[0] ?? null}
          agents={agents}
          onNext={nextItem ? () => setAnswering(nextItem) : null}
          onClose={() => setAnswering(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * Who is walking over to whom and what is being said, from the messages that arrive while the
 * office is open. Messages already there when it opens are history, not a scene.
 */
function useTalk(world: WorldState | null, office: OfficePlan | null): { visits: Visit[]; bubbles: Bubble[] } {
  const seen = useRef<Set<string> | null>(null);
  const [talk, setTalk] = useState<{ visits: Visit[]; bubbles: Bubble[] }>({ visits: [], bubbles: [] });
  useEffect(() => {
    if (!world || !office) return;
    const ids = world.messages.map((m) => m.id);
    if (!seen.current) {
      seen.current = new Set(ids);
      return;
    }
    const fresh = world.messages.filter((m) => !seen.current!.has(m.id)).reverse();
    if (!fresh.length) return;
    for (const id of ids) seen.current.add(id);
    const now = Date.now();
    const next = planTalk(fresh, office, now);
    setTalk((t) => ({ visits: [...t.visits.filter((v) => v.until > now), ...next.visits], bubbles: [...t.bubbles.filter((b) => b.until > now), ...next.bubbles] }));
  }, [world, office]);
  // Clear what has been said once its time is up.
  useEffect(() => {
    const ends = [...talk.visits, ...talk.bubbles].map((x) => x.until);
    if (!ends.length) return;
    const timer = setTimeout(() => {
      const now = Date.now();
      setTalk((t) => ({ visits: t.visits.filter((v) => v.until > now), bubbles: t.bubbles.filter((b) => b.until > now) }));
    }, Math.max(0, Math.min(...ends) - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [talk]);
  return talk;
}

function Scene({ plan, world, agents, teams, waiting, arrivals, talk, selected, onSelect, fly }: {
  plan: OfficePlan;
  world: WorldState;
  agents: Map<string, WorldState["agents"][number]>;
  teams: Map<string, WorldTeam>;
  waiting: Map<string, Waiting>;
  arrivals: Set<string>;
  talk: { visits: Visit[]; bubbles: Bubble[] };
  selected: string | null;
  onSelect: (id: string) => void;
  fly: FlyTarget | null;
}) {
  const { minX, maxX, minZ, maxZ } = plan.bounds;
  // The light aims at the origin and its shadow frustum is in the light's own frame, so it is
  // sized to reach the farthest corner of the floor.
  const reach = Math.max(...[minX, maxX].flatMap((x) => [minZ, maxZ].map((z) => Math.hypot(x, z)))) + 2;
  return (
    <>
      <color attach="background" args={["#dde5ee"]} />
      <fog attach="fog" args={["#dde5ee", 35, 90]} />
      <hemisphereLight args={["#ffffff", "#aeb8c2", 1.1]} />
      <directionalLight
        position={[14, 24, 10]}
        intensity={1.7}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-reach}
        shadow-camera-right={reach}
        shadow-camera-top={reach}
        shadow-camera-bottom={-reach}
        shadow-camera-far={120}
        shadow-bias={-0.0005}
      />
      <Office plan={plan} agents={agents} teams={teams} work={world.work} queueLength={plan.queue.length} />
      {world.agents.map((a) => {
        const w = waiting.get(a.id);
        // The latest visit wins: someone asked twice walks to the second person.
        const visit = talk.visits.findLast((v) => v.fromId === a.id);
        const home = plan.spots.get(a.id)!;
        return (
          <group key={a.id}>
            <Avatar
              agent={a}
              spot={visit?.spot ?? home}
              enterFrom={arrivals.has(a.id) ? ENTRANCE : null}
              waiting={w ? { count: w.count, type: w.type } : null}
              selected={selected === a.id}
              onSelect={onSelect}
              bubble={visit?.text ?? talk.bubbles.findLast((b) => b.agentId === a.id)?.text ?? null}
              carrying={visit?.kind === "handoff"}
            />
            {a.helpers.length ? <Helpers helpers={a.helpers} spot={home} /> : null}
          </group>
        );
      })}
      <Player bounds={plan.bounds} start={START} fly={fly} />
    </>
  );
}
