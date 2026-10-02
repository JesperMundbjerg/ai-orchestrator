import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Color } from "three";
import type { InboxState, ItemType, UsageMeter, WorldAgent, WorldState, WorldTeam } from "../../shared/types.ts";
import { api } from "../api.ts";
import { useItemDetail } from "../hooks.ts";
import { needsYou } from "../queue.ts";
import { Avatar } from "./Avatar.tsx";
import { crafters } from "./crafts.ts";
import { lookFor } from "./look.ts";
import { CALLER, planOffice, queueOrder, SPAWN, YOUR_VIEW, type OfficePlan, type Spot, type Vec2 } from "./layout.ts";
import { callerIn, isBuilding, planBuilding, routeIn, savedLayout, saveLayout, viewIn, type BuildingPlan, type Layout } from "./building.ts";
import { IDLE_MS, inPark, nextPastime, outForABreak, parkPlan, type Park } from "./park.ts";
import { BuildingOffice } from "./BuildingOffice.tsx";
import { CallerCard, CallerNote } from "./Caller.tsx";
import { Office } from "./Office.tsx";
import { Jars } from "./Jars.tsx";
import { AgentPanel, AnswerModal, Legend, TeamPanel, TeamsPanel } from "./Panels.tsx";
import { Helpers } from "./Helpers.tsx";
import { Pace, PaceContext } from "./Pace.tsx";
import { Pacer } from "./pace.ts";
import { Player, type FlyTarget } from "./Player.tsx";
import { calls, GRACE_MS, plan as planTalk, walkMs, type Bubble, type Call, type Visit } from "./visits.ts";

export interface Waiting {
  count: number;
  type: ItemType;
  itemIds: string[];
}

const NO_METERS: UsageMeter[] = [];
/**
 * Just behind your chair and a little above it, facing the first team straight ahead: from
 * here the desk, the line and the corners either side of the first are all in view.
 */
const START: FlyTarget = { pos: YOUR_VIEW, yaw: 0, lift: 0.15, seq: 0 };
/** From your desk, turned so a lead who came over stands left of the card they bring. */
const FACE_CALLER: Vec2 = [SPAWN[0] + 0.3, SPAWN[1] + 0.4];
const FACE_CALLER_YAW = Math.atan2(CALLER[0] - FACE_CALLER[0], FACE_CALLER[1] - CALLER[1]) + 0.05;

/**
 * The office: every agent as a person you can walk up to. Each project (and standing team) has its own corner, the
 * rest wait in the lounge (in the building, the garden), and anyone with something for you queues at your desk.
 */
export function WorldView({ state, tick, onLeave, onCrewGuide }: { state: InboxState; tick: number; onLeave: () => void; onCrewGuide: () => void }) {
  const [world, setWorld] = useState<WorldState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [openTeam, setOpenTeam] = useState<string | null>(null);
  const [answering, setAnswering] = useState<string | null>(null);
  const [fly, setFly] = useState<FlyTarget | null>(null);
  const [layout, setLayout] = useState<Layout>(savedLayout);
  const pacer = useMemo(() => new Pacer(), []);
  const detail = useItemDetail(answering, tick);

  useEffect(() => {
    let live = true;
    api.world().then((w) => live && (setWorld(w), setError(null)), (e: Error) => live && setError(e.message));
    return () => void (live = false);
  }, [tick]);

  const entries = useMemo(() => needsYou(state, "all", null), [state]);
  const queue = useMemo(() => (world ? queueOrder(world.agents, entries.map((e) => e.task.id)) : []), [world, entries]);
  // The office as drawn, and where everyone is in it: in the building, whoever is idle is out in the garden.
  const office = useMemo(() => (world ? (layout === "building" ? planBuilding : planOffice)(world.agents, world.teams, queue) : null), [world, queue, layout]);
  const plan = usePark(world, office);
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
  const { calling, arrived, sendBack } = useCalls(world, agents, plan);
  const walking = calling.filter((c) => !arrived.includes(c));
  // One at a time, once they are here, and not over what you opened yourself.
  const caller = !answering && !selectedAgent && !shownTeam ? arrived[0] ?? null : null;
  const nextItem = entries.find((e) => e.item.id !== answering)?.item.id ?? null;

  const select = (id: string) => {
    setSelected(id);
    const w = waiting.get(id);
    if (w) setAnswering(w.itemIds[0]!);
  };
  const flyTo = (pos: Vec2, yaw: number) => setFly((f) => ({ pos, yaw, seq: (f?.seq ?? 0) + 1 }));

  // When a lead has come over, you turn to face them.
  const faced = useRef<string | null>(null);
  useEffect(() => {
    const key = arrived[0]?.key ?? null;
    if (key && key !== faced.current) flyTo(FACE_CALLER, FACE_CALLER_YAW);
    faced.current = key;
  }, [arrived]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || (e.target as HTMLElement).closest("input, textarea, select")) return;
      if (answering) setAnswering(null);
      else if (selected) setSelected(null);
      else if (openTeam) setOpenTeam(null);
      else if (caller) sendBack(caller.key);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [answering, selected, openTeam, caller, sendBack]);

  if (!world || !plan || !office) {
    return <div className="empty-page">{error ? `The office did not open (${error}).` : "Opening the office…"}</div>;
  }

  return (
    <div className="world">
      {/* Drawn on demand at the pacer's rate, and at no more than 1.5 device pixels a pixel. */}
      <Canvas shadows frameloop="demand" dpr={[1, 1.5]} camera={{ fov: 62, near: 0.1, far: 160 }} onPointerMissed={() => setSelected(null)}>
        <Pace pacer={pacer} />
        <PaceContext value={pacer}>
          <Scene office={office!} plan={plan} world={world} agents={agents} teams={teams} waiting={waiting} arrivals={arrivals} talk={talk} calling={calling} selected={selected} onSelect={select} fly={fly} />
        </PaceContext>
      </Canvas>

      <header className="world-top">
        <button className="ghost small" onClick={onLeave}>← Inbox</button>
        <strong>Office</strong>
        <span className="layout-toggle" role="group" aria-label="Office layout" style={{ display: "inline-flex", gap: 4 }}>
          {(["ring", "building"] as const).map((l) => (
            <button key={l} className={`${layout === l ? "primary" : "ghost"} small`} aria-pressed={layout === l} onClick={() => (saveLayout(l), setLayout(l))}>
              {l === "ring" ? "Ring" : "Building"}
            </button>
          ))}
        </span>
        <span className="muted">
          {world.agents.length} {world.agents.length === 1 ? "agent" : "agents"} · {world.herdr === "connected" ? "live from herdr" : "herdr not running: no live status"}
        </span>
        <span className="spacer" />
        <button className="ghost small" onClick={() => setFly((f) => ({ ...START, seq: (f?.seq ?? 0) + 1 }))}>Your desk</button>
        {entries.length ? (
          <button className="primary small" onClick={() => setAnswering(entries[0]!.item.id)}>
            {queue.length} in line · answer the first
          </button>
        ) : null}
      </header>

      <TeamsPanel
        onCrewGuide={onCrewGuide}
        world={world}
        plan={plan}
        agents={agents}
        onOpen={(id, pos, yaw) => {
          setSelected(null);
          setOpenTeam(id);
          // Corners and bays face your desk from all round, so the plan knows where to stand to see one.
          const corner = plan.corners.find((c) => c.team.id === id);
          const view = corner ? viewIn(plan, corner) : { pos, yaw };
          flyTo(view.pos, view.yaw);
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
            if (!spot) return;
            // In the garden whoever it is faces a bed, a tree or the path, so you stand beside them along the path instead of in front.
            if (spot.zone === "garden") {
              const f = spot.facing;
              const at: Vec2 = [spot.pos[0] + Math.cos(f) * 2.4 + Math.sin(f) * 0.3, spot.pos[1] - Math.sin(f) * 2.4 + Math.cos(f) * 0.3];
              flyTo(at, Math.atan2(spot.pos[0] - at[0], at[1] - spot.pos[1]));
            } else flyTo([spot.pos[0] + Math.sin(spot.facing) * 2.6, spot.pos[1] + Math.cos(spot.facing) * 2.6], -spot.facing);
          }}
          onClose={() => setSelected(null)}
          onTeam={openTeam && selectedAgent.teamId === openTeam ? () => setSelected(null) : null}
        />
      ) : null}
      {caller ? (
        <CallerCard
          key={caller.key}
          call={caller}
          team={teams.get(caller.teamId)!}
          agents={agents}
          waiting={waiting}
          tick={tick}
          onOpen={setSelected}
          onDismiss={() => sendBack(caller.key)}
        />
      ) : null}
      {!caller && walking[0] ? <CallerNote call={walking[0]} agents={agents} /> : null}
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
 * The leads coming to your desk, and those already there. Leads calling when the office opens
 * are there already; later ones count as there once they have walked over.
 */
function useCalls(world: WorldState | null, agents: Map<string, WorldAgent>, office: OfficePlan | null) {
  const [sentBack, setSentBack] = useState<ReadonlySet<string>>(new Set());
  // When each agent became blocked, as this office has seen it; one already blocked when it opens counts from then.
  const since = useRef<Map<string, number>>(new Map());
  const [now, setNow] = useState(Date.now);
  const blockedSince = useMemo(() => {
    const t = Date.now();
    const next = new Map<string, number>();
    for (const a of agents.values()) if (a.status === "blocked") next.set(a.id, since.current.get(a.id) ?? t);
    since.current = next;
    return next;
  }, [agents]);
  // Look again when the earliest crew member still in their grace period has been there long enough.
  useEffect(() => {
    const t = Date.now();
    const due = Math.min(...[...blockedSince.values()].map((s) => s + GRACE_MS).filter((d) => d > t));
    if (!Number.isFinite(due)) return;
    const timer = setTimeout(() => setNow(Date.now()), due - t + 50);
    return () => clearTimeout(timer);
  }, [blockedSince, now]);
  const calling = useMemo(() => (world ? calls(world.teams, agents, sentBack, { blockedSince, now }, office ? callerIn(office) : undefined) : []), [world, agents, sentBack, blockedSince, now, office]);
  // When each lead is at your desk. Kept per lead, so a call that changes while they stand there does not walk them again.
  const at = useRef<Map<string, number> | null>(null);
  const [seen, setSeen] = useState(0);
  useEffect(() => {
    if (!office) return;
    const first = !at.current;
    const t = Date.now();
    const next = new Map<string, number>();
    for (const c of calling) {
      const home = office.spots.get(c.leadId);
      next.set(c.leadId, at.current?.get(c.leadId) ?? (first || !home ? t : t + walkMs(home, c.spot, routeIn(office))));
    }
    at.current = next;
    setSeen((n) => n + 1);
    const soonest = Math.min(...[...next.values()].filter((x) => x > t));
    if (!Number.isFinite(soonest)) return;
    const timer = setTimeout(() => setSeen((n) => n + 1), soonest - t + 50);
    return () => clearTimeout(timer);
  }, [calling, office]);
  // `seen` changes whenever `at` does and when someone arrives, so this reads `at` afresh.
  const arrived = useMemo(() => calling.filter((c) => (at.current?.get(c.leadId) ?? Infinity) <= Date.now()), [calling, seen]);
  const sendBack = useCallback((key: string) => setSentBack((s) => new Set([...s, key])), []);
  return { calling, arrived, sendBack };
}

/**
 * The plan with whoever is idle out in the garden, at what they are doing there now. A member
 * idle when the office opens is out there already; one who goes idle later goes out once idle
 * for IDLE_MS. It changes as they take up something new, a few at a time.
 */
function usePark(world: WorldState | null, office: OfficePlan | null): OfficePlan | null {
  const since = useRef<Map<string, number> | null>(null);
  const [now, setNow] = useState(Date.now);
  const idleSince = useMemo(() => {
    const t = Date.now();
    const first = !since.current;
    const next = new Map<string, number>();
    for (const a of world?.agents ?? []) if (a.status === "idle") next.set(a.id, since.current?.get(a.id) ?? (first ? -Infinity : t));
    if (world) since.current = next;
    return next;
  }, [world]);
  const building = office && isBuilding(office) ? office : null;
  const out = useMemo(() => (world && building ? outForABreak(world.agents, idleSince, now, building.queue) : new Set<string>()), [world, building, idleSince, now]);
  // Look again when the next member has been idle long enough, or the next one in the garden takes up something new.
  useEffect(() => {
    if (!building) return;
    const t = Date.now();
    const due = Math.min(...[...idleSince.values()].map((s) => s + IDLE_MS).filter((d) => d > t), nextPastime(inPark(building, out), t));
    if (!Number.isFinite(due)) return;
    const timer = setTimeout(() => setNow(Date.now()), due - t + 50);
    return () => clearTimeout(timer);
  }, [building, idleSince, out, now]);
  // Who was where, so those not changing stay put.
  const park = useRef<Park>(new Map());
  return useMemo(() => {
    if (!building) return office;
    const next = parkPlan(building as BuildingPlan, out, now, idleSince, park.current);
    park.current = next.park;
    return next.plan;
  }, [building, office, out, now, idleSince]);
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

/** A team's colour, light enough to read on a name tag. */
function tagColor(teamId: string): string {
  return `#${new Color(lookFor(teamId).shirt).lerp(new Color("#ffffff"), 0.35).getHexString()}`;
}

function Scene({ office, plan, world, agents, teams, waiting, arrivals, talk, calling, selected, onSelect, fly }: {
  /** The office as drawn; `plan` has where everyone is in it. */
  office: OfficePlan;
  plan: OfficePlan;
  world: WorldState;
  agents: Map<string, WorldState["agents"][number]>;
  teams: Map<string, WorldTeam>;
  waiting: Map<string, Waiting>;
  arrivals: Set<string>;
  talk: { visits: Visit[]; bubbles: Bubble[] };
  calling: Call[];
  selected: string | null;
  onSelect: (id: string) => void;
  fly: FlyTarget | null;
}) {
  const { minX, maxX, minZ, maxZ } = plan.bounds;
  const walk = useMemo(() => routeIn(plan), [plan]);
  // What each member makes at their station in their team's room.
  const makes = useMemo(() => crafters(office.corners), [office]);
  // Changing the layout puts everyone straight at their new places rather than walking them there through the walls.
  const layout = isBuilding(plan) ? "building" : "ring";
  // The light aims at the origin and its shadow frustum is in the light's own frame, so it is
  // sized to reach the farthest corner of the floor.
  const reach = Math.max(...[minX, maxX].flatMap((x) => [minZ, maxZ].map((z) => Math.hypot(x, z)))) + 2;
  return (
    <>
      <color attach="background" args={["#dde5ee"]} />
      {/* Far enough that the far side of the ring stays clear, from your desk or from above. */}
      <fog attach="fog" args={["#dde5ee", reach + 10, reach * 2 + 60]} />
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
      {isBuilding(office) ? (
        <BuildingOffice plan={office} agents={agents} teams={teams} work={world.work} queueLength={plan.queue.length} meters={world.usage?.meters ?? NO_METERS} />
      ) : (
        <Office plan={plan} agents={agents} teams={teams} work={world.work} queueLength={plan.queue.length} />
      )}
      <Jars corners={office.corners} usage={world.usage} />
      {world.agents.map((a) => {
        const w = waiting.get(a.id);
        // The latest visit wins: someone asked twice walks to the second person.
        const visit = talk.visits.findLast((v) => v.fromId === a.id);
        const home = plan.spots.get(a.id)!;
        // A lead at your desk stays there; a message they are sent meanwhile waits in their terminal.
        const call: Spot | undefined = calling.find((c) => c.leadId === a.id)?.spot;
        return (
          <group key={`${layout}:${a.id}`}>
            <Avatar
              agent={a}
              spot={call ?? visit?.spot ?? home}
              enterFrom={arrivals.has(a.id) ? plan.entrance : null}
              waiting={w ? { count: w.count, type: w.type } : null}
              selected={selected === a.id}
              onSelect={onSelect}
              bubble={call ? null : visit?.text ?? talk.bubbles.findLast((b) => b.agentId === a.id)?.text ?? null}
              carrying={!call && visit?.kind === "handoff"}
              team={a.teamId && teams.has(a.teamId) ? { name: teams.get(a.teamId)!.name, color: tagColor(a.teamId) } : null}
              walk={walk}
              craft={makes.get(a.id) ?? null}
            />
            {a.helpers.length ? <Helpers helpers={a.helpers} spot={home} /> : null}
          </group>
        );
      })}
      <Player bounds={plan.bounds} start={START} fly={fly} />
    </>
  );
}
