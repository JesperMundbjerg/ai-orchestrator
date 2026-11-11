// DESIGN "A page comment is fixed only once its commit is on the team's integration branch": fixedAt is the moment a
// comment turned fixed. A page shows a fix marker only if it loaded after that, so verification and edits must not move it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/server/db.ts";
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

/** A team in a clone of a bare origin on dev (or in no repository), a delivered comment, and a clock the test moves. */
function setup(options: { repo?: boolean } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "inbox-fixedat-")));
  const origin = join(dir, "origin.git");
  const checkout = join(dir, "checkout");
  git(dir, "init", "-q", "--bare", "-b", "dev", origin);
  git(dir, "clone", "-q", origin, checkout);
  git(checkout, "checkout", "-q", "-b", "dev");
  commit(checkout, "base.txt");
  git(checkout, "push", "-q", "origin", "dev");
  const path = options.repo === false ? null : checkout;
  const state = { teams: [{ id: "t1", name: "Cosmology", path, worktrees: [] }], agents: [{ id: "a1", teamId: "t1", role: "lead", cwd: path, name: "Lead", status: "idle" }] } as unknown as WorldState;
  let clock = Date.parse("2026-11-01T10:00:00Z");
  const tick = (minutes: number) => { clock += minutes * 60_000; };
  const db = openDatabase(":memory:");
  const comments = new PageComments(db, {
    state: () => state,
    instruct: () => ({ id: "m1" }) as Message,
    message: () => ({ id: "m1", deliveries: [{ state: "delivered", agentId: "a1" }] }) as unknown as Message,
  }, join(dir, "page-comments.json"), () => new Date(clock), { landingPollMs: 0 });
  const id = comments.enqueue("t1", { text: "The orbit label is wrong." }).id;
  comments.sync();
  return { checkout, comments, db, id, tick, now: () => new Date(clock).toISOString() };
}

test("a fix already on the branch sets fixedAt at that call, and the event carries it", () => {
  const { checkout, comments, id, tick, now } = setup();
  assert.equal(comments.get(id).fixedAt, null, "not fixed yet");
  const sha = commit(checkout, "fix.txt");
  git(checkout, "push", "-q", "origin", "dev");
  tick(5);
  const heard: Array<{ status: string; fixedAt: string | null }> = [];
  comments.listeners.add((event) => heard.push(event));
  const fixed = comments.setStatus(id, { status: "fixed", commit: sha, note: "Relabelled" });
  assert.equal(fixed.fixedAt, now());
  assert.deepEqual(heard.map((e) => [e.status, e.fixedAt]), [["fixed", now()]]);
  assert.equal(comments.list({}).comments[0]!.fixedAt, now(), "the list carries it too");
});

test("a waiting landing gets fixedAt at the flip, not at the fixed call", () => {
  const { checkout, comments, id, tick, now } = setup();
  git(checkout, "checkout", "-q", "-b", "fix");
  const sha = commit(checkout, "fix.txt");
  const marked = comments.setStatus(id, { status: "fixed", commit: sha, note: "Relabelled" });
  assert.equal(marked.status, "working");
  assert.equal(marked.fixedAt, null, "marked, but not fixed: no time");
  tick(18);
  assert.equal(comments.checkLandings(), 1);
  assert.equal(comments.get(id).fixedAt, null, "still waiting");
  git(checkout, "checkout", "-q", "dev");
  git(checkout, "merge", "-q", "--ff-only", "fix");
  git(checkout, "push", "-q", "origin", "dev");
  tick(2);
  const heard: Array<string | null> = [];
  comments.listeners.add((event) => heard.push(event.fixedAt));
  assert.equal(comments.checkLandings(), 0);
  assert.equal(comments.get(id).status, "fixed");
  assert.equal(comments.get(id).fixedAt, now(), "the flip time, 20 minutes after the call");
  assert.deepEqual(heard, [now()]);
});

test("verification and later checks leave fixedAt alone while updatedAt moves", () => {
  const { comments, id, tick } = setup({ repo: false });
  const fixed = comments.setStatus(id, { status: "fixed", note: "Relabelled" });
  tick(30);
  const verified = comments.verify(id, { verdict: "verified" }).comment;
  assert.equal(verified.fixedAt, fixed.fixedAt);
  assert.notEqual(verified.updatedAt, fixed.updatedAt, "updatedAt is not the fix time");
  // The same fix repeated is a no-op and keeps the time.
  tick(5);
  assert.equal(comments.setStatus(id, { status: "fixed", note: "Relabelled" }).fixedAt, fixed.fixedAt);
});

test("still wrong reopens the comment: fixedAt is cleared on it and kept on the attempt; fixing again sets a new one", () => {
  const { comments, id, tick, now } = setup({ repo: false });
  const fixed = comments.setStatus(id, { status: "fixed", note: "Relabelled" });
  tick(10);
  const { comment, followUp } = comments.verify(id, { verdict: "still-wrong" });
  assert.equal(followUp, null, "no follow-up comment");
  assert.equal(comment.status, "working");
  assert.equal(comment.fixedAt, null);
  assert.equal(comment.history[0]!.fixedAt, fixed.fixedAt);
  tick(10);
  assert.equal(comments.setStatus(id, { status: "fixed", note: "Relabelled again" }).fixedAt, now());
});

test("leaving fixed clears fixedAt, and fixing again sets a new one", () => {
  const { comments, db, id, tick, now } = setup({ repo: false });
  comments.setStatus(id, { status: "fixed", note: "Relabelled" });
  tick(10);
  // Fixed is final through the API today; reopening is a status change the owning module makes through its own update.
  (comments as unknown as { update(id: string, fields: Record<string, string>): void }).update(id, { status: "working" });
  assert.equal(comments.get(id).fixedAt, null);
  assert.equal((db.prepare("SELECT fixed_at FROM page_comments WHERE id = ?").get(id) as { fixed_at: string | null }).fixed_at, null, "cleared in storage, not just hidden");
  tick(10);
  assert.equal(comments.setStatus(id, { status: "fixed", note: "Relabelled again" }).fixedAt, now());
});

test("a declined or working comment has no fixedAt", () => {
  const { comments, id } = setup({ repo: false });
  assert.equal(comments.setStatus(id, { status: "working" }).fixedAt, null);
  assert.equal(comments.setStatus(id, { status: "declined", note: "Not a bug" }).fixedAt, null);
});

test("migration 24 backfills fixed comments with their updatedAt and leaves the rest empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "inbox-fixedat-db-"));
  const file = join(dir, "inbox.db");
  const fresh = openDatabase(file);
  const row = (id: string, status: string, updated: string) => fresh.prepare(`INSERT INTO page_comments (id, team_id, text, page, status, attempts, fingerprint, created_at, updated_at)
    VALUES (?, 't', 'x', '{}', ?, 1, ?, '2026-10-01T00:00:00Z', ?)`).run(id, status, id, updated);
  row("pc-0000000001", "fixed", "2026-10-05T12:00:00Z");
  row("pc-0000000002", "working", "2026-10-06T12:00:00Z");
  fresh.exec("ALTER TABLE page_comments DROP COLUMN fixed_at; PRAGMA user_version = 23");
  fresh.close();
  const db = openDatabase(file);
  const at = (id: string) => (db.prepare("SELECT fixed_at FROM page_comments WHERE id = ?").get(id) as { fixed_at: string | null }).fixed_at;
  assert.equal(at("pc-0000000001"), "2026-10-05T12:00:00Z");
  assert.equal(at("pc-0000000002"), null);
  assert.ok(Number(db.prepare("PRAGMA user_version").get()!.user_version) >= 24);
  db.close();
});
