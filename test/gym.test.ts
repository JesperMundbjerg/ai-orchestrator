import { test } from "node:test";
import assert from "node:assert/strict";
import type { Team, WorldAgent } from "../src/shared/types.ts";
import type { Vec2 } from "../src/ui/world/spatial.ts";
import { place, planBuilding, routeIn, type BuildingPlan } from "../src/ui/world/building.ts";
import { chooseGames } from "../src/ui/world/games.ts";
import {
  armReach, BENCH_FROM, BENCH_TO, chooseGym, gymCorner, gymSpot, GymPlayback, handFrom, handTarget, LAYOUT, liftAt, LIFTS, liftPose, newPose, newReach,
  PLATE_R, PLATFORM_H, PROGRAMS, PULL_Y, PULL_Z, restingBar, SET_REST, SHOULDER_Y, stationPose, STATIONS, UPRIGHT_Z, type Lift, type Station,
} from "../src/ui/world/gym.ts";

const agent = (id: string, extra: Partial<WorldAgent> = {}): WorldAgent => ({ id, identity: id, name: id, harness: "manual", cwd: null, project: null, branch: null, status: "idle", title: null, paneId: null, taskIds: [], teamId: null, role: "member", waitingOnYou: false, doing: null, helpers: [], model: null, sessionName: null, ran: true, ...extra });
const team = (id: string): Team => ({ id, name: id, purpose: "", handsTo: null, path: null, branch: null, standing: true, worktrees: [], createdAt: "" });
const crew = (n: number) => Array.from({ length: n }, (_, i) => agent(`idle${i}`, { teamId: "t", role: i ? "member" : "lead" }));
const stations = (gym: Map<string, { gym?: Station }>) => [...gym.values()].map((s) => s.gym!);

test("a third of the idle crew trains, one to a station, the same agents at the same stations whatever the order", () => {
  const agents = crew(15), since = new Map(agents.map((a) => [a.id, 0]));
  const plan = planBuilding(agents, [team("t")], []);
  assert.equal(chooseGym(plan, agents, since, 59_999).size, 0, "a project's members only once out for a break");
  const gym = chooseGym(plan, agents, since, 60_000);
  assert.equal(gym.size, 4);
  assert.deepEqual(stations(gym).sort(), [...STATIONS].sort());
  assert.deepEqual(chooseGym(plan, [...agents].reverse(), since, 60_000), gym);
  for (const n of [0, 1, 2, 3, 5, 6, 9, 12]) assert.equal(chooseGym(plan, crew(n), since, 60_000).size, Math.min(4, Math.floor(n / 3)), `${n} idle`);
  for (const [, spot] of gym) assert.deepEqual(spot, gymSpot(plan, spot.gym!));
});

test("lifters stay at their station while idle, and leave on work, a question for you or a place in line", () => {
  const agents = crew(12), since = new Map(agents.map((a) => [a.id, 0]));
  const plan = planBuilding(agents, [team("t")], []);
  const first = chooseGym(plan, agents, since, 60_000);
  const ids = [...first.keys()];
  // More agents arriving doesn't move anyone already training.
  const more = [...agents, ...Array.from({ length: 9 }, (_, i) => agent(`late${i}`, { teamId: "t" }))];
  const later = chooseGym(plan, more, new Map(more.map((a) => [a.id, 0])), 70_000, first);
  for (const id of ids) assert.equal(later.get(id)?.gym, first.get(id)!.gym);
  for (const status of ["working", "blocked", "done", "offline"] as const) {
    const next = chooseGym(plan, agents.map((a) => (a.id === ids[0] ? { ...a, status } : a)), since, 61_000, first);
    assert.ok(!next.has(ids[0]!), status);
    for (const id of ids.slice(1)) assert.equal(next.get(id)?.gym, first.get(id)!.gym);
    assert.equal(next.size, 3, "a third of eleven idle: three stations");
  }
  assert.ok(!chooseGym(plan, agents.map((a) => (a.id === ids[1] ? { ...a, waitingOnYou: true } : a)), since, 61_000, first).has(ids[1]!));
  assert.ok(!chooseGym({ ...plan, queue: [ids[2]!] }, agents, since, 61_000, first).has(ids[2]!));
});

test("game players don't train, and nobody is in two places", () => {
  const agents = crew(15), since = new Map(agents.map((a) => [a.id, 0]));
  const plan = planBuilding(agents, [team("t")], []);
  const games = chooseGames(plan, agents, since, 60_000);
  const gym = chooseGym(plan, agents, since, 60_000, new Map(), new Set(games.keys()));
  assert.ok(games.size > 0);
  for (const id of gym.keys()) assert.ok(!games.has(id));
  assert.equal(gym.size, 4);
});

test("the clock starts on arrival, never on the way, and walking off stops it", () => {
  const play = new GymPlayback();
  assert.equal(play.seconds("a", 1000), null);
  play.arrive("a", false, 1000);
  assert.equal(play.seconds("a", 2000), null);
  play.arrive("a", true, 5000);
  play.arrive("a", true, 9000);
  assert.equal(play.seconds("a", 9000), 4);
  play.arrive("a", false, 9500);
  assert.equal(play.seconds("a", 9600), null);
  play.arrive("a", true, 20_000);
  assert.equal(play.seconds("a", 20_000), 0, "back again: the set starts over");
});

test("the platform goes three snatches then two clean and jerks; the others repeat their set", () => {
  const s = LIFTS.snatch.length, c = LIFTS.clean.length;
  assert.deepEqual(liftAt("platform", 0), { lift: "snatch", t: 0 });
  assert.equal(liftAt("platform", 2 * s + 1).lift, "snatch");
  assert.deepEqual(liftAt("platform", 3 * s + 1), { lift: "clean", t: 1 });
  assert.equal(liftAt("platform", 3 * s + c + 1).lift, "clean");
  assert.deepEqual(liftAt("platform", 3 * s + 2 * c + 1), { lift: "snatch", t: 1 });
  for (const station of ["rack", "bench", "pullup"] as const) {
    const lift = PROGRAMS[station][0]!, n = LIFTS[lift].length;
    assert.ok(n > 5 * 2 + SET_REST, `${lift} is a set of five and a rest`);
    assert.deepEqual(liftAt(station, n + 2), { lift, t: 2 });
  }
});

const pose = newPose();
const at = (lift: Lift, t: number, h = 1) => ({ ...liftPose(lift, t, h, pose) });
const floor = PLATE_R + PLATFORM_H;

test("snatch: off the floor to overhead in one movement, caught in a squat, stood up, and dropped", () => {
  const start = at("snatch", 0), set = at("snatch", 1.3), catcher = at("snatch", 2.7), up = at("snatch", 4.3), down = at("snatch", 6);
  assert.ok(Math.abs(start.barY - floor) < 1e-9 && start.grip === 0, "the bar waits on the platform");
  assert.ok(Math.abs(set.barY - floor) < 1e-9 && set.grip === 1 && set.bend > 1, "bent over, hands on the bar");
  // From the floor to overhead with nowhere it stops on the way: no rack position.
  let top = 0;
  for (let t = 1.5; t <= 2.5; t += 0.02) {
    const p = at("snatch", t);
    assert.ok(p.barY >= top - 1e-9, `the bar only rises (${t.toFixed(2)})`);
    top = p.barY;
  }
  assert.ok(catcher.barY > catcher.rootY + SHOULDER_Y, "caught overhead");
  assert.ok(catcher.rootY < -0.25 && catcher.thigh < -1, "at the bottom of a squat");
  assert.ok(Math.abs(up.rootY) < 1e-9 && up.barY > SHOULDER_Y + 0.45, "standing, the bar overhead");
  assert.ok(Math.abs(down.barY - floor) < 1e-9 && down.grip === 0);
});

test("clean and jerk: to the shoulders, stood up, then a dip and a drive overhead", () => {
  const caught = at("clean", 2.7), stood = at("clean", 4.4), dip = at("clean", 5.0), jerk = at("clean", 6.4);
  const shoulders = (p: ReturnType<typeof at>) => p.rootY + SHOULDER_Y;
  assert.ok(caught.rootY < -0.25 && Math.abs(caught.barY - shoulders(caught)) < 0.1, "a front squat, the bar on the shoulders");
  assert.ok(Math.abs(stood.rootY) < 1e-9 && Math.abs(stood.barY - SHOULDER_Y) < 0.1 && stood.barZ > 0.05, "standing, the bar racked in front");
  assert.ok(dip.rootY < -0.03 && dip.barY < stood.barY, "the dip");
  assert.ok(Math.abs(jerk.rootY) < 1e-9 && jerk.barY > SHOULDER_Y + 0.45, "overhead");
});

test("squat, bench and pull-up: bar on the back, lying on the bench, hanging from the bar", () => {
  const unrack = at("squat", 0), bottom = at("squat", 3.8), stood = at("squat", 2.4);
  assert.ok(Math.abs(stood.barY - (stood.rootY + SHOULDER_Y)) < 0.1 && stood.barZ < stood.rootZ, "the bar on the back of the shoulders");
  assert.ok(bottom.rootY < -0.25 && bottom.barY < stood.barY - 0.25, "down");
  assert.ok(stood.rootZ < unrack.rootZ - 0.3, "stepped back clear of the hooks");
  const lockout = at("bench", 2.2), chest = at("bench", 3.6);
  assert.ok(lockout.lie && chest.lie);
  assert.ok(lockout.barY > chest.barY + 0.3, "pressed up from the chest");
  const hang = at("pullup", 1.3), top = at("pullup", 2.6);
  assert.equal(hang.carried, false);
  assert.ok(Math.abs(hang.barY - PULL_Y) < 1e-9 && hang.rootY > 0.2, "off the floor");
  assert.ok(top.rootY > hang.rootY + 0.35 && top.rootY + SHOULDER_Y > PULL_Y - 0.2, "chin to the bar");
});

test("every lift starts and ends where its bar rests, holds still between reps, and never jumps", () => {
  for (const lift of Object.keys(LIFTS) as Lift[]) {
    const { length } = LIFTS[lift];
    for (const h of [0.92, 1, 1.08]) {
      const a = at(lift, 0, h), b = at(lift, length, h);
      for (const k of ["barY", "barZ", "rootY", "thigh", "bend", "grip"] as const) assert.ok(Math.abs(a[k] - b[k]) < 1e-9, `${lift}: round ends where it starts (${k})`);
      let last = at(lift, 0, h);
      for (let t = 0.02; t <= length; t += 0.02) {
        const p = at(lift, t, h);
        // At 50 frames a second nothing moves further than the fastest lift (the drop under a snatch) does.
        for (const k of ["rootY", "rootZ", "thigh", "knee", "bend"] as const) assert.ok(Math.abs(p[k] - last[k]) < 0.25, `${lift} ${k} jumps at ${t.toFixed(2)}s`);
        assert.ok(Math.abs(p.barY - last.barY) < 0.15, `${lift} bar jumps at ${t.toFixed(2)}s`);
        last = p;
      }
      assert.equal(at(lift, length - 1, h).moving, false, `${lift}: still while resting`);
    }
  }
  for (const station of STATIONS) {
    const rest = { ...restingBar(station, newPose()) }, first = { ...stationPose(station, 0, 1, newPose()) };
    assert.deepEqual([rest.barY, rest.barZ], [first.barY, first.barZ], `${station}: the bar is picked up where it rests`);
  }
});

test("the hands are on the bar whenever they grip it, whatever the lifter's height and build", () => {
  const reach = newReach(), target: [number, number, number] = [0, 0, 0];
  for (const lift of Object.keys(LIFTS) as Lift[]) {
    for (const [h, build] of [[0.92, 0.9], [1, 1], [1.08, 1.2]] as const) {
      let worst = 0;
      for (let t = 0; t <= LIFTS[lift].length; t += 0.05) {
        const p = liftPose(lift, t, h, pose);
        if (p.grip < 1) continue;
        for (const side of [-1, 1]) {
          const [x, y, z] = handTarget(p, build, side, target);
          const hand = handFrom(armReach(x, y, z, side * p.poleX, p.poleY, p.poleZ, reach));
          // How far the hand is from the bar, across it (its axis runs along x).
          worst = Math.max(worst, Math.hypot(hand[1] - y, hand[2] - z), Math.abs(hand[0] - x) > 0.08 ? 1 : 0);
        }
      }
      assert.ok(worst < 0.04, `${lift} at ${h}/${build}: a hand ${worst.toFixed(3)} m off the bar`);
    }
  }
  // The rig's own sums: what the reach says is where the hand ends up.
  for (const [x, y, z] of [[0.1, -0.4, 0.2], [0.15, 0.5, 0.05], [0.2, 0.05, 0.4], [0.05, -0.2, -0.25]] as const) {
    const hand = handFrom(armReach(x, y, z, 1, -0.5, 0.3, reach));
    assert.ok(Math.hypot(hand[0] - x, hand[1] - y, hand[2] - z) < 1e-6);
  }
});

interface Block { id: string; center: Vec2; half: Vec2; facing: number }
const distance = (b: Block, p: Vec2) => {
  const q = place([0, 0], -b.facing, [p[0] - b.center[0], p[1] - b.center[1]]);
  return Math.hypot(Math.max(0, Math.abs(q[0]) - b.half[0]), Math.max(0, Math.abs(q[1]) - b.half[1]));
};
/** What stands in the gym's corner: the nook's sofa, table and plants, the walls, and each station's frame. */
function corner(plan: BuildingPlan): Block[] {
  const out: Block[] = [];
  const { nook, half, at } = gymCorner(plan);
  const n = nook;
  out.push({ id: "nook sofa", center: n.center, half: [1, 0.44], facing: n.facing });
  out.push({ id: "nook table", center: place(n.center, n.facing, [0, 1.6]), half: [0.45, 0.3], facing: n.facing });
  for (const x of [-1.6, 1.6]) out.push({ id: "nook plant", center: place(n.center, n.facing, [x, -0.8]), half: [0.35, 0.35], facing: n.facing });
  for (const w of plan.walls) {
    const dx = w.b[0] - w.a[0], dz = w.b[1] - w.a[1];
    out.push({ id: "wall", center: [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2], half: [Math.hypot(dx, dz) / 2, 0.15], facing: Math.atan2(-dz, dx) });
  }
  const frames: Record<Station, Array<[Vec2, Vec2]>> = {
    // The platform is floor to walk across; only what stands up counts.
    platform: [],
    rack: [[[-0.62, 0.1], [0.05, 0.35]], [[0.62, 0.1], [0.05, 0.35]]],
    bench: [[[0, (BENCH_FROM + BENCH_TO) / 2], [0.2, (BENCH_TO - BENCH_FROM) / 2]], [[0, UPRIGHT_Z - 0.07], [0.6, 0.05]]],
    pullup: [[[-0.8, PULL_Z], [0.04, 0.04]], [[0.8, PULL_Z], [0.04, 0.04]]],
  };
  for (const station of STATIONS) {
    const spot = gymSpot(plan, station);
    for (const [c, h] of frames[station]) out.push({ id: `gym ${station}`, center: place(spot.pos, spot.facing, c), half: h, facing: spot.facing });
  }
  out.push({ id: "plate tree", center: at(0.56, -half + 0.5), half: [0.25, 0.25], facing: nook.facing });
  return out;
}

test("every station has a clear way in, past the nook and the other stations, whatever the office's size", () => {
  for (const count of [0, 3, 12]) {
    const teams = Array.from({ length: count }, (_, i) => team(`t${i}`));
    const agents = teams.flatMap((t) => Array.from({ length: count === 12 ? 18 : 9 }, (_, i) => agent(`${t.id}:${i}`, { teamId: t.id, role: i === 0 ? "lead" : "member" })));
    const plan = planBuilding(agents, teams, []), blocks = corner(plan);
    const { half } = gymCorner(plan);
    assert.ok(half >= 4.5, "a corner big enough for the gym");
    for (const station of STATIONS) {
      const spot = gymSpot(plan, station);
      assert.ok(Math.abs(LAYOUT[station].x) + 0.9 < half, `${station} inside the corner`);
      const path = [plan.entrance, ...routeIn(plan)(plan.entrance, null, spot)];
      // From the nook's way in on: the rest of the way is every nook seat's, and checked with them.
      const from = path.findIndex((p) => p === spot.approach[2]);
      for (let i = Math.max(1, from + 1); i < path.length; i++) {
        const a = path[i - 1]!, b = path[i]!, n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.08));
        for (let k = 0; k <= n; k++) {
          const p: Vec2 = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n];
          for (const ob of blocks) {
            if (ob.id === `gym ${station}`) continue;
            if (distance(ob, p) < 0.215) assert.fail(`building/${count} ${station}: ${p} hits ${ob.id} at ${ob.center}`);
          }
        }
      }
    }
  }
});
