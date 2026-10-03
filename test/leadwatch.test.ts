import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/server/db.ts";
import { Inbox } from "../src/server/inbox.ts";
import { LEAD_WATCH_SESSION, stalls } from "../src/server/leadwatch.ts";
import { World, type AgentSource, type LiveAgent } from "../src/server/world.ts";
import { waitingLabel } from "../src/shared/waiting.ts";

const MINUTE = 60_000;

/** Mission Control (Alma leads, Kai on it) and Cosmology (Bo), all standing teams of manual agents. */
function setup(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "leadwatch-test-"));
  const db = openDatabase(":memory:");
  let at = Date.parse("2026-10-03T09:00:00Z");
  const now = () => new Date(at);
  const unused = async () => { throw new Error("not used"); };
  const agent = (name: string): LiveAgent => ({ paneId: name, harness: "manual", sessionId: name, cwd: null, status: "idle", title: null, name });
  const live: LiveAgent[] = [agent("Alma"), agent("Kai"), agent("Bo")];
  const source: AgentSource = { available: () => true, live: () => live, prompt: unused, notify: async () => {}, createWorktree: unused, startAgent: unused, closePane: unused, removeWorktree: unused };
  const inbox = new Inbox(db, join(dir, "files"), { available: () => true, forSession: () => null, resolvePane: () => null }, now);
  const world = new World(db, source, () => inbox.state(), now);
  world.leadWatch.inbox = inbox;
  const iso = now().toISOString();
  db.prepare("INSERT INTO teams (id, name, standing, created_at) VALUES ('mc', 'Mission Control', 1, ?), ('cos', 'Cosmology', 1, ?)").run(iso, iso);
  const id = (name: string) => world.state().agents.find((a) => a.name === name)!.id;
  // Office names are allocated; give each the name its pane has, then place them.
  for (const a of world.state().agents) world.updateAgent(a.id, { name: a.paneId! });
  world.updateAgent(id("Alma"), { teamId: "mc", role: "lead" });
  world.updateAgent(id("Kai"), { teamId: "mc", role: "member" });
  world.updateAgent(id("Bo"), { teamId: "cos", role: "lead" });
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const items = () => inbox.state().items.filter((i) => inbox.task(i.taskId).binding.sessionId === LEAD_WATCH_SESSION.sessionId);
  return {
    db, inbox, world, id, items,
    offline: (name: string) => { live.splice(live.findIndex((a) => a.name === name), 1); },
    online: (name: string) => { live.push(agent(name)); },
    pass: (minutes: number) => { at += minutes * MINUTE; },
    tick: () => world.leadWatch.tick(world.state()),
    bo: () => world.state().agents.find((a) => a.name === "Bo")!,
    team: () => world.state().teams.find((t) => t.id === "mc")!,
    now: () => at,
  };
}

test("a team is stalled only when its lead is offline and something has waited on it ten minutes", (t) => {
  const s = setup(t);
  s.world.messages.say(s.bo(), { to: "Mission Control", text: "Please land the fix on dev." });
  s.pass(11); s.tick();
  assert.equal(s.team().stalled, null, "a running lead is not stalled, however long the queue");
  s.offline("Alma");
  s.tick();
  const stall = s.team().stalled!;
  assert.equal(stall.leadName, "Alma");
  assert.deepEqual(stall.blocking, ["Cosmology"]);
  assert.deepEqual(stall.blockingAgentIds, [s.id("Bo")]);
  assert.deepEqual(stall.candidates.map((c) => [c.name, c.running]), [["Kai", true]]);

  // The threshold is a wait of ten minutes, not an offline lead alone.
  const state = s.world.state();
  const lead = state.agents.find((a) => a.name === "Alma")!;
  assert.equal(lead.status, "offline");
  assert.equal(stalls(state, [{ teamId: "mc", fromAgentId: null, since: s.now() - 9 * MINUTE }], s.now()).size, 0);
  assert.deepEqual(stalls(state, [{ teamId: "mc", fromAgentId: null, since: s.now() - 10 * MINUTE }], s.now()).get("mc")!.blocking, ["you"]);
  assert.equal(stalls(state, [], s.now()).size, 0, "nothing waiting, nothing stalled");
});

test("work handed to the team for review waits on its lead as well", (t) => {
  const s = setup(t);
  s.offline("Alma");
  const { work } = s.world.messages.handoff(s.bo(), { title: "ECG fix", summary: "Ready on the branch.", to: "Mission Control" });
  s.db.prepare("UPDATE message_deliveries SET state = 'delivered'").run(); // only the review itself waits
  s.pass(11);
  const waiters = s.world.leadWatch.waiters(s.world.state());
  assert.deepEqual(waiters.map((w) => [w.teamId, w.fromAgentId]), [["mc", s.id("Bo")]]);
  assert.equal(work.state, "in_review");
  s.tick();
  assert.deepEqual(s.team().stalled!.blocking, ["Cosmology"]);
});

test("the sender is told the lead is offline, not that they seem busy", (t) => {
  const s = setup(t);
  s.offline("Alma");
  const said = s.world.messages.say(s.bo(), { to: "Mission Control", text: "Please land the fix on dev." });
  assert.equal(said.deliveries[0]!.offline, "Mission Control's lead (Alma)", "the say response tells the agent at once");
  s.world.messages.instruct("mc", { text: "Status?" });
  s.pass(52);
  const founder = s.world.state().withFounder.find((m) => m.text.startsWith("Status?"))!;
  assert.equal(waitingLabel(founder, founder.deliveries[0]!, s.now()), "waiting 52 min: Mission Control's lead (Alma) is offline");
  const fromBo = s.world.state().messages.find((m) => m.id === said.id)!;
  assert.equal(waitingLabel(fromBo, fromBo.deliveries[0]!, s.now()), "waiting 52 min: Mission Control's lead (Alma) is offline", "an agent sender sees it too");
  s.online("Alma");
  const back = s.world.state().withFounder.find((m) => m.text.startsWith("Status?"))!;
  assert.equal(waitingLabel(back, back.deliveries[0]!, s.now()), "waiting 52 min: they seem busy", "a running recipient is busy again");
});

test("one decision per stalled team, revised rather than repeated, withdrawn when the lead is back", (t) => {
  const s = setup(t);
  s.offline("Alma");
  s.world.messages.say(s.bo(), { to: "Mission Control", text: "Please land the fix on dev." });
  s.world.messages.instruct("mc", { text: "mission control is idle, nothing is happening" });
  s.pass(11);
  assert.equal(s.tick(), true);
  s.tick(); s.pass(5); s.tick();
  assert.equal(s.items().length, 1, "deduplicated");
  const item = s.inbox.item(s.items()[0]!.id);
  assert.equal(item.title, "Mission Control has no lead online");
  assert.equal(item.revision, 1, "an unchanged stall changes nothing");
  assert.equal(item.state, "needs_attention");
  assert.match(item.request, /Cosmology and you are waiting on it/);
  assert.deepEqual(item.options.map((o) => o.label), ["Make Kai lead", "Wait for Alma"]);
  assert.equal(item.recommendation, "", "approve-all never picks a lead");
  assert.ok(!s.world.state().agents.some((a) => a.harness === "manual" && a.identity.includes(LEAD_WATCH_SESSION.sessionId)), "the office's own task is nobody in the office");

  s.online("Alma");
  s.tick();
  assert.equal(s.inbox.item(item.id).state, "withdrawn");
  assert.equal(s.team().stalled, null);

  // A later stall asks afresh, as a new item.
  s.offline("Alma"); s.tick();
  const open = s.items().filter((i) => i.state === "needs_attention");
  assert.equal(open.length, 1);
  assert.notEqual(open[0]!.id, item.id);
});

test("choosing 'Make Kai lead' makes Kai lead through the make-lead path and hands over the team's queue", (t) => {
  const s = setup(t);
  s.offline("Alma");
  const said = s.world.messages.say(s.bo(), { to: "Mission Control", text: "Please land the fix on dev." });
  const direct = s.world.messages.say(s.bo(), { to: "Alma", text: "Ping me when you are back." });
  s.pass(11); s.tick();
  const item = s.inbox.item(s.items()[0]!.id);
  const kai = s.id("Kai");
  s.inbox.answer(item.id, { revision: item.revision, action: "choose", choice: `lead:${kai}` });
  assert.equal(s.tick(), true);

  const state = s.world.state();
  assert.equal(state.agents.find((a) => a.id === kai)!.role, "lead");
  assert.equal(state.agents.find((a) => a.name === "Alma")!.role, "member");
  assert.equal(s.inbox.item(item.id).state, "resolved");
  const reply = s.inbox.detail(item.id).replies.at(-1)!;
  assert.equal(reply.state, "delivered");
  const moved = state.messages.find((m) => m.id === said.id)!;
  assert.deepEqual(moved.deliveries.map((d) => [d.agentId, d.state]), [[kai, "queued"]], "the team's message goes to the new lead");
  const kept = state.messages.find((m) => m.id === direct.id)!;
  assert.deepEqual(kept.deliveries.map((d) => d.agentId), [s.id("Alma")], "a message to Alma by name stays hers");
  s.tick();
  assert.equal(s.team().stalled, null, "the team has a running lead again");
  assert.equal(s.items().filter((i) => i.state === "needs_attention").length, 0, "nothing is asked again");
});

test("'Wait' changes nothing and is not asked again during the same stall", (t) => {
  const s = setup(t);
  s.offline("Alma");
  s.world.messages.say(s.bo(), { to: "Mission Control", text: "Please land the fix on dev." });
  s.pass(11); s.tick();
  const item = s.inbox.item(s.items()[0]!.id);
  s.inbox.answer(item.id, { revision: item.revision, action: "choose", choice: "wait" });
  s.tick(); s.pass(30); s.tick();
  assert.equal(s.world.state().agents.find((a) => a.name === "Alma")!.role, "lead");
  assert.equal(s.items().filter((i) => i.state === "needs_attention").length, 0);
  assert.ok(s.team().stalled, "the board still says so");
  s.online("Alma"); s.tick();
  assert.equal(s.inbox.item(item.id).state, "resolved");
});
