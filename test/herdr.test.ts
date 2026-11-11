import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Herdr } from "../src/server/herdr.ts";
import { AgentStartingError } from "../src/server/agent-starting.ts";

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

test("only herdr's definite not-active refusal identifies a safely retryable startup prompt", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-starting-test-"));
  const output = join(dir, "error.json");
  const bin = join(dir, "herdr");
  writeFileSync(bin, `#!/bin/sh\ncat '${output}'\nexit 1\n`);
  chmodSync(bin, 0o755);
  const herdr = new Herdr(bin, join(dir, "unused.sock"));
  t.after(() => herdr.stop());
  for (const message of ["agent wX:p1 is not an active named agent", "agent_prompt_stalled", "timed out", "agent not found", "PTY actor closed", "agent is asking something"]) {
    writeFileSync(output, JSON.stringify({ error: { message } }));
    await assert.rejects(herdr.prompt("wX:p1", "Start ECG"), (err: Error) => {
      assert.equal(err.message, message);
      assert.equal(err instanceof AgentStartingError, message === "agent wX:p1 is not an active named agent");
      return true;
    });
  }
});

test("a failed prompt says how herdr ended and never echoes the command line or the message", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-error-test-"));
  const secret = "Private message body — do not leak";
  const cases: Array<{ script: string; killMs?: number; expected: string }> = [
    { script: "exit 3", expected: "herdr agent prompt exited with code 3 without saying why" },
    { script: "echo 'unexpected argument --until' >&2\nexit 2", expected: "herdr agent prompt exited with code 2: unexpected argument --until" },
    { script: "kill -KILL $$", expected: "herdr agent prompt was ended by SIGKILL without saying why" },
    { script: "exec sleep 5", killMs: 300, expected: "herdr agent prompt gave no answer within 300 ms and was stopped without saying why" },
  ];
  for (const [i, c] of cases.entries()) {
    const bin = join(dir, `herdr-${i}`);
    writeFileSync(bin, `#!/bin/sh\n${c.script}\n`);
    chmodSync(bin, 0o755);
    const herdr = new Herdr(bin, join(dir, "unused.sock"), Date.now, c.killMs);
    t.after(() => herdr.stop());
    await assert.rejects(herdr.prompt("wX:p1", secret), (err: Error) => {
      assert.equal(err.message, c.expected);
      assert.ok(!err.message.includes(secret) && !err.message.includes("Command failed") && !err.message.includes(bin));
      assert.equal(err instanceof AgentStartingError, false);
      return true;
    });
  }
});

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(check(), "timed out");
}
