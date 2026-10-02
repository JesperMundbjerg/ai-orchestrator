import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { openDatabase } from "../src/server/db.ts";
import { Inbox, InboxError } from "../src/server/inbox.ts";
import { createInboxServer } from "../src/server/http.ts";
import { World } from "../src/server/world.ts";
import { agentOperations, type ApiErrorBody } from "../src/shared/agent-protocol.ts";

// Exercise the real HTTP callback without listen(): no port, office process, herdr or account
// access. The only persistence is an in-memory database and a disposable evidence directory.
function fixture(t: TestContext, staticUi = false) {
  const dir = mkdtempSync(join(tmpdir(), "inbox-http-contract-"));
  const db = openDatabase(":memory:");
  const inbox = new Inbox(db, join(dir, "files"), { available: () => false, forSession: () => null, resolvePane: () => null });
  const world = new World(db, null, () => inbox.state());
  if (staticUi) writeFileSync(join(dir, "index.html"), "<!doctype html><title>Test UI</title>");
  const server = createInboxServer(inbox, null, { port: 49999, staticDir: staticUi ? dir : null, world });
  t.after(() => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const request = async (method: string, path: string, body: unknown = {}, headers: Record<string, string> = {}, raw?: string) => {
    const req = Object.assign(Readable.from([Buffer.from(raw ?? JSON.stringify(body))]), {
      method, url: path, headers: { host: "localhost:49999", "content-type": "application/json", ...headers },
    }) as unknown as IncomingMessage;
    const responseHeaders: Record<string, string> = {};
    let status = 0;
    const parts: string[] = [];
    let done!: () => void;
    const ended = new Promise<void>((resolve) => { done = resolve; });
    const res = {
      setHeader: (key: string, value: string) => { responseHeaders[key.toLowerCase()] = value; },
      writeHead: (code: number, head: Record<string, string>) => { status = code; for (const [key, value] of Object.entries(head)) responseHeaders[key.toLowerCase()] = value; },
      write: (s: string) => { parts.push(s); if (responseHeaders["content-type"] === "text/event-stream") done(); },
      end: (s: string) => { parts.push(s); done(); },
    } as unknown as ServerResponse;
    server.emit("request", req, res);
    await ended;
    req.emit("close"); // also clears the SSE heartbeat
    const output = parts.join("");
    return { status, headers: responseHeaders, text: output, body: responseHeaders["content-type"] === "application/json" ? JSON.parse(output) : undefined };
  };
  return { request, inbox, world, db };
}
const session = { harness: "manual" as const, sessionId: "contract-session" };
const submit = { session, item: { type: "milestone" as const, title: "A checked increment" } };
const mutations: Array<[string, string]> = [
  ["POST", "/api/items/id/replies"], ["POST", "/api/items/id/snooze"], ["POST", "/api/items/id/resolve"],
  ["POST", "/api/replies/id/retry"], ["PATCH", "/api/tasks/id"], ["POST", "/api/tasks/id/open"],
  ["POST", "/api/projects/id/pin"], ["POST", "/api/uploads"], ["POST", "/api/world/teams"],
  ["PATCH", "/api/world/teams/id"], ["DELETE", "/api/world/teams/id"],
  ["POST", "/api/world/teams/id/worktrees"], ["POST", "/api/world/teams/id/worktrees/remove"], ["POST", "/api/world/teams/id/merge"],
  ["POST", "/api/world/all-leads/messages"], ["POST", "/api/world/teams/id/messages"],
  ["POST", "/api/world/messages/id/deliveries/id/retry"], ["POST", "/api/world/agents/id/effort"],
  ["PATCH", "/api/world/agents/id"], ["DELETE", "/api/world/agents/id"], ["POST", "/api/world/agents/id/messages"],
  ["PUT", "/api/world/crew-tree"], ["POST", "/api/machine/browsers/1/close"], ["POST", "/api/hooks/claude"],
  ...Object.values(agentOperations).map((op): [string, string] => [op.method, op.path]),
];

test("every mutation rejects non-object JSON with a field-path 400, never an internal exception", async (t) => {
  const f = fixture(t);
  for (const [method, path] of mutations) {
    for (const value of [null, [], "text", 42, false]) {
      const out = await f.request(method, path, value);
      assert.equal(out.status, 400, `${method} ${path}: ${JSON.stringify(value)}`);
      assert.equal(out.body.code, "invalid_request");
      assert.equal(out.body.details[0].path, "body");
      assert.match(out.body.error, /must be an object/);
    }
  }
  assert.equal(f.inbox.state().items.length, 0, "invalid mutations have no side effects");
});

test("agent identity, nested fields, arrays, enums and URLs are checked before domain calls", async (t) => {
  const f = fixture(t);
  const cases: Array<[string, unknown, string]> = [
    ["/api/agent/replies", {}, "session"],
    ["/api/agent/replies", { session: {} }, "session"],
    ["/api/agent/replies", { session: { harness: "pi" } }, "session"],
    ["/api/agent/replies", { session: { harness: "wrong", sessionId: "x" } }, "session.harness"],
    ["/api/agent/replies", { session: { harness: "pi", sessionId: 2 } }, "session.sessionId"],
    ["/api/agent/replies", { session, mode: "not-a-mode" }, "mode"],
    ["/api/agent/activity", { session, activity: false }, "activity"],
    ["/api/agent/ack", { session, deliveryId: 5 }, "deliveryId"],
    ["/api/agent/items", { session, item: { type: "milestone", title: 7 } }, "item.title"],
    ["/api/agent/items", { session, item: { type: "decide", title: "Choose?", options: "one" } }, "item.options"],
    ["/api/agent/items", { session, item: { type: "decide", title: "Choose?", options: [null] } }, "item.options.0"],
    ["/api/agent/items", { session, item: { type: "decide", title: "Choose?", options: [{ label: 2 }] } }, "item.options.0.label"],
    ["/api/agent/items", { session, item: { type: "try", title: "Try", preview: "http://" } }, "item.preview"],
    ["/api/agent/items", { session, item: { type: "try", title: "Try", preview: { url: "https://", viewport: "phone" } } }, "item.preview.url"],
    ["/api/agent/items", { session, item: { type: "try", title: "Try", preview: { url: "http://localhost:3000", viewport: "huge" } } }, "item.preview.viewport"],
    ["/api/agent/items", { ...submit, item: { ...submit.item, pages: [{ url: "file:///etc/passwd" }] } }, "item.pages.0.url"],
    ["/api/agent/items", { ...submit, item: { ...submit.item, evidence: [{ url: "http://" }] } }, "item.evidence.0.url"],
    ["/api/agent/items", { ...submit, item: { ...submit.item, blocking: "false" } }, "item.blocking"],
    ["/api/agent/events", { session, events: "bad" }, "events"],
    ["/api/agent/events", { session, events: [{ kind: "wrong" }] }, "events.0.kind"],
    ["/api/agent/events", { session, events: [{ kind: "model", model: { id: 5 } }] }, "events.0.model.id"],
    ["/api/agent/effort", { session, report: { current: "high", levels: "high" } }, "report.levels"],
    ["/api/agent/review", { session, work: "work", verdict: "yes" }, "verdict"],
    ["/api/agent/usage", { provider: "codex", limits: [{ usedPercent: "50" }] }, "limits.0.usedPercent"],
    ["/api/agent/usage", { provider: "codex", limits: [null] }, "limits.0"],
    ["/api/agent/usage", { provider: "claude", limits: [{ usedPercent: 10, resetsAt: {} }] }, "limits.0.resetsAt"],
    ["/api/hooks/claude", { session_id: 5 }, "session_id"],
    ["/api/world/switches", { agent: 2 }, "agent"],
  ];
  for (const [path, body, field] of cases) {
    const out = await f.request("POST", path, body);
    assert.equal(out.status, 400, path);
    assert.equal(out.body.details[0].path, field, out.text);
  }
});

test("opaque tool inputs still validate helper calls consumed by activity bookkeeping", async (t) => {
  const f = fixture(t);
  await f.request("POST", "/api/agent/items", submit);
  for (const calls of [[null], [5], [[]]]) {
    const out = await f.request("POST", "/api/agent/events", { session, events: [{ kind: "tool", tool: "agents", callId: "call", input: { calls } }] });
    assert.equal(out.status, 400, out.text);
    assert.equal(out.body.details[0].path, "events.0.input.calls.0");
    const hook = await f.request("POST", "/api/hooks/claude", { hook_event_name: "PreToolUse", tool_name: "agents", tool_input: { calls } });
    assert.equal(hook.status, 400);
    assert.equal(hook.body.details[0].path, "tool_input.calls.0");
  }
  const valid = await f.request("POST", "/api/agent/events", { session, events: [{ kind: "tool", tool: "agents", callId: "call", input: { calls: [{ name: "reviewer", extra: true }] } }] });
  assert.equal(valid.status, 200, valid.text);
  assert.equal(f.world.state().agents[0]!.helpers[0]!.type, "reviewer");
  // Other tools' input is not our schema: arbitrary JSON stays available to their integrations.
  assert.equal((await f.request("POST", "/api/agent/events", { session, events: [{ kind: "tool", tool: "unrelated", input: { calls: [null] } }] })).status, 200);
});

test("UI mutations refuse coercion and silent dropping of wrongly typed known fields", async (t) => {
  const f = fixture(t);
  const posted = await f.request("POST", "/api/agent/items", submit);
  const state = f.inbox.state();
  const project = state.projects[0]!;
  const cases: Array<[string, string, unknown, string]> = [
    ["POST", `/api/projects/${project.id}/pin`, { pinned: "false" }, "pinned"],
    ["PATCH", `/api/tasks/${posted.body.taskId}`, { parked: "false" }, "parked"],
    ["POST", `/api/items/${posted.body.itemId}/replies`, { revision: 1, action: "accept", images: [1] }, "images.0"],
    ["POST", `/api/items/${posted.body.itemId}/replies`, { revision: "1", action: "accept" }, "revision"],
    ["PATCH", "/api/world/teams/id", { purpose: 4 }, "purpose"],
    ["PATCH", "/api/world/agents/id", { takeName: "false" }, "takeName"],
    ["PATCH", "/api/world/agents/id", { role: "boss" }, "role"],
    ["POST", "/api/world/teams/id/messages", { images: [false] }, "images.0"],
    ["POST", "/api/world/teams", { name: "Team", standing: "false" }, "standing"],
    ["POST", "/api/world/teams/id/worktrees", { path: 5 }, "path"],
    ["POST", "/api/world/teams/id/merge", { into: false }, "into"],
    ["POST", "/api/world/all-leads/messages", { clientId: "id", leadIds: [1] }, "leadIds.0"],
    ["POST", `/api/items/${posted.body.itemId}/snooze`, { until: "not-a-date" }, "until"],
    ["POST", "/api/uploads", { data: 4 }, "data"],
    ["PUT", "/api/world/crew-tree", { version: 1, mode: "mixed", rules: [{ id: "a", when: 4 }] }, "rules.0.when"],
  ];
  for (const [method, path, body, field] of cases) {
    const out = await f.request(method, path, body);
    assert.equal(out.status, 400, out.text);
    assert.equal(out.body.details[0].path, field);
  }
  assert.equal(f.inbox.state().projects[0]!.pinned, false);
  assert.equal(f.inbox.state().tasks[0]!.parked, false);
});

test("known paths enforce methods and Allow (including SSE, reads and evidence); unknown stays 404", async (t) => {
  const f = fixture(t);
  for (const [path, method, allow] of [
    ["/api/events", "POST", "GET"], ["/api/events", "DELETE", "GET"], ["/api/state", "POST", "GET"],
    ["/api/agent/replies", "GET", "POST"], ["/api/agent/items", "PUT", "POST"],
    ["/api/world/teams/id", "POST", "PATCH, DELETE"], ["/api/world/switches", "DELETE", "GET, POST"],
    ["/api/world/switches/all-from", "GET", "POST"],
    ["/files/id", "POST", "GET, HEAD"], ["/uploads/id.png", "POST", "GET"],
  ]) {
    // No content type required merely to learn a path's supported verbs.
    const out = await f.request(method!, path!, {}, { "content-type": "" });
    assert.equal(out.status, 405, path);
    assert.equal(out.headers.allow, allow);
    assert.equal(out.body.code, "method_not_allowed");
    assert.notEqual(out.headers["content-type"], "text/event-stream");
  }
  assert.equal((await f.request("GET", "/api/not-real")).status, 404);
  const sse = await f.request("GET", "/api/events");
  assert.equal(sse.status, 200);
  assert.equal(sse.headers["content-type"], "text/event-stream");
  assert.match(sse.text, /retry: 2000/);
});

test("the built UI is GET-only and invalid URL encoding is a 400", async (t) => {
  const f = fixture(t, true);
  const refused = await f.request("POST", "/", {});
  assert.equal(refused.status, 405);
  assert.equal(refused.headers.allow, "GET");
  const malformed = await f.request("GET", "/%zz");
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.details[0].path, "url");
});

test("errors have a stable additive envelope and unexpected 500s hide exception details", async (t) => {
  const f = fixture(t);
  const invalid = await f.request("POST", "/api/agent/items", {}, {}, "{");
  assert.deepEqual(invalid.body, { error: "invalid JSON", code: "invalid_json" });
  const blocked = await f.request("POST", "/api/agent/items", submit, { origin: "https://elsewhere.example" });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, "forbidden");
  assert.equal((await f.request("GET", "/api/state", {}, { host: "elsewhere:49999" })).status, 403);
  assert.equal((await f.request("POST", "/api/agent/items", submit, { "content-type": "application/jsonp" })).body.code, "unsupported_media_type");
  const huge = await f.request("POST", "/api/agent/items", {}, {}, "x".repeat(1_000_001));
  assert.equal(huge.status, 413);
  assert.equal(huge.body.code, "payload_too_large");
  t.mock.method(console, "error", () => {});
  t.mock.method(f.inbox, "state", () => { throw new Error("private/path secret failure"); });
  const failed = await f.request("GET", "/api/state");
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.body, { error: "internal server error", code: "internal_error" });
});

test("domain refusal codes/details survive boundary normalization", async (t) => {
  const f = fixture(t);
  t.mock.method(f.inbox, "submit", () => { throw Object.assign(new InboxError(409, "replay differs"), { code: "replay_conflict", details: [{ path: "id", message: "already used" }] }); });
  const out = await f.request("POST", "/api/agent/items", submit);
  assert.equal(out.status, 409);
  assert.deepEqual(out.body as ApiErrorBody, { error: "replay differs", code: "replay_conflict", details: [{ path: "id", message: "already used" }] });
});

test("current caller payloads and unknown additions retain the submit/poll/ack wire lifecycle", async (t) => {
  const f = fixture(t);
  const posted = await f.request("POST", "/api/agent/items", { ...submit, futureField: true,
    item: { ...submit.item, pages: ["First=http://localhost:3000/?a=b", " http://localhost:3000/?a=b "], futureField: [] },
  }, { "content-type": "application/json; charset=utf-8" });
  assert.equal(posted.status, 200, posted.text);
  assert.equal(agentOperations.submit.response.parse(posted.body).revision, 1);
  assert.equal(f.inbox.item(posted.body.itemId).pages[1]!.url, "http://localhost:3000/?a=b");
  const answered = await f.request("POST", `/api/items/${posted.body.itemId}/replies`, { id: "answer-key", revision: 1, action: "accept", text: "Looks good", images: null });
  assert.equal(answered.status, 200, answered.text);
  const polled = await f.request("POST", "/api/agent/replies", { session }); // default pull
  const replies = agentOperations.replies.response.parse(polled.body);
  assert.equal(replies.length, 1);
  assert.equal((await f.request("POST", "/api/agent/replies", { session, mode: "pull" })).body.length, 1, "polling claims but is not acknowledgement");
  const acked = await f.request("POST", "/api/agent/ack", { session, deliveryId: replies[0]!.deliveryId });
  assert.equal(agentOperations.acknowledge.response.parse(acked.body).state, "delivered");
  assert.deepEqual((await f.request("POST", "/api/agent/replies", { session, mode: "pull" })).body, []);
  assert.equal((await f.request("POST", "/api/hooks/claude", { futureHookField: {} })).status, 200);
});
