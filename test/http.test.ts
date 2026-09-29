import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { createInboxServer } from "../src/server/http.ts";
import { Inbox } from "../src/server/inbox.ts";
import { World, type LiveAgent } from "../src/server/world.ts";

let nextPort = 48_000 + Math.floor(Math.random() * 1000);

async function withServer(fn: (base: string) => Promise<void>, live: LiveAgent[] = [], typed: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "inbox-http-"));
  const db = openDatabase(":memory:");
  const inbox = new Inbox(db, join(dir, "files"), { available: () => false, forSession: () => null, resolvePane: () => null });
  const none = async () => { throw new Error("not in this test"); };
  const world = new World(db, {
    available: () => true, live: () => live, prompt: async (pane, text) => void typed.push(`${pane}: ${text}`), notify: async () => {},
    createWorktree: none, startAgent: none, closePane: none, removeWorktree: none,
  }, () => inbox.state());
  const port = nextPort++;
  const server = createInboxServer(inbox, null, { port, staticDir: null, world });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

const submission = JSON.stringify({
  session: { harness: "manual", sessionId: "s1" },
  item: { type: "milestone", title: "Storyboard pass" },
});

test("the agent protocol accepts JSON from a local client", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/agent/items`, { method: "POST", headers: { "content-type": "application/json" }, body: submission });
    assert.equal(res.status, 200);
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.items[0].title, "Storyboard pass");
  });
});

test("mutations from another website are refused", async () => {
  await withServer(async (base) => {
    const cross = await fetch(`${base}/api/agent/items`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: submission,
    });
    assert.equal(cross.status, 403);
    const form = await fetch(`${base}/api/agent/items`, { method: "POST", headers: { "content-type": "text/plain" }, body: submission });
    assert.equal(form.status, 415);
  });
});

test("a request for another host name is refused (DNS rebinding)", async () => {
  await withServer(async (base) => {
    // fetch drops a Host override, so this goes through node:http.
    const status = await new Promise<number>((resolve, reject) => {
      request(`${base}/api/state`, { headers: { host: "attacker.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on("error", reject).end();
    });
    assert.equal(status, 403);
  });
});

test("an agent finds its project and talks to another agent by name", async () => {
  const live: LiveAgent[] = [
    { paneId: "p1", harness: "pi", sessionId: "s1", cwd: "/a", status: "idle", title: null, name: null },
    { paneId: "p2", harness: "claude", sessionId: "s2", cwd: "/b", status: "idle", title: null, name: null },
  ];
  const typed: string[] = [];
  await withServer(async (base) => {
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const brief = await post("/api/agent/team", { session: { harness: "pi", sessionId: "s1", paneId: "p1" } });
    assert.equal(brief.status, 200);
    const { text } = await brief.json();
    assert.match(text, /not on a project/);
    const world = await (await fetch(`${base}/api/world`)).json();
    const b = world.agents.find((a: { cwd: string }) => a.cwd === "/b");
    const said = await post("/api/agent/say", { session: { harness: "pi", sessionId: "s1", paneId: "p1" }, to: b.name, text: "hello", clientId: "k1" });
    assert.equal(said.status, 200);
    const again = await post("/api/agent/say", { session: { harness: "pi", sessionId: "s1", paneId: "p1" }, to: b.name, text: "hello", clientId: "k1" });
    assert.equal((await again.json()).id, (await said.json()).id, "a retried request sends nothing twice");
    const unknown = await post("/api/agent/team", { session: { harness: "pi", sessionId: "nope" } });
    assert.equal(unknown.status, 404);
    for (let i = 0; i < 50 && !typed.length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(typed.length, 1, "the message is typed as soon as it is sent, since the other agent is free");
    assert.match(typed[0]!, /^p2: \[Message from/);
  }, live, typed);
});

test("the Claude Code hook endpoint never gets in an agent's way", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/hooks/claude`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "unknown", tool_name: "Bash", tool_input: {} }) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {});
  });
});

test("Claude Code's hooks tell the office the model from the session's own transcript", async () => {
  const transcript = join(mkdtempSync(join(tmpdir(), "inbox-transcript-")), "session.jsonl");
  const reply = (model: string) => `${JSON.stringify({ type: "assistant", message: { model, content: [] } })}\n`;
  writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { content: "hi" } })}\n${reply("claude-opus-5-5")}${reply("<synthetic>")}`);
  const live: LiveAgent[] = [{ paneId: "p1", harness: "claude", sessionId: "c1", cwd: "/repo", status: "working", title: null, name: null }];
  await withServer(async (base) => {
    const hook = (event: string, extra: Record<string, unknown> = {}) => fetch(`${base}/api/hooks/claude`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ hook_event_name: event, session_id: "c1", cwd: "/repo", transcript_path: transcript, tool_name: "Bash", tool_input: {}, ...extra }),
    });
    const model = async () => ((await (await fetch(`${base}/api/world`)).json()).agents[0].model);
    await hook("PreToolUse");
    assert.deepEqual(await model(), { id: "claude-opus-5-5", label: "Opus 5.5" }, "the latest real reply's model; a synthetic one is skipped");
    appendFileSync(transcript, reply("claude-sonnet-5-5"));
    await hook("PreToolUse");
    assert.equal((await model()).label, "Opus 5.5", "a known model is not re-read on every tool call");
    await hook("Stop");
    assert.equal((await model()).label, "Sonnet 5.5", "a turn's end picks up a /model switch");
    await hook("SessionStart", { model: "claude-fable-5-1", transcript_path: undefined });
    assert.equal((await model()).label, "Fable 5.1", "a model the hook input names wins");
  }, live);
});
