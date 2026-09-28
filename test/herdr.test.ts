import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Herdr } from "../src/server/herdr.ts";

test("a status event from herdr's socket updates presence well before the next poll", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-test-"));
  const list = join(dir, "agents.json");
  const agents = (status: string) =>
    writeFileSync(list, JSON.stringify({ result: { agents: [{ pane_id: "w1:p1", agent: "pi", agent_status: status, cwd: "/repo", agent_session: { value: "s1" } }] } }));
  agents("idle");
  // A stand-in for the CLI: `herdr agent list` prints the current list.
  const bin = join(dir, "herdr");
  writeFileSync(bin, `#!/bin/sh\ncat '${list}'\n`);
  chmodSync(bin, 0o755);

  const subscribed: unknown[] = [];
  let client: Socket | null = null;
  const server = createServer((socket) => {
    client = socket;
    socket.on("data", (chunk) => {
      subscribed.push(JSON.parse(String(chunk)));
      socket.write(`${JSON.stringify({ id: "review-inbox", result: { type: "subscription_started" } })}\n`);
    });
  });
  const socketPath = join(dir, "herdr.sock");
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  const herdr = new Herdr(bin, socketPath);
  t.after(() => {
    herdr.stop();
    server.close();
  });
  herdr.start();
  await until(() => client !== null && subscribed.length > 0);
  const request = subscribed[0] as { method: string; params: { subscriptions: Array<{ type: string; pane_id?: string }> } };
  assert.equal(request.method, "events.subscribe");
  assert.ok(request.params.subscriptions.some((s) => s.type === "pane.agent_status_changed" && s.pane_id === "w1:p1"));

  const changed = new Promise<number>((resolve) => {
    const start = Date.now();
    herdr.onChange = () => resolve(Date.now() - start);
  });
  agents("working");
  client!.write(`${JSON.stringify({ type: "pane_agent_status_changed", pane_id: "w1:p1", workspace_id: "w1", agent_status: "working" })}\n`);
  assert.ok((await changed) < 1500);
  assert.equal(herdr.live()[0]?.status, "working");
});

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(check(), "timed out");
}
