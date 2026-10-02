import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Inbox, type PresenceSource } from "../src/server/inbox.ts";
import { Messages } from "../src/server/messages.ts";
import type { WorldAgent, WorldState, WorldTeam } from "../src/shared/types.ts";

const absent: PresenceSource = { available: () => false, forSession: () => null, resolvePane: () => null };
const conflict = { status: 409, code: "replay_conflict" };
const now = () => new Date("2026-10-01T10:00:00Z");

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "api-replay-"));
  const file = join(dir, "inbox.db");
  let db = openDatabase(file);
  const teams = ["Build", "QA", "Empty"].map((name, n): WorldTeam => ({
    id: `t${n}`, name, purpose: "", handsTo: n === 0 ? "t1" : null, path: null, branch: null,
    standing: true, worktrees: [], createdAt: now().toISOString(), status: "idle", blockedBy: [],
  }));
  const agents = ["Alma", "Basil", "Cora"].map((name, n): WorldAgent => ({
    id: `a${n}`, identity: `pi:/test/${n}`, name, harness: "pi", cwd: null, project: null, branch: null,
    status: "idle", title: null, paneId: `p${n}`, taskIds: [], teamId: n === 0 ? "t0" : "t1",
    role: n === 2 ? "member" : "lead", waitingOnYou: false, doing: null, helpers: [], model: null,
    sessionName: null, ran: true,
  }));
  for (const t of teams) db.prepare("INSERT INTO teams (id, name, standing, created_at) VALUES (?, ?, 1, ?)").run(t.id, t.name, t.createdAt);
  for (const a of agents) db.prepare("INSERT INTO world_agents (id, identity, name, team_id, role, first_seen_at) VALUES (?, ?, ?, ?, ?, ?)").run(a.id, a.identity, a.name, a.teamId, a.role, now().toISOString());
  const state: WorldState = { agents, teams, messages: [], withFounder: [], work: [], repositories: [], herdr: "unavailable" };
  let notifications = 0;
  const changed = () => { assert.equal(db.isTransaction, false, "observers see only committed operations"); notifications++; };
  let messages = new Messages(db, null, () => state, now, changed);
  let inbox = new Inbox(db, join(dir, "files"), absent, now);
  return {
    get db() { return db; }, get messages() { return messages; }, get inbox() { return inbox; },
    agents, state, get notifications() { return notifications; },
    reopen() { db.close(); db = openDatabase(file); messages = new Messages(db, null, () => state, now, changed); inbox = new Inbox(db, join(dir, "files"), absent, now); },
    close() { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("answer ids bind the item, revision, action, choice, text and images across SQLite reopen", () => {
  const f = fixture();
  try {
    const session = { harness: "manual" as const, sessionId: "s" };
    const item = (key: string) => f.inbox.submit({ session, item: { type: "decide", key, title: key, options: ["One", "Two"] } }).itemId;
    const a = item("A");
    const b = item("B");
    const input = { id: "answer-1", revision: 1, action: "choose" as const, choice: "a", text: "One" };
    const first = f.inbox.answer(a, input);
    f.reopen();
    assert.deepEqual(f.inbox.answer(a, { ...input, text: " One " }), first);
    for (const patch of [{ revision: 2 }, { action: "discuss" as const }, { choice: "b" }, { text: "Two" }, { images: ["not-an-upload"] }]) {
      assert.throws(() => f.inbox.answer(a, { ...input, ...patch }), conflict);
    }
    assert.throws(() => f.inbox.answer(b, input), conflict);
    assert.equal(f.inbox.item(b).state, "needs_attention");
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM replies").get()!.n, 1);
  } finally { f.close(); }
});

test("message keys bind sender, recipient, operation and normalized content, not just clientId", () => {
  const f = fixture();
  try {
    const [alma, basil, cora] = f.agents;
    const input = { to: basil!.name, text: "Review the patch", clientId: "say-1" };
    const first = f.messages.say(alma!, input);
    f.reopen();
    assert.equal(f.messages.say(alma!, { ...input, to: " BASIL ", text: " Review the patch " }).id, first.id);
    assert.throws(() => f.messages.say(cora!, input), conflict);
    assert.throws(() => f.messages.say(alma!, { ...input, to: cora!.name }), conflict);
    assert.throws(() => f.messages.say(alma!, { ...input, text: "Do something else" }), conflict);
    assert.throws(() => f.messages.tell(basil!.id, input), conflict);
    assert.throws(() => f.messages.instruct("t1", input), conflict);
    assert.throws(() => f.messages.handoff(alma!, { title: "Patch", summary: "Ready", to: "QA", clientId: input.clientId }), conflict);
    assert.equal(f.messages.list().length, 1);
  } finally { f.close(); }
});

test("founder sends and broadcasts fingerprint explicit selection; exact retries keep fixed recipients", () => {
  const f = fixture();
  try {
    const first = f.messages.tell("a1", { text: "Hello", clientId: "tell" });
    assert.equal(f.messages.tell("a1", { text: " Hello ", clientId: "tell" }).id, first.id);
    assert.throws(() => f.messages.tell("a2", { text: "Hello", clientId: "tell" }), conflict);
    assert.throws(() => f.messages.tell("a1", { text: "Bye", clientId: "tell" }), conflict);
    assert.throws(() => f.messages.tell("a1", { text: "Hello", images: ["image"], clientId: "tell" }), conflict);
    const instruction = f.messages.instruct("t1", { text: "Review", clientId: "instruct" });
    assert.equal(f.messages.instruct("t1", { text: "Review", clientId: "instruct" }).id, instruction.id);
    assert.throws(() => f.messages.instruct("t0", { text: "Review", clientId: "instruct" }), conflict);
    const input = { text: "Plan", clientId: "broadcast", leadIds: ["a0", "a1", "a0"] };
    const broadcast = f.messages.tellAllLeads(input).message;
    assert.equal(f.messages.tellAllLeads({ ...input, leadIds: ["a1", "a0"] }).message.id, broadcast.id);
    assert.throws(() => f.messages.tellAllLeads({ ...input, leadIds: ["a1"] }), conflict);
    assert.throws(() => f.messages.tellAllLeads({ ...input, leadIds: undefined }), conflict);
    f.state.agents[1]!.role = "member";
    assert.deepEqual(f.messages.tellAllLeads(input).message.deliveries, broadcast.deliveries, "replay does not recalculate recipients");
  } finally { f.close(); }
});

test("unverifiable legacy message ids fail safely instead of acknowledging changed intent", () => {
  const f = fixture();
  try {
    const input = { text: "Hello", clientId: "old" };
    f.messages.tell("a1", input);
    f.db.exec("UPDATE messages SET replay_scope = NULL, replay_fingerprint = NULL");
    assert.throws(() => f.messages.tell("a1", input), conflict);
    assert.throws(() => f.messages.tell("a2", { ...input, text: "Another" }), conflict);
  } finally { f.close(); }
});

test("empty handoff recipients leave no work or replay receipt; the same id succeeds after repair", () => {
  const f = fixture();
  try {
    const input = { title: "Patch", summary: "Ready", to: "Empty", clientId: "handoff" };
    for (let i = 0; i < 2; i++) assert.throws(() => f.messages.handoff(f.agents[0]!, input), /nobody is on Empty/);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM work").get()!.n, 0);
    assert.equal(f.messages.list().length, 0);
    assert.equal(f.notifications, 0);
    f.state.agents[1]!.teamId = "t2";
    const first = f.messages.handoff(f.agents[0]!, input);
    assert.equal(f.messages.handoff(f.agents[0]!, input).message.id, first.message.id);
    assert.equal(f.notifications, 1);
  } finally { f.close(); }
});

for (const kind of ["message", "delivery"]) {
  test(`handoff creation, verdict and re-handoff roll back on a failed ${kind} insertion`, () => {
    const f = fixture();
    const reject = () => f.db.exec(kind === "message"
      ? "CREATE TRIGGER reject_insert BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'injected failure'); END"
      : "CREATE TRIGGER reject_insert BEFORE INSERT ON message_deliveries BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    const repair = () => f.db.exec("DROP TRIGGER reject_insert");
    try {
      const input = { title: "Patch", summary: "Ready", to: "QA", clientId: "handoff" };
      reject();
      assert.throws(() => f.messages.handoff(f.agents[0]!, input), /injected failure/);
      assert.equal(f.db.prepare("SELECT count(*) AS n FROM work").get()!.n, 0);
      assert.equal(f.messages.list().length, 0);
      assert.equal(f.notifications, 0);
      repair();
      const sent = f.messages.handoff(f.agents[0]!, input);
      reject();
      const review = { work: sent.work.id, verdict: "changes", notes: "Fix it", clientId: "review", round: 1 };
      assert.throws(() => f.messages.review(f.agents[1]!, review), /injected failure/);
      assert.equal(f.messages.workById(sent.work.id).state, "in_review");
      assert.equal(f.messages.list().length, 1);
      assert.equal(f.notifications, 1);
      repair();
      const verdict = f.messages.review(f.agents[1]!, review);
      assert.equal(verdict.work.state, "changes_requested");
      reject();
      const again = { work: sent.work.id, summary: "Fixed", clientId: "round2" };
      assert.throws(() => f.messages.handoff(f.agents[0]!, again), /injected failure/);
      assert.deepEqual(f.messages.workById(sent.work.id), verdict.work);
      assert.equal(f.messages.list().length, 2);
      assert.equal(f.notifications, 2);
      repair();
      assert.equal(f.messages.handoff(f.agents[0]!, again).work.round, 2);
      assert.equal(f.notifications, 3);
    } finally { f.close(); }
  });
}

test("verdict retries are bound to the review round and return the original round result", () => {
  const f = fixture();
  try {
    const handed = f.messages.handoff(f.agents[0]!, { title: "Patch", summary: "Ready", to: "QA", clientId: "handoff" });
    const input = { work: handed.work.id, verdict: "changes", notes: "Fix", round: 1, clientId: "verdict-1" };
    const reviewed = f.messages.review(f.agents[1]!, input);
    f.reopen();
    assert.deepEqual(f.messages.review(f.agents[1]!, input), reviewed);
    for (const patch of [{ round: 2 }, { verdict: "accept" }, { notes: "Another fix" }]) {
      assert.throws(() => f.messages.review(f.agents[1]!, { ...input, ...patch }), conflict);
    }
    assert.throws(() => f.messages.review(f.agents[2]!, input), conflict);
    const round2 = f.messages.handoff(f.agents[0]!, { work: handed.work.id, summary: "Fixed", clientId: "handoff2" });
    assert.equal(round2.work.round, 2);
    assert.deepEqual(f.messages.handoff(f.agents[0]!, { title: "Patch", summary: "Ready", to: "QA", clientId: "handoff" }), handed);
    assert.deepEqual(f.messages.review(f.agents[1]!, input), reviewed);
    assert.throws(() => f.messages.review(f.agents[1]!, { ...input, clientId: "new" }), /stale review round/);
    const legacy = { work: handed.work.id, verdict: "accept", notes: "Good" };
    const last = f.messages.review(f.agents[1]!, legacy);
    assert.deepEqual(f.messages.review(f.agents[1]!, legacy), last);
    assert.throws(() => f.messages.review(f.agents[1]!, { ...legacy, notes: "Different" }), { status: 409 });
    assert.equal(f.messages.list().length, 4);
  } finally { f.close(); }
});
