import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { changedFiles, parseWrites, strayFiles, type ChangedFile } from "../src/shared/surface.ts";

const files = (...paths: string[]): ChangedFile[] => paths.map((path) => ({ path, status: "M" }));
const stray = (paths: string[], writes: string) => strayFiles(files(...paths), parseWrites([writes])).map((f) => f.path);

test("* stays within one folder; ** spans any number of folders, none included", () => {
  assert.deepEqual(stray(["src/server/qa.ts", "src/server/qa-agent.ts", "src/server/pipelines/qa.ts"], "src/server/qa*.ts"), ["src/server/pipelines/qa.ts"]);
  assert.deepEqual(stray(["src/a.ts", "src/x/y/b.ts", "srcx/c.ts"], "src/**"), ["srcx/c.ts"]);
  assert.deepEqual(stray(["test/a.test.ts", "test/deep/b.test.ts", "test/fixture.json"], "test/**/*.test.ts"), ["test/fixture.json"]);
  assert.deepEqual(stray(["a.md", "docs/b.md", "docs/c.txt"], "**/*.md"), ["docs/c.txt"]);
  assert.deepEqual(stray(["docs/API.md", "docs/API.mdx", "docsXAPI.md"], "docs/API.md"), ["docs/API.mdx", "docsXAPI.md"]);
  assert.deepEqual(stray(["docs/a/b.md", "doc.md"], "docs/"), ["doc.md"], "a trailing slash covers the whole folder");
});

test("several globs, comma-separated or repeated, each widen the surface", () => {
  assert.deepEqual(parseWrites(["src/server/qa*.ts, test/qa*", "", "docs/DESIGN.md,"]), ["src/server/qa*.ts", "test/qa*", "docs/DESIGN.md"]);
  assert.deepEqual(stray(["src/server/qa.ts", "test/qa-agent.test.ts", "docs/DESIGN.md", "README.md"], "src/server/qa*.ts,test/qa*,docs/DESIGN.md"), ["README.md"]);
});

test("a rename touches both paths, a deletion counts as a write, and a copy leaves its source alone", () => {
  const z = ["M", "src/in.ts", "R087", "src/old.ts", "lib/new.ts", "D", "lib/gone.ts", "C100", "src/in.ts", "src/copy.ts", ""].join("\0");
  assert.deepEqual(changedFiles(z), [
    { path: "src/in.ts", status: "M" },
    { path: "src/old.ts", status: "D" },
    { path: "lib/new.ts", status: "A" },
    { path: "lib/gone.ts", status: "D" },
    { path: "src/copy.ts", status: "A" },
  ]);
  assert.deepEqual(strayFiles(changedFiles(z), ["src/**"]).map((f) => `${f.status} ${f.path}`), ["A lib/new.ts", "D lib/gone.ts"]);
  assert.deepEqual(strayFiles(changedFiles(z), ["lib/**"]).map((f) => `${f.status} ${f.path}`), ["M src/in.ts", "D src/old.ts", "A src/copy.ts"],
    "moving a file into the surface still deletes one outside it");
  assert.deepEqual(changedFiles(""), []);
});

test("inbox surface-check names stray files from the repository's diff and exits non-zero", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "surface-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  git("init", "-q");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/keep.ts"), "1\n");
  writeFileSync(join(repo, "README.md"), "readme with enough lines\nto detect\na rename\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "src/keep.ts"), "2\n");
  git("mv", "README.md", "src/README.md");
  git("commit", "-qam", "work");
  const bin = fileURLToPath(new URL("../bin/inbox", import.meta.url));
  const run = (...args: string[]) => {
    try {
      return { code: 0, out: execFileSync(bin, ["surface-check", ...args], { cwd: repo, encoding: "utf8", stdio: "pipe", env: { ...process.env, INBOX_URL: "http://127.0.0.1:9" } }) };
    } catch (err) {
      const e = err as { status: number; stdout: string };
      return { code: e.status, out: e.stdout };
    }
  };
  const bad = run("--writes", "src/**", "--base", base);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /README\.md \(deleted\)/);
  assert.doesNotMatch(bad.out, /keep\.ts/);
  const good = run("--writes", "src/**,README.md", "--base", base, "--commit", "HEAD");
  assert.equal(good.code, 0, good.out);
  assert.match(good.out, /inside the write surface/);
});
