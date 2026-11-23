import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirtyState, uncommitted } from "../src/server/worktrees.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/** A temporary repository with one commit on `main`; the caller removes it. */
function repository() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "finder-meta-")));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  return dir;
}

test("an untracked .DS_Store is not uncommitted work, at any depth", (t) => {
  const dir = repository();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, ".DS_Store"), "finder\n");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", ".DS_Store"), "finder\n");
  assert.equal(dirtyState(dir).count, 0);
  assert.equal(uncommitted(dir), 0);
});

test("rewriting an untracked .DS_Store leaves the fingerprint unchanged", (t) => {
  const dir = repository();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "src", ".DS_Store");
  mkdirSync(join(dir, "src"));
  writeFileSync(file, "one\n");
  const before = dirtyState(dir).fingerprint;
  writeFileSync(file, "two, longer\n");
  utimesSync(file, new Date("2030-01-01"), new Date("2030-01-01"));
  assert.equal(dirtyState(dir).fingerprint, before);
});

test("a real untracked file still counts, and editing it changes the fingerprint", (t) => {
  const dir = repository();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, ".DS_Store"), "finder\n");
  writeFileSync(join(dir, "notes.txt"), "draft\n");
  assert.equal(dirtyState(dir).count, 1);
  assert.equal(uncommitted(dir), 1);
  const before = dirtyState(dir).fingerprint;
  writeFileSync(join(dir, "notes.txt"), "draft, edited\n");
  assert.notEqual(dirtyState(dir).fingerprint, before);
});

test("an untracked folder holding a real file next to its .DS_Store still counts", (t) => {
  const dir = repository();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", ".DS_Store"), "finder\n");
  writeFileSync(join(dir, "src", "new.ts"), "export {};\n");
  assert.equal(dirtyState(dir).count, 1);
  assert.equal(uncommitted(dir), 1);
});

test("a tracked .DS_Store that changed still counts", (t) => {
  const dir = repository();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, ".DS_Store"), "tracked\n");
  git(dir, "add", ".DS_Store");
  git(dir, "commit", "-qm", "track metadata");
  writeFileSync(join(dir, ".DS_Store"), "changed\n");
  assert.equal(dirtyState(dir).count, 1);
  assert.equal(uncommitted(dir), 1);
});
