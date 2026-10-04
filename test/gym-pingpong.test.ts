import { test } from "node:test";
import assert from "node:assert/strict";
import type { Team, WorldAgent } from "../src/shared/types.ts";
import type { Vec2 } from "../src/ui/world/spatial.ts";
import { place, planBuilding, routeIn, type BuildingPlan } from "../src/ui/world/building.ts";
import { FOREARM, gymCorner, gymSpot, handFrom, shoulderFrame, STATIONS } from "../src/ui/world/gym.ts";
import {
  BALL_BACK, ballBack, bakeRally, BALL_R, BALL_REST, ballAt, BLADE, choosePingPong, handAt, NET_H, newHand, newPing, newPlayer, ON_HAND, paddleAt, pingCorner, PingEase, pingSpot, PingPlayback, pingTable, playerPose, RALLY, STAND, TABLE_H, TABLE_L, TABLE_W, TABLE_X, TABLE_Z, UNSETTLE, type End, type Ping, type Player, type Rally,
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
const side = (a: number): End => (a < 0 ? 0 : 1);
/** The flights between two moments. */
const during = (t0: number, t1: number) => RALLY.flights.filter((f) => f.t0 >= t0 - 1e-9 && f.t1 <= t1 + 1e-9);

test("every point is served by whoever has the ball: a bounce on each side, then each shot once on the far side, on the table and over the net", () => {
  let server: End = 0;
  for (const p of RALLY.points) {
    assert.equal(p.server, server, "the one with the ball serves");
    const hits = RALLY.hits.filter((h) => h.at >= p.t0 && h.at < p.t1);
    assert.equal(hits[0]!.serve && hits[0]!.end, p.server);
    assert.equal(hits.length, p.shots + (p.ending === "miss" ? 0 : 1), "the shots, and the one that goes long or into the net");
    hits.forEach((h, i) => assert.equal(h.end, i % 2 ? 1 - p.server : p.server, "in turn"));
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i]!, next = hits[i + 1]?.at ?? p.t1;
      const last = i === hits.length - 1;
      const bounces = during(h.at, next).filter((f) => f.bounce);
      if (last && p.ending === "long") assert.equal(bounces.length, 0, "long: over the far end without touching it");
      else if (last && p.ending === "net") {
        assert.ok(bounces.every((f) => side(f.a1) === h.end), "into the net: back on the hitter's side");
        assert.ok(during(h.at, next).some((f) => f.roll), "and rolls off their end");
      } else if (h.serve) assert.deepEqual(bounces.map((f) => side(f.a1)), [h.end, 1 - h.end], "the serve: the server's side, then the other's");
      else assert.deepEqual(bounces.map((f) => side(f.a1)), [1 - h.end], "a shot: once, on the far side");
      for (const f of bounces) {
        assert.ok(Math.abs(f.a1) < TABLE_L / 2 - 0.05 && Math.abs(f.c1) < TABLE_W / 2 - 0.05, "on the table");
        assert.ok(Math.abs(at(f.t1).y - top) < 1e-9, "on its top");
      }
      // Over the net, unless it is the one into it.
      if (last && p.ending === "net") continue;
      for (let t = h.at; t < next; t += 0.002) {
        const a = at(t), b = at(t + 0.002);
        if (Math.sign(a.a) !== Math.sign(b.a)) assert.ok(a.y > TABLE_H + NET_H + BALL_R, `over the net at ${t.toFixed(2)}s`);
      }
    }
    server = RALLY.holds.find((h) => Math.abs(h.t1 - p.t1) < 1e-9)!.end;
  }
});

test("no two points alike: how many shots, how fast and how high, where they land and where they are met, and how each ends", () => {
  const shots = RALLY.points.map((p) => p.shots);
  assert.ok(Math.min(...shots) <= 2 && Math.max(...shots) >= 7, `from ${Math.min(...shots)} to ${Math.max(...shots)} shots`);
  for (const ending of ["miss", "long", "net"] as const) assert.ok(RALLY.points.filter((p) => p.ending === ending).length >= 2, `${ending} at least twice`);
  assert.ok(new Set(RALLY.points.map((p) => p.winner)).size === 2, "both win points");
  const across = RALLY.flights.filter((f) => !f.roll && Math.abs(f.a1 - f.a0) > 1);
  const speeds = across.map((f) => Math.abs(f.a1 - f.a0) / (f.t1 - f.t0)), tops = across.map((f) => f.y0 + (f.vy * f.vy) / (2 * f.g));
  assert.ok(Math.max(...speeds) / Math.min(...speeds) > 1.8, "slow and fast");
  assert.ok(Math.max(...tops) - Math.min(...tops) > 0.4, "flat and lobbed");
  const lands = RALLY.flights.filter((f) => f.bounce).map((f) => Math.abs(f.a1));
  assert.ok(Math.max(...lands) - Math.min(...lands) > 0.6, "short and deep");
  const met = RALLY.hits.map((h) => STAND - Math.abs(h.a));
  assert.ok(Math.max(...met) - Math.min(...met) > 0.35, "met close to the table and back from it");
  const durations = RALLY.points.map((p) => p.t1 - p.t0);
  assert.ok(Math.max(...durations) > 2 * Math.min(...durations), "short points and long ones");
  // Seeded: the same seed, the same match; another, another.
  assert.deepEqual(bakeRally(), RALLY);
  assert.notDeepEqual(bakeRally("another").points.map((p) => p.shots), RALLY.points.map((p) => p.shots));
});

test("the ball flies in arcs under gravity, bounces believably, rolls to a stop, and meets each paddle as it swings", () => {
  for (const f of RALLY.flights) {
    if (f.t1 - f.t0 < 0.05) continue;
    const T = f.t1 - f.t0, dt = T / 4;
    const y = (t: number) => at(t).y;
    const accel = (y(f.t0 + 3 * dt) - 2 * y(f.t0 + 2 * dt) + y(f.t0 + dt)) / (dt * dt);
    assert.ok(Math.abs(accel + f.g) < 1e-6, f.roll ? "rolling flat" : "falling at g");
    assert.equal(f.g, f.roll ? 0 : g);
  }
  for (let i = 0; i + 1 < RALLY.flights.length; i++) {
    const f = RALLY.flights[i]!, next = RALLY.flights[i + 1]!;
    if (!f.bounce || next.roll) continue;
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

test("between points the ball is caught or picked up, held a moment, tossed and served: it never jumps or stops in the air", () => {
  const p = newPing(), q = newPing();
  const close = (a: Ping, b: Ping, d: number) => Math.hypot(a.a - b.a, a.y - b.y, a.c - b.c) < d;
  // Lying on the table where it rests when nobody plays, until the first server picks it up.
  assert.deepEqual(at(0), BALL_REST);
  assert.deepEqual(at(RALLY.holds[0]!.t0 - 0.01), BALL_REST);
  for (let t = 0; t < RALLY.length + 20; t += 0.005) {
    assert.ok(close(ballAt(t, p), ballAt(t + 0.005, q), 0.035), `the ball jumps at ${t.toFixed(3)}s`);
    assert.ok(p.y >= BALL_R - 1e-9, "never through the floor");
  }
  for (const h of RALLY.holds) {
    // In the free hand from the catch to the toss: from where it was caught.
    const caught = at(h.t0 - 1e-6), hand = handAt(h.end, h.t0, newHand());
    assert.ok(close(caught, hand, 1e-3) && Math.abs(hand.w - 1) < 1e-9, `taken in the hand at ${h.t0.toFixed(2)}s`);
  }
  // Each serve: held still for a moment before the toss, which goes up and comes down onto the paddle.
  for (const point of RALLY.points) {
    const serve = RALLY.hits.find((h) => h.at >= point.t0 && h.serve)!;
    const hold = RALLY.holds.find((h) => h.t0 === point.t0)!;
    assert.ok(hold.t1 - hold.t0 >= 0.6, "a breath before the serve");
    const still = (t: number) => Math.hypot(...(["a", "y", "c"] as const).map((k) => at(t + 0.05)[k] - at(t)[k])) < 1e-6;
    assert.ok(still(hold.t0 + 0.05) && still(hold.t1 - 0.35), "held still");
    const toss = RALLY.flights.find((f) => f.t0 === hold.t1)!;
    assert.ok(toss.vy > 1.5 && toss.t1 === serve.at, "tossed up and met on the way down");
  }
});

test("the players never jump: every joint, the step and the reach, through the whole match and round again, easing in from standing", () => {
  const plan = planBuilding([], [], []);
  const table = pingTable(plan);
  for (const end of [0, 1] as const) {
    const spot = pingSpot(plan, end);
    const a = newPlayer(), b = newPlayer();
    playerPose(table, spot.pos[0], spot.pos[1], spot.facing, end, 0, 1, 1, a);
    for (const v of [a.rootX, a.rootY, a.rootZ, a.thigh, a.bend, a.head, a.right.x, a.right.elbow, a.left.x]) assert.ok(Math.abs(v) < 1e-9, "standing as they arrive");
    const flat = (p: Player) => [p.rootX, p.rootY, p.rootZ, p.stride, p.thigh, p.knee, p.bend, p.head, p.right.x, p.right.y, p.right.z, p.right.elbow, p.left.x, p.left.y, p.left.z, p.left.elbow];
    const names = ["rootX", "rootY", "rootZ", "stride", "thigh", "knee", "bend", "head", "right.x", "right.y", "right.z", "right.elbow", "left.x", "left.y", "left.z", "left.elbow"];
    for (let t = 0; t < RALLY.length + 20; t += 0.01) {
      playerPose(table, spot.pos[0], spot.pos[1], spot.facing, end, t, 1, 1, a);
      playerPose(table, spot.pos[0], spot.pos[1], spot.facing, end, t + 0.01, 1, 1, b);
      const p = flat(a), q = flat(b);
      for (let i = 0; i < p.length; i++) {
        // At most 0.25 rad (or 2.5 cm) a hundredth of a second: under a frame's worth of blur at 20 fps.
        assert.ok(Math.abs(p[i]! - q[i]!) < (i < 3 ? 0.025 : 0.25), `end ${end}: ${names[i]} jumps ${(q[i]! - p[i]!).toFixed(3)} at ${t.toFixed(2)}s`);
      }
    }
  }
});

test("each player's paddle hand reaches the blade, and the free hand the ball it holds, at every height and build", () => {
  const plan = planBuilding([], [], []);
  const table = pingTable(plan);
  const pose = newPlayer(), paddle = newPing(), hand = newHand(), target: [number, number, number] = [0, 0, 0];
  for (const end of [0, 1] as const) {
    const spot = pingSpot(plan, end);
    const local = (p: Ping) => {
      const [wx, wz] = table.world(p.a, p.c);
      return place([0, 0], -spot.facing, [wx - spot.pos[0], wz - spot.pos[1]]);
    };
    for (const [h, build] of [[0.92, 0.9], [1, 1], [1.08, 1.2]] as const) {
      let worst = 0, worstHand = 0, worstAt = 0, worstHandAt = 0;
      for (let t = 0.6; t < RALLY.length; t += 0.05) {
        playerPose(table, spot.pos[0], spot.pos[1], spot.facing, end, t, h, build, pose);
        paddleAt(end, t, paddle);
        const [lx, lz] = local(paddle);
        shoulderFrame((lx - pose.rootX) / h, paddle.y / h - pose.rootY, (lz - pose.rootZ) / h, pose.bend, build, 1, target);
        const blade = handFrom(pose.right, FOREARM + BLADE);
        const miss = Math.hypot(blade[0] - target[0], blade[1] - target[1], blade[2] - target[2]) * h;
        if (miss > worst) { worst = miss; worstAt = t; }
        handAt(end, t, hand);
        if (hand.w > 0.999) {
          const [hx, hz] = local(hand);
          shoulderFrame((hx - pose.rootX) / h, (hand.y - ON_HAND) / h - pose.rootY, (hz - pose.rootZ) / h, pose.bend, build, -1, target);
          const fist = handFrom(pose.left, FOREARM);
          const off = Math.hypot(fist[0] - target[0], fist[1] - target[1], fist[2] - target[2]) * h;
          if (off > worstHand) { worstHand = off; worstHandAt = t; }
        }
        assert.ok(Math.abs(pose.rootX) <= 0.5 && Math.abs(pose.head) <= 0.9 && pose.rootZ >= -0.25 && pose.rootZ <= 0.45);
      }
      assert.ok(worst < 0.03, `end ${end} at ${h}/${build}: the blade ${worst.toFixed(3)} m from where it should be at ${worstAt.toFixed(2)}s`);
      assert.ok(worstHand < 0.03, `end ${end} at ${h}/${build}: the free hand ${worstHand.toFixed(3)} m from the ball at ${worstHandAt.toFixed(2)}s`);
    }
  }
});

test("any seed bakes a whole match, and through it, round again, the ball and both players move on without a jump", () => {
  const plan = planBuilding([], [], []);
  const table = pingTable(plan);
  const flat = (p: Player) => [p.rootX, p.rootY, p.rootZ, p.stride, p.thigh, p.knee, p.bend, p.head, p.right.x, p.right.y, p.right.z, p.right.elbow, p.left.x, p.left.y, p.left.z, p.left.elbow];
  const names = ["rootX", "rootY", "rootZ", "stride", "thigh", "knee", "bend", "head", "right.x", "right.y", "right.z", "right.elbow", "left.x", "left.y", "left.z", "left.elbow"];
  const b0 = newPing(), b1 = newPing(), paddle = newPing(), hand = newHand(), p0 = newPlayer(), p1 = newPlayer();
  const spots = ([0, 1] as const).map((end) => pingSpot(plan, end));
  const dt = 0.01;
  for (let s = 0; s < 8; s++) {
    // A seed some versions of the bake found no shot for, and seven more.
    const seed = s ? `seed${s * 7}` : "seed3";
    const rally: Rally = bakeRally(seed);
    assert.ok(rally.points.length >= 24, `${seed}: a whole match`);
    for (let t = 0; t < rally.length + 6; t += 0.03) {
      ballAt(t, b0, rally);
      ballAt(t + dt, b1, rally);
      const jump = Math.hypot(b1.a - b0.a, b1.y - b0.y, b1.c - b0.c);
      assert.ok(jump < 0.1, `${seed}: the ball jumps ${jump.toFixed(3)} m at ${t.toFixed(2)}s`);
      if (Math.abs(b0.a) < TABLE_L / 2 && Math.abs(b0.c) < TABLE_W / 2) assert.ok(b0.y > TABLE_H + BALL_R - 1e-6, `${seed}: the ball in the table at ${t.toFixed(2)}s`);
      if (Math.sign(b0.a) !== Math.sign(b1.a) && Math.abs(b0.c) < TABLE_W / 2 + 0.16) assert.ok(b0.y > TABLE_H + NET_H + BALL_R, `${seed}: through the net at ${t.toFixed(2)}s`);
      for (const end of [0, 1] as const) {
        // Each player on their own side: the paddle, and the free hand when it reaches out, never over the far half.
        const own = (a: number) => (end ? a : -a);
        assert.ok(own(paddleAt(end, t, paddle, rally).a) > TABLE_L / 2 - 0.3, `${seed}: end ${end}'s paddle over the table at ${t.toFixed(2)}s`);
        handAt(end, t, hand, rally);
        assert.ok(hand.w < 0.5 || own(hand.a) > TABLE_L / 2 - 0.3, `${seed}: end ${end}'s free hand over the table at ${t.toFixed(2)}s`);
        const spot = spots[end]!;
        playerPose(table, spot.pos[0], spot.pos[1], spot.facing, end, t, 1, 1, p0, rally);
        playerPose(table, spot.pos[0], spot.pos[1], spot.facing, end, t + dt, 1, 1, p1, rally);
        const p = flat(p0), q = flat(p1);
        for (let i = 0; i < p.length; i++) assert.ok(Math.abs(p[i]! - q[i]!) < (i < 3 ? 0.025 : 0.25), `${seed}: end ${end}'s ${names[i]} jumps ${(q[i]! - p[i]!).toFixed(3)} at ${t.toFixed(2)}s`);
        assert.ok(Math.abs(p0.rootX) < 0.5 - 1e-9, `${seed}: end ${end} reaching further across than they can step at ${t.toFixed(2)}s`);
        // The blade where the rally has it.
        const local = (q: Ping) => place([0, 0], -spot.facing, [table.world(q.a, q.c)[0] - spot.pos[0], table.world(q.a, q.c)[1] - spot.pos[1]]);
        const [lx, lz] = local(paddle), target: [number, number, number] = [0, 0, 0];
        shoulderFrame(lx - p0.rootX, paddle.y - p0.rootY, lz - p0.rootZ, p0.bend, 1, 1, target);
        const blade = handFrom(p0.right, FOREARM + BLADE);
        if (t >= 0.6) assert.ok(Math.hypot(blade[0] - target[0], blade[1] - target[1], blade[2] - target[2]) < 0.03, `${seed}: end ${end}'s blade off the paddle's place at ${t.toFixed(2)}s`);
      }
    }
  }
});

test("a partner walking off mid-rally leaves the other easing out of their swing into standing, wherever in the match it happens", () => {
  const plan = planBuilding([], [], []);
  const table = pingTable(plan);
  const flat = (p: Player) => [p.rootX, p.rootY, p.rootZ, p.stride, p.thigh, p.knee, p.bend, p.head, p.right.x, p.right.y, p.right.z, p.right.elbow, p.left.x, p.left.y, p.left.z, p.left.elbow];
  const pose = (spot: ReturnType<typeof pingSpot>, e: { end: End; seconds: number; keep: number } | null, out: Player) => {
    if (!e) return flat(Object.assign(out, newPlayer()));
    return flat(playerPose(table, spot.pos[0], spot.pos[1], spot.facing, e.end, e.seconds, 1, 1, out, RALLY, e.keep));
  };
  const a = newPlayer(), b = newPlayer(), dt = 10;
  for (const end of [0, 1] as const) {
    const spot = pingSpot(plan, end);
    // Every so often through the match, and early on, still settling in.
    for (let stop = 0.3; stop < RALLY.length; stop += 1.37) {
      const ease = new PingEase();
      const at = 1_000_000;
      let before = pose(spot, ease.frame(end, stop, at, true), a);
      // From the last frame of play, a frame at a time, until they stand.
      for (let ms = dt; ms <= UNSETTLE * 1000 + 2 * dt; ms += dt) {
        const e = ease.frame(end, null, at + ms, true);
        const now = pose(spot, e, b);
        for (let i = 0; i < now.length; i++) assert.ok(Math.abs(now[i]! - before[i]!) < (i < 3 ? 0.025 : 0.25), `end ${end}, stopped at ${stop.toFixed(2)}s: joint ${i} jumps ${(now[i]! - before[i]!).toFixed(3)} ${ms} ms on`);
        if (e) assert.ok(Math.abs(e.seconds - (stop + ms / 1000)) < 1e-9, "the swing carries on as the match has it");
        before = now;
      }
      assert.equal(ease.frame(end, null, at + UNSETTLE * 1000 + 50, true), null, "standing once eased out");
    }
  }
  // Walking off: the walk takes over at once. And play starting again goes back to the rally's own clock.
  const ease = new PingEase();
  ease.frame(0, 12, 0, true);
  assert.equal(ease.frame(0, null, 10, false), null);
  assert.equal(ease.frame(undefined, null, 20, true), null, "nothing to ease out of");
  ease.frame(1, 30, 0, true);
  ease.frame(1, null, 100, true);
  assert.deepEqual(ease.frame(1, 0.05, 200, true), { end: 1, seconds: 0.05, keep: 1 });
});

test("when play stops, the ball hops back from wherever it is to where it rests, over the net and never through the table", () => {
  const from = newPing(), p = newPing(), q = newPing();
  for (let t = 0; t < RALLY.length; t += 0.07) {
    ballAt(t, from);
    const steps = 200, frame = BALL_BACK / steps;
    assert.deepEqual(ballBack(from, 0, p), from);
    for (let i = 0; i < steps; i++) {
      ballBack(from, i / steps, p);
      ballBack(from, (i + 1) / steps, q);
      const jump = Math.hypot(q.a - p.a, q.y - p.y, q.c - p.c);
      // No faster than the ball goes in play.
      assert.ok(jump / frame < 7, `stopped at ${t.toFixed(2)}s: the ball jumps ${jump.toFixed(3)} m`);
      if (Math.abs(q.a) < TABLE_L / 2 && Math.abs(q.c) < TABLE_W / 2) assert.ok(q.y > TABLE_H + BALL_R - 1e-6, `stopped at ${t.toFixed(2)}s: through the table`);
      if (Math.sign(p.a) !== Math.sign(q.a)) assert.ok(p.y > TABLE_H + NET_H + BALL_R, `stopped at ${t.toFixed(2)}s: through the net`);
    }
    for (const k of ["a", "y", "c"] as const) assert.ok(Math.abs(q[k] - BALL_REST[k]) < 1e-9, "back where it rests");
  }
});

test("a plan worked out again for the same office puts the table in the same place, though every object in it is new", () => {
  // The office keys the rally's clock on where the table is, so a world update (every message, every status) never
  // restarts a rally; only a different pair or a moved table does.
  const agents = crew(8), teams = [team("t")];
  const a = planBuilding(agents, teams, []), b = planBuilding(agents.map((x) => ({ ...x })), teams, []);
  assert.notEqual(a.outline, b.outline);
  const [ta, tb] = [pingTable(a), pingTable(b)];
  assert.deepEqual([ta.center, ta.yaw], [tb.center, tb.yaw]);
  const bigger = pingTable(planBuilding(crew(40), teams, []));
  assert.ok(bigger.center[0] !== ta.center[0] || bigger.center[1] !== ta.center[1], "a bigger office moves the table");
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
