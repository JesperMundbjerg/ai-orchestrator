import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/server/db.ts";
import { Messages } from "../src/server/messages.ts";
import { World, type AgentSource, type LiveAgent } from "../src/server/world.ts";
import type { WorldAgent } from "../src/shared/types.ts";

const HOUR = 3_600_000;
/** World gives a pane's record this long while nothing runs there; that is when someone not seen is gone. */
const GRACE = 24 * HOUR;
const GONE_LINE = (n: number, name: string) => `${n} message${n === 1 ? "" : "s"} to ${name} ${n === 1 ? "was" : "were"} not delivered: ${name} is gone; re-send to whoever took over.`;

function setup(t: { after: (fn: () => void) => void }, durable = false) {
  const dir = mkdtempSync(join(tmpdir(), "undelivered-gone-"));
  const file = durable ? join(dir, "office.sqlite") : ":memory:";
  let db = openDatabase(file);
  let at = Date.parse("2026-10-01T10:00:00Z");
  let available = true;
  const unused = async () => { throw new Error("not used"); };
  const pane = (id: string, status: LiveAgent["status"] = "idle"): LiveAgent => ({ paneId: id, harness: "manual", sessionId: id, cwd: null, status, title: null, name: id });
  let live: LiveAgent[] = [pane("sender"), pane("sleepy")];
  const source: AgentSource = { available: () => available, live: () => live, prompt: unused,
    notify: async () => {}, createWorktree: unused, startAgent: unused, closePane: unused, removeWorktree: unused };
  const build = () => new World(db, source, () => ({ tasks: [], projects: [], items: [] }), () => new Date(at));
  let world = build();
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const find = (paneId: string): WorldAgent => world.state().agents.find((a) => a.paneId === paneId)!;
  const sender = find("sender");
  const sleepy = find("sleepy");
  return {
    world, db, sender, sleepy,
    get messages() { return world.messages; },
    setLive: (next: LiveAgent[]) => { live = next; },
    pane,
    advance: (ms: number) => { at += ms; },
    available: (v: boolean) => { available = v; },
    watch: () => world.messages.watch(world.state()),
    say: (text: string, to = sleepy.name) => world.messages.say(sender, { to, text }),
    deliveries: (agentId: string) => db.prepare("SELECT state, error FROM message_deliveries WHERE agent_id = ? ORDER BY rowid").all(agentId) as Array<{ state: string; error: string | null }>,
    toSender: () => (db.prepare(`SELECT m.text FROM messages m JOIN message_deliveries d ON d.message_id = m.id
      WHERE d.agent_id = ? AND m.from_office = 1 ORDER BY m.rowid`).all(sender.id) as Array<{ text: string }>).map((r) => r.text),
    restart: () => { db.close(); db = openDatabase(file); world = build(); },
  };
}

test("a recipient not seen for the grace period fails its deliveries once and tells the sender, batched", (t) => {
  const s = setup(t);
  s.say("first"); s.say("second"); s.say("third");
  s.setLive([s.pane("sender")]);
  s.advance(GRACE - HOUR);
  assert.equal(s.watch(), false, "gone only after the grace period, not before");
  assert.deepEqual(s.deliveries(s.sleepy.id).map((d) => d.state), ["queued", "queued", "queued"]);
  assert.deepEqual(s.toSender(), []);

  s.advance(2 * HOUR);
  assert.equal(s.watch(), true);
  const rows = s.deliveries(s.sleepy.id);
  assert.deepEqual(rows.map((d) => d.state), ["failed", "failed", "failed"]);
  assert.match(rows[0]!.error!, new RegExp(`${s.sleepy.name} is gone`));
  assert.deepEqual(s.toSender(), [GONE_LINE(3, s.sleepy.name)], "one notice, not one per message");

  assert.equal(s.watch(), false);
  s.advance(HOUR);
  s.watch();
  assert.equal(s.toSender().length, 1, "never told twice");
});

test("the sender gets one notice for several gone recipients, a line each", (t) => {
  const s = setup(t);
  s.setLive([s.pane("sender"), s.pane("sleepy"), s.pane("second")]);
  const second = s.world.state().agents.find((a) => a.paneId === "second")!;
  s.say("a"); s.say("b", second.name);
  s.setLive([s.pane("sender")]);
  s.advance(GRACE + HOUR);
  s.watch();
  assert.deepEqual(s.toSender(), [[GONE_LINE(1, s.sleepy.name), GONE_LINE(1, second.name)].join("\n")]);
});

test("an agent that is only busy, offline briefly or back in the same pane is never failed", (t) => {
  const s = setup(t);
  s.say("while you were busy");
  s.setLive([s.pane("sender"), s.pane("sleepy", "working")]);
  s.advance(30 * 24 * HOUR);
  assert.equal(s.watch(), false, "still running after a month, busy or not");
  s.setLive([s.pane("sender"), s.pane("sleepy", "blocked")]);
  assert.equal(s.watch(), false, "stopped at a prompt is still there");

  // Its pane vanishes, then returns inside the grace period: restarting in the same pane.
  s.setLive([s.pane("sender")]);
  s.advance(GRACE - 2 * HOUR);
  assert.equal(s.watch(), false, "offline briefly");
  s.setLive([s.pane("sender"), s.pane("sleepy")]);
  s.world.state();
  s.advance(GRACE - 2 * HOUR);
  s.setLive([s.pane("sender")]);
  assert.equal(s.watch(), false, "the clock restarts from when it was last seen");
  assert.deepEqual(s.deliveries(s.sleepy.id).map((d) => d.state), ["queued"]);
  assert.deepEqual(s.toSender(), []);
});

test("a team's offline lead keeps what waits for it, and a switching agent is held", (t) => {
  const s = setup(t);
  s.db.prepare("INSERT INTO teams (id, name, standing, created_at) VALUES ('project', 'Lantern', 1, ?)").run(new Date().toISOString());
  s.world.updateAgent(s.sleepy.id, { teamId: "project", role: "lead" });
  s.say("for the lead");
  s.setLive([s.pane("sender")]);
  s.advance(GRACE * 3);
  assert.equal(s.watch(), false);
  assert.deepEqual(s.deliveries(s.sleepy.id).map((d) => d.state), ["queued"]);

  s.db.prepare("UPDATE world_agents SET team_id = NULL, role = 'member' WHERE id = ?").run(s.sleepy.id); // left its team
  s.messages.held = () => new Set([s.sleepy.id]);
  assert.equal(s.watch(), false, "a switch in progress holds, not fails");
  s.messages.held = () => new Set();
  assert.equal(s.watch(), true);
  assert.deepEqual(s.deliveries(s.sleepy.id).map((d) => d.state), ["failed"]);
});

test("nothing fails while herdr cannot be read", (t) => {
  const s = setup(t);
  s.say("hello");
  s.setLive([s.pane("sender")]);
  s.advance(GRACE * 2);
  s.available(false);
  assert.equal(s.watch(), false);
  assert.deepEqual(s.deliveries(s.sleepy.id).map((d) => d.state), ["queued"]);
  s.available(true);
  assert.equal(s.watch(), true);
});

test("removing an agent tells its senders what will be dropped", (t) => {
  const s = setup(t);
  s.say("one"); s.say("two");
  s.db.prepare("INSERT INTO teams (id, name, standing, created_at) VALUES ('project', 'Lantern', 1, ?)").run(new Date().toISOString());
  s.world.updateAgent(s.sleepy.id, { teamId: "project" });
  s.setLive([s.pane("sender")]);
  s.world.removeAgent(s.sleepy.id);
  assert.deepEqual(s.deliveries(s.sleepy.id), [], "waiting messages are dropped with the agent");
  assert.deepEqual(s.toSender(), [GONE_LINE(2, s.sleepy.name)]);
});

test("a failed gone delivery cannot be retried, and the founder is told about their own messages", (t) => {
  const s = setup(t);
  const told = s.messages.tell(s.sleepy.id, { text: "From the founder" });
  s.setLive([s.pane("sender")]);
  s.advance(GRACE + HOUR);
  s.watch();
  assert.throws(() => s.messages.retry(told.id, s.sleepy.id), /left before it arrived/);
  const notices = s.messages.withFounder().filter((m) => m.fromOffice);
  assert.deepEqual(notices.map((m) => m.text), [GONE_LINE(1, s.sleepy.name)]);
  assert.equal(notices[0]!.toFounder, true);
  assert.deepEqual(s.toSender(), [], "no agent sent it");
});

test("old rows are swept once at startup, on a restart with the data kept", (t) => {
  const s = setup(t, true);
  s.say("ancient");
  s.advance(GRACE * 2);
  s.setLive([s.pane("sender")]);
  s.restart();
  const before = s.deliveries(s.sleepy.id);
  assert.deepEqual(before.map((d) => d.state), ["queued"]);
  assert.equal(s.watch(), true);
  assert.deepEqual(s.deliveries(s.sleepy.id).map((d) => d.state), ["failed"]);
  assert.equal(s.watch(), false);
  assert.equal(s.toSender().length, 1);
});
