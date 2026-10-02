import { test } from "node:test";
import assert from "node:assert/strict";
import type { Team, UsageMeter, WorldAgent } from "../src/shared/types.ts";
import { callerIn, planBuilding, type BuildingPlan, type Rect } from "../src/ui/world/building.ts";
import { YOUR_VIEW, type Vec2 } from "../src/ui/world/layout.ts";
import { meterGround, meterLook, meterSpots, RING_OUT, toneOf, when } from "../src/ui/world/meters.ts";
import { parkPlaces } from "../src/ui/world/park.ts";
import { benchNook, groundOf, plantGarden } from "../src/ui/world/planting.ts";

const agent = (id: string, extra: Partial<WorldAgent> = {}): WorldAgent => ({
  id, identity: id, name: id, harness: "pi", cwd: null, project: null, branch: null, status: "idle", title: null, paneId: null, taskIds: [], teamId: null, role: "member", waitingOnYou: false, doing: null, helpers: [], model: null, sessionName: null, ran: true, ...extra,
});
const team = (id: string): Team => ({ id, name: id, purpose: "", handsTo: null, path: `/repo-${id}`, branch: `worktree-${id}`, standing: false, worktrees: [], createdAt: "" });
function building(n: number): BuildingPlan {
  const teams = Array.from({ length: n }, (_, i) => team(`t${i}`));
  const agents = [...teams.flatMap((t) => [agent(`${t.id}-lead`, { teamId: t.id, role: "lead" }), agent(`${t.id}-c`, { teamId: t.id })]), agent("q1"), agent("l1")];
  return planBuilding(agents, teams, ["q1"]);
}
const meter = (extra: Partial<UsageMeter> = {}): UsageMeter => ({ id: "m", label: "Claude week", usedPercent: 62, resetsAt: "2026-10-09T06:00:00Z", asOf: "2026-10-02T14:00:00Z", stale: false, window: "week", ...extra });
const NOW = Date.parse("2026-10-02T14:05:00Z");
const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const away = (r: Rect, [x, z]: Vec2) => Math.hypot(Math.max(r.minX - x, 0, x - r.maxX), Math.max(r.minZ - z, 0, z - r.maxZ));
const within = (r: Rect, [x, z]: Vec2, pad: number) => x - pad >= r.minX - 1e-9 && x + pad <= r.maxX + 1e-9 && z - pad >= r.minZ - 1e-9 && z + pad <= r.maxZ + 1e-9;
/** How close the segment from a to b comes to p. */
function gap(a: Vec2, b: Vec2, p: Vec2): number {
  const d: Vec2 = [b[0] - a[0], b[1] - a[1]];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / (d[0] ** 2 + d[1] ** 2 || 1)));
  return dist([a[0] + d[0] * t, a[1] + d[1] * t], p);
}
const three: UsageMeter[] = [meter({ id: "cw" }), meter({ id: "c5", label: "Claude 5-hour", window: "five_hour" }), meter({ id: "xw", label: "Codex week" })];

test("the towers stand in a lawn, clear of the paths, the clearing, the benches, the park's places and of each other, and the 5-hour one is smaller", () => {
  for (const n of [0, 1, 4, 9, 12]) {
    const plan = building(n);
    const g = plan.garden;
    const spots = meterSpots(g, three);
    assert.equal(spots.length, 3, `${n} teams: every meter has a tower`);
    const [week, five] = spots;
    assert.ok(five!.radius < week!.radius && five!.height < week!.height, "the 5-hour tower is smaller than the weekly ones");
    const places = parkPlaces(g, plan.loop);
    const standing = [...places.seats, ...places.tree, ...places.flower, ...places.ducks, ...places.stretch, ...places.chat.flat()].map((s) => s.pos);
    for (const s of spots) {
      const reach = s.radius * RING_OUT;
      const here = `${n} teams: the tower at ${s.pos}`;
      assert.ok(within(g.lawns[1], s.pos, reach), `${here} is on the east lawn`);
      for (const p of [...g.paths, g.clearing]) assert.ok(away(p, s.pos) >= reach, `${here} is off the paths and the clearing`);
      for (const b of g.benches) assert.ok(away(benchNook(b), s.pos) >= reach, `${here} is clear of the bench at ${b.pos}`);
      for (const p of standing) assert.ok(dist(p, s.pos) >= reach + 0.3, `${here} leaves the park place at ${p} free`);
      assert.ok(dist(s.pos, g.pond.center) > g.pond.radius + reach, `${here} is out of the pond`);
      for (const o of spots) if (o !== s) assert.ok(dist(o.pos, s.pos) >= (o.radius + s.radius) * RING_OUT, `${here} and the one at ${o.pos} keep apart`);
    }
  }
});

test("nothing grows where the towers stand, and they hide nobody who comes to you or waits for you", () => {
  for (const n of [1, 6, 12]) {
    const plan = building(n);
    const g = plan.garden;
    const ground = meterGround(g);
    const planting = plantGarden(g);
    const things = [
      ...planting.trees.map((t) => ({ pos: t.pos, r: groundOf(t), what: `a ${t.kind}` })),
      ...planting.plants.map((p) => ({ pos: p.pos, r: p.radius, what: `a ${p.kind}` })),
      ...planting.rocks.map((r) => ({ pos: r.pos, r: r.radius, what: "a rock" })),
    ];
    for (const t of things) assert.ok(away(ground, t.pos) >= t.r, `${n} teams: ${t.what} at ${t.pos} grows where the meters stand`);
    // A crown over a tower hangs above its roof.
    for (const t of planting.trees) if (away(ground, t.pos) < t.crown) assert.ok(t.base > 2, `${n} teams: the ${t.kind} at ${t.pos} hangs into the towers`);
    const seen = [...Array.from({ length: 12 }, (_, i) => callerIn(plan)(i).pos), ...plan.queue.map((id) => plan.spots.get(id)!.pos)];
    for (const s of meterSpots(g, three)) for (const p of seen) assert.ok(gap(YOUR_VIEW, p, s.pos) > s.radius * RING_OUT, `${n} teams: the tower at ${s.pos} hides ${p}`);
  }
});

test("towers there is no room for are left out, the first ones kept", () => {
  const g = building(1).garden;
  const many = Array.from({ length: 9 }, (_, i) => meter({ id: `m${i}` }));
  const spots = meterSpots(g, many);
  assert.ok(spots.length >= 4 && spots.length < 9);
  assert.deepEqual(spots.map((s) => s.id), many.slice(0, spots.length).map((m) => m.id));
});

test("the water is green, amber from 70% and red from 90%", () => {
  assert.equal(toneOf(0), "green");
  assert.equal(toneOf(69.9), "green");
  assert.equal(toneOf(70), "amber");
  assert.equal(toneOf(89.9), "amber");
  assert.equal(toneOf(90), "red");
  assert.equal(toneOf(100), "red");
  assert.equal(meterLook(meter({ usedPercent: 35 }), NOW).tone, "green");
  assert.equal(meterLook(meter({ usedPercent: 75 }), NOW).tone, "amber");
  assert.equal(meterLook(meter({ usedPercent: 97 }), NOW).tone, "red");
});

test("a fresh reading fills the tank to its share and says when it resets", () => {
  const look = meterLook(meter(), NOW, "Europe/Copenhagen");
  assert.equal(look.level, 0.62);
  assert.equal(look.faded, false);
  assert.equal(look.over, false);
  assert.equal(look.label, "Claude week 62%, resets Fri 08:00");
  // 2026-10-09 06:00 is 6 days 15 h 55 min away, out of a 7-day window.
  assert.ok(Math.abs(look.left! - (6 * 24 * 60 + 15 * 60 + 55) / (7 * 24 * 60)) < 1e-9);
});

test("at its limit the tank runs over, and never shows fuller than full", () => {
  for (const used of [100, 104]) {
    const look = meterLook(meter({ usedPercent: used }), NOW);
    assert.equal(look.over, true);
    assert.equal(look.level, 1);
    assert.equal(look.tone, "red");
  }
  assert.equal(meterLook(meter({ usedPercent: 99.6 }), NOW).over, false);
});

test("a stale reading shows faded and says as of when; an unknown one faded and empty", () => {
  const stale = meterLook(meter({ stale: true }), NOW, "UTC");
  assert.equal(stale.faded, true);
  assert.equal(stale.level, 0.62);
  assert.equal(stale.label, "Claude week 62% as of Fri 14:00, resets Fri 06:00");
  const unknown = meterLook(meter({ usedPercent: null, resetsAt: null, asOf: null }), NOW);
  assert.deepEqual(unknown, { level: 0, tone: "green", faded: true, over: false, left: null, label: "Claude week: no reading yet" });
});

test("past its reset with no new reading, a meter shows empty and faded until one confirms it", () => {
  const look = meterLook(meter({ usedPercent: 97, resetsAt: "2026-10-02T14:00:00Z" }), NOW, "UTC");
  assert.equal(look.level, 0);
  assert.equal(look.faded, true);
  assert.equal(look.over, false);
  assert.equal(look.left, 0);
  assert.equal(look.label, "Claude week reset Fri 14:00, not yet confirmed");
});

test("the ring counts down a 5-hour window by its own length", () => {
  const look = meterLook(meter({ window: "five_hour", resetsAt: new Date(NOW + 2.5 * 3600 * 1000).toISOString() }), NOW);
  assert.ok(Math.abs(look.left! - 0.5) < 1e-9);
  assert.equal(when(new Date("2026-10-02T06:00:00Z"), "UTC"), "Fri 06:00");
});
