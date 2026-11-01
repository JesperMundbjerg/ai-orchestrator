import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { capture, inRequest, repository } from "../src/server/pipelines/candidate.ts";

function scratchRepo(t: { after: (fn: () => void) => void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pipeline-scope-"))); const repo = join(root, "repo"); mkdirSync(repo);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git("init", "-b", "feature"); git("config", "user.name", "Scratch"); git("config", "user.email", "scratch@invalid");
  writeFileSync(join(repo, "file"), "one"); git("add", "file"); git("commit", "-m", "seed");
  return { repo, git };
}

test("a request reads the repository once; the next request sees it as it is then", (t) => {
  const { repo, git } = scratchRepo(t);
  const clean = capture(repo, "HEAD", "HEAD");
  assert.deepEqual(clean.changedPaths, []);
  inRequest(() => {
    assert.deepEqual(capture(repo, "HEAD", "HEAD").changedPaths, []);
    writeFileSync(join(repo, "file"), "two"); // The checkout changes mid-request: this request keeps one consistent view.
    assert.deepEqual(capture(repo, "HEAD", "HEAD").changedPaths, [], "memoised inside the request");
    assert.equal(capture(repo, "HEAD", "HEAD").fingerprint, clean.fingerprint);
  });
  // Outside any request nothing is remembered: every read sees the checkout now.
  const dirty = capture(repo, "HEAD", "HEAD");
  assert.deepEqual(dirty.changedPaths, ["file"]); assert.notEqual(dirty.fingerprint, clean.fingerprint);
  inRequest(() => assert.deepEqual(capture(repo, "HEAD", "HEAD").changedPaths, ["file"], "a new request starts fresh"));
  git("checkout", "--", "file");
  assert.deepEqual(capture(repo, "HEAD", "HEAD").changedPaths, []);
});

test("a memoised capture cannot be changed by its caller, and a failure is remembered for the request only", (t) => {
  const { repo, git } = scratchRepo(t);
  inRequest(() => {
    const first = capture(repo, "HEAD", "HEAD"); first.changedPaths.push("tampered"); first.head = "0".repeat(40);
    const second = capture(repo, "HEAD", "HEAD"); assert.deepEqual(second.changedPaths, []); assert.notEqual(second.head, first.head);
    assert.throws(() => capture(repo, "HEAD", "no-such-branch"), /unavailable/);
    git("branch", "no-such-branch");
    assert.throws(() => capture(repo, "HEAD", "no-such-branch"), /unavailable/, "the same request keeps its earlier answer");
  });
  assert.doesNotThrow(() => capture(repo, "HEAD", "no-such-branch"), "the next read sees the branch");
});

test("repository answers are remembered per request and a request scope cannot span an await", async (t) => {
  const { repo } = scratchRepo(t);
  const before = repository(repo);
  inRequest(() => { assert.deepEqual(repository(repo), before); assert.deepEqual(inRequest(() => repository(repo)), before, "scopes nest into one"); });
  assert.throws(() => inRequest((async () => repository(repo)) as unknown as () => unknown), /cannot span an await/);
  // The refused async scope is closed, so later reads are not stuck in a stale one.
  writeFileSync(join(repo, "other"), "x");
  assert.deepEqual(capture(repo, "HEAD", "HEAD").changedPaths, ["other"]);
});
