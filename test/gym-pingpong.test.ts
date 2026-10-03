import { test } from "node:test";
import assert from "node:assert/strict";
import type { Team, WorldAgent } from "../src/shared/types.ts";
import type { Vec2 } from "../src/ui/world/spatial.ts";
import { place, planBuilding, routeIn, type BuildingPlan } from "../src/ui/world/building.ts";
import { FOREARM, gymCorner, gymSpot, handFrom, shoulderFrame, STATIONS } from "../src/ui/world/gym.ts";
import {
  BALL_R, ballAt, BLADE, choosePingPong, NET_H, newPing, newPlayer, paddleAt, pingCorner, pingSpot, PingPlayback, pingTable, playerPose, RALLY, SHOTS, TABLE_H, TABLE_L, TABLE_W, TABLE_X, TABLE_Z, type End,
} from "../src/ui/world/pingpong.ts";

const agent = (id: string, extra: Partial<WorldAgent> = {}): WorldAgent => ({ id, identity: id, name: id, harness: "manual", cwd: null, project: null, branch: null, status: "idle", title: null, paneId: null, taskIds: [], teamId: null, role: "member", waitingOnYou: false, doing: null, helpers: [], model: null, sessionName: null, ran: true, ...extra });
const team = (id: string): Team => ({ id, name: id, purpose: "", handsTo: null, path: null, branch: null, standing: true, worktrees: [], createdAt: "" });
const crew = (n: number) => Array.from({ length: n }, (_, i) => agent(`idle${i}`, { teamId: "t", role: i ? "member" : "lead" }));
const ends = (pp: Map<string, { pingpong?: End }>) => Object.fromEntries([...pp].map(([id, s]) => [s.pingpong!, id]));

test("two idle agents pair up at the table, the same two at the same ends whatever the order; one alone doesn't play", () => {
  const agents = crew(8), since = new Map(agents.map((a) => [a.id, 0]));
  const plan = planBuilding(agents, [team("t")], []);
  assert.equal(choosePingPong(plan, agents, since, 59_999).size, 0, "a project's members only once out for a break");
  const pair = choosePingPong(plan, agents, since, 60_000);
  assert.equal(pair.size, 2);
  assert.deepEqual(Object.keys(ends(pair)).sort(), ["0", "1"]);
  assert.deepEqual(choosePingPong(plan, [...agents].reverse(), since, 60_000), pair);
  for (const [, spot] of pair) assert.deepEqual(spot, pingSpot(plan, spot.pingpong!));
  assert.equal(choosePingPong(plan, crew(1), since, 60_000).size, 0, "nobody to play with");
  // Someone busy elsewhere leaves one: still nobody to play with.
  const two = crew(2);
  assert.equal(choosePingPong(plan, two, since, 60_000, new Map(), new Set([two[0]!.id])).size, 0);
  assert.equal(choosePingPong(plan, two, since, 60_000).size, 2);
});

test("a pair plays on while both are idle; one leaving makes room for the next, the other staying at their end", () => {
  const agents = crew(8), since = new Map(agents.map((a) => [a.id, 0]));
  const plan = planBuilding(agents, [team("t")], []);
  const first = choosePingPong(plan, agents, since, 60_000);
  const [a0, a1] = [ends(first)[0]!, ends(first)[1]!];
  const more = [...agents, ...Array.from({ length: 6 }, (_, i) => agent(`late${i}`, { teamId: "t" }))];
  assert.deepEqual(ends(choosePingPong(plan, more, new Map(more.map((a) => [a.id, 0])), 70_000, first)), { 0: a0, 1: a1 });
  for (const change of [{ status: "working" as const }, { waitingOnYou: true }]) {
    const next = choosePingPong(plan, agents.map((a) => (a.id === a1 ? { ...a, ...change } : a)), since, 61_000, first);
    assert.equal(next.size, 2);
    assert.equal(ends(next)[0], a0, "the one still idle keeps their end");
    assert.ok(ends(next)[1] && ends(next)[1] !== a1);
  }
  assert.ok(!choosePingPong({ ...plan, queue: [a0] }, agents, since, 61_000, first).has(a0));
  assert.ok(!choosePingPong(plan, agents, since, 61_000, first, new Set([a0])).has(a0), "never someone at a game or the gym");
});

test("the rally starts once both are at the table and stops when either walks off", () => {
  const play = new PingPlayback(["a", "b"]);
  play.arrive("a", true, 1000);
  assert.equal(play.seconds(2000), null, "waiting for the other");
  play.arrive("c", true, 1500);
  play.arrive("b", false, 2000);
  play.arrive("b", true, 3000);
  assert.equal(play.seconds(5000), 2);
  play.arrive("a", false, 6000);
  assert.equal(play.seconds(6000), null);
  assert.equal(new PingPlayback(["a"]).seconds(0), null);
});

const g = 9.81;
const top = TABLE_H + BALL_R;
const at = (t: number) => ({ ...ballAt(t, newPing()) });

test("the serve bounces once on each side and every rally shot once on the far one, on the table and over the net", () => {
  const { hits, flights } = RALLY;
  assert.equal(hits.length, 2 * (SHOTS + 1), "two points a round, the last shot of each caught");
  assert.deepEqual(hits.filter((h) => h.serve).map((h) => h.end), [0, 1], "each end serves in turn");
  for (let i = 0; i + 1 < hits.length; i++) {
    const h = hits[i]!, next = hits[i + 1]!;
    if (next.end === h.end) continue;
    const bounces = flights.filter((f) => f.bounce && f.t1 > h.at && f.t1 < next.at);
    const side = (a: number) => (a < 0 ? 0 : 1);
    if (h.serve) assert.deepEqual(bounces.map((f) => side(f.a1)), [h.end, next.end], "the serve: the server's side, then the other's");
    else assert.deepEqual(bounces.map((f) => side(f.a1)), [next.end], "a shot: once, on the far side");
    for (const f of bounces) {
      assert.ok(Math.abs(f.a1) < TABLE_L / 2 - 0.05 && Math.abs(f.c1) < TABLE_W / 2 - 0.05, "on the table");
      assert.ok(Math.abs(at(f.t1).y - top) < 1e-9, "on its top");
    }
    // Over the net: wherever the ball crosses the middle, it is above the net.
    for (let t = h.at; t < next.at; t += 0.002) {
      const p = at(t), q = at(t + 0.002);
      if (Math.sign(p.a) !== Math.sign(q.a)) assert.ok(p.y > TABLE_H + NET_H + BALL_R, `over the net at ${t.toFixed(2)}s`);
    }
  }
});

test("the ball flies in arcs under gravity, bounces believably, and meets each paddle as it swings", () => {
  for (const f of RALLY.flights) {
    if (f.t1 - f.t0 < 0.05) continue;
    // A parabola: constant speed along the table, falling at g.
    const T = f.t1 - f.t0, dt = T / 4;
    const y = (t: number) => at(t).y;
    const accel = (y(f.t0 + 3 * dt) - 2 * y(f.t0 + 2 * dt) + y(f.t0 + dt)) / (dt * dt);
    assert.ok(Math.abs(accel + g) < 1e-6, "falling at g");
  }
  for (let i = 0; i + 1 < RALLY.flights.length; i++) {
    const f = RALLY.flights[i]!, next = RALLY.flights[i + 1]!;
    if (!f.bounce) continue;
    const e = next.vy / -(f.vy - g * (f.t1 - f.t0));
    assert.ok(e > 0.7 && e < 0.95, `a bounce gives back ${e.toFixed(2)} of its speed`);
  }
  const paddle = newPing();
  for (const h of RALLY.hits) {
    const b = at(h.at - 1e-6);
    paddleAt(h.end, h.at - 1e-6, paddle);
    assert.ok(Math.hypot(b.a - paddle.a, b.y - paddle.y, b.c - paddle.c) < 1e-3, `the paddle meets the ball at ${h.at.toFixed(2)}s`);
  }
});

test("a round loops seamlessly and nothing jumps: the ball, each paddle and each player", () => {
  const p = newPing(), q = newPing();
  const close = (a: { a: number; y: number; c: number }, b: { a: number; y: number; c: number }, d: number) => Math.hypot(a.a - b.a, a.y - b.y, a.c - b.c) < d;
  assert.ok(close(at(0), at(RALLY.length - 1e-9), 1e-3), "the ball");
  for (const end of [0, 1] as const) assert.ok(close(paddleAt(end, 0, p), paddleAt(end, RALLY.length - 1e-9, q), 1e-3), `paddle ${end}`);
  for (let t = 0; t < 2 * RALLY.length; t += 0.01) {
    assert.ok(close(ballAt(t, p), ballAt(t + 0.01, q), 0.07), `the ball jumps at ${t.toFixed(2)}s`);
    for (const end of [0, 1] as const) assert.ok(close(paddleAt(end, t, p), paddleAt(end, t + 0.01, q), 0.04), `paddle ${end} jumps at ${t.toFixed(2)}s`);
  }
});

test("each player's paddle hand reaches the blade to where the rally has it, at every height and build", () => {
  const plan = planBuilding([], [], []);
  const table = pingTable(plan);
  const pose = newPlayer(), paddle = newPing(), target: [number, number, number] = [0, 0, 0];
  for (const end of [0, 1] as const) {
    const spot = pingSpot(plan, end);
    for (const [h, build] of [[0.92, 0.9], [1, 1], [1.08, 1.2]] as const) {
      let worst = 0;
      for (let t = 0; t < RALLY.length; t += 0.05) {
        playerPose(table, spot.pos[0], spot.pos[1], spot.facing, end, t, h, build, pose);
        paddleAt(end, t, paddle);
        const [wx, wz] = table.world(paddle.a, paddle.c);
        const [lx, lz] = place([0, 0], -spot.facing, [wx - spot.pos[0], wz - spot.pos[1]]);
        shoulderFrame((lx - pose.rootX) / h, paddle.y / h - pose.rootY, lz / h, pose.bend, build, 1, target);
        const blade = handFrom(pose.right, FOREARM + BLADE);
        worst = Math.max(worst, Math.hypot(blade[0] - target[0], blade[1] - target[1], blade[2] - target[2]) * h);
        assert.ok(Math.abs(pose.rootX) <= 0.5 && Math.abs(pose.head) <= 0.9);
      }
      assert.ok(worst < 0.03, `end ${end} at ${h}/${build}: the blade ${worst.toFixed(3)} m from where it should be`);
    }
  }
});

interface Block { id: string; center: Vec2; half: Vec2; facing: number }
const distance = (b: Block, p: Vec2) => {
  const q = place([0, 0], -b.facing, [p[0] - b.center[0], p[1] - b.center[1]]);
  return Math.hypot(Math.max(0, Math.abs(q[0]) - b.half[0]), Math.max(0, Math.abs(q[1]) - b.half[1]));
};

test("both ends have a clear way in past the nook and the table, and the table stands in a corner of its own", () => {
  for (const count of [0, 3, 12]) {
    const teams = Array.from({ length: count }, (_, i) => team(`t${i}`));
    const agents = teams.flatMap((t) => Array.from({ length: count === 12 ? 18 : 9 }, (_, i) => agent(`${t.id}:${i}`, { teamId: t.id, role: i === 0 ? "lead" : "member" })));
    const plan: BuildingPlan = planBuilding(agents, teams, []);
    const { nook, half, at } = pingCorner(plan);
    assert.notDeepEqual(nook.center, gymCorner(plan).nook.center, "not the gym's corner");
    const table = pingTable(plan);
    const blocks: Block[] = [
      { id: "nook sofa", center: nook.center, half: [1, 0.44], facing: nook.facing },
      { id: "nook table", center: place(nook.center, nook.facing, [0, 1.6]), half: [0.45, 0.3], facing: nook.facing },
      ...[-1.6, 1.6].map((x): Block => ({ id: "nook plant", center: place(nook.center, nook.facing, [x, -0.8]), half: [0.35, 0.35], facing: nook.facing })),
      { id: "table", center: table.center, half: [TABLE_L / 2, TABLE_W / 2 + 0.18], facing: table.yaw },
      ...plan.walls.map((w): Block => {
        const dx = w.b[0] - w.a[0], dz = w.b[1] - w.a[1];
        return { id: "wall", center: [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2], half: [Math.hypot(dx, dz) / 2, 0.15], facing: Math.atan2(-dz, dx) };
      }),
    ];
    // The table and the players inside the corner's square, clear of its walls.
    assert.ok(Math.abs(TABLE_X) + 2.2 + 0.4 < half && TABLE_Z - TABLE_W / 2 > 0.3);
    assert.deepEqual(table.center, at(TABLE_X, -half + TABLE_Z));
    for (const end of [0, 1] as const) {
      const spot = pingSpot(plan, end);
      const path = [plan.entrance, ...routeIn(plan)(plan.entrance, null, spot)];
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1]!, b = path[i]!, n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.08));
        for (let k = 0; k <= n; k++) {
          const p: Vec2 = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n];
          for (const ob of blocks) if (distance(ob, p) < 0.215) assert.fail(`building/${count} end ${end}: ${p} hits ${ob.id} at ${ob.center}`);
        }
      }
    }
    // Nothing of the gym's in this corner.
    for (const s of STATIONS) assert.ok(Math.hypot(gymSpot(plan, s).pos[0] - table.center[0], gymSpot(plan, s).pos[1] - table.center[1]) > 6);
  }
});
