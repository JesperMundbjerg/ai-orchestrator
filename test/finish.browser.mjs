// Optional browser regression (no Playwright dependency in the service):
// npm run build && PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs [SHOTS=/dir] node test/finish.browser.mjs
// Starts its own isolated office through the scratch launcher, uses headless Chromium, and closes both in finally.
// Finishing a project whose work has not landed is refused and its lead told; uncommitted changes offer no way
// past, commits not on the integration branch offer "Finish anyway: keep the branch".
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawnScratchOffice } from "../scripts/lib/scratch-office.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const home = await realpath(await mkdtemp(join(tmpdir(), "inbox-finish-test-")));
const shots = process.env.SHOTS ?? join(home, "shots");
await mkdir(shots, { recursive: true });
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

// A repository landing on dev (published to a bare origin), and a project worktree beside it.
const origin = join(home, "origin.git");
const root = join(home, "projects", "lantern");
const atoms = join(home, "projects", "lantern-atoms");
execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
execFileSync("git", ["init", "-q", "-b", "main", root]);
await writeFile(join(root, "orchestrator.json"), JSON.stringify({ integrationBranch: "dev" }));
git(root, "add", ".");
git(root, "commit", "-qm", "init");
git(root, "branch", "dev");
git(root, "remote", "add", "origin", origin);
git(root, "push", "-q", "origin", "main", "dev");
git(root, "worktree", "add", "-q", "-b", "worktree-atoms", atoms, "dev");

const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
assert.notEqual(port, 4870);
const url = `http://localhost:${port}`;
const office = await spawnScratchOffice(process.execPath, ["src/server/main.ts"], {
  env: { ...process.env, HOME: home, INBOX_DATA_DIR: join(home, "data"), INBOX_PORT: String(port), HERDR_BIN_PATH: "/usr/bin/false", HERDR_SOCKET_PATH: "/nonexistent", INBOX_CODEX_ACCOUNT_POLLING: "0", INBOX_PRESENCE_DISCOVERY: "0", INBOX_BROWSER_CLEANUP: "0" },
  stdio: "ignore",
});
let browser;
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${url}/api/state`)).ok) break; } catch {}
    if (i === 100) throw new Error("Scratch office did not start");
    await delay(100);
  }
  // The project's lead, known to the office from the inbox (herdr is faked away, so it is offline).
  const response = await fetch(`${url}/api/agent/items`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: { harness: "manual", sessionId: "clara", cwd: atoms }, project: { name: "Lantern", root: atoms }, task: { title: "Atoms", objective: "Light the atoms" }, item: { key: "m1", type: "milestone", title: "Atoms glow" } }),
  });
  assert.ok(response.ok, await response.text());
  const world = async () => (await fetch(`${url}/api/world`)).json();
  const team = (await world()).teams.find((t) => t.path === atoms);
  assert.ok(team, "the worktree is a project");
  const lead = (await world()).agents.find((a) => a.teamId === team.id && a.role === "lead");
  assert.ok(lead, "the project has a lead");

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto(`${url}/#/world`);
  const panel = page.locator(".world-panel.teams");
  const refusal = panel.locator(".finish-refused");
  const finish = async () => {
    if (!(await panel.getByRole("button", { name: "Finish project" }).count())) await panel.getByRole("button", { name: `Edit ${team.name}` }).click();
    await panel.getByRole("button", { name: "Finish project" }).click();
    await refusal.waitFor();
  };

  // Uncommitted: refused, the lead told, and no way past.
  await writeFile(join(atoms, "b.txt"), "b\n");
  await finish();
  const uncommitted = await refusal.textContent();
  assert.match(uncommitted, /is not finished: 1 uncommitted change in .*: commit and land it first\./);
  assert.match(uncommitted, new RegExp(`${lead.name} was told to land it on dev`));
  assert.equal(await refusal.getByRole("button", { name: "Finish anyway: keep the branch" }).count(), 0);
  await panel.screenshot({ path: join(shots, "1-refused-uncommitted.png") });

  // Committed but not on origin/dev: refused, the lead told, and Finish anyway offered.
  git(atoms, "add", ".");
  git(atoms, "commit", "-qm", "b");
  await refusal.getByRole("button", { name: "OK" }).click();
  await finish();
  assert.match(await refusal.textContent(), /1 commit not on dev: land it first, or finish anyway and keep the branch\./);
  const anyway = refusal.getByRole("button", { name: "Finish anyway: keep the branch" });
  await anyway.waitFor();
  await panel.screenshot({ path: join(shots, "2-refused-unlanded-finish-anyway.png") });
  const messages = (await world()).messages.filter((m) => m.fromOffice && m.deliveries.some((d) => d.agentId === lead.id));
  assert.deepEqual(messages.map((m) => /has not landed: (.*?)\. Commit/.exec(m.text)?.[1]?.replace(/ in .*/, "")).reverse(), ["1 uncommitted change", "1 commit not on dev"], "newest first: one notice per attempt");

  // Finish anyway gets past the landing check; with herdr faked away, it stops at herdr, so nothing is removed here.
  await anyway.click();
  await panel.locator(".warn").filter({ hasText: /herdr/ }).first().waitFor();
  await panel.screenshot({ path: join(shots, "3-finish-anyway-reaches-herdr.png") });
  assert.equal(git(root, "worktree", "list").includes(atoms), true);
  assert.deepEqual(errors, []);
  console.log(`finish flow ok; screenshots in ${shots}`);
} finally {
  await browser?.close();
  await office.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
}
