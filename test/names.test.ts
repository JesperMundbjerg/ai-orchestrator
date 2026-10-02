import { test, type TestContext } from "node:test";
import type { Task } from "../src/shared/types.ts";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { allocateName, NAMES, NAME_REUSE_MS, type NameRecord } from "../src/server/names.ts";
import { World, agentId, type AgentSource, type LiveAgent } from "../src/server/world.ts";

const AT = Date.parse("2026-10-10T12:00:00Z");
const fresh = new Date(AT).toISOString();
const stale = new Date(AT - NAME_REUSE_MS).toISOString();
const record = (name: string, i: number): NameRecord => ({ id: `a${i}`, name, teamId: null, removed: false, lastSeenAt: fresh });
const pool = () => NAMES.map(record);

test("the pool contains at least 600 short distinct first names, without reserved names or numbers", () => {
  assert.ok(NAMES.length >= 600);
  assert.equal(new Set(NAMES.map((n) => n.toLowerCase())).size, NAMES.length);
  for (const name of NAMES) {
    assert.match(name, /^[A-Z][a-z]{1,7}$/);
    assert.notEqual(name.toLowerCase(), "founder");
  }
});

test("allocation uses every first name before numbering, regardless of hash collisions", () => {
  const records: NameRecord[] = [];
  for (let i = 0; i < NAMES.length; i++) {
    const assigned = allocateName(records, new Set(), 19, AT);
    assert.ok(NAMES.includes(assigned.name));
    assert.equal(assigned.retired, undefined);
    records.push(record(assigned.name, i));
  }
  assert.equal(new Set(records.map((r) => r.name.toLowerCase())).size, NAMES.length);
  assert.match(allocateName(records, new Set(), 19, AT).name, / \d+$/);
});

test("unused names win before recycling; comparisons and archival names are case-insensitive", () => {
  const records = pool();
  records[0]!.name = "tOM";
  records[0]!.lastSeenAt = stale;
  const unused = records.pop()!;
  assert.deepEqual(allocateName(records, new Set(), 0, AT), { name: unused.name });
  records.push(unused, record("TOM (EARLIER)", 1001), record("tom (earlier 2)", 1002));
  assert.deepEqual(allocateName(records, new Set(), 0, AT), {
    name: "Tom", retired: { id: "a0", name: "tOM (earlier 3)" },
  });
});

test("only stale, unplaced, nonremoved, unobserved records can release a name", () => {
  for (const patch of [
    { teamId: "team" }, { removed: true }, { lastSeenAt: new Date(AT - NAME_REUSE_MS + 1).toISOString() },
    { lastSeenAt: "" }, { lastSeenAt: "invalid" },
  ]) {
    const records = pool();
    Object.assign(records[0]!, { lastSeenAt: stale }, patch);
    assert.match(allocateName(records, new Set(), 0, AT).name, / \d+$/);
  }
  const records = pool();
  records[0]!.lastSeenAt = stale;
  assert.match(allocateName(records, new Set(["a0"]), 0, AT).name, / \d+$/);
  records.push({ ...records[0]!, id: "duplicate" });
  assert.match(allocateName(records, new Set(), 0, AT).name, / \d+$/);
});

test("numeric fallback also skips case-insensitive collisions", () => {
  const records = pool();
  // Include the name that would be assigned at records.length + 1.
  records.push(record(`TOM ${NAMES.length + 2}`, 1001));
  assert.equal(allocateName(records, new Set(), 0, AT).name, `Tom ${NAMES.length + 3}`);
});

function setup(t: TestContext) {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  let live: LiveAgent[] = [];
  let tasks: Task[] = [];
  const source: AgentSource = {
    available: () => true, live: () => live, prompt: async () => {}, notify: async () => {},
    createWorktree: async () => { throw new Error("unused"); }, startAgent: async () => {},
    closePane: async () => {}, removeWorktree: async () => {},
  };
  const world = new World(db, source, () => ({ tasks, projects: [], items: [] }), () => new Date(AT));
  const pane = (id: string): LiveAgent => ({ paneId: id, harness: "pi", sessionId: null, cwd: null, status: "working", title: null, name: null });
  const seed = () => {
    const insert = db.prepare("INSERT INTO world_agents (id, identity, name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)");
    for (const [i, name] of NAMES.entries()) insert.run(`a${i}`, `pi:old-${i}`, name, stale, fresh);
  };
  return { db, world, seed, pane, setLive: (...ids: string[]) => { live = ids.map(pane); }, holdTask: (sessionId: string) => { tasks = [{
    id: "task", projectId: "project", title: "Task", objective: "", activity: "", nextMilestone: "", lastDecision: "", lastAcceptedMilestone: "",
    parked: false, binding: { harness: "pi", sessionId, cwd: null }, presence: null,
    capabilities: { submit: true, reply: "pull", ack: false, openConversation: false, openPreview: false }, createdAt: fresh, updatedAt: fresh,
  }]; } };
}

test("registration recycles a name atomically, keeps sender ids, and does not share it with the earlier record", (t) => {
  const f = setup(t);
  f.seed();
  // All names are held except this one, which has been unseen for exactly three days.
  f.db.prepare("UPDATE world_agents SET last_seen_at = ?, identity = 'pi:old' WHERE id = 'a0'").run(stale);
  f.setLive("old");
  const old = f.world.state().agents[0]!;
  const said = f.world.messages.say(old, { to: "founder", text: "The old Tom's report" });
  f.setLive();
  f.db.prepare("UPDATE world_agents SET last_seen_at = ? WHERE id = 'a0'").run(stale);
  f.setLive("new");
  assert.equal(f.world.state().agents[0]!.name, "Tom");
  assert.equal((f.db.prepare("SELECT name FROM world_agents WHERE id = 'a0'").get() as { name: string }).name, "Tom (earlier)");
  assert.equal(f.world.messages.withFounder().find((m) => m.id === said.id)?.fromAgentId, old.id);
  f.setLive("new", "old");
  assert.deepEqual(f.world.state().agents.map((a) => a.name).sort(), ["Tom", "Tom (earlier)"]);
  assert.throws(() => f.world.updateAgent(old.id, { name: "tOM" }), /already an agent/);
});

test("a failed registration rolls back the earlier-record rename", (t) => {
  const f = setup(t);
  f.seed();
  f.db.prepare("UPDATE world_agents SET last_seen_at = ? WHERE id = 'a0'").run(stale);
  f.db.exec("CREATE TRIGGER refuse_new BEFORE INSERT ON world_agents BEGIN SELECT RAISE(ABORT, 'refused'); END");
  f.setLive("new");
  assert.throws(() => f.world.state(), /refused/);
  assert.equal((f.db.prepare("SELECT name FROM world_agents WHERE id = 'a0'").get() as { name: string }).name, "Tom");
  assert.equal((f.db.prepare("SELECT count(*) AS count FROM world_agents").get() as { count: number }).count, NAMES.length);
});

test("an old live record returning beside a newcomer is protected before any registration", (t) => {
  const f = setup(t);
  f.seed();
  f.db.prepare("UPDATE world_agents SET last_seen_at = ?, identity = 'pi:old' WHERE id = 'a0'").run(stale);
  f.setLive("new", "old");
  const agents = f.world.state().agents;
  assert.equal(agents.find((a) => a.paneId === "old")!.name, "Tom");
  assert.match(agents.find((a) => a.paneId === "new")!.name, / \d+$/);
  assert.equal((f.db.prepare("SELECT last_seen_at FROM world_agents WHERE id = 'a0'").get() as { last_seen_at: string }).last_seen_at, fresh);
});

test("offline task holders and hidden running panes cannot lose their names", (t) => {
  for (const kind of ["task", "hidden"]) {
    const f = setup(t);
    f.seed();
    f.db.prepare("UPDATE world_agents SET last_seen_at = ?, identity = 'pi:old' WHERE id = 'a0'").run(stale);
    if (kind === "task") {
      f.holdTask("old");
      f.setLive("new");
    } else {
      f.setLive("new", "old");
      f.world.hiddenPanes = () => new Set(["old"]);
    }
    assert.match(f.world.state().agents.find((a) => a.paneId === "new")!.name, / \d+$/);
    assert.equal((f.db.prepare("SELECT name FROM world_agents WHERE id = 'a0'").get() as { name: string }).name, "Tom");
  }
});

test("existing numbered names stay stable when registered again and active", (t) => {
  const f = setup(t);
  f.db.prepare("INSERT INTO world_agents (id, identity, name, first_seen_at, last_seen_at) VALUES (?, 'pi:old', 'Agnes 193', ?, ?)")
    .run(agentId("pi:old"), stale, stale);
  f.setLive("old");
  assert.equal(f.world.state().agents[0]!.name, "Agnes 193");
  assert.equal(f.world.state().agents[0]!.name, "Agnes 193");
});

test("legacy databases get a conservative last-seen grace period without renaming anyone", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "names-migration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "office.sqlite");
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE world_agents (id TEXT PRIMARY KEY, identity TEXT UNIQUE, name TEXT, team_id TEXT, role TEXT, first_seen_at TEXT, ran_at TEXT, removed INTEGER);");
  old.exec("INSERT INTO world_agents VALUES ('old', 'pi:old', 'Agnes 193', NULL, 'member', '2020-01-01', '2020-01-01', 0)");
  old.close();
  const before = Date.now();
  const db = openDatabase(path);
  t.after(() => db.close());
  const row = db.prepare("SELECT name, last_seen_at FROM world_agents WHERE id = 'old'").get() as { name: string; last_seen_at: string };
  assert.equal(row.name, "Agnes 193");
  assert.ok(Date.parse(row.last_seen_at) >= before);
  assert.ok(Date.parse(row.last_seen_at) <= Date.now());
});
