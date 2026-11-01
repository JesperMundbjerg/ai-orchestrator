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

/** An office whose git cache is cold: it answers 503 git_pending `pending` times, then normally. */
function coldCache(pending: number) {
  const calls: Array<{ path: string; body?: string; at: number }> = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ path: new URL(url).pathname, body: init.body as string | undefined, at: Date.now() });
    if (calls.length <= pending) {
      return new Response(JSON.stringify({ error: "the office is reading the checkout from Git (the machine is busy); retry in a few seconds", code: "git_pending" }), { status: 503 });
    }
    return new Response(JSON.stringify({ itemId: "i", taskId: "t", revision: 1, changed: true }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}
const session = { harness: "claude" as const, sessionId: "s1", cwd: "/work" };

test("a git_pending answer is asked again, a write too, with the same body, until the office answers", async () => {
  const { calls, fetch } = coldCache(2);
  const client = createAgentClient({ fetch, baseUrl: "http://office.test", session, gitPendingRetryMs: 20, gitPendingBudgetMs: 1000 });
  const out = await client.submit({ item: { type: "milestone", fixed: "Fixed.", title: "Done" } });
  assert.equal(out.itemId, "i");
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map((c) => c.body)).size, 1, "every attempt sends the same body");
  assert.ok(calls[1]!.at - calls[0]!.at >= 15, "the retries are spaced, not a busy loop");
});

test("past the budget, the office's own git_pending message is the error", async () => {
  const { calls, fetch } = coldCache(Infinity);
  const started = Date.now();
  await assert.rejects(
    createAgentClient({ fetch, baseUrl: "http://office.test", session, gitPendingRetryMs: 20, gitPendingBudgetMs: 100 }).team(),
    (err: AgentClientError) => err.kind === "http" && err.status === 503 && err.code === "git_pending" && /reading the checkout from Git/.test(err.message),
  );
  assert.ok(calls.length >= 3 && calls.length <= 7, `asked ${calls.length} times in a 100 ms budget at 20 ms apart`);
  assert.ok(Date.now() - started < 1000);
});

test("other errors are not retried, and cancelling stops the wait", async () => {
  let calls = 0;
  const fetch = (async () => { calls++; return new Response(JSON.stringify({ error: "busy", code: "something_else" }), { status: 503 }); }) as unknown as typeof globalThis.fetch;
  await assert.rejects(createAgentClient({ fetch, baseUrl: "http://office.test", session, gitPendingRetryMs: 10 }).team(), (err: AgentClientError) => err.code === "something_else");
  assert.equal(calls, 1);
  const cold = coldCache(Infinity);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(
    createAgentClient({ fetch: cold.fetch, baseUrl: "http://office.test", session, gitPendingRetryMs: 1000, gitPendingBudgetMs: 20_000 }).team({}, { signal: controller.signal }),
    (err: AgentClientError) => err.kind === "cancelled",
  );
  assert.equal(cold.calls.length, 1);
});

test("by default the git_pending retries end within 12 s, inside an older install's 15 s hook", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { calls, fetch } = coldCache(Infinity);
  const result = createAgentClient({ fetch, baseUrl: "http://office.test", session }).team().then(() => null, (err: AgentClientError) => err);
  for (let i = 0; i < 10; i++) { await new Promise<void>((r) => setImmediate(r)); t.mock.timers.tick(2000); }
  const err = await result;
  assert.equal(err?.code, "git_pending");
  assert.equal(calls.length, 7, "asked at 0, 2, 4, 6, 8, 10 and 12 s, then the office's message");
  assert.ok(calls.at(-1)!.at - calls[0]!.at <= 12_000);
});
