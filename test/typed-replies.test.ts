import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Inbox, type PresenceSource } from "../src/server/inbox.ts";
import { World, hookSettings, type AgentSource, type LiveAgent } from "../src/server/world.ts";
import { formatReply } from "../src/shared/agent-client.ts";
import type { SessionInput } from "../src/shared/types.ts";

const emil: SessionInput = { harness: "claude", sessionId: "uuid-emil", cwd: "/repo/cosmology" };

/** An office whose herdr shows whatever `setLive` says, and records what it types. */
function setup(clock = { t: Date.parse("2026-09-30T10:00:00Z") }) {
  const db = openDatabase(":memory:");
  let live: LiveAgent[] = [];
  const presence: PresenceSource = {
    available: () => true,
    forSession: (harness, sessionId) => {
      const a = live.find((x) => x.harness === harness && x.sessionId === sessionId);
      return a ? { source: "herdr", paneId: a.paneId, status: a.status, name: null, title: null, seenAt: "" } : null;
    },
    resolvePane: () => null,
  };
  const now = () => new Date(clock.t);
  const inbox = new Inbox(db, join(mkdtempSync(join(tmpdir(), "typed-test-")), "files"), presence, now);
  const typed: Array<{ pane: string; text: string }> = [];
  let refuse: string | null = null;
  let hold: Promise<void> | null = null;
  const none = async () => { throw new Error("not in this test"); };
  const source: AgentSource = {
    available: () => true,
    live: () => live,
    prompt: async (pane, text) => {
      if (hold) await hold;
      if (refuse) throw new Error(refuse);
      typed.push({ pane, text });
    },
    notify: async () => {},
    createWorktree: none, startAgent: none, closePane: none, removeWorktree: none,
  };
  const world = new World(db, source, () => inbox.state(), now);
  world.messages.replies = inbox;
  const { itemId } = inbox.submit({ session: emil, item: { type: "decide", title: "Which prior for the dark energy fit?", options: ["Flat: simple", "Informative: faster"] } });
  const reply = inbox.answer(itemId, { revision: 1, action: "choose", choice: "a", text: "Flat, and note it in the paper." });
  const at = (status: LiveAgent["status"], sessionId: string | null = emil.sessionId!) =>
    void (live = [{ paneId: "w3:p1", harness: "claude", sessionId, cwd: emil.cwd!, status, title: null, name: null }]);
  return { inbox, world, typed, itemId, reply, at, clock, refuse: (why: string | null) => void (refuse = why), hold: (p: Promise<void> | null) => void (hold = p) };
}

test("a reply for a session that can only pull is typed into its pane once it is free, in the hook's words, and acknowledged once", async () => {
  const { inbox, world, typed, itemId, reply, at } = setup();
  assert.equal(inbox.task(inbox.item(itemId).taskId).capabilities.reply, "pull");

  at("working");
  await world.react();
  assert.equal(typed.length, 0, "a working agent is not interrupted");
  assert.equal(inbox.reply(reply.id).state, "queued");

  at("idle");
  await world.react();
  assert.deepEqual(inbox.pendingReplies(emil, "pull"), [], "nothing is left to pull");
  assert.equal(typed.length, 1);
  assert.equal(typed[0]!.pane, "w3:p1");
  assert.match(typed[0]!.text, /^\[Review inbox\] Reply to your decide request "Which prior for the dark energy fit\?"/);
  assert.match(typed[0]!.text, /Decision: Flat\n\nFlat, and note it in the paper\./);
  assert.equal(inbox.reply(reply.id).state, "delivered");
  assert.equal(inbox.item(itemId).state, "delivered");

  await world.react();
  await world.react();
  assert.equal(typed.length, 1, "typed once");
});

test("the typed text is exactly what the hook hands over", async () => {
  const { inbox, world, typed, at, reply } = setup();
  const [expected] = inbox.pendingReplies(emil, "pull"); // pulled but not acknowledged: the agent has it, nothing is typed
  assert.equal(expected!.deliveryId, reply.id);
  at("idle");
  await world.react();
  assert.equal(typed.length, 0);
  // A fresh reply, never collected, is typed as formatReply writes it.
  const next = inbox.submit({ session: emil, item: { type: "milestone", title: "Fit done" } });
  inbox.answer(next.itemId, { revision: 1, action: "accept" });
  const [pending] = inbox.typeable().map((t) => t.reply);
  await world.react();
  assert.deepEqual(typed.map((t) => t.text), [formatReply(pending!)]);
});

test("without a pane the reply stays queued for the agent to pull", async () => {
  const { inbox, world, typed, reply } = setup();
  await world.react();
  assert.deepEqual(typed, []);
  assert.equal(inbox.reply(reply.id).state, "queued");
  assert.deepEqual(inbox.pendingReplies(emil, "pull").map((r) => r.deliveryId), [reply.id]);
});

test("a hook that takes the reply first means nothing is typed", async () => {
  const { inbox, world, typed, reply, at } = setup();
  const [pending] = inbox.pendingReplies(emil, "boundary");
  inbox.acknowledge(emil, pending!.deliveryId);
  at("idle");
  await world.react();
  assert.deepEqual(typed, []);
  assert.equal(inbox.reply(reply.id).state, "delivered");
});

test("a live integration keeps its replies; nothing is typed for it", async () => {
  const { inbox, world, typed, reply, at } = setup();
  inbox.pendingReplies(emil, "live"); // claims it, as the Pi extension does before it hands it over
  at("idle");
  await world.react();
  assert.deepEqual(typed, []);
  assert.equal(inbox.reply(reply.id).state, "queued");
});

test("an idle session with the hook is typed to too: it has no turn boundary until someone prompts it", async () => {
  const { inbox, world, typed, reply, at } = setup();
  const later = inbox.submit({ session: emil, item: { type: "milestone", title: "Fit done" } });
  inbox.pendingReplies(emil, "boundary"); // the hook ran at the end of an earlier turn and took the first reply
  inbox.acknowledge(emil, reply.id);
  const second = inbox.answer(later.itemId, { revision: 1, action: "accept" });
  assert.equal(inbox.task(inbox.item(later.itemId).taskId).capabilities.reply, "boundary");
  at("idle");
  await world.react();
  assert.equal(typed.length, 1);
  assert.equal(inbox.reply(second.id).state, "delivered");
});

test("while a reply is being typed, a hook firing on that prompt does not hand it over again", async () => {
  const { inbox, world, typed, reply, at, hold } = setup();
  let release!: () => void;
  hold(new Promise((r) => (release = r)));
  at("idle");
  const typing = world.react();
  // The typed prompt makes Claude Code run UserPromptSubmit before herdr reports it working.
  assert.deepEqual(inbox.pendingReplies(emil, "boundary"), []);
  assert.deepEqual(inbox.pendingReplies(emil, "pull"), []);
  await world.react(); // another change meanwhile types nothing more
  release();
  await typing;
  assert.equal(typed.length, 1);
  assert.equal(inbox.reply(reply.id).state, "delivered");
});

test("a reply herdr could not type fails, returns its item to Needs you, and types again after Retry", async () => {
  const { inbox, world, typed, itemId, reply, at, refuse } = setup();
  at("idle");
  refuse("agent is blocked");
  await world.react();
  assert.equal(inbox.reply(reply.id).state, "failed");
  assert.equal(inbox.reply(reply.id).error, "agent is blocked");
  assert.equal(inbox.item(itemId).state, "needs_attention");
  await world.react();
  assert.deepEqual(typed, [], "a failed reply waits for Retry");

  refuse(null);
  inbox.retry(reply.id);
  await world.react();
  assert.equal(typed.length, 1);
  assert.equal(inbox.reply(reply.id).state, "delivered");
});

test("a reply overtaken by a new revision while it is typed stays stale", async () => {
  const { inbox, world, reply, at, hold } = setup();
  let release!: () => void;
  hold(new Promise((r) => (release = r)));
  at("idle");
  const typing = world.react();
  inbox.submit({ session: emil, item: { type: "decide", title: "Which prior for the dark energy fit?", options: ["Flat: simple", "Informative: faster", "Both: compare"] } });
  release();
  await typing;
  assert.equal(inbox.reply(reply.id).state, "stale");
});

test("one thing at a time per agent: the founder's answer goes before a waiting message", async () => {
  const { inbox, world, typed, reply, at } = setup();
  at("idle");
  const agent = world.state().agents.find((a) => a.paneId === "w3:p1")!;
  world.messages.tell(agent.id, { text: "How is the fit going?" });
  await world.react();
  assert.equal(typed.length, 1);
  assert.match(typed[0]!.text, /^\[Review inbox\]/);
  assert.equal(inbox.reply(reply.id).state, "delivered");
  await world.react();
  assert.equal(typed.length, 2);
  assert.match(typed[1]!.text, /How is the fit going\?/);
});

test("a lead the office starts runs the inbox hook through --settings, unless its settings already do", () => {
  const config = mkdtempSync(join(tmpdir(), "claude-config-"));
  const worktree = mkdtempSync(join(tmpdir(), "lead-worktree-"));
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    const args = hookSettings(worktree);
    assert.equal(args[0], "--settings");
    const settings = JSON.parse(args[1]!) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    assert.deepEqual(Object.keys(settings.hooks).sort(), ["SessionStart", "Stop", "UserPromptSubmit"]);
    assert.match(settings.hooks.Stop![0]!.hooks[0]!.command, /^INBOX_URL='http:\/\/127\.0\.0\.1:\d+' '\/.*\/bin\/inbox' hook claude$/);

    writeFileSync(join(config, "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "inbox hook claude" }] }] } }));
    assert.deepEqual(hookSettings(worktree), [], "a second hook would hand each reply over twice");
    writeFileSync(join(config, "settings.json"), "{}");
    mkdirSync(join(worktree, ".claude"));
    writeFileSync(join(worktree, ".claude", "settings.local.json"), '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/x/bin/inbox hook claude"}]}]}}');
    assert.deepEqual(hookSettings(worktree), []);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
  }
});
