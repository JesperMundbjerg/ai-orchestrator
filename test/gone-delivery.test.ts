import { test } from "node:test";
import assert from "node:assert/strict";
import { leftBeforeArrival } from "../src/shared/delivery.ts";
import { Messages } from "../src/server/messages.ts";
import { openDatabase } from "../src/server/db.ts";
import type { Delivery, WorldAgent, WorldState } from "../src/shared/types.ts";
import type { AgentSource } from "../src/server/world.ts";

const failed = (error: string): Delivery => ({ agentId: "recipient", state: "failed", error, updatedAt: "" });
test("departed-recipient failures say left before it arrived, transport failures to live agents retain Retry", () => {
  const live = { paneId: "pane" };
  for (const reason of ["PTY actor closed during input submission", "agent not found", "pane w1:p2 closed", "No such terminal", "pane_not_found", "not found", "closed"]) {
    assert.equal(leftBeforeArrival(failed(reason), live), true, reason);
  }
  for (const reason of ["socket disconnected", "timed out", "agent_prompt_stalled", "settings file not found"]) {
    assert.equal(leftBeforeArrival(failed(reason), live), false, reason);
    assert.equal(leftBeforeArrival(failed(reason), undefined), true);
    assert.equal(leftBeforeArrival(failed(reason), { paneId: null }), true);
  }
  assert.equal(leftBeforeArrival({ ...failed(""), state: "delivered" }, undefined), false);
});

test("service refuses gone-recipient retries but keeps genuine failure retries for a live agent", async () => {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO world_agents (id, identity, name, first_seen_at) VALUES ('recipient', 'pi:test', 'Test', 'now')").run();
  let agents = [{ id: "recipient", paneId: "pane", status: "idle", teamId: null, taskIds: [] }] as unknown as WorldAgent[];
  let error = "socket disconnected";
  const world = () => ({ agents, teams: [], work: [] }) as unknown as WorldState;
  const messages = new Messages(db, { prompt: async () => { throw new Error(error); } } as unknown as AgentSource, world, () => new Date(), () => {});
  try {
    const message = messages.tell("recipient", { text: "Thanks, you're done" });
    await messages.deliver(world());
    assert.equal(messages.retry(message.id, "recipient").deliveries[0]!.state, "queued");
    error = "PTY actor closed during input submission";
    await messages.deliver(world());
    assert.throws(() => messages.retry(message.id, "recipient"), /left before it arrived/);
    assert.equal(messages.list()[0]!.deliveries[0]!.state, "failed");
    error = "socket disconnected";
    const second = messages.tell("recipient", { text: "Another message" });
    await messages.deliver(world());
    agents = [];
    assert.throws(() => messages.retry(second.id, "recipient"), /left before it arrived/);
  } finally { db.close(); }
});
