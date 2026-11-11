// One list of what the founder must act on among page comments (shared/awaiting.ts, GET /api/page-comments/awaiting):
// fixed ones to judge, sent-back ones he waits on or may release without. A release gate blocks on exactly this list,
// so nothing that blocks a release is missing from the page (DESIGN "Still wrong reopens the same comment").
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/server/db.ts";
import { createInboxServer } from "../src/server/http.ts";
import { Inbox } from "../src/server/inbox.ts";
import { PageComments } from "../src/server/pagecomments.ts";
import { World, type LiveAgent } from "../src/server/world.ts";
import { awaitingFounder, type AwaitingEntry } from "../src/shared/awaiting.ts";
import type { PageComment } from "../src/shared/pagecomments.ts";

let nextPort = 49_000 + Math.floor(Math.random() * 900);
const live: LiveAgent[] = [
  { paneId: "p1", harness: "pi", sessionId: "s1", cwd: "/lead", status: "idle", title: null, name: null },
  { paneId: "p2", harness: "pi", sessionId: "s2", cwd: "/lead2", status: "idle", title: null, name: null },
];
const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** An isolated office on a free port (never 4870), in memory, with a team whose lead is online. */
async function office(fn: (o: { base: string; comments: PageComments; db: DatabaseSync; team: string; other: string }) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "inbox-awaiting-"));
  const ui = join(dir, "dist");
  mkdirSync(join(ui, "embed"), { recursive: true });
  writeFileSync(join(ui, "index.html"), "<!doctype html><title>app</title>");
  const db = openDatabase(":memory:");
  const inbox = new Inbox(db, join(dir, "files"), { available: () => false, forSession: () => null, resolvePane: () => null });
  const none = async () => { throw new Error("not in this test"); };
  const world = new World(db, {
    available: () => true, live: () => live, prompt: async () => {}, notify: async () => {},
    createWorktree: none, startAgent: none, closePane: none, removeWorktree: none,
  }, () => inbox.state());
  world.messages.uploads = inbox.uploads;
  const comments = new PageComments(db, {
    state: () => world.state(), instruct: (id, input) => world.messages.instruct(id, input), message: (id) => world.messages.message(id),
  }, join(dir, "page-comments.json"), undefined, { landingPollMs: 0 });
  const team = await world.createTeam({ name: "Dispatch", standing: true });
  const other = await world.createTeam({ name: "Elsewhere", standing: true });
  const lead = world.state().agents.find((a) => a.cwd === "/lead")!;
  world.updateAgent(lead.id, { teamId: team.id, role: "lead" });
  world.updateAgent(world.state().agents.find((a) => a.cwd === "/lead2")!.id, { teamId: other.id, role: "lead" });
  let server!: ReturnType<typeof createInboxServer>;
  for (let tries = 0; ; tries++) {
    const port = nextPort++;
    server = createInboxServer(inbox, null, { port, staticDir: ui, world, pageComments: comments });
    const listening = server;
    const ok = await new Promise<boolean>((resolve) => {
      listening.once("error", (err: NodeJS.ErrnoException) => { if (err.code === "EADDRINUSE" && tries < 20) resolve(false); else throw err; });
      listening.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (ok) break;
  }
  try {
    await fn({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, comments, db, team: team.id, other: other.id });
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

const PAGE = "http://localhost:3000";
type Entry = AwaitingEntry & { comment: PageComment };

/** FysikLab's releaseBlockingFixes as it reads the office today (space-app fix-markers.mjs), synchronously over every comment. */
function legacyGate(all: PageComment[]): string[] {
  const byId = new Map(all.map((c) => [c.id, c]));
  const verifiedChain = (c: PageComment, seen: Set<string>): boolean => c.followUps.filter((id) => !seen.has(id) && seen.add(id)).some((id) => {
    const f = byId.get(id);
    return !!f && (f.verification === "verified" || f.status === "withdrawn" || (f.verification === "still-wrong" && verifiedChain(f, seen)));
  });
  return all.filter((c) => c.status === "fixed" && (c.verification === null || (c.verification === "still-wrong" && !verifiedChain(c, new Set([c.id]))))).map((c) => c.id);
}

/** Every kind of comment, through the office's own calls (legacy chains as stored before reopening). */
function seed(comments: PageComments, db: DatabaseSync, team: string, other: string) {
  const make = (text: string, t = team, origin = PAGE) => comments.enqueue(t, { text, page: { url: `${origin}/${text.replace(/\W+/g, "-")}` } }).id;
  const fix = (id: string, note = "Fixed") => comments.setStatus(id, { status: "fixed", note });
  comments.sync();
  const ids = {
    judge: make("judge"), verified: make("verified"), declined: make("declined"), withdrawn: make("withdrawn"), open: make("open"),
    reopened: make("reopened"), reworked: make("reworked"), asked: make("asked"), legacyOpen: make("legacy open"), legacyDone: make("legacy done"),
    legacyDeep: make("legacy deep"), elsewhere: make("elsewhere", other), otherOrigin: make("other origin", team, "http://127.0.0.1:5173"),
  };
  comments.sync();
  for (const id of [ids.judge, ids.verified, ids.reopened, ids.reworked, ids.asked, ids.legacyOpen, ids.legacyDone, ids.legacyDeep, ids.elsewhere, ids.otherOrigin]) fix(id);
  comments.verify(ids.verified, { verdict: "verified" });
  comments.setStatus(ids.declined, { status: "declined", note: "no" });
  comments.withdraw(ids.withdrawn);
  comments.verify(ids.reopened, { verdict: "still-wrong", note: "still off" });
  comments.verify(ids.reworked, { verdict: "still-wrong", note: "still off" });
  fix(ids.reworked, "Fixed again");
  comments.verify(ids.asked, { verdict: "still-wrong", note: "still off" });
  comments.ask(ids.asked, { question: "Which phone?" });
  // Legacy: still wrong opened a linked follow-up; a chain ends once some follow-up is verified (or withdrawn).
  const legacy = (id: string) => {
    const f = comments.enqueue(team, { text: `follow ${id}`, page: { url: `${PAGE}/f` }, followsUp: id, clientId: `still-wrong:${id}` }).id;
    db.prepare("UPDATE page_comments SET verification = 'still-wrong', verified_at = '2026-10-01T00:00:00.000Z' WHERE id = ?").run(id);
    comments.sync();
    return f;
  };
  const openFollow = legacy(ids.legacyOpen);
  const doneFollow = legacy(ids.legacyDone);
  fix(doneFollow);
  comments.verify(doneFollow, { verdict: "verified" });
  const deep1 = legacy(ids.legacyDeep);
  fix(deep1);
  const deep2 = legacy(deep1);
  return { ...ids, openFollow, doneFollow, deep1, deep2 };
}

const awaiting = async (base: string, q = "") => (await (await fetch(`${base}/api/page-comments/awaiting${q}`)).json()).awaiting as Entry[];
const by = (list: Entry[]) => new Map(list.map((e) => [e.comment.id, e]));

test("the list holds what to judge and what is sent back, with each one's action; nothing else", async () => {
  await office(async ({ base, comments, db, team, other }) => {
    const s = seed(comments, db, team, other);
    const list = by(await awaiting(base, `?team=${team}`));
    assert.deepEqual([...list.keys()].sort(), [s.judge, s.reworked, s.reopened, s.asked, s.legacyOpen, s.legacyDeep, s.deep1, s.otherOrigin].sort(), "the middle of a legacy chain is still wrong too");
    assert.deepEqual(list.get(s.judge)!.action, "judge");
    assert.deepEqual([list.get(s.judge)!.releaseWithout, list.get(s.judge)!.waitingOn], [false, null]);
    assert.equal(list.get(s.reworked)!.action, "judge", "reworked, then fixed: judge it again");
    assert.deepEqual(list.get(s.reopened)!.waitingOn, { kind: "fix", status: "working", landing: null });
    assert.equal(list.get(s.reopened)!.releaseWithout, true);
    assert.equal(list.get(s.reopened)!.since, list.get(s.reopened)!.comment.history[0]!.judgedAt);
    assert.equal(list.get(s.asked)!.action, "answer", "the lead's question is the founder's to answer");
    assert.deepEqual([list.get(s.asked)!.releaseWithout, list.get(s.asked)!.waitingOn], [true, { kind: "answer", question: "Which phone?" }]);
    assert.deepEqual(list.get(s.legacyOpen)!.waitingOn, { kind: "follow-up", id: s.openFollow, status: "delivered" });
    assert.deepEqual(list.get(s.legacyDeep)!.waitingOn, { kind: "follow-up", id: s.deep2, status: "delivered" }, "the open end of a longer chain");
    assert.deepEqual(list.get(s.deep1)!.waitingOn, { kind: "follow-up", id: s.deep2, status: "delivered" });
    for (const e of list.values()) assert.ok(e.action === "judge" || e.releaseWithout);
    const since = [...list.values()].map((e) => e.since);
    assert.deepEqual(since, [...since].sort(), "oldest first");

    assert.deepEqual((await awaiting(base, `?origin=${encodeURIComponent("http://127.0.0.1:5173")}`)).map((e) => e.comment.id), [s.otherOrigin], "by origin");
    assert.deepEqual((await awaiting(base, `?team=${other}`)).map((e) => e.comment.id), [s.elsewhere], "by team");
  });
});

test("every comment a release gate would block is on the list: the endpoint is the shared rule over every comment", async () => {
  await office(async ({ base, comments, db, team, other }) => {
    seed(comments, db, team, other);
    const all = comments.list({ limit: 500 }).comments;
    const listed = (await awaiting(base)).map((e) => e.comment.id).sort();
    assert.deepEqual(listed, awaitingFounder(all).map((e) => e.comment.id).sort(), "the office lists exactly what the shared function blocks on");
    for (const id of legacyGate(all)) assert.ok(listed.includes(id), `${id}, which today's gate blocks on, is on the list`);
    for (const c of all.filter((c) => c.history.length && !["fixed", "declined", "withdrawn"].includes(c.status))) assert.ok(listed.includes(c.id), `reopened ${c.id} blocks`);
  });
});

test("release-without records it on the comment and takes it off the list, until it is fixed again", async () => {
  await office(async ({ base, comments, db, team, other }) => {
    const s = seed(comments, db, team, other);
    const release = (id: string, body: unknown = {}) => fetch(`${base}/api/page-comments/${id}/release-without`, json(body));

    const judged = await release(s.judge);
    assert.equal(judged.status, 409, "judge it instead");
    assert.equal((await judged.json()).code, "not_releasable");
    assert.equal((await release(s.verified)).status, 409, "not awaiting him");

    const res = await release(s.reopened, { note: "Ship the chapter; the overlap can wait." });
    assert.equal(res.status, 200);
    const released = await res.json() as PageComment;
    assert.equal(released.status, "working", "the team still works on it");
    assert.equal(released.releasedWithout!.note, "Ship the chapter; the overlap can wait.");
    assert.match(released.releasedWithout!.at, /^\d{4}-/);
    assert.ok(!(await awaiting(base)).some((e) => e.comment.id === s.reopened), "off the list");
    assert.deepEqual((await (await release(s.reopened, { note: "again" })).json()).releasedWithout, released.releasedWithout, "the same call again changes nothing");

    assert.equal((await release(s.legacyOpen)).status, 200, "a legacy chain that can never end can be released");
    assert.ok(!(await awaiting(base)).some((e) => e.comment.id === s.legacyOpen));

    comments.setStatus(s.reopened, { status: "fixed", note: "Fixed after the release" });
    const back = by(await awaiting(base)).get(s.reopened)!;
    assert.equal(back.action, "judge", "a new fix is judged again");
    assert.deepEqual(back.comment.releasedWithout, released.releasedWithout, "the release stays recorded");
    comments.verify(s.reopened, { verdict: "still-wrong", note: "still" });
    assert.equal(by(await awaiting(base)).get(s.reopened)!.action, "waiting", "sent back again: waiting again");
  });
});

test("the shared rule reads legacy chains whose follow-up it cannot see as open", () => {
  const base = { teamId: "t", origin: null, status: "fixed" as const, verifiedAt: "2026-10-01T00:00:00Z", fixedAt: "2026-09-30T00:00:00Z", history: [], releasedWithout: null, question: null, landing: null, updatedAt: "2026-10-01T00:00:00Z" };
  const out = awaitingFounder([
    { ...base, id: "pc-000000000a", verification: "still-wrong", followUps: ["pc-000000000b"] },
    { ...base, id: "pc-000000000c", verification: "still-wrong", followUps: [] },
  ]);
  assert.deepEqual(out.map((e) => e.waitingOn), [{ kind: "follow-up", id: "pc-000000000b", status: null }, { kind: "follow-up", id: null, status: null }]);
});
