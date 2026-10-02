import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAgentClient, AgentClientError, call, get, fetchReplies, acknowledge,
} from "../src/shared/agent-client.ts";
import { type OperationOutput } from "../src/shared/agent-protocol.ts";

const session = { harness: "manual" as const, sessionId: "one" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fake = (fn: (url: string, init: RequestInit) => Promise<Response> | Response): typeof fetch =>
  async (url, init) => fn(String(url), init ?? {});
const pending: OperationOutput<"replies">[number] = {
  deliveryId: "delivery", itemId: "item", itemKey: "key", itemTitle: "Question?", itemType: "decide",
  revision: 1, action: "answer", choice: null, choiceLabel: null, text: "Proceed", images: [], createdAt: "now",
};
const reply: OperationOutput<"acknowledge"> = {
  id: "delivery", itemId: "item", revision: 1, action: "answer", choice: null, text: "Proceed", images: [],
  state: "delivered", error: null, createdAt: "now", deliveredAt: "later",
};
const switched: OperationOutput<"switchAgent"> = {
  id: "switch", agentId: "agent", agentName: "Ada", from: "claude", to: "pi", toLabel: "Pi", model: "example-model",
  effort: "high", step: "queued", says: "Waiting", handoff: null, error: null, batchId: null, startedAt: "now", updatedAt: "now",
};

async function failure(fn: () => Promise<unknown>): Promise<AgentClientError> {
  try { await fn(); assert.fail("expected a client error"); }
  catch (err) { assert.ok(err instanceof AgentClientError, String(err)); return err; }
}

test("instances have injectable isolated URLs, transports and session identity", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = fake((url, init) => { seen.push({ url, init }); return json([pending]); });
  const client = createAgentClient({ baseUrl: "http://localhost:51001/", session, fetch: fetcher });
  const other = createAgentClient({ baseUrl: "http://localhost:51002", session: { ...session, sessionId: "two" }, fetch: fetcher });
  assert.deepEqual(await client.replies({ mode: "live" }), [pending]);
  await other.replies();
  await client.replies({ session: { ...session, sessionId: "override" }, mode: "boundary" });
  assert.deepEqual(seen.map((s) => s.url), ["http://localhost:51001/api/agent/replies", "http://localhost:51002/api/agent/replies", "http://localhost:51001/api/agent/replies"]);
  assert.deepEqual(seen.map((s) => JSON.parse(s.init.body as string)), [
    { session, mode: "live" }, { session: { ...session, sessionId: "two" } }, { session: { ...session, sessionId: "override" }, mode: "boundary" },
  ]);
  assert.ok(seen.every((s) => s.init.method === "POST" && !!s.init.signal));
});

test("JSON HTTP failures keep typed status, code, details and the human error", async () => {
  for (const status of [400, 404, 409, 500]) {
    const details = [{ path: "item.title", message: "must be a string" }];
    const client = createAgentClient({ session, fetch: fake(() => json({ error: "domain refusal", code: "specific_code", details }, status)) });
    const err = await failure(() => client.replies());
    assert.equal(err.name, "AgentClientError");
    assert.equal(err.kind, "http");
    assert.equal(err.status, status);
    assert.equal(err.code, "specific_code");
    assert.equal(err.message, "domain refusal");
    assert.deepEqual(err.details, details);
  }
  const oldService = createAgentClient({ session, fetch: fake(() => json({ error: "stale revision" }, 409)) });
  const oldError = await failure(() => oldService.replies());
  assert.equal(oldError.status, 409);
  assert.equal(oldError.code, "http_error", "pre-envelope services still work");
  assert.equal(oldError.message, "stale revision");
});

test("text, HTML, malformed JSON and empty error responses preserve the HTTP failure", async () => {
  for (const body of ["Bad gateway", "<html>proxy failure</html>", "", "{", "null", "[]"]) {
    const client = createAgentClient({ session, fetch: fake(() => new Response(body, { status: 502 })) });
    const err = await failure(() => client.replies());
    assert.equal(err.kind, "http");
    assert.equal(err.status, 502);
    assert.equal(err.code, "http_error");
    assert.equal(err.message, "inbox answered 502");
  }
  const badDetails = createAgentClient({ session, fetch: fake(() => json({ error: "failed", code: 4, details: [{ path: 4 }] }, 400)) });
  const err = await failure(() => badDetails.replies());
  assert.equal(err.status, 400);
  assert.equal(err.code, "http_error");
  assert.equal(err.details, undefined);
});

test("invalid success JSON or DTOs are protocol failures, never claimed as success", async () => {
  for (const body of ["<html>login</html>", "", "null", "{}", '[{"deliveryId":"partial"}]']) {
    const client = createAgentClient({ session, fetch: fake(() => new Response(body)) });
    const err = await failure(() => client.replies());
    assert.equal(err.kind, "protocol");
    assert.equal(err.status, 200);
    assert.equal(err.code, "invalid_response");
  }
  const client = createAgentClient({ session, fetch: fake(() => json([{ ...pending, images: [5] }])) });
  const err = await failure(() => client.replies());
  assert.equal(err.details?.[0]?.path, "response.0.images.0");
});

test("request validation happens before fetch; response extensions are retained", async () => {
  let calls = 0;
  const client = createAgentClient({ fetch: fake(() => { calls++; return json([]); }) });
  const err = await failure(() => client.replies());
  assert.equal(err.kind, "validation");
  assert.equal(err.code, "invalid_request");
  assert.equal(err.details?.[0]?.path, "session");
  assert.equal(calls, 0);
  const configured = createAgentClient({ session, fetch: fake(() => { calls++; return json({ agentId: "agent", text: "crew" }); }) });
  for (const value of [null, [], "wrong", 42]) {
    const invalid = await failure(() => Reflect.apply(configured.team, undefined, [value]));
    assert.equal(invalid.kind, "validation");
    assert.equal(invalid.details?.[0]?.path, "body");
  }
  assert.equal(calls, 0);
  const withSession = createAgentClient({ session, fetch: fake(() => json({ itemId: "i", taskId: "t", revision: 1, changed: true, future: { useful: true } })) });
  const result = await withSession.submit({ item: { title: "Done", type: "milestone" } });
  assert.equal(result.itemId, "i");
  assert.deepEqual((result as typeof result & { future: unknown }).future, { useful: true });
});

test("transport failures, timeout and caller cancellation are distinct, with their cause", async () => {
  const network = new TypeError("connection refused");
  const client = createAgentClient({ session, fetch: fake(() => { throw network; }) });
  const err = await failure(() => client.replies());
  assert.equal(err.kind, "transport");
  assert.equal(err.status, undefined);
  assert.equal(err.code, "transport_error");
  assert.equal(err.cause, network);
  const waiting = fake((_url, init) => new Promise<Response>((_resolve, reject) => {
    const abort = () => reject(init.signal?.reason);
    if (init.signal?.aborted) abort(); else init.signal?.addEventListener("abort", abort, { once: true });
  }));
  const timed = createAgentClient({ session, timeoutMs: 5, fetch: waiting });
  // AbortSignal.timeout does not keep the event loop alive itself.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const timeout = await failure(() => timed.replies());
    assert.equal(timeout.kind, "timeout");
    assert.equal(timeout.code, "timeout");
    const controller = new AbortController();
    const cancellation = failure(() => timed.replies({}, { signal: controller.signal, timeoutMs: 1000 }));
    controller.abort(new Error("user stopped"));
    assert.equal((await cancellation).kind, "cancelled");
    controller.abort();
    assert.equal((await failure(() => timed.replies({}, { signal: controller.signal }))).kind, "cancelled");
  } finally { clearTimeout(keepAlive); }
});

test("invalid timeouts and non-JSON bodies are typed validation failures before transport", async () => {
  let calls = 0;
  const client = createAgentClient({ session, fetch: fake(() => { calls++; return json([]); }) });
  assert.equal((await failure(() => client.replies({}, { timeoutMs: -1 }))).kind, "validation");
  assert.equal((await failure(() => client.crew({ extra: 1n }))).kind, "validation");
  assert.equal(calls, 0);
});

test("mutations have no blind retries; explicit replays keep the caller's client id", async () => {
  const bodies: unknown[] = [];
  const client = createAgentClient({ session, fetch: fake((_url, init) => {
    bodies.push(JSON.parse(init.body as string)); return json({ error: "unknown outcome", code: "unavailable" }, 503);
  }) });
  const input = { to: "Ada", text: "Check the increment", clientId: "retained-key" };
  await failure(() => client.say(input));
  assert.equal(bodies.length, 1);
  await failure(() => client.say(input));
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(bodies.length, 2);
});

test("control operations use named switch payloads and GET status, not guessed response casts", async () => {
  const seen: Array<[string, string, unknown]> = [];
  const client = createAgentClient({ baseUrl: "http://localhost:51000", fetch: fake((url, init) => {
    seen.push([url, init.method!, init.body ? JSON.parse(init.body as string) : undefined]);
    return json(url.endsWith("all-from") ? { batchId: "batch", switches: [switched], skipped: [] } : url.endsWith("/switches") && init.method === "GET" ? [switched] : switched);
  }) });
  assert.equal((await client.switchAgent({ agent: "Ada", to: "pi" })).id, "switch");
  assert.equal((await client.switchAll({ from: "claude" })).switches[0]!.id, "switch");
  assert.equal((await client.switchStatus("switch")).says, "Waiting");
  assert.deepEqual(await client.switches(), [switched]);
  assert.equal(seen[2]![1], "GET");
  assert.equal(seen[2]![2], undefined);
  assert.equal((await failure(async () => client.switchStatus("../wrong"))).kind, "validation");
});

test("named office reporting operations send their typed payloads and decode results", async () => {
  const bodies: Array<{ path: string; body: unknown }> = [];
  const client = createAgentClient({ session, fetch: fake((url, init) => {
    const path = new URL(url).pathname;
    bodies.push({ path, body: JSON.parse(init.body as string) });
    const responses: Record<string, unknown> = {
      "/api/agent/team": { agentId: "agent", text: "Your crew" }, "/api/agent/crew": { text: "Crew guide" },
      "/api/agent/pane": { recorded: true }, "/api/agent/story": { story: "A made-up note" },
      "/api/agent/events": { ok: true }, "/api/agent/usage": { changed: true }, "/api/agent/effort": { request: null },
    };
    return json(responses[path]);
  }) });
  assert.equal((await client.team()).agentId, "agent");
  assert.equal((await client.crew()).text, "Crew guide");
  assert.equal((await client.pane({ paneId: "pane" })).recorded, true);
  assert.equal((await client.story({ text: "A made-up note" })).story, "A made-up note");
  assert.equal((await client.events({ events: [{ kind: "idle" }] })).ok, true);
  assert.equal((await client.usage({ provider: "codex", limits: [{ usedPercent: 10, resetsAt: "1700000000" }] })).changed, true);
  assert.equal((await client.effort({ report: { current: "high", levels: ["low", "high"] } })).request, null);
  assert.deepEqual(bodies[2], { path: "/api/agent/pane", body: { session, paneId: "pane" } });
  assert.deepEqual(bodies[4], { path: "/api/agent/events", body: { session, events: [{ kind: "idle" }] } });
});

test("legacy exports retain decoded results and typed errors", async (t) => {
  t.mock.method(globalThis, "fetch", fake((url) => {
    if (url.endsWith("/api/agent/replies")) return json([pending]);
    if (url.endsWith("/api/agent/ack")) return json(reply);
    if (url.endsWith("/switch")) return json(switched);
    return json({ error: "stale", code: "stale_revision", details: [{ path: "revision", message: "changed" }] }, 409);
  }));
  assert.deepEqual(await fetchReplies(session, "pull"), [pending]);
  assert.equal((await acknowledge(session, "delivery")).state, "delivered");
  assert.equal((await get<OperationOutput<"switchAgent">>("/api/world/switches/switch")).id, "switch");
  for (const fn of [() => call("/api/legacy", {}), () => get("/api/legacy")]) {
    const err = await failure(fn);
    assert.equal(err.status, 409);
    assert.equal(err.code, "stale_revision");
    assert.equal(err.details?.[0]?.path, "revision");
  }
});
