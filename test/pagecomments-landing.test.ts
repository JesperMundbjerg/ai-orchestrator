// DESIGN "A page comment is fixed only once its commit is on the team's integration branch": a real temporary
// repository with a bare origin, a team whose checkout is a clone of it, and the office's own PageComments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { configureGit, isGitPending, resetGitCache } from "../src/server/gitcache.ts";
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

test("a fix committed off the integration branch stays working, waiting for dev, and turns fixed once it is merged and pushed", () => {
  const { checkout, comments, id } = setup();
  git(checkout, "checkout", "-q", "-b", "fix");
  const sha = commit(checkout, "fix.txt");
  git(checkout, "push", "-q", "origin", "fix");

  const marked = comments.setStatus(id, { status: "fixed", commit: sha.slice(0, 8), note: "Relabelled" });
  assert.equal(marked.status, "working", "the founder's page does not see it fixed yet");
  assert.deepEqual(marked.landing, { commit: sha, branch: "dev" });
  assert.equal(marked.note, "Relabelled");
  assert.equal(comments.checkLandings(), 1, "still waiting while the commit is only on its own branch");
  assert.equal(comments.get(id).status, "working");

  // Merged locally but not pushed: origin/dev does not have it, so it still waits.
  git(checkout, "checkout", "-q", "dev");
  git(checkout, "merge", "-q", "--ff-only", "fix");
  assert.equal(comments.checkLandings(), 1, "an unpushed merge is not on dev");

  const heard: string[] = [];
  comments.listeners.add((event) => heard.push(event.status));
  git(checkout, "push", "-q", "origin", "dev");
  assert.equal(comments.checkLandings(), 0);
  const fixed = comments.get(id);
  assert.equal(fixed.status, "fixed");
  assert.equal(fixed.landing, null);
  assert.equal(fixed.commit, sha);
  assert.deepEqual(heard, ["fixed"], "the page hears it turn fixed");
});

test("a fix already on origin/dev is fixed at once", () => {
  const { checkout, comments, id } = setup();
  const sha = commit(checkout, "fix.txt");
  git(checkout, "push", "-q", "origin", "dev");
  const marked = comments.setStatus(id, { status: "fixed", commit: sha, note: "Relabelled" });
  assert.equal(marked.status, "fixed");
  assert.equal(marked.landing, null);
});

test("fixed without a commit is refused for a team with an integration branch, naming --commit; working and declined are not", () => {
  const { comments, id } = setup();
  assert.throws(() => comments.setStatus(id, { status: "fixed", note: "Relabelled" }), (err: InboxError) => err.status === 400 && /--commit/.test(err.message) && /dev/.test(err.message));
  assert.throws(() => comments.setStatus(id, { status: "fixed", commit: "deadbeef", note: "Relabelled" }), (err: InboxError) => err.status === 400 && /no commit deadbeef/.test(err.message));
  assert.equal(comments.get(id).status, "delivered", "a refused fixed changes nothing");
  assert.equal(comments.setStatus(id, { status: "working" }).status, "working");
  assert.equal(comments.setStatus(id, { status: "declined", note: "Not a bug" }).status, "declined");
});

test("a team with no integration branch is fixed as before, with or without a commit", () => {
  const { comments, id } = setup({ repo: false });
  const out = comments.setStatus(id, { status: "fixed", commit: "ABC1234", note: "Relabelled" });
  assert.equal(out.status, "fixed");
  assert.equal(out.commit, "abc1234");
  assert.equal(out.landing, null);
  const other = setup({ repo: false });
  assert.equal(other.comments.setStatus(other.id, { status: "fixed", note: "Relabelled" }).status, "fixed");
});

test("with the office's non-blocking git, the landing is read in the background and turns fixed on a later look", async () => {
  configureGit({ nonblocking: true, waitMs: 0 });
  try {
    const { checkout, comments, id } = setup();
    git(checkout, "checkout", "-q", "-b", "fix");
    const sha = commit(checkout, "fix.txt");
    // The call-time check is a decision: it answers git_pending until it has read Git since it was asked.
    let marked;
    for (let i = 0; ; i++) {
      try { marked = comments.setStatus(id, { status: "fixed", commit: sha, note: "Relabelled" }); break; }
      catch (err) { if (!isGitPending(err) || i > 200) throw err; await err.settled; }
    }
    assert.equal(marked.status, "working");
    git(checkout, "checkout", "-q", "dev");
    git(checkout, "merge", "-q", "--ff-only", "fix");
    git(checkout, "push", "-q", "origin", "dev");
    // Each look answers from what was read before and refreshes it in the background; it never runs git in line.
    const deadline = Date.now() + 15_000;
    while (comments.get(id).status !== "fixed" && Date.now() < deadline) { comments.checkLandings(); await new Promise((r) => setTimeout(r, 100)); }
    assert.equal(comments.get(id).status, "fixed");
  } finally {
    configureGit({ nonblocking: false, waitMs: 150 });
    resetGitCache();
  }
});
