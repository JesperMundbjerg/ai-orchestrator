// DESIGN "Still wrong reopens the same comment": the founder's still-wrong verdict sends the same comment back to its
// team (working again, his note as the new instruction), keeps the attempt as history, and never opens a follow-up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { PageComments } from "../src/server/pagecomments.ts";
import type { Message, WorldState } from "../src/shared/types.ts";

/** A team without an integration branch (fixed is immediate), a lead who hears everything, and a clock the test moves. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "inbox-reopen-"));
  const state = { teams: [{ id: "t1", name: "Cosmology", path: null, worktrees: [] }], agents: [{ id: "a1", teamId: "t1", role: "lead", cwd: null, name: "Lead", status: "idle" }] } as unknown as WorldState;
  let clock = Date.parse("2026-11-01T10:00:00Z");
  const told: Array<{ text?: string; clientId?: string }> = [];
  let reachable = true;
  const db = openDatabase(":memory:");
  const comments = new PageComments(db, {
    state: () => state,
    instruct: (_team, input) => {
      if (!reachable) throw Object.assign(new Error("nobody on the team to give it to"), { status: 409 });
      told.push(input);
      return { id: `m${told.length}` } as Message;
    },
    message: (id) => ({ id, deliveries: [{ state: "delivered", agentId: "a1" }] }) as unknown as Message,
  }, join(dir, "page-comments.json"), () => new Date(clock), { landingPollMs: 0 });
  const id = comments.enqueue("t1", { text: "The orbit label is wrong.", page: { url: "http://localhost:3000/orbit" }, openUrl: "http://localhost:3000/orbit?step=2", kind: "bug" }).id;
  comments.sync();
  return { comments, db, id, told, tick: (min: number) => { clock += min * 60_000; }, now: () => new Date(clock).toISOString(), unreachable: () => { reachable = false; } };
}

test("still wrong reopens the same id, keeps the attempt in its history and tells the lead on that id", () => {
  const { comments, id, told, tick, now } = setup();
  comments.setStatus(id, { status: "working" });
  const fixed = comments.setStatus(id, { status: "fixed", note: "Relabelled", commit: "abc1234", url: "http://localhost:3000/orbit?step=2#label" });
  tick(5);
  const heard: string[] = [];
  comments.listeners.add((e) => heard.push(`${e.id}:${e.status}:${e.history.length}`));
  const { comment, followUp } = comments.verify(id, { verdict: "still-wrong", note: "It still overlaps the planet on phones." });

  assert.equal(followUp, null);
  assert.equal(comment.id, id);
  assert.deepEqual([comment.status, comment.verification, comment.verifiedAt, comment.fixedAt, comment.commit, comment.note], ["working", null, null, null, null, null]);
  assert.equal(comment.openUrl, "http://localhost:3000/orbit?step=2", "the fixer's url belonged to the attempt");
  assert.deepEqual(comment.followUps, [], "no follow-up comment is made");
  assert.equal(comments.list({}).comments.length, 1, "still one comment");
  assert.deepEqual(comment.history, [{
    commit: "abc1234", note: "Relabelled", url: "http://localhost:3000/orbit?step=2#label", fixedAt: fixed.fixedAt, by: null,
    verdict: "still-wrong", verdictNote: "It still overlaps the planet on phones.", judgedAt: now(),
  }]);
  assert.deepEqual(heard, [`${id}:working:1`], "the page hears it reopen");

  const message = told.at(-1)!;
  assert.equal(message.clientId, `page-comment:${id}:still-wrong:1`);
  assert.match(message.text!, new RegExp(`^\\[Page comment ${id} still wrong\\]`));
  assert.match(message.text!, /It still overlaps the planet on phones\./);
  assert.match(message.text!, /The orbit label is wrong\./, "the original comment comes with it");
  assert.match(message.text!, new RegExp(`inbox comment fixed ${id} --commit SHA`));

  // The same verdict again (a retried request) changes nothing and tells nobody twice.
  const sent = told.length;
  assert.equal(comments.verify(id, { verdict: "still-wrong", note: "It still overlaps the planet on phones." }).comment.history.length, 1);
  assert.equal(told.length, sent);
  assert.throws(() => comments.verify(id, { verdict: "verified" }), /not fixed/, "the next fix is what is judged");
});

test("a reworked comment is fixed and judged as before; each send-back adds one attempt", () => {
  const { comments, id, tick, now } = setup();
  comments.setStatus(id, { status: "fixed", note: "First try", commit: "aaaaaaa" });
  comments.verify(id, { verdict: "still-wrong", note: "no" });
  tick(3);
  const again = comments.setStatus(id, { status: "fixed", note: "Second try", commit: "bbbbbbb" });
  assert.deepEqual([again.status, again.fixedAt, again.note, again.commit], ["fixed", now(), "Second try", "bbbbbbb"]);
  assert.deepEqual(comments.list({ verification: ["none"] }).comments.map((c) => c.id), [id], "fixed and unjudged again");
  comments.verify(id, { verdict: "still-wrong" });
  const third = comments.setStatus(id, { status: "fixed", note: "Third try", commit: "ccccccc" });
  assert.deepEqual(third.history.map((a) => [a.note, a.commit, a.verdictNote]), [["First try", "aaaaaaa", "no"], ["Second try", "bbbbbbb", null]]);
  const ok = comments.verify(id, { verdict: "verified" }).comment;
  assert.deepEqual([ok.status, ok.verification, ok.note, ok.history.length], ["fixed", "verified", "Third try", 2]);
});

test("a reopened comment can be asked about, answered, declined or withdrawn like any working one", () => {
  const { comments, id } = setup();
  comments.setStatus(id, { status: "fixed", note: "Try" });
  comments.verify(id, { verdict: "still-wrong", note: "no" });
  assert.equal(comments.ask(id, { question: "Which phone?" }).status, "asked");
  assert.equal(comments.answer(id, { text: "iPhone SE" }).status, "working");
  assert.equal(comments.withdraw(id).status, "withdrawn");
  assert.equal(comments.get(id).history.length, 1, "history stays");
});

test("when nobody on the team can be told, still wrong changes nothing", () => {
  const { comments, id, unreachable } = setup();
  const fixed = comments.setStatus(id, { status: "fixed", note: "Try" });
  unreachable();
  assert.throws(() => comments.verify(id, { verdict: "still-wrong", note: "no" }), /nobody/);
  const after = comments.get(id);
  assert.deepEqual([after.status, after.verification, after.fixedAt, after.history.length], ["fixed", null, fixed.fixedAt, 0]);
});

test("old follow-up chains still read as before, and judging them makes no new follow-up", () => {
  const { comments, db, id } = setup();
  comments.setStatus(id, { status: "fixed", note: "Old fix" });
  // As stored before still wrong reopened comments: the verdict on the fixed comment and its linked follow-up.
  const follow = comments.enqueue("t1", { text: "Still wrong.", followsUp: id, clientId: `still-wrong:${id}` });
  db.prepare("UPDATE page_comments SET verification = 'still-wrong', verified_at = '2026-10-01T00:00:00.000Z' WHERE id = ?").run(id);
  const old = comments.get(id);
  assert.deepEqual([old.status, old.verification, old.followUps, comments.get(follow.id).followsUp], ["fixed", "still-wrong", [follow.id], id]);
  const again = comments.verify(id, { verdict: "still-wrong" });
  assert.equal(again.followUp!.id, follow.id, "the same follow-up, never another");
  assert.throws(() => comments.verify(id, { verdict: "verified" }), /verify its follow-up instead/);
  comments.sync();
  comments.setStatus(follow.id, { status: "fixed", note: "Fixed for real" });
  const reopened = comments.verify(follow.id, { verdict: "still-wrong", note: "nope" });
  assert.equal(reopened.followUp, null, "the follow-up reopens itself; the chain grows no further");
  assert.deepEqual(reopened.comment.followUps, []);
  assert.equal(comments.list({}).comments.length, 2);
});
