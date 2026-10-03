import { test } from "node:test";
import assert from "node:assert/strict";
import type { Team, WorldAgent } from "../src/shared/types.ts";
import { planBuilding, routeIn } from "../src/ui/world/building.ts";
import { chooseGym, gymSpot, LIFTS, PROGRAMS, stationPose, STATIONS, newPose } from "../src/ui/world/gym.ts";
import { choosePingPong, pingSpot, PingPlayback, RALLY } from "../src/ui/world/pingpong.ts";
import { CAST, cheerAt, coolerAt, highFiveAt, isRegular, partnerLone, placeRegulars, regularLook, sipAt, asideSpot } from "../src/ui/world/regulars.ts";
import type { Spot } from "../src/ui/world/spatial.ts";
import { NAMES } from "../src/server/names.ts";

const agent = (id: string, extra: Partial<WorldAgent> = {}): WorldAgent => ({ id, identity: id, name: id, harness: "manual", cwd: null, project: null, branch: null, status: "idle", title: null, paneId: null, taskIds: [], teamId: null, role: "member", waitingOnYou: false, doing: null, helpers: [], model: null, sessionName: null, ran: true, ...extra });
const team = (id: string): Team => ({ id, name: id, purpose: "", handsTo: null, path: null, branch: null, standing: true, worktrees: [], createdAt: "" });
const crew = (n: number) => Array.from({ length: n }, (_, i) => agent(`idle${i}`, { teamId: "t", role: i ? "member" : "lead" }));
const office = (n = 8) => planBuilding(crew(n), [team("t")], []);
const acts = (r: ReturnType<typeof placeRegulars>) => Object.fromEntries([...r].map(([id, p]) => [id.slice("regular:".length), p.act]));
const far = (a: Spot["pos"], b: Spot["pos"], d: number) => Math.hypot(a[0] - b[0], a[1] - b[1]) >= d;

test("a small fixed cast, their own names and looks, the same every time and never an agent's id", () => {
  assert.ok(CAST.length >= 4 && CAST.length <= 6);
  assert.equal(new Set(CAST.map((r) => r.id)).size, CAST.length);
  assert.equal(new Set(CAST.map((r) => r.name)).size, CAST.length);
  for (const r of CAST) {
    assert.ok(isRegular(r.id));
    assert.deepEqual(regularLook(r), regularLook(r));
  }
  assert.ok(!crew(20).some((a) => isRegular(a.id)));
  // No agent can ever be named like a regular: none of their names is in the office's name pool.
  const pool = new Set(NAMES.map((n) => n.toLowerCase()));
  assert.deepEqual(CAST.filter((r) => pool.has(r.name.toLowerCase())).map((r) => r.name), []);
  // Every station and both ends have a regular whose home it is.
  assert.deepEqual(new Set(CAST.flatMap((r) => ("gym" in r.home ? [r.home.gym] : []))), new Set(STATIONS));
  assert.deepEqual(CAST.flatMap((r) => ("pingpong" in r.home ? [r.home.pingpong] : [])).sort(), [0, 1]);
});

test("with no agent at them, the regulars fill every station and both ends of the table", () => {
  const plan = office();
  const placed = placeRegulars(plan, new Map());
  assert.equal(placed.size, CAST.length);
  assert.deepEqual(new Set([...placed.values()].flatMap((p) => (p.spot.gym ? [p.spot.gym] : []))), new Set(STATIONS));
  assert.deepEqual([...placed.values()].flatMap((p) => (p.spot.pingpong !== undefined ? [p.spot.pingpong] : [])).sort(), [0, 1]);
  for (const p of placed.values()) {
    if (p.spot.gym) assert.deepEqual(p.spot, gymSpot(plan, p.spot.gym));
    if (p.spot.pingpong !== undefined) assert.deepEqual(p.spot, pingSpot(plan, p.spot.pingpong));
  }
  assert.deepEqual(placeRegulars(plan, new Map()), placed);
});

test("an agent arriving takes the station or the table, and that regular steps aside", () => {
  const plan = office();
  const agents = new Map<string, Spot>([["a", gymSpot(plan, "rack")], ["b", pingSpot(plan, 0)], ["c", pingSpot(plan, 1)]]);
  const placed = placeRegulars(plan, agents);
  assert.deepEqual(acts(placed), { ottilie: "lift", kwabena: "stretch", marisol: "lift", thandiwe: "lift", brigitta: "watch", ignatius: "watch" });
  // Never two at one station or end.
  for (const p of placed.values()) {
    assert.ok(!(p.spot.gym === "rack"), "nobody else at the agent's station");
    assert.equal(p.spot.pingpong, undefined);
  }
  // Lots of agents: everything taken, everyone aside, each at their own place.
  const busy = new Map<string, Spot>([...STATIONS.map((s) => [s, gymSpot(plan, s)] as const), ["p0", pingSpot(plan, 0)], ["p1", pingSpot(plan, 1)]]);
  const aside = placeRegulars(plan, busy);
  assert.deepEqual(new Set(Object.values(acts(aside))), new Set(["stretch", "cooler", "watch"]));
  const spots = [...aside.values()].map((p) => p.spot);
  spots.forEach((s, i) => spots.slice(i + 1).forEach((o) => assert.ok(far(s.pos, o.pos, 0.8), "aside places apart")));
  // Clear of everyone using the gym and the table, and of the water cooler.
  for (const s of spots) for (const o of busy.values()) assert.ok(far(s.pos, o.pos, 1), "aside places clear of the stations and ends");
  for (const s of spots) assert.ok(far(s.pos, coolerAt(plan).pos, 0.35));
  // The two at the cooler high five each other only while both are there.
  assert.equal(aside.get("regular:marisol")!.partner, "regular:thandiwe");
  const oneAside = placeRegulars(plan, new Map([["a", gymSpot(plan, "bench")]]));
  assert.equal(oneAside.get("regular:marisol")!.partner, null);
  // When the agent goes, the regular is back at their station.
  assert.equal(placeRegulars(plan, new Map()).get("regular:kwabena")!.act, "lift");
});

test("stepping aside and back is a walk inside the corner, along its lane, never out on the walkway", () => {
  for (const n of [1, 8, 23]) {
    const plan = office(n);
    const walk = routeIn(plan);
    for (const r of CAST) {
      const home = "gym" in r.home ? gymSpot(plan, r.home.gym) : pingSpot(plan, r.home.pingpong);
      const aside = asideSpot(plan, r);
      const there = walk(home.pos, home, aside), back = walk(aside.pos, aside, home);
      assert.deepEqual(there.at(-1), aside.pos);
      assert.deepEqual(back.at(-1), home.pos);
      // Never out on the walkway: in the corner, by the nook's way in and its lane.
      for (const p of [...there, ...back]) assert.notDeepEqual(p, home.approach[0], `${r.name} stays inside (${n} agents)`);
      assert.ok(there.some((p) => p[0] === aside.approach.at(-1)![0] && p[1] === aside.approach.at(-1)![1]), "along the lane");
    }
  }
});

test("a lone idle agent plays a regular; two or more agents pair up as before", () => {
  const since = new Map(crew(8).map((a) => [a.id, 0]));
  const plan = office();
  const one = crew(1);
  const lone = partnerLone(plan, one, since, 60_000);
  assert.deepEqual([...lone], [[one[0]!.id, pingSpot(plan, 0)]]);
  assert.equal(choosePingPong(plan, one, since, 60_000).size, 0, "agents alone still never pair with nobody");
  // The regular whose end is free plays them; the other watches.
  const placed = placeRegulars(plan, lone);
  assert.deepEqual([acts(placed).brigitta, acts(placed).ignatius], ["watch", "play"]);
  const play = new PingPlayback([one[0]!.id, "regular:ignatius"]);
  play.arrive(one[0]!.id, true, 0);
  play.arrive("regular:ignatius", true, 500);
  assert.equal(play.seconds(1500), 1, "the rally runs on the same clock as two agents'");
  // They keep the end they had.
  assert.equal(partnerLone(plan, one, since, 61_000, new Map([[one[0]!.id, pingSpot(plan, 1)]])).get(one[0]!.id)!.pingpong, 1);
  // Nobody idle, two idle, or the only one busy elsewhere: no partnering.
  assert.equal(partnerLone(plan, [], since, 60_000).size, 0);
  assert.equal(partnerLone(plan, crew(2), since, 60_000).size, 0);
  assert.equal(partnerLone(plan, one, since, 60_000, new Map(), new Set([one[0]!.id])).size, 0);
  assert.equal(partnerLone(plan, [agent("w", { status: "working" })], since, 60_000).size, 0);
  // A project's member only once out for a break, like every game.
  assert.equal(partnerLone(plan, one, since, 59_999).size, 0);
});

test("regulars are never chosen as agents: the gym and the table choose from agents alone", () => {
  const agents = crew(12), since = new Map(agents.map((a) => [a.id, 0]));
  const plan = office(12);
  for (const id of [...chooseGym(plan, agents, since, 60_000).keys(), ...choosePingPong(plan, agents, since, 60_000).keys()]) assert.ok(!isRegular(id));
});

test("a lifter sips between sets, with their hands off the bar and standing still", () => {
  for (const station of STATIONS) {
    const round = PROGRAMS[station].reduce((sum, l) => sum + LIFTS[l].length, 0);
    let sipped = 0;
    for (let t = 0; t < round * 2; t += 0.05) {
      const s = sipAt(station, t);
      assert.ok(s >= 0 && s <= 1);
      if (!s) continue;
      sipped++;
      const pose = stationPose(station, t, 1, newPose());
      assert.ok(pose.grip < 1e-6, `${station} at ${t.toFixed(2)}: hands off the bar`);
      assert.ok(!pose.moving, `${station} at ${t.toFixed(2)}: resting`);
    }
    assert.ok(sipped > 0, `${station} has a sip each round`);
  }
});

test("after each point the one who didn't catch it cheers, the watchers after every point, and the high five comes round", () => {
  for (const h of RALLY.holds) {
    const t = h.t0 + 0.6;
    assert.equal(cheerAt(h.end, t), 0, "the catcher has the ball to serve");
    assert.equal(cheerAt((1 - h.end) as 0 | 1, t), 1);
    assert.equal(cheerAt(null, t), 1);
  }
  // Mid-rally, nobody cheers.
  const mid = RALLY.hits[3]!.at;
  assert.equal(cheerAt(0, mid) + cheerAt(1, mid) + cheerAt(null, mid), 0);
  assert.equal(highFiveAt(500), 1);
  assert.equal(highFiveAt(5000), 0);
  assert.equal(highFiveAt(14_500), 1);
});
