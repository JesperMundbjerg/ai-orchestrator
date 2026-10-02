// npm run build && PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/lanes.browser.mjs
// Projects made for Mission Control's crew worktrees, merged into it from the board and the office panel.
// Scratch office: unique port, temp HOME/data, no herdr, headless only.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repoDir = process.cwd();
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const home = realpathSync(mkdtempSync(join(tmpdir(), "inbox-lanes-browser-")));
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const work = join(home, "projects");
const root = join(work, "lantern");
mkdirSync(root, { recursive: true });
git(root, "init", "-q", "-b", "dev");
writeFileSync(join(root, "a.txt"), "a\n");
git(root, "add", ".");
git(root, "commit", "-qm", "init");
const wt = {};
for (const n of ["galilei", "heisenberg", "einstein"]) { wt[n] = join(work, `lantern-${n}`); git(root, "worktree", "add", "-q", "-b", `worktree-${n}`, wt[n]); }
const clara = join(home, "clara"); mkdirSync(clara);

const socket = createServer();
await new Promise((r) => socket.listen(0, "127.0.0.1", r));
const port = socket.address().port;
await new Promise((r) => socket.close(r));
assert.notEqual(port, 4870);
const url = `http://localhost:${port}`;
const shots = process.env.TEST_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), "review-inbox-artifacts-"));
mkdirSync(shots, { recursive: true });
const office = spawn(process.execPath, ["src/server/main.ts"], {
  cwd: repoDir,
  env: { ...process.env, HOME: home, INBOX_DATA_DIR: join(home, "data"), INBOX_PORT: String(port), HERDR_BIN_PATH: "/usr/bin/false", HERDR_SOCKET_PATH: "/nonexistent", INBOX_CODEX_ACCOUNT_POLLING: "0", INBOX_PRESENCE_DISCOVERY: "0", INBOX_BROWSER_CLEANUP: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
office.stdout.on("data", (d) => { logs += d; });
office.stderr.on("data", (d) => { logs += d; });
const call = async (method, path, body) => {
  const res = await fetch(`${url}${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const out = await res.json();
  if (!res.ok) throw new Error(`${path}: ${out.error}`);
  return out;
};
let browser;
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${url}/api/world`)).ok) break; } catch {}
    if (i === 100) throw new Error(`Scratch office did not start: ${logs}`);
    await delay(100);
  }
  // Clara leads Mission Control; three Claude crew sessions appear in its crew worktrees.
  const post = (sessionId, cwd, title) => call("POST", "/api/agent/items", { session: { harness: "claude", sessionId, cwd }, project: { name: "lantern" }, item: { type: "decide", title, options: ["Yes", "No"], blocking: false } });
  await post("s-clara", clara, "Dispatch the next comment?");
  const mc = await call("POST", "/api/world/teams", { name: "Mission Control", standing: true, purpose: "Dispatch review comments to the crew lanes" });
  let world = await call("GET", "/api/world");
  await call("PATCH", `/api/world/agents/${world.agents.find((a) => a.cwd === clara).id}`, { teamId: mc.id, role: "lead" });
  await post("s-nora", wt.galilei, "Which docking test first?");
  await post("s-liv", wt.heisenberg, "Keep the old fixture?");
  await post("s-agnes", wt.einstein, "Rename the lane?");
  world = await call("GET", "/api/world");
  assert.deepEqual(world.teams.map((t) => t.name).sort(), ["Einstein", "Galilei", "Heisenberg", "Mission Control"], "the bug reproduced");

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(`${url}/#/teams`);
  const column = (name) => page.locator("section.team-column").filter({ has: page.locator("strong", { hasText: new RegExp(`^${name}$`) }) });
  await column("Galilei").waitFor();
  await page.screenshot({ path: join(shots, "lanes-1-before.png") });

  // Board: Edit Galilei, Merge into Mission Control.
  await column("Galilei").getByRole("button", { name: "Edit" }).click();
  const form = page.locator("form.team-form");
  await form.getByText("its own", { exact: true }).waitFor();
  await form.getByLabel("Merge into").selectOption({ label: "Mission Control" });
  await form.screenshot({ path: join(shots, "lanes-2-edit-galilei.png") });
  await form.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator(".board-note").getByText(/Galilei is merged into Mission Control/).waitFor();
  await page.screenshot({ path: join(shots, "lanes-3-merged-on-board.png") });
  assert.equal(await column("Galilei").count(), 0);

  // A refusal is explained: Einstein's own worktree cannot just be added to Mission Control.
  await column("Mission Control").getByRole("button", { name: "Edit" }).click();
  await page.locator("form.team-form").getByText("lantern-galilei", { exact: true }).waitFor();
  await page.locator("form.team-form").getByPlaceholder("Add a worktree of the same repository").fill(wt.einstein);
  await page.locator("form.team-form").getByRole("button", { name: "Add", exact: true }).click();
  await page.locator(".warn").getByText(/Einstein's own worktree\. To make it Mission Control's, merge Einstein into Mission Control/).waitFor();
  await page.screenshot({ path: join(shots, "lanes-4-refused-add.png") });
  await page.locator("form.team-form").getByRole("button", { name: "Cancel" }).click();

  // Office panel: Edit Heisenberg, Merge into Mission Control.
  await page.goto(`${url}/#/world`);
  await page.getByRole("button", { name: "Edit Heisenberg" }).click();
  const panelForm = page.locator(".world-panel.teams form.team-form");
  await panelForm.getByLabel("Merge into").selectOption({ label: "Mission Control" });
  await page.locator(".world-panel.teams").screenshot({ path: join(shots, "lanes-5-office-edit.png") });
  await panelForm.getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator(".world-panel.teams .board-note").getByText(/Heisenberg is merged into Mission Control/).waitFor();
  await page.getByRole("button", { name: "Edit Einstein" }).click();
  await page.locator(".world-panel.teams form.team-form").getByLabel("Merge into").selectOption({ label: "Mission Control" });
  await page.locator(".world-panel.teams form.team-form").getByRole("button", { name: "Merge", exact: true }).click();
  await page.locator(".world-panel.teams .board-note").getByText(/Einstein is merged into Mission Control/).waitFor();
  await page.getByRole("button", { name: "Edit Mission Control" }).click();
  await page.locator(".world-panel.teams form.team-form").getByText("lantern-einstein", { exact: true }).waitFor();
  await page.locator(".world-panel.teams").screenshot({ path: join(shots, "lanes-6-office-mission-control.png") });

  world = await call("GET", "/api/world");
  const team = world.teams.find((t) => t.name === "Mission Control");
  assert.deepEqual(world.teams.map((t) => t.name), ["Mission Control"]);
  assert.deepEqual([...team.worktrees].sort(), [wt.einstein, wt.galilei, wt.heisenberg]);
  for (const p of Object.values(wt)) assert.ok(existsSync(p), `${p} is kept`);
  const crew = world.agents.filter((a) => Object.values(wt).includes(a.cwd));
  assert.deepEqual(crew.map((a) => [a.teamId, a.role]), crew.map(() => [team.id, "member"]));
  assert.equal(world.agents.find((a) => a.cwd === clara).role, "lead");
  await page.goto(`${url}/#/teams`);
  await column("Mission Control").waitFor();
  await page.screenshot({ path: join(shots, "lanes-7-board-after.png") });
  assert.deepEqual(errors, []);
  console.log("ok", shots);
} finally {
  await browser?.close();
  office.kill();
}
