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
import { STORY_PROMPT, framedStory, storyIntro, storySeeds } from "../src/shared/story.ts";

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
/** Every form of the ask, first or retold, seeded or not, says this. */
const asks = (text: string) => text.includes("tell your personal life story");
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
    assert.ok(asks(o.world.brief(session).text));
    const me = o.world.resolve(session);
    o.world.messages.tell(me.id, { text: "Start your task.", clientId: "first" });
    await o.world.react();
    assert.ok(asks(o.typed[0]!));
    assert.ok(o.typed[0]!.includes(`Your office name is ${me.name}.`));
    o.world.setStory(session, story);
    assert.ok(!asks(o.world.brief(session).text));
    o.world.messages.tell(me.id, { text: "Next task.", clientId: "second" });
    await o.world.react();
    assert.ok(!asks(o.typed[1]!));
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
  for (const asked of ["childhood memory", "crisis", "love or fear", "not your job"]) assert.ok(storyIntro("agent").includes(asked), asked);
  assert.ok(!/why you came to work here|playful backstory/.test(storyIntro("agent")));
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
    assert.equal(first.filter(asks).length, 1, "only the old-prompt story is re-asked");
    assert.equal(o.world.resolve(session).story, old, "the old story stays shown until replaced");
    assert.ok(o.world.brief(session).text.includes(`Your story: ${old}`));
    const second = await say("Second task.");
    assert.ok(second.every((t) => !asks(t)), "never asked again");
    assert.ok(!asks(o.world.brief(session).text));
    o.world.setStory(session, story);
    assert.equal(o.db.prepare("SELECT story_prompt FROM world_agents WHERE id = ?").get(me.id)!.story_prompt, STORY_PROMPT);
    const third = await say("Third task.");
    assert.ok(third.every((t) => !asks(t)));
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
    assert.ok(asks(o.typed.at(-1)!));
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

test("story seeds are the same for an agent every time and differ across agents", () => {
  const ids = Array.from({ length: 40 }, (_, i) => `agent-${i}`);
  for (const id of ids) {
    assert.deepEqual(storySeeds(id), storySeeds(id));
    assert.equal(storyIntro(id), storyIntro(id));
    for (const seed of Object.values(storySeeds(id))) assert.ok(storyIntro(id).includes(seed), seed);
  }
  for (const field of ["place", "decade", "trade", "object", "joy", "fear"] as const) {
    assert.ok(new Set(ids.map((id) => storySeeds(id)[field])).size >= 5, `${field} varies`);
  }
  assert.equal(new Set(ids.map((id) => storyIntro(id))).size, ids.length, "no two agents get the same seeds");
  assert.ok(ids.every((id) => !/\b(unsaid|silen(ce|t)|rivers?|fjords?|boats?|workshops?)\b/i.test(Object.values(storySeeds(id)).join(" "))), "no overused theme is seeded");
  assert.match(storyIntro("agent"), /no label, framing or disclaimer/);
  assert.match(storyIntro("agent"), /left unsaid/, "the overused themes are named to avoid");
});

const framed = [
  "Fictional office backstory for Yuri: I grew up above a bakery.",
  "Fictional office backstory for Sami, not an AI autobiography: I grew up in Lagos.",
  "In my imagined life, I was born in Lisbon.",
  "In my office story I was a ferry pilot's daughter.",
  "I don't have a childhood, but if I did it would be in Oslo.",
  "I DON’T have a real childhood… still, here goes.",
  "As an AI, I never scraped a knee.",
  "Backstory: born in Lima in 1971.",
  "My story: I was born in Accra.",
  "Here's my bio. I was born in Pune.",
  "This is a fictional account of my life.",
  "I'm Pim, a Claude model, so I have nothing to remember.",
  "I'm Alina, an AI. I begin fresh each session.",
];
const plain = [
  story,
  "My imaginary friend lived in our fridge in Busan, and I fed him cold rice until I was nine.",
  "My father invented a better mousetrap in Detroit in 1964 and never sold one.",
  "Stories were my mother's trade: she typed them at a newspaper in Tunis.",
  "I grew up in Valparaíso. Years later I imagined life without the hills and hated it.",
];

test("a story that opens with a frame or disclaimer is refused; a plain one is saved", () => {
  const o = office();
  try {
    for (const text of framed) {
      assert.ok(framedStory(text), text);
      assert.throws(() => o.world.setStory(session, text), (err: Error & { status?: number }) => err.status === 400 && /plainly as your own life/.test(err.message), text);
    }
    assert.equal(o.world.resolve(session).story, null, "nothing framed was saved");
    for (const text of plain) {
      assert.ok(!framedStory(text), text);
      assert.equal(o.world.setStory(session, text).story, text);
    }
  } finally { o.close(); }
});

test("the story route answers a framed story with a clear 400", async () => {
  const o = office();
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const server = createInboxServer(o.inbox, null, { port, staticDir: null, world: o.world });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/agent/story`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session, text: framed[0] }),
    });
    assert.equal(response.status, 400);
    assert.match(JSON.stringify(await response.json()), /plainly as your own life/);
    assert.equal(o.world.resolve(session).story, null);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    o.close();
  }
});

test("a story told under the second prompt is asked once to be retold under the third, with the agent's own seeds", async () => {
  const o = office();
  try {
    const me = o.world.resolve(session);
    const other = o.world.resolve({ harness: "pi", sessionId: "two", paneId: "two" });
    const old = "Fictional office backstory for Yuri: a river, a boat and things left unsaid.";
    // As the second prompt left it: saved under 2, and maybe already re-asked under 2.
    o.db.prepare("UPDATE world_agents SET story = ?, story_prompt = 2, story_asked = 2 WHERE id = ?").run(old, me.id);
    o.world.setStory({ harness: "pi", sessionId: "two", paneId: "two" }, story);
    const say = async (text: string) => {
      for (const id of [me.id, other.id]) o.world.messages.tell(id, { text, clientId: `${text}-${id}` });
      await o.world.react();
      return [o.typed.at(-2)!, o.typed.at(-1)!];
    };
    assert.ok(o.world.brief(session).text.includes(storyIntro(me.id, true)));
    const first = await say("First task.");
    assert.equal(first.filter(asks).length, 1, "only the second-prompt story is re-asked");
    assert.ok(first.some((t) => t.includes(storyIntro(me.id, true))), "with the retell wording and this agent's seeds");
    assert.equal(o.world.resolve(session).story, old, "kept until retold");
    const second = await say("Second task.");
    assert.ok(second.every((t) => !asks(t)), "asked once");
    assert.ok(!asks(o.world.brief(session).text));
    o.world.setStory(session, plain[1]!);
    assert.equal(o.db.prepare("SELECT story_prompt FROM world_agents WHERE id = ?").get(me.id)!.story_prompt, 3);
  } finally { o.close(); }
});
