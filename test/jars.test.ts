import { test } from "node:test";
import assert from "node:assert/strict";
import type { Team, UsageMeter, UsageShare, UsageView, WorldAgent } from "../src/shared/types.ts";
import { DESK_SIZE } from "../src/ui/world/spatial.ts";
import { planBuilding } from "../src/ui/world/building.ts";
import { JAR, jarLook, jarSpots, meterTokens, settleFill } from "../src/ui/world/jars.ts";

const meter = (id: string, label: string, window: UsageMeter["window"] = "week"): UsageMeter => ({ id, label, window, usedPercent: 40, resetsAt: null, asOf: null, stale: false });
const use = (a: number, b: number): UsageShare => ({ tokens: a + b, share: 4, parts: [{ meter: "a", tokens: a, share: 4 }, { meter: "b", tokens: b, share: null }] });
const teams: Team[] = ["busy", "small", "empty"].map((id) => ({ id, name: id, standing: false, path: `/tmp/${id}`, branch: id, worktrees: [], purpose: "", handsTo: null, createdAt: "" }));
const usage: UsageView = { meters: [meter("b", "Second week"), meter("short", "Short", "five_hour"), meter("a", "First week")], agents: {}, teams: { busy: use(1_200_000, 800_000), small: use(120_000, 0) } };

test("two data-labelled weekly jars use one busiest-project scale, including mixed usage", () => {
  const spots = jarSpots(planBuilding([], teams, []).corners, usage);
  assert.equal(spots.length, 3);
  assert.deepEqual(spots.map((s) => s.jars.map((j) => j.fill)), [[0.6, 0.4], [0.06, 0], [0, 0]]);
  assert.deepEqual(spots[0]!.jars.map((j) => j.label), ["First week", "Second week"]);
  assert.equal(spots[0]!.jars[0]!.text, "First week · 1.2M tokens · ≈4%");
  assert.match(spots[0]!.jars[1]!.text, /800k tokens · share unavailable/);
  assert.equal(spots[2]!.jars[0]!.text, "First week · 0 tokens · 0%");
  const reordered = { ...usage, meters: [...usage.meters].reverse() };
  assert.deepEqual(jarSpots(planBuilding([], teams, []).corners, reordered), spots);
});

test("empty weeks are truly empty; hidden/finished projects do not distort the visible scale", () => {
  const corners = planBuilding([], teams, []).corners;
  assert.ok(jarSpots(corners, { ...usage, teams: {} }).every((s) => s.jars.every((j) => j.fill === 0)));
  const extra = { ...usage, teams: { ...usage.teams, hidden: use(1e12, 0) } };
  assert.equal(jarSpots(corners, extra)[0]!.jars[0]!.fill, 0.6);
  assert.deepEqual(jarSpots(corners, undefined), [], "no invented vendor labels when data is absent");
});

test("legacy data never splits tokens using percentages; unscaled new data retains tokens", () => {
  const legacy: UsageShare = { tokens: 1234, share: 20, parts: [{ meter: "a", share: 10 }, { meter: "b", share: 10 }] };
  assert.equal(meterTokens(legacy, "a"), null);
  assert.match(jarLook("a", "Any label", legacy, 1234).text, /token split unavailable/);
  assert.equal(meterTokens({ ...legacy, parts: [legacy.parts[0]!] }, "a"), 1234);
  assert.equal(meterTokens({ ...legacy, parts: [] }, "a"), null);
  assert.equal(meterTokens(use(100, 200), "missing"), 0);
  assert.equal(jarLook("b", "Arbitrary week", use(100, 200), 300).fill, 2 / 3);
});

test("side tables stay clear of crafts and walking approaches", () => {
  const agents: WorldAgent[] = teams.flatMap((t) => Array.from({ length: 46 }, (_, i) => ({
    id: `${t.id}-${i}`, identity: `${t.id}-${i}`, name: `Maker ${i}`, harness: "manual", cwd: t.path,
    project: null, branch: null, status: "done", title: null, paneId: null, taskIds: [], teamId: t.id,
    role: i === 0 ? "lead" : "member", waitingOnYou: false, doing: null, helpers: [], model: null, sessionName: null, ran: true,
  })));
  const office = planBuilding(agents, teams, []);
  const spots = jarSpots(office.corners, usage);
  for (const s of spots) {
    const corner = office.corners.find((c) => c.team.id === s.teamId)!;
    for (const desk of corner.desks) {
      const dx = s.pos[0] - desk.pos[0], dz = s.pos[1] - desk.pos[1];
      const x = dx * Math.cos(desk.facing) - dz * Math.sin(desk.facing);
      const z = dx * Math.sin(desk.facing) + dz * Math.cos(desk.facing);
      assert.ok(Math.abs(x) > DESK_SIZE[desk.kind][0] * desk.scale / 2 + 0.39 || Math.abs(z) > DESK_SIZE[desk.kind][1] * desk.scale / 2 + 0.18);
    }
    for (const seat of office.spots.values()) {
      const path = [...seat.approach, seat.pos];
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1]!, b = path[i]!;
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((s.pos[0] - a[0]) * dx + (s.pos[1] - a[1]) * dz) / (dx * dx + dz * dz || 1)));
        assert.ok(Math.hypot(s.pos[0] - a[0] - t * dx, s.pos[1] - a[1] - t * dz) > 0.43, "no walking route crosses a jar table, even with a crowded crew");
      }
    }
    assert.ok(JAR.base + JAR.height < 1.5, "below the corkboard and eye line");
  }
});

test("fill settles only after a value changes, both up and down, ending exactly empty", () => {
  for (const [from, target] of [[0, 1], [1, 0], [0.6, 0.2]]) {
    let shown = from!;
    for (let i = 0; i < 100; i++) {
      const next = settleFill(shown, target!, 0.05);
      assert.ok(next >= Math.min(shown, target!) && next <= Math.max(shown, target!));
      shown = next;
    }
    assert.equal(shown, target);
    assert.equal(settleFill(shown, target!, 0.2), target);
  }
});
