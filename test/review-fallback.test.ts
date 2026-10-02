import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewFallback } from "../src/server/review-fallback.ts";
import type { Work, WorldAgent } from "../src/shared/types.ts";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "projector-fallback-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "checkout"); mkdirSync(cwd);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const write = (path: string, text = Array.from({ length: 80 }, (_, i) => `const beat${i} = ${i};`).join("\n")) => writeFileSync(join(cwd, path), text);
  git("init", "-b", "main"); git("config", "user.name", "Projector test"); git("config", "user.email", "projector@example.test");
  write("base.ts"); git("add", "."); git("commit", "-m", "base"); git("switch", "-c", "review");
  return { root, cwd, git, write };
}

test("viewers and fresh server instances agree within a slot; windows rotate without agent events", (t) => {
  const { cwd, git, write } = fixture(t);
  write("changed.ts"); git("add", "."); git("commit", "-m", "review");
  const one = new ReviewFallback(), two = new ReviewFallback();
  const first = one.excerpt(cwd, "review-42", 40_000)!;
  assert.deepEqual(first, one.excerpt(cwd, "review-42", 59_999));
  assert.deepEqual(first, two.excerpt(cwd, "review-42", 45_000));
  assert.equal(first.path, "changed.ts"); assert.equal(first.lines.length, 12);
  mkdirSync(join(cwd, "nested"));
  assert.deepEqual(first, two.excerpt(join(cwd, "nested"), "review-42", 45_000), "agent cwd may be below checkout root");
  const windows = new Set(Array.from({ length: 10 }, (_, i) => one.excerpt(cwd, "review-42", i * 20_000)!.startLine));
  assert.ok(windows.size > 1);
  assert.ok(new Set(["a", "b", "c", "d"].map((id) => one.excerpt(cwd, id, 40_000)!.startLine)).size > 1);
});

test("branch diff uses the merge base, not new default-branch changes; dirty and staged files also win", (t) => {
  const { cwd, git, write } = fixture(t);
  git("switch", "main"); write("main-only.ts"); git("add", "."); git("commit", "-m", "default moved"); git("switch", "review");
  write("branch.ts"); git("add", "."); git("commit", "-m", "branch changed");
  const fallback = new ReviewFallback();
  assert.equal(fallback.excerpt(cwd, "id", 0)?.path, "branch.ts");
  write("branch.ts", "const password = 'withheld';");
  write("base.ts", "export const uncommitted = true;");
  assert.equal(fallback.excerpt(cwd, "id", 10_000)?.path, "base.ts");
  git("add", "base.ts");
  assert.equal(fallback.excerpt(cwd, "id", 20_000)?.path, "base.ts");
  git("restore", "--staged", "base.ts"); git("restore", "base.ts");
  write("new file.ts", "export const fresh = true;");
  assert.equal(fallback.excerpt(cwd, "id", 30_000)?.path, "new file.ts");
});

test("a sparse safe source does not leave the projector blank when its chosen window is whitespace", (t) => {
  const { cwd, write } = fixture(t);
  write("sparse.ts", "\n".repeat(100) + "export const last = true;");
  for (let i = 0; i < 10; i++) {
    const excerpt = new ReviewFallback().excerpt(cwd, String(i), 0)!;
    assert.equal(excerpt.path, "sparse.ts");
    assert.ok(excerpt.lines.some((line) => line.includes("export const")));
  }
});

test("remote default branch is preferred even when named neither main nor master", (t) => {
  const { cwd, git, write } = fixture(t);
  write("already-default.ts"); git("add", "."); git("commit", "-m", "default point");
  git("update-ref", "refs/remotes/origin/trunk", "HEAD"); git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  write("review-only.ts"); git("add", "."); git("commit", "-m", "review point");
  for (let i = 0; i < 10; i++) assert.equal(new ReviewFallback().excerpt(cwd, String(i), 0)?.path, "review-only.ts");
});

test("unsafe changed files fall through to safe tracked code, and safety never expires with the cache", (t) => {
  const { root, cwd, git, write } = fixture(t);
  mkdirSync(join(cwd, ".hidden")); mkdirSync(join(cwd, "credentials"));
  for (const path of [".hidden/ok.ts", "credentials/ok.ts", "secret.ts", "notes.md"]) write(path, "not projected");
  write("binary.ts", "a\0b"); write("large.ts", "// x\n".repeat(40_000));
  write("ordinary.ts", 'const api_key = "no";'); write("opaque.ts", `// ${"a".repeat(50)}`);
  writeFileSync(join(root, "outside.ts"), "export const outside = true;");
  symlinkSync(join(root, "outside.ts"), join(cwd, "linked.ts"));
  symlinkSync(join(cwd, ".hidden/ok.ts"), join(cwd, "alias.ts"));
  git("add", "."); git("commit", "-m", "unsafe changes");
  const fallback = new ReviewFallback();
  for (let i = 0; i < 8; i++) assert.equal(fallback.excerpt(cwd, String(i), 0)?.path, "base.ts");
  write("base.ts", "const authorization = 'no';");
  assert.equal(fallback.excerpt(cwd, "a", 1), null, "contents rechecked even with cached names");
  assert.equal(fallback.excerpt(null, "a", 0), null);
  assert.equal(fallback.excerpt(join(root, "missing"), "a", 0), null);
});

test("review state chooses the reviewed checkout; real helper reads win without git or invented activity", (t) => {
  const { cwd } = fixture(t);
  const agent: WorldAgent = { id: "lead", name: "Lead", identity: "lead", harness: "manual", cwd, project: null, branch: null, status: "working", title: null, paneId: null, taskIds: [], teamId: "reviewers", role: "lead", waitingOnYou: false, doing: null, helpers: [], model: null, sessionName: null, ran: true };
  const author = { ...agent, id: "author", teamId: "authors" };
  const work: Work = { id: "w", title: "w", summary: "", fromAgentId: "author", fromTeamId: "authors", toTeamId: "reviewers", state: "in_review", reviewerId: null, notes: "", round: 1, createdAt: "", updatedAt: "" };
  const fallback = new ReviewFallback();
  assert.equal(fallback.forAgent(agent, [agent], [], [], 0), null);
  const reviewer = { ...agent, cwd: "/not-the-reviewed-checkout" };
  assert.equal(fallback.forAgent(reviewer, [reviewer, author], [work], [], 0)?.path, "base.ts");
  assert.deepEqual(reviewer.helpers, [], "a fallback isn't a helper event");
  assert.equal(fallback.forAgent(reviewer, [reviewer, author], [{ ...work, state: "accepted" }], [], 0), null);
  assert.equal(fallback.forAgent(reviewer, [reviewer, author], [{ ...work, reviewerId: "someone-else" }], [], 0), null);
  agent.helpers = [{ id: "h", type: "code-reviewer", startedAt: "" }];
  assert.equal(fallback.forAgent(agent, [agent], [], [], 0)?.path, "base.ts");
  const reported = { path: "real-read.ts", startLine: 3, lines: ["read by helper"], viewedAt: 1 };
  agent.helpers[0]!.excerpt = reported;
  let gitCalls = 0;
  const noGit = new ReviewFallback(() => { gitCalls++; return ""; });
  assert.deepEqual(noGit.forAgent(agent, [agent], [], [], 0), reported);
  assert.equal(gitCalls, 0, "a real read must not run git");
  assert.equal(fallback.forAgent({ ...agent, status: "offline" }, [agent], [], [], 0), null);
  agent.helpers = [{ id: "h", type: "builder", startedAt: "", excerpt: reported }];
  assert.equal(fallback.forAgent(agent, [agent], [], [], 0), null, "not an ordinary helper's source");
});

test("a quiet review requests one display-only refresh at the next slot, not one per viewer", (t) => {
  const { cwd } = fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let redraws = 0;
  const fallback = new ReviewFallback(undefined, () => { redraws++; });
  fallback.excerpt(cwd, "a", 39_990); fallback.excerpt(cwd, "a", 39_991);
  t.mock.timers.tick(9); assert.equal(redraws, 0);
  t.mock.timers.tick(1); assert.equal(redraws, 1);
  t.mock.timers.tick(60_000); assert.equal(redraws, 1, "does not self-poll after viewers leave");
});

test("git lists are cached briefly including failures, but refreshed to see changed candidates", (t) => {
  const { cwd, git, write } = fixture(t);
  let calls = 0;
  const fallback = new ReviewFallback((_cwd, args) => { calls++; return git(...args); });
  assert.equal(fallback.excerpt(cwd, "a", 0)?.path, "base.ts");
  const initial = calls;
  write("new.ts");
  assert.equal(fallback.excerpt(cwd, "b", 9999)?.path, "base.ts"); assert.equal(calls, initial);
  assert.equal(fallback.excerpt(cwd, "b", 10_000)?.path, "new.ts"); assert.ok(calls > initial);
  let failures = 0;
  const missing = new ReviewFallback(() => { failures++; throw Error("gone"); });
  assert.equal(missing.excerpt(cwd, "a", 0), null); const count = failures;
  assert.equal(missing.excerpt(cwd, "b", 1), null); assert.equal(failures, count);
});
