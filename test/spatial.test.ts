import { test } from "node:test";
import assert from "node:assert/strict";
import type { WorldAgent } from "../src/shared/types.ts";
import { queueOrder } from "../src/ui/world/spatial.ts";

test("the queue has one place per agent, in the order its items wait", () => {
  const agents = [{ id: "tom", taskIds: ["t1", "t3"] }, { id: "ada", taskIds: ["t2"] }] as WorldAgent[];
  assert.deepEqual(queueOrder(agents, ["t3", "t2", "t1"]), ["tom", "ada"]);
  assert.deepEqual(queueOrder(agents, ["unknown"]), []);
});
