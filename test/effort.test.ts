import { test } from "node:test";
import assert from "node:assert/strict";
import { Efforts } from "../src/server/effort.ts";
import { openDatabase } from "../src/server/db.ts";
import { World, type AgentSource, type LiveAgent } from "../src/server/world.ts";
import type { InboxState } from "../src/shared/types.ts";

const report = { current: "high", levels: ["off", "low", "high", "max"] };
test("effort capability is learned, validated, expires and belongs to only one session", () => {
  const efforts = new Efforts();
  assert.equal(efforts.view("pi", "one", 0).capabilities.changeEffort, undefined);
  assert.match(efforts.view("claude", "one", 0).capabilities.effortUnavailable!, /defaults/);
  assert.throws(() => efforts.request("claude", "one", "low", 0), /cannot change effort/);
  assert.equal(efforts.report("pi", "one", { ...report, levels: ["low\n/exit"] }, 0), false);
  efforts.report("pi", "one", report, 0);
  assert.deepEqual(efforts.view("pi", "one", 0).capabilities.changeEffort?.levels, report.levels);
  assert.throws(() => efforts.request("pi", "one", "xhigh", 0), /unsupported/);
  assert.throws(() => efforts.request("pi", "one", { level: "low" }, 0), /unsupported/);
  const requested = efforts.request("pi", "one", "low", 1);
  assert.equal(requested.current, "high", "request is not a reported level");
  assert.equal(efforts.pending("pi", "two", 1), null);
  assert.equal(efforts.pending("claude", "one", 1), null);
  assert.throws(() => efforts.request("pi", "one", "high", 2), /already pending/);
  efforts.report("pi", "one", { ...report, current: "low", result: { id: "wrong" } }, 2);
  assert.equal(efforts.view("pi", "one", 2).effort?.request?.state, "pending");
  efforts.report("pi", "one", { ...report, current: "low", result: { id: requested.request!.id } }, 3);
  assert.equal(efforts.view("pi", "one", 3).effort?.request?.state, "confirmed");
  assert.equal(efforts.pending("pi", "one", 3), null);
  assert.equal(efforts.view("pi", "one", 15_003).capabilities.changeEffort, undefined);
  assert.throws(() => efforts.request("pi", "one", "low", 15_003), /cannot change effort/);
});

test("clamping, explicit errors and missing acknowledgements are failures, not confirmation", () => {
  for (const error of [undefined, "setter failed"]) {
    const efforts = new Efforts();
    efforts.report("pi", "one", report, 0);
    const request = efforts.request("pi", "one", "low", 0).request!;
    efforts.report("pi", "one", { ...report, result: { id: request.id, error } }, 1);
    assert.equal(efforts.view("pi", "one", 1).effort?.request?.state, "failed");
    assert.match(efforts.view("pi", "one", 1).effort?.request?.error!, /setter failed|applied high, not low/);
  }
  const efforts = new Efforts();
  efforts.report("pi", "one", report, 0);
  efforts.request("pi", "one", "low", 0);
  assert.equal(efforts.pending("pi", "one", 30_000), null);
  assert.match(efforts.view("pi", "one", 30_000).effort?.request?.error!, /30 seconds/);
});

test("world handles Pi effort events and session-addressed polling; Claude never receives a typed command", async () => {
  const db = openDatabase(":memory:");
  const live: LiveAgent[] = [{ harness: "pi", paneId: "pane", cwd: "/no-such-effort-test", sessionId: "one", status: "working", title: null, name: "test" }];
  let typed = 0;
  const source = { available: () => true, live: () => live, prompt: async () => { typed++; } } as unknown as AgentSource;
  const world = new World(db, source, () => ({ tasks: [], items: [], projects: [] }) as unknown as InboxState);
  try {
    const session = { harness: "pi" as const, sessionId: "one", paneId: "pane" };
    const agent = world.state().agents[0]!;
    assert.throws(() => world.setEffort(agent.id, "low"), /no session-only/);
    world.report(session, [{ kind: "effort", effort: report }]);
    const request = world.setEffort(agent.id, "low").request!;
    assert.equal(world.pollEffort(session, report).request?.id, request.id);
    world.pollEffort(session, { ...report, current: "low", result: { id: request.id } });
    assert.equal(world.state().agents[0]!.effort?.current, "low");
    assert.equal(world.state().agents[0]!.effort?.request?.state, "confirmed");
    live[0]!.sessionId = "two";
    assert.equal(world.state().agents[0]!.effort, undefined, "new session does not inherit old effort or requests");
    live[0]!.harness = "claude";
    for (const status of ["working", "blocked", "idle", "done"] as const) {
      live[0]!.status = status;
      assert.throws(() => world.setEffort(world.state().agents[0]!.id, "low"), /no session-only/);
    }
    assert.equal(typed, 0, "no unsafe /effort command, even when free");
  } finally { db.close(); }
});
