import { test } from "node:test";
import assert from "node:assert/strict";
import type { Team, WorldAgent } from "../src/shared/types.ts";
import { planBuilding, routeIn } from "../src/ui/world/building.ts";
import { chooseGym, gymSpot, routine, STATIONS, type Station } from "../src/ui/world/gym.ts";
import { choosePingPong, pingSpot, PingPlayback, RALLY } from "../src/ui/world/pingpong.ts";
import { CAST, cheerAt, coolerAt, highFiveAt, isRegular, partnerLone, placeRegulars, placeSpot, cornerWalk, regularLook, rolesAt, scheduleRegulars, SHIFT, tableAt, VISIT, visitAt, asideSpot, type Place } from "../src/ui/world/regulars.ts";
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

// A morning's worth of visits, from today's office clock: wherever the clock is, the same rules.
const today = visitAt(Date.UTC(2026, 9, 3, 9));
const visits = Array.from({ length: 6 * SHIFT * 3 }, (_, i) => today + i);
const where = (p: { act: string; spot: Spot }) => `${p.act}@${p.spot.pos.map((x) => x.toFixed(2))}`;
const placesOf = (plan: ReturnType<typeof office>) => (["mat0", "mat1", "cooler0", "cooler1", "watch0", "watch1"] as Place[]).map((p) => placeSpot(plan, p));

test("in the gym they move round every visit: never the same role twice running, and over a shift every station and a break", () => {
  const plan = office();
  for (const v of visits) {
    const now = rolesAt(v), next = rolesAt(v + 1);
    for (const r of CAST) {
      const a = now.get(r.id)!, b = next.get(r.id)!;
      if (typeof a === "string" || typeof b === "string") assert.notEqual(a, b, `${r.name} at ${a} twice running (visit ${v})`);
    }
    // With nobody else about, two at the table, the rest in the gym, each somewhere new.
    const placed = scheduleRegulars(plan, new Map(), v), after = scheduleRegulars(plan, new Map(), v + 1);
    assert.deepEqual(scheduleRegulars(plan, new Map(), v), placed, "the same visit, the same places");
    assert.equal([...placed.values()].filter((p) => p.act === "play").length, 2);
    assert.ok([...placed.values()].filter((p) => p.act === "lift").length >= 3, "the gym is busy");
    for (const r of CAST) {
      const p = placed.get(r.id)!, q = after.get(r.id)!;
      if (p.act !== "play" && q.act !== "play") assert.notEqual(where(p), where(q), `${r.name} moves on (visit ${v})`);
    }
  }
  // Over a shift in the gym everyone there lifts at three stations or more and takes a break.
  for (let start = today - (today % SHIFT); start < today + 6 * SHIFT; start += SHIFT) {
    const gym = CAST.filter((r) => !tableAt(start).includes(r.id));
    for (const r of gym) {
      const roles = Array.from({ length: SHIFT }, (_, i) => rolesAt(start + i).get(r.id)!);
      assert.ok(new Set(roles.filter((x) => x !== "break")).size >= 3, `${r.name}: ${roles}`);
    }
  }
  // Over the morning everyone lifts at every station, takes breaks and plays.
  for (const r of CAST) {
    const roles = new Set(visits.map((v) => rolesAt(v).get(r.id)!));
    assert.ok(STATIONS.every((st) => roles.has(st)) && roles.has("break") && (roles.has(0) || roles.has(1)), `${r.name}: ${[...roles]}`);
  }
});

test("the table changes over a player a shift, each keeping their end, and everyone gets a turn", () => {
  const players = new Set<string>();
  for (const v of visits) {
    const [a, b] = tableAt(v), [c, d] = tableAt(v + 1);
    assert.notEqual(a, b);
    if (Math.floor((v + 1) / SHIFT) === Math.floor(v / SHIFT)) assert.deepEqual([c, d], [a, b], "a whole shift at the table");
    else assert.equal(+(a === c) + +(b === d), 1, "one hands over, the other stays at their end");
    players.add(a).add(b);
  }
  assert.equal(players.size, CAST.length);
});

test("a visit's places: never two at one place, never where an agent is, a free end always played, and a set never cut short", () => {
  const plan = office();
  const s = (st: Station) => gymSpot(plan, st);
  const crowds: Array<Map<string, Spot>> = [
    new Map(),
    new Map([["a", pingSpot(plan, 0)]]),
    new Map([["a", pingSpot(plan, 1)], ["b", s("rack")]]),
    new Map([["a", pingSpot(plan, 0)], ["b", pingSpot(plan, 1)]]),
    new Map([["a", s("platform")], ["b", s("bench")]]),
    new Map([...STATIONS.map((st) => [st, s(st)] as const), ["p0", pingSpot(plan, 0)], ["p1", pingSpot(plan, 1)]]),
  ];
  const aside = placesOf(plan);
  for (const agents of crowds) {
    for (const v of visits) {
      const placed = scheduleRegulars(plan, agents, v);
      assert.equal(placed.size, CAST.length);
      const spots = [...placed.values()].map((p) => p.spot);
      spots.forEach((a, i) => spots.slice(i + 1).forEach((b) => assert.ok(far(a.pos, b.pos, 0.8), `two at one place (visit ${v})`)));
      for (const p of placed.values()) {
        for (const o of agents.values()) assert.ok(far(p.spot.pos, o.pos, 0.8), `${p.regular.name} where an agent is`);
        if (p.act === "lift") {
          assert.deepEqual(p.spot, gymSpot(plan, p.spot.gym!));
          assert.deepEqual(p.visit, { station: p.spot.gym, seed: `${p.regular.id}:${v}`, until: (v + 1) * VISIT * 1000 });
        } else if (p.act === "play") assert.deepEqual(p.spot, pingSpot(plan, p.spot.pingpong!));
        else assert.ok(aside.some((a) => a.pos[0] === p.spot.pos[0] && a.pos[1] === p.spot.pos[1]), `${p.regular.name} ${p.act} at a place aside`);
        assert.equal(p.act === "lift", !!p.visit);
      }
      for (const end of [0, 1] as const) {
        const taken = [...agents.values()].some((a) => a.pingpong === end);
        assert.equal([...placed.values()].filter((p) => p.act === "play" && p.spot.pingpong === end).length, taken ? 0 : 1, `end ${end} played once (visit ${v})`);
      }
      // The two at the cooler chat and high five, and only they.
      const cooler = [...placed.values()].filter((p) => p.act === "cooler");
      for (const p of cooler) assert.equal(p.partner, cooler.length === 2 ? cooler.find((o) => o !== p)!.regular.id : null);
    }
  }
});

test("a lone agent at the table always has a regular to play, whoever's turn it is", () => {
  const plan = office();
  for (const end of [0, 1] as const) {
    for (const v of visits) {
      const placed = scheduleRegulars(plan, new Map([["lone", pingSpot(plan, end)]]), v);
      const other = [...placed.values()].filter((p) => p.act === "play");
      assert.equal(other.length, 1);
      assert.equal(other[0]!.spot.pingpong, 1 - end);
    }
  }
});

test("moving round the gym leaves time for a set: the walks are short, and the first set fits the rest of a visit", () => {
  for (const n of [1, 8, 23]) {
    const plan = office(n);
    const walk = routeIn(plan);
    const gym = [...STATIONS.map((st) => gymSpot(plan, st)), ...(["mat0", "mat1", "cooler0", "cooler1"] as Place[]).map((p) => placeSpot(plan, p))];
    let longest = 0;
    for (const a of gym) for (const b of gym) {
      const path = [a.pos, ...(cornerWalk(a, b) ?? walk(a.pos, a, b))];
      let d = 0;
      for (let i = 1; i < path.length; i++) d += Math.hypot(path[i]![0] - path[i - 1]![0], path[i]![1] - path[i - 1]![1]);
      longest = Math.max(longest, d);
    }
    // Regulars walk at 1.6 m/s (Regulars.tsx).
    const seconds = longest / 1.6;
    assert.ok(seconds < 12, `${n} agents: ${seconds.toFixed(1)} s across the gym`);
    for (const st of STATIONS) for (let i = 0; i < 30; i++) {
      const first = routine(st, `regular:x:${i}`)[0]!;
      assert.ok(first.length + seconds < VISIT, `${st}: a first set of ${first.length} s fits after a walk`);
    }
  }
});

test("after each point its winner cheers, the watchers after every point, and the high five comes round", () => {
  const won = RALLY.holds.filter((h) => h.winner !== undefined);
  assert.ok(won.length >= 10);
  for (const h of won) {
    const t = h.t0 + 0.6;
    assert.equal(cheerAt(h.winner!, t), 1);
    assert.equal(cheerAt((1 - h.winner!) as 0 | 1, t), 0, "the loser doesn't");
    assert.equal(cheerAt(null, t), 1);
  }
  // Mid-rally, and while the server waits to serve, nobody cheers.
  const mid = RALLY.hits.find((x) => !x.serve && x.at > RALLY.intro + 5)!.at;
  assert.equal(cheerAt(0, mid) + cheerAt(1, mid) + cheerAt(null, mid), 0);
  assert.equal(highFiveAt(500), 1);
  assert.equal(highFiveAt(5000), 0);
  assert.equal(highFiveAt(14_500), 1);
});
