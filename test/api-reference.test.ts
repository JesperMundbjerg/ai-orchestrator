import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { agentOperations } from "../src/shared/agent-protocol.ts";

// Check the actual reference rows, not incidental mentions of a path in prose.
const reference = readFileSync(new URL("../docs/API.md", import.meta.url), "utf8");
const rows = [...reference.matchAll(/^\| `([^`]+)` \| `(GET|POST)` \| `([^`]+)` \|/gm)];

test("the API reference documents every agent operation with its current method and path", () => {
  const documented = new Map<string, { method: string; path: string }>();
  for (const [, name, method, path] of rows) {
    assert.ok(!documented.has(name!), `duplicate API operation row: ${name}`);
    documented.set(name!, { method: method!, path: path! });
  }
  assert.deepEqual([...documented.keys()].sort(), Object.keys(agentOperations).sort(),
    "Update docs/API.md when adding or removing an agent operation");
  for (const [name, operation] of Object.entries(agentOperations)) {
    assert.deepEqual(documented.get(name), { method: operation.method, path: operation.path },
      `API reference drift for ${name}`);
  }
});
