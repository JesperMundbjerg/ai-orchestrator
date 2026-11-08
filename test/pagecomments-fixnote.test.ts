// DESIGN "A page comment is fixed only once its commit is on the team's integration branch" (the fix note): a real temporary
// repository with a bare origin, a team whose checkout is a clone of it, and the office's own PageComments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { InboxError } from "../src/server/inbox.ts";
import { PageComments } from "../src/server/pagecomments.ts";
import type { Message, WorldState } from "../src/shared/types.ts";

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function commit(cwd: string, file: string): string {
  writeFileSync(join(cwd, file), `${file}\n`);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", file);
  return git(cwd, "rev-parse", "HEAD");
}

/** A clone on dev with a bare origin, and an office whose one team works in it (or in no repository at all). */
function setup(options: { repo?: boolean } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "inbox-landing-")));
  const origin = join(dir, "origin.git");
  const checkout = join(dir, "checkout");
  git(dir, "init", "-q", "--bare", "-b", "dev", origin);
  git(dir, "clone", "-q", origin, checkout);
  git(checkout, "checkout", "-q", "-b", "dev");
  commit(checkout, "base.txt");
  git(checkout, "push", "-q", "origin", "dev");
  const team = { id: "t1", name: "Cosmology", path: options.repo === false ? null : checkout, worktrees: [] };
  const state = { teams: [team], agents: [{ id: "a1", teamId: "t1", role: "lead", cwd: options.repo === false ? null : checkout, name: "Lead", status: "idle" }] } as unknown as WorldState;
  const db = openDatabase(":memory:");
  const comments = new PageComments(db, {
    state: () => state,
    instruct: () => ({ id: "m1" }) as Message,
    message: () => ({ id: "m1", deliveries: [{ state: "delivered", agentId: "a1" }] }) as unknown as Message,
  }, join(dir, "page-comments.json"), () => new Date(), { landingPollMs: 0 });
  const sent = comments.enqueue("t1", { text: "The orbit label is wrong." });
  comments.sync();
  assert.equal(comments.get(sent.id).status, "delivered");
  return { checkout, comments, id: sent.id };
}

const err = (status: number, code: string, pattern: RegExp) => (e: unknown) => e instanceof InboxError && e.status === status && (e as InboxError & { code?: string }).code === code && pattern.test(e.message);

test("fixed without a note is refused, naming --note, and changes nothing", () => {
  for (const repo of [false, true]) {
    const { checkout, comments, id } = setup({ repo });
    const sha = commit(checkout, "fix.txt");
    git(checkout, "push", "-q", "origin", "dev");
    const input = repo ? { status: "fixed" as const, commit: sha } : { status: "fixed" as const };
    assert.throws(() => comments.setStatus(id, input), err(400, "note_required", /--note/));
    assert.throws(() => comments.setStatus(id, { ...input, note: "   \n " }), err(400, "note_required", /--note/));
    assert.equal(comments.get(id).status, "delivered");
  }
});

test("a fix note over 120 characters is refused with the limit; 120 is fine", () => {
  const { comments, id } = setup({ repo: false });
  assert.throws(() => comments.setStatus(id, { status: "fixed", note: "x".repeat(121) }), err(400, "note_too_long", /120/));
  assert.equal(comments.get(id).status, "delivered");
  const out = comments.setStatus(id, { status: "fixed", note: "x".repeat(120) });
  assert.equal(out.note, "x".repeat(120));
});

test("the fix note is one trimmed line, stored with the fix, replaces an earlier note and goes in the event", () => {
  const { comments, id } = setup({ repo: false });
  comments.setStatus(id, { status: "working", note: "looking" });
  const heard: Array<{ status: string; note: string | null }> = [];
  comments.listeners.add((event) => heard.push({ status: event.status, note: event.note }));
  const out = comments.setStatus(id, { status: "fixed", note: "  Packets now fly inside\n  a faint cone toward Earth.  " });
  assert.equal(out.note, "Packets now fly inside a faint cone toward Earth.");
  assert.equal(comments.get(id).note, out.note);
  assert.deepEqual(heard, [{ status: "fixed", note: out.note }]);
  assert.equal(comments.setStatus(id, { status: "fixed", note: "Packets now fly inside a faint cone toward Earth." }).note, out.note, "repeating the same close is fine");
});

test("a note on a fix that waits for dev is kept while it waits and when it turns fixed", () => {
  const { checkout, comments, id } = setup();
  git(checkout, "checkout", "-q", "-b", "fix");
  const sha = commit(checkout, "fix.txt");
  git(checkout, "push", "-q", "origin", "fix");
  assert.throws(() => comments.setStatus(id, { status: "fixed", commit: sha }), err(400, "note_required", /--note/));
  const waiting = comments.setStatus(id, { status: "fixed", commit: sha, note: "Moved the label below the chart." });
  assert.equal(waiting.status, "working");
  assert.equal(waiting.note, "Moved the label below the chart.");
  git(checkout, "checkout", "-q", "dev");
  git(checkout, "merge", "-q", "--ff-only", "fix");
  git(checkout, "push", "-q", "origin", "dev");
  assert.equal(comments.checkLandings(), 0);
  const fixed = comments.get(id);
  assert.equal(fixed.status, "fixed");
  assert.equal(fixed.note, "Moved the label below the chart.");
});

test("an already fixed comment without a note is left as it is", () => {
  const { comments, id } = setup({ repo: false });
  comments.setStatus(id, { status: "fixed", note: "Reworded." });
  assert.equal(comments.setStatus(id, { status: "fixed" }).note, "Reworded.");
});
