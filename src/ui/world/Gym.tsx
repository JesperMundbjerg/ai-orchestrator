import { createContext, useContext, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { CylinderGeometry, MeshStandardMaterial, type Group } from "three";
import type { BuildingPlan } from "./building.ts";
import type { Kit } from "./Furniture.tsx";
import { lookFor } from "./look.ts";
import { usePace } from "./Pace.tsx";
import { BAR_LENGTH, BENCH_FROM, BENCH_TO, BENCH_TOP, GymPlayback, gymCorner, gymSpot, HOOK_Y, HOOK_Z, LAYOUT, newPose, PLATE_R, PLATFORM_H, PULL_Y, PULL_Z, restingBar, STATIONS, UPRIGHT_Y, UPRIGHT_Z, type Station } from "./gym.ts";
import type { Spot } from "./spatial.ts";

// The gym as drawn: its boxes go in with the building's furniture (`furnishGym`), and what is
// round, the bars and the plates, is a few meshes on shared geometry and materials (`GymScene`).
// A bar is where its lifter's pose says while they train, and back where it rests otherwise: the
// lifter is whoever the gym's clock has at its station, an agent or a regular moving round.

export const GymContext = createContext<GymPlayback | null>(null);
export const useGym = () => useContext(GymContext);

const RUBBER = "#34393f";
const PAD = "#3f4a5a";

/** The gym's boxes, each station in its own frame (+z the way its lifter faces). */
export function furnishGym(kit: Kit, plan: BuildingPlan) {
  const { nook, half } = gymCorner(plan);
  // A rubber floor along the outer wall, behind the nook's sofa and plants.
  const floor = kit.at(nook.center, nook.facing);
  floor("fabric", [0, 0.003, -half + 1.45], [2 * half - 0.3, 0.006, 2.6], 0, RUBBER);
  const frame = (station: Station) => {
    const spot = gymSpot(plan, station);
    return { add: kit.at(spot.pos, spot.facing), wall: -LAYOUT[station].z + 0.15 };
  };
  {
    // A lifting platform: a wooden middle to stand on, rubber either side where the plates land.
    const { add } = frame("platform");
    add("wood", [0, PLATFORM_H / 2, 0.05], [1.2, PLATFORM_H, 2], 0, "#c8a27a");
    for (const sx of [-1, 1]) add("fabric", [sx * 0.9, PLATFORM_H / 2, 0.05], [0.6, PLATFORM_H, 2], 0, "#2a2e33");
  }
  {
    // A squat stand: two uprights either side of the lifter, J-hooks reaching back to the bar.
    const { add } = frame("rack");
    for (const sx of [-1, 1]) {
      add("metal", [sx * 0.62, 1.0, 0.1], [0.07, 2.0, 0.07]);
      add("metal", [sx * 0.62, 0.03, 0.1], [0.1, 0.06, 0.7]);
      add("metal", [sx * 0.62, HOOK_Y - 0.035, (HOOK_Z + 0.1) / 2], [0.06, 0.04, 0.16], 0, "#c9cdd2");
      add("metal", [sx * 0.62, 0.62, 0.1], [0.06, 0.04, 0.5], 0, "#c9cdd2");
    }
    add("metal", [0, 1.98, 0.1], [1.3, 0.06, 0.07]);
  }
  {
    // A flat bench, its uprights over the head end.
    const { add } = frame("bench");
    const mid = (BENCH_FROM + BENCH_TO) / 2;
    add("fabric", [0, BENCH_TOP - 0.04, mid], [0.3, 0.08, BENCH_TO - BENCH_FROM], 0, PAD);
    add("metal", [0, BENCH_TOP - 0.1, mid], [0.08, 0.04, BENCH_TO - BENCH_FROM - 0.1]);
    for (const z of [BENCH_FROM + 0.15, BENCH_TO - 0.12]) {
      add("metal", [0, (BENCH_TOP - 0.1) / 2, z], [0.06, BENCH_TOP - 0.1, 0.06]);
      add("metal", [0, 0.02, z], [0.4, 0.04, 0.08]);
    }
    for (const sx of [-1, 1]) {
      add("metal", [sx * 0.55, (UPRIGHT_Y + 0.12) / 2, UPRIGHT_Z - 0.07], [0.06, UPRIGHT_Y + 0.12, 0.06]);
      add("metal", [sx * 0.55, UPRIGHT_Y - 0.035, UPRIGHT_Z - 0.02], [0.05, 0.04, 0.12], 0, "#c9cdd2");
    }
    add("metal", [0, 0.03, UPRIGHT_Z - 0.07], [1.2, 0.06, 0.1]);
  }
  {
    // A pull-up rig: two posts and beams back to the wall; its bar is round (GymScene).
    const { add, wall } = frame("pullup");
    for (const sx of [-1, 1]) {
      add("metal", [sx * 0.8, 1.22, PULL_Z], [0.08, 2.44, 0.08]);
      add("metal", [sx * 0.8, 1.22, wall + 0.08], [0.08, 2.44, 0.08]);
      add("metal", [sx * 0.8, 2.4, (PULL_Z + wall + 0.08) / 2], [0.08, 0.08, PULL_Z - wall - 0.08]);
    }
  }
  // A plate tree by the wall between the stand and the bench.
  const tree = treeAt(plan);
  const add = kit.at(tree.pos, tree.facing);
  add("metal", [0, 0.6, 0], [0.06, 1.2, 0.06]);
  add("metal", [0, 0.025, 0], [0.5, 0.05, 0.5]);
  for (const [y, sx] of TREE_PEGS) add("metal", [sx * 0.12, y, 0], [0.2, 0.035, 0.035], 0, "#c9cdd2");
}

/** Where the plate tree stands. */
function treeAt(plan: BuildingPlan): Spot {
  const { half, at, nook } = gymCorner(plan);
  return { pos: at(0.56, -half + 0.5), facing: nook.facing, zone: "lounge", group: "gym", approach: [] };
}

/** The plate tree's pegs, their heights and sides, and the plates on them. */
const TREE_PEGS: Array<[number, number]> = [[0.35, -1], [0.35, 1], [0.8, -1], [0.8, 1]];
const TREE_PLATES: Array<{ peg: number; r: number; color: string }> = [
  { peg: 0, r: PLATE_R, color: "#b8433a" },
  { peg: 1, r: PLATE_R, color: "#2f5fa8" },
  { peg: 2, r: 0.17, color: "#e0b43a" },
  { peg: 3, r: 0.14, color: "#4f9a5a" },
];

// Shared by every bar and plate: one geometry each, one material each finish.
const BAR = new CylinderGeometry(0.016, 0.016, 1, 8);
const DISC = new CylinderGeometry(1, 1, 1, 20);
const STEEL = new MeshStandardMaterial({ color: "#c9cdd2", roughness: 0.35, metalness: 0.6 });
const plates = new Map<string, MeshStandardMaterial>();
const plate = (color: string) => {
  let m = plates.get(color);
  if (!m) plates.set(color, (m = new MeshStandardMaterial({ color, roughness: 0.75 })));
  return m;
};

/** What each station's bar carries: plates from the inside out, as radius, thickness and colour. */
const LOADS: Record<Exclude<Station, "pullup">, Array<[number, number, string]>> = {
  platform: [[PLATE_R, 0.07, "#b8433a"], [PLATE_R, 0.05, "#2f5fa8"]],
  rack: [[0.22, 0.05, "#2b2f35"], [0.22, 0.05, "#2b2f35"], [0.16, 0.035, "#2b2f35"]],
  bench: [[0.2, 0.05, "#2b2f35"], [0.14, 0.035, "#2b2f35"]],
};

/** The bars and plates, and the pull-up rig's bar. Only a bar being lifted asks the pacer for frames. */
export function GymScene({ plan }: { plan: BuildingPlan }) {
  const spots = useMemo(() => new Map(STATIONS.map((s) => [s, gymSpot(plan, s)] as const)), [plan]);
  const pull = spots.get("pullup")!;
  const tree = treeAt(plan);
  return (
    <group name="gym">
      {(["platform", "rack", "bench"] as const).map((s) => <Barbell key={s} station={s} spot={spots.get(s)!} />)}
      <group position={[pull.pos[0], 0, pull.pos[1]]} rotation-y={pull.facing}>
        <mesh geometry={BAR} material={STEEL} position={[0, PULL_Y, PULL_Z]} rotation-z={Math.PI / 2} scale={[1.6, 1.7, 1.6]} castShadow />
      </group>
      <group position={[tree.pos[0], 0, tree.pos[1]]} rotation-y={tree.facing}>
        {TREE_PLATES.map(({ peg, r, color }, i) => {
          const [y, sx] = TREE_PEGS[peg]!;
          return <mesh key={i} geometry={DISC} material={plate(color)} position={[sx * 0.14, y + r - 0.05, 0]} rotation-z={Math.PI / 2} scale={[r, 0.05, r]} castShadow />;
        })}
      </group>
    </group>
  );
}

function Barbell({ station, spot }: { station: Exclude<Station, "pullup">; spot: Spot }) {
  const root = useRef<Group>(null);
  const gym = useGym();
  const pace = usePace();
  const pose = useMemo(newPose, []);
  // The lifter's height, looked up once each time someone new is at the station.
  const lifter = useRef<{ id: string | null; height: number }>({ id: null, height: 1 });
  useFrame(() => {
    const g = root.current;
    if (!g) return;
    const id = gym?.lifterAt(station) ?? null;
    const l = lifter.current;
    if (id !== l.id) { l.id = id; l.height = id ? lookFor(id).height : 1; }
    const p = id ? gym!.pose(id, Date.now(), l.height, pose) : null;
    const h = p ? l.height : 1;
    if (p?.moving) pace?.moved(performance.now());
    if (!p) restingBar(station, pose);
    const f = spot.facing;
    g.position.set(spot.pos[0] + Math.sin(f) * pose.barZ * h, pose.barY * h, spot.pos[1] + Math.cos(f) * pose.barZ * h);
    g.rotation.y = f;
  });
  // Loaded outside the uprights each bar rests in.
  let at = station === "rack" ? 0.7 : 0.62;
  const load = LOADS[station].map(([r, w, color]) => {
    const x = at + w / 2;
    at += w + 0.004;
    return { r, w, color, x };
  });
  return (
    <group ref={root} name={`gym-bar:${station}`}>
      <mesh geometry={BAR} material={STEEL} rotation-z={Math.PI / 2} scale={[1, BAR_LENGTH, 1]} castShadow />
      {[-1, 1].flatMap((sx) => [
        ...load.map((l, i) => <mesh key={`${sx}:${i}`} geometry={DISC} material={plate(l.color)} position={[sx * l.x, 0, 0]} rotation-z={Math.PI / 2} scale={[l.r, l.w, l.r]} castShadow />),
        <mesh key={`${sx}:collar`} geometry={DISC} material={STEEL} position={[sx * (at + 0.02), 0, 0]} rotation-z={Math.PI / 2} scale={[0.035, 0.04, 0.035]} />,
      ])}
    </group>
  );
}
