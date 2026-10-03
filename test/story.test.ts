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
import { STORY_INTRO, STORY_PROMPT } from "../src/shared/story.ts";

function office(file = ":memory:") {
  const db = openDatabase(file);
  const dir = mkdtempSync(join(tmpdir(), "office-story-"));
  const inbox = new Inbox(db, join(dir, "files"), { available: () => false, forSession: () => null, resolvePane: () => null });
  const typed: string[] = [];
  const pane = { down: false };
  const source: AgentSource = {
    available: () => true,
    live: () => ["one", "two"].map((id) => ({ paneId: id, harness: "pi", sessionId: id, cwd: `/story-${id}`, status: "idle", name: null, title: null })),
    prompt: async (_pane, text) => { if (pane.down) throw new Error("pane gone"); typed.push(text); },
    notify: async () => {}, createWorktree: async () => ({ paneId: "new" }),
    startAgent: async () => {}, closePane: async () => {}, removeWorktree: async () => {},
  };
  const world = new World(db, source, () => inbox.state());
  return { db, inbox, world, typed, pane, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const session = { harness: "pi" as const, sessionId: "one", paneId: "one" };
const story = "When I was seven I built a raft from fence boards and it sank in the pond, and my grandmother laughed until she cried. I still fear deep water, and I still love building things that might not float.";

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

test("stories are capped at 800 Unicode characters and terminal control codes are not stored", () => {
  const o = office();
  try {
    const capped = o.world.setStory(session, "🌞".repeat(850)).story;
    assert.equal(Array.from(capped).length, 800);
    assert.equal(capped, "🌞".repeat(800), "no split surrogate at the cap");
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
    const row = db.prepare("SELECT name, story, story_prompt, story_asked FROM world_agents WHERE id = 'old'").get();
    assert.equal(row!.name, "Old");
    assert.equal(row!.story, null);
    assert.equal(row!.story_prompt, null, "an existing story is marked as answering the first prompt");
    assert.equal(row!.story_asked, null);
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
    const capped = await post({ session, text: "x".repeat(900) });
    assert.equal(capped.status, 200);
    assert.equal((await capped.json()).story.length, 800);
    assert.equal((await post({ session, text: {} })).status, 400);
    assert.equal((await post({ text: story })).status, 400);
    assert.equal((await post({ session, text: story }, "https://elsewhere.example")).status, 403);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    o.close();
  }
});

test("the intro asks for a personal life story, not a job backstory", () => {
  for (const asked of ["childhood memory", "crisis", "love or fear", "not your job"]) assert.ok(STORY_INTRO.includes(asked), asked);
  assert.ok(!/why you came to work here|playful backstory/.test(STORY_INTRO));
});

test("the briefing shows the agent its own story and invites it into its work, never another agent's", () => {
  const o = office();
  try {
    o.world.setStory(session, story);
    const text = o.world.brief(session).text;
    assert.ok(text.includes(`Your story: ${story}`));
    assert.match(text, /personal touch/);
    o.world.setStory({ harness: "pi", sessionId: "two", paneId: "two" }, "Someone else's rainy summer.");
    assert.ok(!o.world.brief(session).text.includes("rainy summer"));
    assert.ok(!o.world.brief({ harness: "pi", sessionId: "two", paneId: "two" }).text.includes(story));
  } finally { o.close(); }
});

test("a story under the old job prompt is re-asked exactly once and kept until retold; new stories are not re-asked", async () => {
  const o = office();
  try {
    const me = o.world.resolve(session);
    const other = o.world.resolve({ harness: "pi", sessionId: "two", paneId: "two" });
    const old = "I used to bottle sunrise for sleepy astronomers and came here to grow ideas.";
    // As the first prompt left it: a story with no prompt marker.
    o.db.prepare("UPDATE world_agents SET story = ?, story_prompt = NULL WHERE id = ?").run(old, me.id);
    o.world.setStory({ harness: "pi", sessionId: "two", paneId: "two" }, story);
    const say = async (text: string) => {
      for (const id of [me.id, other.id]) o.world.messages.tell(id, { text, clientId: `${text}-${id}` });
      await o.world.react();
      return [o.typed.at(-2)!, o.typed.at(-1)!];
    };
    const first = await say("First task.");
    assert.equal(first.filter((t) => t.includes(STORY_INTRO)).length, 1, "only the old-prompt story is re-asked");
    assert.equal(o.world.resolve(session).story, old, "the old story stays shown until replaced");
    assert.ok(o.world.brief(session).text.includes(`Your story: ${old}`));
    const second = await say("Second task.");
    assert.ok(second.every((t) => !t.includes(STORY_INTRO)), "never asked again");
    assert.ok(!o.world.brief(session).text.includes(STORY_INTRO));
    o.world.setStory(session, story);
    assert.equal(o.db.prepare("SELECT story_prompt FROM world_agents WHERE id = ?").get(me.id)!.story_prompt, STORY_PROMPT);
    const third = await say("Third task.");
    assert.ok(third.every((t) => !t.includes(STORY_INTRO)));
  } finally { o.close(); }
});

test("a failed delivery does not use up the one re-ask", async () => {
  const o = office();
  try {
    const me = o.world.resolve(session);
    o.db.prepare("UPDATE world_agents SET story = 'An old job story.' WHERE id = ?").run(me.id);
    o.pane.down = true;
    o.world.messages.tell(me.id, { text: "Lost.", clientId: "lost" });
    await o.world.react();
    assert.equal(o.typed.length, 0);
    o.pane.down = false;
    o.world.messages.tell(me.id, { text: "Found.", clientId: "found" });
    await o.world.react();
    assert.ok(o.typed.at(-1)!.includes(STORY_INTRO));
  } finally { o.close(); }
});

test("an office database already past the legacy adoption gains the story columns and keeps working", async () => {
  const dir = mkdtempSync(join(tmpdir(), "story-existing-"));
  const file = join(dir, "inbox.sqlite");
  try {
    // An existing office as it was before the story columns: current schema, version 7, no such columns.
    openDatabase(file).close();
    const old = new DatabaseSync(file);
    old.exec("ALTER TABLE world_agents DROP COLUMN story_prompt; ALTER TABLE world_agents DROP COLUMN story_asked; PRAGMA user_version = 7;");
    assert.ok(!old.prepare("PRAGMA table_info(world_agents)").all().some((c) => c.name === "story_prompt" || c.name === "story_asked"));
    old.close();

    const o = office(file);
    try {
      // The story columns arrived in migration 8; later migrations may follow.
      assert.ok(Number(o.db.prepare("PRAGMA user_version").get()!.user_version) >= 8);
      const me = o.world.resolve(session);
      assert.deepEqual(o.world.setStory(session, story), { story });
      assert.equal(o.db.prepare("SELECT story_prompt FROM world_agents WHERE id = ?").get(me.id)!.story_prompt, STORY_PROMPT);
      o.db.prepare("UPDATE world_agents SET story = 'An old job story.', story_prompt = NULL WHERE id = ?").run(me.id);
      o.world.messages.tell(me.id, { text: "Start.", clientId: "start" });
      await o.world.react();
      assert.ok(o.typed.at(-1)!.includes("Start."));
      assert.equal(o.db.prepare("SELECT state FROM message_deliveries WHERE agent_id = ?").get(me.id)!.state, "delivered");
      assert.equal(o.db.prepare("SELECT story_asked FROM world_agents WHERE id = ?").get(me.id)!.story_asked, STORY_PROMPT);
    } finally { o.close(); }
    openDatabase(file).close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a failing story_asked update never fails or retries a delivery", async () => {
  const o = office();
  try {
    const me = o.world.resolve(session);
    o.db.prepare("UPDATE world_agents SET story = 'An old job story.' WHERE id = ?").run(me.id);
    o.db.exec("CREATE TRIGGER no_story_asked BEFORE UPDATE OF story_asked ON world_agents BEGIN SELECT RAISE(ABORT, 'story_asked broken'); END");
    o.world.messages.tell(me.id, { text: "Once.", clientId: "once" });
    await o.world.react();
    await o.world.react();
    assert.equal(o.typed.filter((t) => t.includes("Once.")).length, 1, "typed exactly once");
    assert.equal(o.db.prepare("SELECT state FROM message_deliveries WHERE agent_id = ?").get(me.id)!.state, "delivered");
  } finally { o.close(); }
});
