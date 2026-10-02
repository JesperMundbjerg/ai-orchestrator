import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { openDatabase } from "../src/server/db.ts";
import { createInboxServer } from "../src/server/http.ts";
import { Inbox } from "../src/server/inbox.ts";
import { World, type AgentSource } from "../src/server/world.ts";
import { STORY_INTRO } from "../src/shared/story.ts";

function office(file = ":memory:") {
  const db = openDatabase(file);
  const dir = mkdtempSync(join(tmpdir(), "office-story-"));
  const inbox = new Inbox(db, join(dir, "files"), { available: () => false, forSession: () => null, resolvePane: () => null });
  const typed: string[] = [];
  const source: AgentSource = {
    available: () => true,
    live: () => ["one", "two"].map((id) => ({ paneId: id, harness: "pi", sessionId: id, cwd: `/story-${id}`, status: "idle", name: null, title: null })),
    prompt: async (_pane, text) => { typed.push(text); },
    notify: async () => {}, createWorktree: async () => ({ paneId: "new" }),
    startAgent: async () => {}, closePane: async () => {}, removeWorktree: async () => {},
  };
  const world = new World(db, source, () => inbox.state());
  return { db, inbox, world, typed, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const session = { harness: "pi" as const, sessionId: "one", paneId: "one" };
const story = "I used to bottle sunrise for sleepy astronomers. I came to this office because its windows looked like a place where small ideas could grow wings.";

test("an agent stores its own story on its identity and it survives an office restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "story-persist-"));
  const file = join(dir, "inbox.sqlite");
  const first = office(file);
  const before = first.world.state().agents;
  assert.ok(before.every((a) => a.story === null), "no stories are backfilled");
  const me = first.world.resolve(session);
  let changes = 0;
  first.world.onChange = () => { changes++; };
  assert.deepEqual(first.world.setStory(session, story), { story });
  assert.equal(changes, 1, "the office redraws when the note arrives");
  assert.equal(first.world.resolve(session).story, story);
  assert.equal(first.world.state().agents.find((a) => a.id !== me.id)!.story, null);
  first.close();
  const next = office(file);
  try {
    assert.equal(next.world.resolve(session).id, me.id);
    assert.equal(next.world.resolve(session).story, story);
    next.world.setStory(session, "A revised note.");
    assert.equal(next.world.resolve(session).story, "A revised note.");
  } finally { next.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("stories are capped at 600 Unicode characters and terminal control codes are not stored", () => {
  const o = office();
  try {
    const capped = o.world.setStory(session, "🌞".repeat(650)).story;
    assert.equal(Array.from(capped).length, 600);
    assert.equal(capped, "🌞".repeat(600), "no split surrogate at the cap");
    assert.equal(o.world.setStory(session, "  A\u0000\n\tB\u001b\u007f  ").story, "A B");
    for (const invalid of [null, {}, 12, " \n\u0000"]) assert.throws(() => o.world.setStory(session, invalid));
    assert.throws(() => o.world.setStory({ harness: "pi", sessionId: "stranger" }, story), /does not know/);
    assert.equal(o.world.resolve(session).story, "A B", "refused writes leave the story alone");
  } finally { o.close(); }
});

test("the additive story migration preserves existing agents without inventing a story", () => {
  const dir = mkdtempSync(join(tmpdir(), "story-migrate-"));
  const file = join(dir, "inbox.sqlite");
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE world_agents (id TEXT PRIMARY KEY, identity TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
    team_id TEXT, role TEXT NOT NULL DEFAULT 'member', first_seen_at TEXT NOT NULL);
    INSERT INTO world_agents VALUES ('old', 'pi:/old', 'Old', NULL, 'member', '2026-01-01');`);
  old.close();
  const db = openDatabase(file);
  try {
    const row = db.prepare("SELECT name, story FROM world_agents WHERE id = 'old'").get();
    assert.equal(row!.name, "Old");
    assert.equal(row!.story, null);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("intro and first-message instructions ask the agent itself, then omit the request once saved", async () => {
  const o = office();
  try {
    assert.ok(o.world.brief(session).text.includes(STORY_INTRO));
    const me = o.world.resolve(session);
    o.world.messages.tell(me.id, { text: "Start your task.", clientId: "first" });
    await o.world.react();
    assert.ok(o.typed[0]!.includes(STORY_INTRO));
    assert.ok(o.typed[0]!.includes(`Your office name is ${me.name}.`));
    o.world.setStory(session, story);
    assert.ok(!o.world.brief(session).text.includes(STORY_INTRO));
    o.world.messages.tell(me.id, { text: "Next task.", clientId: "second" });
    await o.world.react();
    assert.ok(!o.typed[1]!.includes(STORY_INTRO));
  } finally { o.close(); }
});

test("inbox story saves plain text through the API and /api/world exposes only that agent's note", async () => {
  const o = office();
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const server = createInboxServer(o.inbox, null, { port, staticDir: null, world: o.world });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${port}`;
  const post = (body: unknown, origin?: string) => fetch(`${base}/api/agent/story`, {
    method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
  });
  try {
    const literal = '<b>I repaired kites.</b> **Now I build ideas here.**';
    const result = await promisify(execFile)(process.execPath, ["bin/inbox", "--harness", "pi", "--session", "one", "story", literal], {
      cwd: process.cwd(), env: { ...process.env, INBOX_URL: base, HERDR_PANE_ID: "one" },
    });
    assert.match(result.stdout, /Office story saved/);
    const response = await fetch(`${base}/api/world`);
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.agents.find((a: { paneId: string }) => a.paneId === "one").story, literal, "markup stays literal text");
    assert.equal(state.agents.find((a: { paneId: string }) => a.paneId === "two").story, null);
    const capped = await post({ session, text: "x".repeat(700) });
    assert.equal(capped.status, 200);
    assert.equal((await capped.json()).story.length, 600);
    assert.equal((await post({ session, text: {} })).status, 400);
    assert.equal((await post({ text: story })).status, 400);
    assert.equal((await post({ session, text: story }, "https://elsewhere.example")).status, 403);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    o.close();
  }
});
