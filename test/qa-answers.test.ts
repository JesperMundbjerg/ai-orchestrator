import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/server/db.ts";
import { Inbox, InboxError, type PresenceSource } from "../src/server/inbox.ts";
import { AutoApprove } from "../src/server/autoapprove.ts";
import { Messages } from "../src/server/messages.ts";
import type { QaAgent } from "../src/server/qa.ts";
import { formatReply } from "../src/shared/agent-client.ts";
import type { SessionInput, SubmitInput, WorldState } from "../src/shared/types.ts";
import { needsYou } from "../src/ui/queue.ts";

const presence: PresenceSource = { available: () => false, forSession: () => null, resolvePane: () => null };
const asker = { harness: "manual" as const, sessionId: "asking-agent" };
const qaSession: SessionInput = { harness: "manual", sessionId: "qa-session" };
const crewSession: SessionInput = { harness: "manual", sessionId: "crew-session" };
const choices = ["Docked: draft stays visible", "Overlay: draft stays wide"];

/** An inbox with the QA agent Quinn and another crew member; no model, terminal or network is involved. */
function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "qa-answers-"));
  const db = openDatabase(join(dir, "inbox.sqlite"));
  const inbox = new Inbox(db, join(dir, "files"), presence);
  const learnings = join(dir, "learnings");
  const auto = new AutoApprove(db, inbox, learnings);
  const agents = new Map<string, QaAgent>([
    ["quinn", { id: "quinn", name: "Quinn", online: true, taskIds: [] }],
    ["crew", { id: "crew", name: "Ida", online: true, taskIds: [] }],
  ]);
  for (const a of agents.values()) db.prepare("INSERT INTO world_agents (id, identity, name, first_seen_at) VALUES (?, ?, ?, 'now')").run(a.id, a.id, a.name);
  const state = { agents: [], teams: [], messages: [], withFounder: [], work: [], repositories: [], herdr: "unavailable" } as unknown as WorldState;
  const messages = new Messages(db, null, () => state, () => new Date(), () => {});
  const office = {
    agent: (id: string) => agents.get(id) ?? null,
    resolve: (s: SessionInput) => {
      const found = s.sessionId === "qa-session" ? agents.get("quinn") : s.sessionId === "crew-session" ? agents.get("crew") : undefined;
      if (!found) throw new InboxError(404, "the office does not know this session");
      return found;
    },
    notice: (agentId: string, text: string) => void messages.notice(agentId, text),
  };
  auto.qa.office = office;
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const submit = (item: SubmitInput["item"], session: SessionInput = asker) => inbox.submit({ session, item });
  const notices = () => db.prepare(`SELECT m.text FROM messages m JOIN message_deliveries d ON d.message_id = m.id
    WHERE m.from_office = 1 AND d.agent_id = 'quinn'`).all().map((r) => String(r.text));
  const learn = (slug: string) => writeFileSync(join(learnings, `${slug}.md`), "---\ntype: Founder Answer Pattern\ntitle: t\n---\n# Pattern\n");
  const replies = () => Number(db.prepare("SELECT count(*) AS n FROM replies").get()!.n);
  return { dir, db, inbox, auto, agents, office, messages, submit, notices, learn, learnings, replies };
}

test("QA answers never answer by themselves: items wait for the QA agent, out of Needs you only while it is online", (t) => {
  const { inbox, auto, agents, submit, notices, replies } = setup(t);
  auto.setMode("qa", "quinn");
  const milestone = submit({ type: "milestone", title: "Ready" });
  const decision = submit({ type: "decide", title: "Layout?", options: choices, recommendation: "Docked" });
  const open = submit({ type: "decide", title: "What should the demo open on?" });
  for (const { itemId } of [milestone, decision, open]) assert.equal(inbox.item(itemId).state, "needs_attention");
  assert.equal(replies(), 0, "nothing is answered automatically");

  // The founder's view: what the QA agent has is marked and leaves Needs you; the header counts it.
  const marked = auto.qa.mark(inbox.state());
  assert.deepEqual(marked.items.filter((i) => i.withQa).map((i) => i.id).sort(), [milestone.itemId, decision.itemId, open.itemId].sort());
  assert.deepEqual(needsYou(marked, "all", null), []);
  assert.equal(auto.state().qa?.withQa, 3);
  assert.equal(auto.qa.markDetail(inbox.detail(open.itemId)).withQa, true);

  // One ordinary office notice, not one per item, until it has been typed.
  assert.equal(notices().length, 1);
  assert.match(notices()[0]!, /^QA: questions wait for you to decide for the founder\. .*inbox qa next/);

  // A sweep or a restart answers nothing either.
  auto.sweep();
  const restarted = new AutoApprove(auto["db"], inbox);
  restarted.qa.office = auto.qa.office;
  restarted.sweep();
  assert.equal(replies(), 0);

  // Offline: everything is the founder's again, and still nothing is answered.
  agents.get("quinn")!.online = false;
  assert.equal(needsYou(auto.qa.mark(inbox.state()), "all", null).length, 3);
  assert.equal(auto.state().qa?.withQa, 0);
  assert.equal(auto.state().qa?.online, false);
  agents.get("quinn")!.online = true;
  assert.equal(needsYou(auto.qa.mark(inbox.state()), "all", null).length, 0);

  // Missing from the office, or QA answers off: the founder's.
  agents.delete("quinn");
  assert.equal(needsYou(auto.qa.mark(inbox.state()), "all", null).length, 3);
  agents.set("quinn", { id: "quinn", name: "Quinn", online: true, taskIds: [] });
  auto.setMode("off");
  assert.equal(needsYou(auto.qa.mark(inbox.state()), "all", null).length, 3);
  assert.equal(replies(), 0);
});

test("only the chosen QA agent decides, through the ordinary answer path, marked as its own and never as the founder's", (t) => {
  const { inbox, auto, submit, learn } = setup(t);
  auto.setMode("qa", "quinn");
  learn("prefer-docked-layouts");
  const { itemId } = submit({ type: "decide", title: "Layout?", options: choices });
  assert.throws(() => auto.qa.next(crewSession), (e: InboxError) => e.status === 403 && /only the QA agent \(Quinn\)/.test(e.message));
  assert.throws(() => auto.qa.answer({ session: crewSession, item: itemId, revision: 1, action: "choose", choice: "a", reason: "x" }), (e: InboxError) => e.status === 403);

  const next = auto.qa.next(qaSession);
  assert.equal(next.item?.id, itemId);
  assert.equal(next.waiting, 1);
  assert.match(next.learnings, /learnings$/);

  assert.throws(() => auto.qa.answer({ session: qaSession, item: itemId, revision: 1, action: "choose", choice: "a", reason: "  " }), /reason/);
  assert.throws(() => auto.qa.answer({ session: qaSession, item: itemId, revision: 1, action: "choose", choice: "a", reason: "r", learnings: ["made-up"] }), /no learning "made-up"/);
  assert.throws(() => auto.qa.answer({ session: qaSession, item: itemId, revision: 1, action: "discuss", reason: "r" }), /decides/);
  assert.throws(() => auto.qa.answer({ session: qaSession, item: itemId, revision: 2, action: "choose", choice: "a", reason: "r" }), /stale/);

  const reply = auto.qa.answer({ session: qaSession, item: itemId, revision: 1, action: "choose", choice: "a", reason: "The founder keeps drafts visible.", learnings: ["prefer-docked-layouts"] });
  assert.equal(reply.id, `qa:${itemId}:1`);
  assert.equal(reply.answeredBy, "qa_agent");
  assert.equal(reply.state, "queued");
  assert.match(reply.text, /^QA agent Quinn, for the founder: The founder keeps drafts visible\. Learnings: prefer-docked-layouts\.$/);
  const event = inbox.detail(itemId).history.find((h) => h.kind === "reply.queued")!;
  assert.equal(event.actor, "system", "never logged as the founder");
  assert.deepEqual(event.detail.qaAgent, { id: "quinn", name: "Quinn" });
  assert.deepEqual(event.detail.learnings, ["prefer-docked-layouts"]);
  assert.equal(event.detail.autoApproved, undefined, "not Approve all either");

  // The asking agent is told plainly who answered.
  const pending = inbox.pendingReplies(asker, "pull")[0]!;
  assert.equal(pending.answeredBy, "qa_agent");
  const told = formatReply(pending);
  assert.match(told, /Answered by the office's QA agent on the founder's behalf, not by the founder\./);
  assert.doesNotMatch(told, /This is the user's answer/);
  assert.equal(auto.state().qa?.answered, 1);

  // Off: the QA agent decides nothing.
  const later = submit({ type: "milestone", title: "Later" });
  auto.setMode("off");
  assert.throws(() => auto.qa.answer({ session: qaSession, item: later.itemId, revision: 1, action: "accept", reason: "r" }), (e: InboxError) => e.status === 409 && /off/.test(e.message));
});

test("the QA agent answers open questions in words, and asks for changes with what to change", (t) => {
  const { auto, submit } = setup(t);
  auto.setMode("qa", "quinn");
  const open = submit({ type: "decide", title: "What should the demo open on?" });
  assert.throws(() => auto.qa.answer({ session: qaSession, item: open.itemId, revision: 1, action: "answer", reason: "r" }), /in words/);
  const reply = auto.qa.answer({ session: qaSession, item: open.itemId, revision: 1, action: "answer", text: "The pendulum.", reason: "It is the founder's usual opener." });
  assert.match(reply.text, /^The pendulum\.\n\nQA agent Quinn, for the founder: It is the founder's usual opener\. No learning applied\.$/);
  const tryIt = submit({ type: "try", title: "Try it", preview: "http://localhost:3000" });
  assert.throws(() => auto.qa.answer({ session: qaSession, item: tryIt.itemId, revision: 1, action: "request_changes", reason: "r" }), /what needs to change/);
  assert.equal(auto.qa.answer({ session: qaSession, item: tryIt.itemId, revision: 1, action: "request_changes", text: "The hint overlaps the slider.", reason: "r" }).action, "request_changes");
});

test("the QA agent's own questions stay with the founder", (t) => {
  const { inbox, auto, agents, submit } = setup(t);
  auto.setMode("qa", "quinn");
  const own = submit({ type: "milestone", title: "QA's own" }, qaSession);
  agents.get("quinn")!.taskIds = [own.taskId];
  assert.equal(auto.qa.next(qaSession).item, null);
  assert.throws(() => auto.qa.answer({ session: qaSession, item: own.itemId, revision: 1, action: "accept", reason: "r" }), (e: InboxError) => e.status === 409 && /own question/.test(e.message));
  assert.equal(needsYou(auto.qa.mark(inbox.state()), "all", null).length, 1);
});

test("the first answer wins: the founder first refuses the QA answer; the founder after the QA agent overrides it, marked", (t) => {
  const { inbox, auto, submit, learn } = setup(t);
  auto.setMode("qa", "quinn");
  learn("prefer-docked-layouts");
  const first = submit({ type: "decide", title: "Founder first", options: choices });
  inbox.answer(first.itemId, { revision: 1, action: "choose", choice: "b" });
  assert.throws(() => auto.qa.answer({ session: qaSession, item: first.itemId, revision: 1, action: "choose", choice: "a", reason: "r" }), (e: InboxError) => e.status === 409 && /already answered/.test(e.message));

  const second = submit({ type: "decide", title: "QA first", options: choices });
  auto.qa.answer({ session: qaSession, item: second.itemId, revision: 1, action: "choose", choice: "a", reason: "r", learnings: ["prefer-docked-layouts"] });
  const override = inbox.answer(second.itemId, { revision: 1, action: "choose", choice: "b", text: "Overlay this time." });
  assert.equal(override.answeredBy, "founder");
  assert.equal(override.overridesQa, true);
  const event = inbox.detail(second.itemId).history.filter((h) => h.kind === "reply.queued").at(-1)!;
  assert.equal(event.actor, "user");
  assert.equal(event.detail.overridesQa, true);
  const pending = inbox.pendingReplies(asker, "pull").find((p) => p.deliveryId === override.id)!;
  assert.match(formatReply(pending), /The founder overrides the QA agent's earlier answer to this revision: follow this one\./);
  assert.match(formatReply(pending), /This is the user's answer/);
  assert.deepEqual({ answered: auto.state().qa?.answered, overridden: auto.state().qa?.overridden }, { answered: 1, overridden: 1 });
});

test("the QA agent learns only from the founder's own answers, as they were asked, behind a cursor that only moves forward", (t) => {
  const { inbox, auto, submit, notices } = setup(t);
  // Approve all's answers are not the founder's preferences.
  auto.setMode("approve_all");
  submit({ type: "milestone", title: "Auto-accepted" });
  auto.setMode("off");
  const asked = submit({ type: "decide", title: "Layout?", options: choices, recommendation: "Docked", key: "layout" });
  inbox.answer(asked.itemId, { revision: 1, action: "choose", choice: "b", text: "Wide is better for drafts." });
  // The agent revises the item afterwards; the feed keeps what the founder actually answered.
  submit({ type: "decide", title: "Layout, again?", options: choices, key: "layout" });
  const qaItem = submit({ type: "milestone", title: "For QA" });
  auto.setMode("qa", "quinn");
  auto.qa.answer({ session: qaSession, item: qaItem.itemId, revision: 1, action: "accept", reason: "r" });
  const discussed = submit({ type: "milestone", title: "Talked about" });
  inbox.answer(discussed.itemId, { revision: 1, action: "discuss", text: "What about mobile?" });

  assert.throws(() => auto.qa.answers(crewSession), (e: InboxError) => e.status === 403);
  const feed = auto.qa.answers(qaSession, 1);
  assert.equal(feed.answers.length, 1);
  assert.equal(feed.remaining, 1);
  const a = feed.answers[0]!;
  assert.deepEqual([a.itemId, a.revision, a.title, a.recommendation, a.action, a.choice, a.choiceLabel, a.text, a.overrode],
    [asked.itemId, 1, "Layout?", "Docked", "choose", "b", choices[1]!.split(":")[0], "Wide is better for drafts.", null]);
  const all = auto.qa.answers(qaSession);
  assert.deepEqual(all.answers.map((x) => x.title), ["Layout?", "Talked about"], "no Approve-all or QA answers");
  assert.equal(auto.qa.next(qaSession).toLearn, 2);

  auto.qa.learned(qaSession, a.seq);
  assert.deepEqual(auto.qa.answers(qaSession).answers.map((x) => x.title), ["Talked about"]);
  assert.equal(auto.qa.learned(qaSession, 0).learnedThrough, a.seq, "the cursor never moves back");
  assert.throws(() => auto.qa.learned(qaSession, 10_000), /seq/);
  assert.match(notices().join("\n"), /founder answers wait for you to learn from/);
});

test("choosing QA answers needs an agent the office knows and prepares an empty OKF bundle without overwriting it", (t) => {
  const { auto, learnings } = setup(t);
  assert.throws(() => auto.setMode("qa"), /choose the agent/);
  assert.throws(() => auto.setMode("qa", "nobody"), (e: InboxError) => e.status === 404);
  assert.equal(auto.state().mode, "off");
  auto.setMode("qa", "quinn");
  assert.deepEqual({ mode: auto.state().mode, enabled: auto.state().enabled, agent: auto.state().qa?.agentName }, { mode: "qa", enabled: false, agent: "Quinn" });
  assert.match(readFileSync(join(learnings, "index.md"), "utf8"), /^---\nokf_version: "0\.2"\n---\n/);
  assert.ok(existsSync(join(learnings, "log.md")));
  writeFileSync(join(learnings, "index.md"), "kept");
  auto.setMode("off"); auto.setMode("qa");
  assert.equal(readFileSync(join(learnings, "index.md"), "utf8"), "kept");
});

test("migration keeps an Approve all that was on as Approve all, and off as off", (t) => {
  for (const enabled of [1, 0]) {
    const dir = mkdtempSync(join(tmpdir(), "qa-migration-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "inbox.sqlite");
    openDatabase(file).close();
    const raw = new DatabaseSync(file);
    raw.exec(`ALTER TABLE auto_approve DROP COLUMN mode; ALTER TABLE auto_approve DROP COLUMN qa_agent_id;
      ALTER TABLE auto_approve DROP COLUMN qa_learned_through; ALTER TABLE replies DROP COLUMN answered_by;
      UPDATE auto_approve SET enabled = ${enabled}; PRAGMA user_version = 11;`);
    raw.close();
    const db = openDatabase(file);
    const inbox = new Inbox(db, join(dir, "files"), presence);
    const auto = new AutoApprove(db, inbox);
    assert.equal(auto.state().mode, enabled ? "approve_all" : "off");
    assert.equal(auto.state().enabled, Boolean(enabled));
    const { itemId } = inbox.submit({ session: asker, item: { type: "milestone", title: "After the upgrade" } });
    assert.equal(inbox.item(itemId).state, enabled ? "answer_queued" : "needs_attention");
    db.close();
  }
});
