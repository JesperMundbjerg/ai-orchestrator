import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Inbox, type PresenceSource } from "../src/server/inbox.ts";
import { World, type AgentSource, type LiveAgent } from "../src/server/world.ts";
import type { SessionInput } from "../src/shared/types.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const ida: SessionInput = { harness: "claude", sessionId: "uuid-ida", cwd: "/repo/ida" };
const MINUTE = 60_000;

/** An office with Ida (the one who is busy) and Alma, whose herdr shows whatever `setStatus` says, and which records what it types. */
function setup() {
  const clock = { t: Date.parse("2026-09-30T10:00:00Z") };
  const db = openDatabase(":memory:");
  let status: LiveAgent["status"] = "working";
  const live = (): LiveAgent[] => [
    { paneId: "w3:p1", harness: "claude", sessionId: ida.sessionId!, cwd: ida.cwd!, status, title: null, name: null },
    { paneId: "w3:p2", harness: "pi", sessionId: "alma-session", cwd: "/repo/alma", status: "working", title: null, name: null },
  ];
  const presence: PresenceSource = {
    available: () => true,
    forSession: (harness, sessionId) => {
      const a = live().find((x) => x.harness === harness && x.sessionId === sessionId);
      return a ? { source: "herdr", paneId: a.paneId, status: a.status, name: null, title: null, seenAt: "" } : null;
    },
    resolvePane: () => null,
  };
  const now = () => new Date(clock.t);
  const inbox = new Inbox(db, join(mkdtempSync(join(tmpdir(), "batched-test-")), "files"), presence, now);
  const typed: Array<{ pane: string; text: string }> = [];
  let refuse: string | null = null;
  const none = async () => { throw new Error("not in this test"); };
  const source: AgentSource = {
    available: () => true,
    live,
    prompt: async (pane, text) => {
      if (refuse) throw new Error(refuse);
      typed.push({ pane, text });
    },
    notify: async () => {},
    createWorktree: none, startAgent: none, closePane: none, removeWorktree: none,
  };
  const world = new World(db, source, () => inbox.state(), now);
  world.messages.replies = inbox;
  world.messages.uploads = inbox.uploads;
  const agent = (name: string) => world.state().agents.find((a) => a.cwd === `/repo/${name}`)!;
  return {
    inbox, world, typed, clock, agent,
    setStatus: (next: LiveAgent["status"]) => void (status = next),
    refuse: (why: string | null) => void (refuse = why),
    minutesLater: (n: number) => void (clock.t += n * MINUTE),
  };
}

/** Ida is busy while Alma and the founder write to her over 42 minutes. */
function queueUp(o: ReturnType<typeof setup>) {
  const alma = o.agent("alma");
  const target = o.agent("ida");
  o.world.messages.say(alma, { to: target.name, text: "Can you look at the rail?" });
  o.minutesLater(30);
  o.world.messages.tell(target.id, { text: "Rail first, please" });
  o.minutesLater(10);
  o.world.messages.say(alma, { to: target.name, text: "Never mind the rail, the login matters more." });
  o.minutesLater(2);
  return target;
}

test("what queued up while an agent was busy is typed in one prompt, oldest first, each with its sender and age", async () => {
  const o = setup();
  const target = queueUp(o);
  const alma = o.agent("alma");
  await o.world.react();
  assert.equal(o.typed.length, 0, "not while it works");

  o.setStatus("idle");
  await o.world.react();
  assert.equal(o.typed.length, 1, "one prompt for all three");
  const text = o.typed[0]!.text;
  assert.match(text, /^3 messages arrived while you were busy; later ones may supersede earlier ones\. Reply once to what still matters\.\n\n/);
  const order = [`${alma.name}, 42 min ago:`, "The founder, 12 min ago:", `${alma.name}, 2 min ago:`].map((label) => text.indexOf(label));
  assert.ok(order.every((i) => i >= 0) && order[0]! < order[1]! && order[1]! < order[2]!, `oldest first, in: ${text}`);
  assert.match(text, /Can you look at the rail\?[\s\S]*Rail first, please[\s\S]*Never mind the rail/);
  assert.equal(text.match(/\(From the office\./g)?.length, 1, "the footer once");

  const states = o.world.state().messages.flatMap((m) => m.deliveries.filter((d) => d.agentId === target.id).map((d) => d.state));
  assert.deepEqual(states, ["delivered", "delivered", "delivered"]);
  await o.world.react();
  assert.equal(o.typed.length, 1, "typed once");
});

test("one waiting message is typed exactly as before, with no header or age", async () => {
  const o = setup();
  const target = o.agent("ida");
  o.world.messages.tell(target.id, { text: "Rail first, please" });
  o.minutesLater(20);
  o.setStatus("idle");
  await o.world.react();
  assert.equal(o.typed.length, 1);
  assert.match(o.typed[0]!.text, /^\[Message from the founder\]\n\nRail first, please\n\nAnswer the founder in one or two sentences: inbox say founder/);
  assert.doesNotMatch(o.typed[0]!.text, /min ago|arrived while you were busy/);
  assert.match(o.typed[0]!.text, /\n\(From the office\. `inbox team` shows your project and who else is here\.\)$/);
});

test("when the combined prompt fails they all fail together, and Retry sends them again", async () => {
  const o = setup();
  const target = queueUp(o);
  o.setStatus("idle");
  o.refuse("agent is asking something");
  await o.world.react();
  const deliveries = () => o.world.state().messages.flatMap((m) => m.deliveries.filter((d) => d.agentId === target.id).map((d) => ({ id: m.id, state: d.state, error: d.error })));
  assert.deepEqual(deliveries().map((d) => [d.state, d.error]), Array(3).fill(["failed", "agent is asking something"]));
  await o.world.react();
  assert.equal(o.typed.length, 0, "a failed delivery waits for Retry");

  o.refuse(null);
  for (const d of deliveries()) o.world.messages.retry(d.id, target.id);
  await o.world.react();
  assert.equal(o.typed.length, 1, "resent as one prompt");
  assert.match(o.typed[0]!.text, /^3 messages arrived/);
  assert.deepEqual(deliveries().map((d) => d.state), ["delivered", "delivered", "delivered"]);

  // Retrying just one sends just that one, as a single message.
  o.refuse("busy");
  o.world.messages.tell(target.id, { text: "One more" });
  await o.world.react();
  const failed = deliveries().find((d) => d.state === "failed")!;
  o.refuse(null);
  o.world.messages.retry(failed.id, target.id);
  await o.world.react();
  assert.equal(o.typed.length, 2);
  assert.match(o.typed[1]!.text, /^\[Message from the founder\]\n\nOne more/);
});

test("the founder's answer to something the agent asked is typed first, as its own prompt, then the messages together", async () => {
  const o = setup();
  o.setStatus("idle");
  const { itemId } = o.inbox.submit({ session: ida, item: { type: "decide", title: "Which prior?", options: ["Flat: simple", "Informative: faster"] } });
  o.inbox.answer(itemId, { revision: 1, action: "choose", choice: "a", text: "Flat." });
  const target = o.agent("ida");
  o.world.messages.tell(target.id, { text: "First note" });
  o.minutesLater(5);
  o.world.messages.tell(target.id, { text: "Second note" });

  await o.world.react();
  assert.equal(o.typed.length, 1);
  assert.match(o.typed[0]!.text, /^\[Review inbox\] Reply to your decide request "Which prior\?"/);
  assert.doesNotMatch(o.typed[0]!.text, /First note/);

  await o.world.react();
  assert.equal(o.typed.length, 2);
  assert.match(o.typed[1]!.text, /^2 messages arrived while you were busy/);
  assert.match(o.typed[1]!.text, /First note[\s\S]*Second note/);
});

test("images stay with their message, and a long queue keeps the newest in full and shrinks the older ones to a line", async () => {
  const o = setup();
  const target = o.agent("ida");
  const shot = o.inbox.uploads.save({ data: PNG.toString("base64") });
  const path = join(o.inbox.uploads.dir, shot.id);
  o.world.messages.tell(target.id, { text: "Look at this", images: [shot.id] });
  for (let i = 0; i < 5; i++) {
    o.minutesLater(1);
    o.world.messages.tell(target.id, { text: `Note ${i}: ${"detail ".repeat(200)}` });
  }
  o.world.messages.tell(target.id, { text: "Latest word" });
  o.setStatus("idle");
  await o.world.react();

  assert.equal(o.typed.length, 1);
  const text = o.typed[0]!.text;
  assert.match(text, /^7 messages arrived/);
  assert.ok(text.length < 12_000, `the prompt is capped, was ${text.length}`);
  assert.match(text, /The founder, just now:\n\[Message from the founder\]\n\nLatest word/, "the newest is in full");
  assert.match(text, /The founder, just now:\n\[Message from the founder\]\n\nNote 4: (detail ){190,}/, "so is the one before it");
  assert.ok(text.includes(`The founder, 5 min ago: Look at this Image: ${path}`), "the oldest is one line, its image beside it");
  assert.match(text, /The founder, 4 min ago: Note 0: (detail ){10,}[^\n]*…/, "an older one is cut short");
  assert.doesNotMatch(text, /Note 0: (detail ){30}/, "and not repeated in full");
  assert.deepEqual(o.world.state().messages.flatMap((m) => m.deliveries.map((d) => d.state)), Array(7).fill("delivered"));
});
