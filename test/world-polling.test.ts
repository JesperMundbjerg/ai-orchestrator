import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/server/db.ts";
import { World, type AgentSource, type LiveAgent } from "../src/server/world.ts";

const report = { current: "medium", levels: ["off", "medium", "high"] };
const liveAgent = (paneId: string, name: string | null = null): LiveAgent => ({
  paneId, harness: "pi", sessionId: `session-${paneId}`, cwd: "/nonexistent/polling-fixture",
  status: "working", title: null, name,
});
const source = (live: LiveAgent[]): AgentSource => ({
  available: () => true, live: () => live, prompt: async () => {}, notify: async () => {},
  createWorktree: async () => { throw new Error("unused"); }, startAgent: async () => {},
  closePane: async () => {}, removeWorktree: async () => {},
});
const session = (a: LiveAgent) => ({ harness: a.harness, sessionId: a.sessionId!, paneId: a.paneId, cwd: a.cwd! });

test("registered live effort polls and activity do not build snapshots or write SQLite", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const live = [liveAgent("lead", "lead"), liveAgent("crew", "crew")];
  let inboxReads = 0;
  const world = new World(db, source(live), () => {
    inboxReads++;
    return { tasks: [], projects: [], items: [] };
  });
  const before = world.state();
  const crew = before.agents.find((a) => a.paneId === "crew")!;
  world.report(session(live[1]!), [{ kind: "effort", effort: report }]);
  const request = world.setEffort(crew.id, "high");
  const changes = db.prepare("SELECT total_changes() AS n").get()!.n;
  inboxReads = 0;
  const snapshot = t.mock.method(world, "state", () => assert.fail("a poll must not draw the office"));
  for (let n = 0; n < 50; n++) {
    assert.equal(world.pollEffort(session(live[1]!), report).request?.id, request.request?.id);
    assert.deepEqual(world.report(session(live[1]!), [{ kind: "tool", tool: "edit", input: { path: "poll.ts" } }]), { ok: true });
  }
  assert.equal(inboxReads, 0, "caller lookup must not read the full inbox either");
  assert.equal(db.prepare("SELECT total_changes() AS n").get()!.n, changes, "observing a stable caller needs no disk commit");
  snapshot.mock.restore();
  assert.equal(world.state().agents.find((a) => a.id === crew.id)?.doing, "Editing poll.ts");
});

test("fast caller lookup follows current presence and distinguishes shared-checkout agents", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const live = [liveAgent("one"), liveAgent("two"), liveAgent("named", "crew")];
  const world = new World(db, source(live), () => ({ tasks: [], projects: [], items: [] }));
  const initial = world.state();
  for (const a of live) {
    // Without paneId, the exact harness/session must still pick the right current pane.
    assert.deepEqual(world.report({ harness: a.harness, sessionId: a.sessionId! }, [{
      kind: "tool", tool: "read", input: { path: `${a.paneId}.ts` },
    }]), { ok: true });
  }
  for (const a of initial.agents) assert.equal(world.state().agents.find((x) => x.id === a.id)?.doing, `Reading ${a.paneId}.ts`);
  const restarted = live[2]!;
  restarted.sessionId = "new-session";
  assert.deepEqual(world.report({ harness: "pi", sessionId: "session-named" }, [{ kind: "idle" }]), { ok: false });
  assert.deepEqual(world.report({ harness: "pi", sessionId: restarted.sessionId }, [{ kind: "idle" }]), { ok: true });
  world.hiddenPanes = () => new Set([restarted.paneId]);
  assert.deepEqual(world.report({ harness: "pi", sessionId: restarted.sessionId }, [{ kind: "idle" }]), { ok: false });
});

test("activity keeps the persisted agent id after identity takeover", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const a = liveAgent("old", "crew");
  const world = new World(db, source([a]), () => ({ tasks: [], projects: [], items: [] }));
  const old = world.state().agents[0]!;
  a.cwd = "/nonexistent/new-polling-fixture";
  const identity = `pi:${a.cwd}@crew`;
  db.prepare("UPDATE world_agents SET identity = ? WHERE id = ?").run(identity, old.id);
  assert.deepEqual(world.report(session(a), [{ kind: "tool", tool: "read", input: { path: "takeover.ts" } }]), { ok: true });
  const current = world.state().agents[0]!;
  assert.equal(current.id, old.id);
  assert.equal(current.identity, identity);
  assert.equal(current.doing, "Reading takeover.ts");
});

test("first-seen live callers still register and unknown effort callers are refused", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const a = liveAgent("new", "new");
  const world = new World(db, source([a]), () => ({ tasks: [], projects: [], items: [] }));
  assert.equal(world.pollEffort(session(a), report).request, null);
  const registered = world.state().agents[0]!;
  assert.equal(registered.effort?.current, "medium");
  assert.equal(registered.ran, true);
  assert.deepEqual(world.report({ harness: "pi", sessionId: "unknown" }, [{ kind: "idle" }]), { ok: false });
  assert.throws(() => world.pollEffort({ harness: "pi", sessionId: "unknown" }, report), /does not know this session/);
});
