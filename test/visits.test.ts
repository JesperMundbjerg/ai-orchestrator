import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, Team, WorldAgent } from "../src/shared/types.ts";
import { planBuilding } from "../src/ui/world/building.ts";
import { plan as planTalk } from "../src/ui/world/visits.ts";

const agent = (id: string, extra: Partial<WorldAgent> = {}): WorldAgent => ({
  id, identity: id, name: id, harness: "pi", cwd: null, project: null, branch: null, status: "idle", title: null, paneId: null, taskIds: [], teamId: null, role: "member", waitingOnYou: false, doing: null, helpers: [], model: null, sessionName: null, ran: true, ...extra,
});
const team = (id: string): Team => ({ id, name: id, purpose: "", handsTo: null, path: `/repo-${id}`, branch: `worktree-${id}`, standing: false, worktrees: [], createdAt: "" });
const said = (id: string, kind: Message["kind"], from: string | null, to: string[], text = "hello"): Message =>
  ({ id, kind, fromAgentId: from, teamId: null, text, images: [], workId: null, createdAt: "", toFounder: false, deliveries: to.map((agentId) => ({ agentId, state: "queued", error: null, updatedAt: "" })) });

test("an agent who says something walks to the person it is for and stands beside them", () => {
  const teams = [team("dev"), team("qa")];
  const agents = [agent("lead", { teamId: "dev", role: "lead" }), agent("coder", { teamId: "dev" }), agent("rev", { teamId: "qa" })];
  const office = planBuilding(agents, teams, []);
  const { visits, bubbles } = planTalk([said("m1", "handoff", "coder", ["rev"]), said("m2", "instruction", null, ["lead"], "Ship it")], office, 1000);
  assert.equal(visits.length, 1);
  const [v] = visits;
  const target = office.spots.get("rev")!.pos;
  const gap = Math.hypot(v!.spot.pos[0] - target[0], v!.spot.pos[1] - target[1]);
  assert.ok(gap > 0.5 && gap < 1.2, `stands beside, not on top (${gap.toFixed(2)} m)`);
  assert.equal(v!.kind, "handoff");
  assert.match(v!.text, /^Handing over: hello/);
  assert.ok(v!.until > 1000 + 7000, "the visit lasts the walk there and the talk");
  assert.deepEqual(bubbles.map((b) => [b.agentId, b.text]), [["lead", "You: Ship it"]]);
});
