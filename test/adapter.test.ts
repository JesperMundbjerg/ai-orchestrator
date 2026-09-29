import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Adapters, parseAdapter } from "../src/server/adapter.ts";
import { openDatabase } from "../src/server/db.ts";
import { Inbox, type PresenceSource } from "../src/server/inbox.ts";
import { World, type AgentSource, type LiveAgent } from "../src/server/world.ts";

const ROOT = "/work/space-shuttle";

const FYSIKLAB = {
  project: "fysiklab",
  integrationBranch: "dev",
  preview: { base: "http://localhost:3000" },
  comments: { kinds: ["wrong", "taste"], anchor: ["sim", "chapterId", "step"], charter: "docs/fix-comments-charter.md", leaseMinutes: 45 },
  decisions: { maxQuestion: 400 },
  checks: { changed: "npm --prefix space-app run check:changed" },
  reviewers: { perSlice: ["architecture-reviewer"], cap: "once each per slice" },
  land: { mode: "ff-or-cherry-pick", publish: "git push origin dev" },
  lanes: [
    { name: "einstein", worktree: ".claude/worktrees/einstein", harness: "pi", model: "openai-codex/gpt-6-astra" },
    { name: "mission-control", agent: "dispatch-mission-control", role: "router" },
  ],
};

test("a project's orchestrator.json is read with its lanes' worktrees resolved against the main checkout", () => {
  const { adapter, problems } = parseAdapter(JSON.stringify(FYSIKLAB), ROOT, "space-shuttle");
  assert.deepEqual(problems, []);
  assert.equal(adapter?.project, "fysiklab");
  assert.equal(adapter?.integrationBranch, "dev");
  assert.equal(adapter?.comments?.leaseMinutes, 45);
  assert.deepEqual(adapter?.lanes, [
    { name: "einstein", worktree: "/work/space-shuttle/.claude/worktrees/einstein", agent: null, harness: "pi", model: "openai-codex/gpt-6-astra", role: null },
    { name: "mission-control", worktree: null, agent: "dispatch-mission-control", harness: null, model: null, role: "router" },
  ]);
});

test("an empty adapter names the project after the repository", () => {
  const { adapter } = parseAdapter("{}", ROOT, "Space Shuttle");
  assert.equal(adapter?.project, "space-shuttle");
  assert.deepEqual(adapter?.lanes, []);
});

test("an invalid adapter is not half-used: every problem is reported and nothing is read", () => {
  assert.match(parseAdapter("{ lanes: [", ROOT, "x").problems[0]!, /not valid JSON/);
  const { adapter, problems } = parseAdapter(JSON.stringify({
    project: "FysikLab!",
    preview: { base: "localhost:3000" },
    decisions: { maxQuestion: -1 },
    lanes: [{ name: "einstein", harness: "vim" }, { worktree: "x" }, { name: "Einstein" }],
  }), ROOT, "x");
  assert.equal(adapter, null);
  assert.equal(problems.length, 6);
  for (const p of [/project must be lowercase/, /preview.base must be an http/, /maxQuestion must be a whole number/, /lanes\[0\].harness must be one of/, /lanes\[1\] needs a name/, /"Einstein" is named twice/]) {
    assert.ok(problems.some((x) => p.test(x)), `expected ${p} in ${problems.join(" | ")}`);
  }
});

test("a key the service does not know is reported but the rest is used", () => {
  const { adapter, problems } = parseAdapter(JSON.stringify({ project: "fysiklab", lane: [] }), ROOT, "x");
  assert.equal(adapter?.project, "fysiklab");
  assert.deepEqual(problems, ['orchestrator.json: unknown key "lane" ignored']);
});

test("the adapter is read again when the file changes, and forgotten when it goes", () => {
  const dir = mkdtempSync(join(tmpdir(), "adapter-"));
  const file = join(dir, "orchestrator.json");
  const adapters = new Adapters();
  assert.deepEqual(adapters.read(dir, "repo"), { adapter: null, problems: [] });
  writeFileSync(file, JSON.stringify({ project: "one" }));
  assert.equal(adapters.read(dir, "repo").adapter?.project, "one");
  writeFileSync(file, JSON.stringify({ project: "two", integrationBranch: "main" }));
  utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.equal(adapters.read(dir, "repo").adapter?.project, "two");
  rmSync(file);
  assert.equal(adapters.read(dir, "repo").adapter, null);
});

test("the office shows each repository's adapter, and what is wrong with it", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "adapter-repo-")));
  const root = join(dir, "space-shuttle");
  execFileSync("git", ["init", "-q", "-b", "dev", root]);
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
  const db = openDatabase(":memory:");
  const noPresence: PresenceSource = { available: () => false, forSession: () => null, resolvePane: () => null };
  const inbox = new Inbox(db, join(dir, "files"), noPresence);
  const live: LiveAgent[] = [{ paneId: "w1:p1", harness: "pi", sessionId: "s1", cwd: root, status: "idle", title: null, name: null }];
  const source = { available: () => true, live: () => live } as unknown as AgentSource;
  const world = new World(db, source, () => inbox.state());

  const repo = () => world.state().repositories.find((r) => r.root === root)!;
  assert.equal(repo().adapter, null);
  assert.deepEqual(repo().adapterProblems, []);
  writeFileSync(join(root, "orchestrator.json"), JSON.stringify(FYSIKLAB));
  assert.equal(repo().adapter?.project, "fysiklab");
  assert.equal(repo().adapter?.lanes[0]?.worktree, join(root, ".claude/worktrees/einstein"));
  writeFileSync(join(root, "orchestrator.json"), JSON.stringify({ lanes: "einstein" }));
  utimesSync(join(root, "orchestrator.json"), new Date(), new Date(Date.now() + 5000));
  assert.equal(repo().adapter, null);
  assert.deepEqual(repo().adapterProblems, ["orchestrator.json: lanes must be a list"]);
});
