import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentClientError, createAgentClient, get } from "../src/shared/agent-client.ts";

/** An office that is stuck on its first answer, as a blocked event loop leaves it, and fine on the next. */
function stuckOnce() {
  const calls: Array<{ method: string; path: string; timeoutAborts: boolean }> = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const call = { method: init.method ?? "GET", path: new URL(url).pathname, timeoutAborts: false };
    calls.push(call);
    if (calls.length === 1) {
      await new Promise<void>((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
    }
    const body = call.path === "/api/agent/team" ? { agentId: "a1", text: "You are Samir" } : call.path === "/api/agent/items" ? { itemId: "i", taskId: "t", revision: 1, changed: true } : {};
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

test("a read that times out is asked once more, with a longer limit", async () => {
  const { calls, fetch } = stuckOnce();
  const client = createAgentClient({ fetch, baseUrl: "http://office.test", timeoutMs: 30, session: { harness: "claude", sessionId: "s1", cwd: "/work" } });
  const brief = await client.team();
  assert.equal(brief.text, "You are Samir");
  assert.equal(calls.length, 2);
});

test("a read that times out twice fails with the timeout, after one retry only", async () => {
  let calls = 0;
  const fetch = (async (_url: string, init: RequestInit) => {
    calls++;
    await new Promise<void>((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
    return new Response("{}");
  }) as unknown as typeof globalThis.fetch;
  const started = Date.now();
  await assert.rejects(
    createAgentClient({ fetch, baseUrl: "http://office.test", timeoutMs: 20, retryTimeoutMs: 100, session: { harness: "claude", sessionId: "s1", cwd: "/work" } }).team({}, { timeoutMs: 20 }),
    (err: AgentClientError) => err.kind === "timeout",
  );
  assert.equal(calls, 2);
  assert.ok(Date.now() - started >= 50, "the retry waited for the longer limit");
});

test("a write is never retried: it may already have been done", async () => {
  const { calls, fetch } = stuckOnce();
  const client = createAgentClient({ fetch, baseUrl: "http://office.test", timeoutMs: 30, session: { harness: "claude", sessionId: "s1", cwd: "/work" } });
  await assert.rejects(client.submit({ item: { type: "milestone", fixed: "Fixed.", title: "Done" } }), (err: AgentClientError) => err.kind === "timeout");
  assert.equal(calls.length, 1);
});

test("a cancelled read and a refused read are not retried", async () => {
  let calls = 0;
  const refusing = (async () => { calls++; return new Response(JSON.stringify({ error: "no" }), { status: 404 }); }) as unknown as typeof globalThis.fetch;
  await assert.rejects(createAgentClient({ fetch: refusing, baseUrl: "http://office.test", session: { harness: "claude", sessionId: "s1", cwd: "/work" } }).team(), (err: AgentClientError) => err.kind === "http");
  assert.equal(calls, 1);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(createAgentClient({ fetch: refusing, baseUrl: "http://office.test", session: { harness: "claude", sessionId: "s1", cwd: "/work" } }).team({}, { signal: abort.signal }), (err: AgentClientError) => err.kind === "cancelled");
  assert.equal(calls, 1);
  void get;
});
