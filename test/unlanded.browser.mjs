// npm run build && PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/unlanded.browser.mjs
// The office panel lists agents with unlanded work (agent, checkout, uncommitted, commits ahead, since
// when, how far the office has told), and the team's Edit form sets the merge instruction.
// Scratch office: own free port, temporary HOME/data, no herdr, no integrations, headless only. Optional SCREENSHOT_DIR.
// A scratch office has no herdr, so no agent is live and idle there: the browser adds the list to the
// service's own /api/world answer. What the service puts in that list is tested in test/unlanded.test.ts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawnScratchOffice } from "../scripts/lib/scratch-office.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const home = await mkdtemp(join(tmpdir(), "unlanded-browser-"));
const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
assert.notEqual(port, 4870);
const url = `http://localhost:${port}`;
const shots = process.env.SCREENSHOT_DIR ?? join(home, "screenshots");
await mkdir(shots, { recursive: true });

const repo = join(home, "repo");
await mkdir(join(repo, ".claude/commands"), { recursive: true });
await writeFile(join(repo, ".claude/commands/worktree-sync.md"), "Land with `land <checkout> <sha>`.\n");
for (const args of [["init", "-q", "-b", "main"], ["add", "."], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]]) execFileSync("git", ["-C", repo, ...args]);

const call = async (method, path, body) => {
  const res = await fetch(url + path, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const out = await res.json();
  if (!res.ok) throw new Error(`${path}: ${out.error}`);
  return out;
};

let office, browser;
try {
  office = await spawnScratchOffice(process.execPath, ["src/server/main.ts"], {
    env: { ...process.env, HOME: home, INBOX_DATA_DIR: join(home, "data"), INBOX_PORT: String(port),
      HERDR_SOCKET_PATH: "/nonexistent", HERDR_BIN_PATH: "/usr/bin/false",
      INBOX_CODEX_ACCOUNT_POLLING: "0", INBOX_PRESENCE_DISCOVERY: "0", INBOX_BROWSER_CLEANUP: "0" }, stdio: "ignore",
  });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${url}/api/world`)).ok) break; } catch {}
    if (i === 100) throw new Error("Scratch office did not start");
    await delay(100);
  }
  const session = { harness: "claude", sessionId: "s-lead", cwd: repo };
  await call("POST", "/api/agent/items", { session, project: { name: "lessons" }, item: { type: "milestone", fixed: "Fixed.", title: "Ready" } });
  const team = await call("POST", "/api/world/teams", { name: "Space Shuttle", standing: true, purpose: "Lanes and a dispatcher" });
  const world = await call("GET", "/api/world");
  const lead = world.agents.find((a) => a.cwd === repo);
  await call("PATCH", `/api/world/agents/${lead.id}`, { teamId: team.id, role: "lead" });

  // The setting round trip through the real service, then the form.
  const saved = await call("PATCH", `/api/world/teams/${team.id}`, { mergeInstruction: "Land with land <checkout> <sha>.", mergeInstructionPath: ".claude/commands/gone.md" });
  assert.equal(saved.mergeInstruction, "Land with land <checkout> <sha>.");
  assert.match((await call("GET", "/api/world")).teams[0].mergeInstructionProblem, /was not found/);
  const brief = (await call("POST", "/api/agent/team", { session })).text;
  assert.match(brief, /could not give you Space Shuttle's merge file \.claude\/commands\/gone\.md/);
  assert.match(brief, /When your work is done, land it with Space Shuttle's merge instruction, then say it has landed:\nLand with land <checkout> <sha>\./);
  await call("PATCH", `/api/world/teams/${team.id}`, { mergeInstructionPath: ".claude/commands/worktree-sync.md" });
  assert.equal((await call("GET", "/api/world")).teams[0].mergeInstructionProblem, null);

  browser = await chromium.launch({ headless: true });
  const errors = [];
  const since = new Date(Date.now() - 23 * 60_000).toISOString();
  const open = async (viewport) => {
    const page = await browser.newPage({ viewport });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route(/\/api\/world$/, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      const t = body.teams[0];
      body.unlanded = [
        { agentId: lead.id, agentName: lead.name, teamId: t.id, checkout: `${home}/space-shuttle-galilei`, branch: "lane-galilei", landing: "dev", uncommitted: 3, ahead: 0, since, stage: "agent" },
        { agentId: "x2", agentName: "Mach", teamId: t.id, checkout: `${home}/space-shuttle-einstein`, branch: "lane-einstein", landing: "dev", uncommitted: 0, ahead: 2, since, stage: "lead" },
        { agentId: "x3", agentName: "Ohm", teamId: t.id, checkout: `${home}/space-shuttle-curie`, branch: "worktree-a-very-long-branch-name-for-the-curie-lane", landing: "dev", uncommitted: 12, ahead: 5, since, stage: "founder" },
      ];
      await route.fulfill({ response: res, json: body });
    });
    await page.goto(`${url}/#/world`);
    await page.getByRole("button", { name: "Front door ↗" }).waitFor();
    return page;
  };

  const check = async (page, name) => {
    const list = page.getByRole("group", { name: "Unlanded work" });
    await list.waitFor();
    const text = await list.innerText();
    assert.match(text, /3 uncommitted/);
    assert.match(text, /2 ahead of dev/);
    assert.match(text, /12 uncommitted, 5 ahead of dev/);
    assert.match(text, /agent told/);
    assert.match(text, /lead told/);
    assert.match(text, /you were told/);
    await page.screenshot({ path: join(shots, `${name}-team-panel-unlanded.png`) });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `${name}: the page scrolls sideways by ${overflow}px`);
  };

  // The projects panel opens the team by its button, but the existing layout hides that panel on a phone:
  // the team is opened at desktop width and the window then made phone-sized, with the team panel still open.
  const page = await open({ width: 1440, height: 900 });
  await page.getByRole("button", { name: /Space Shuttle/ }).first().click();
  await check(page, "desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await check(page, "phone");
  await page.close();

  // The Edit form on the teams board: the merge instruction fields, filled from the service.
  for (const [name, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${url}/#/teams`);
    await page.getByRole("button", { name: "Edit", exact: true }).first().click();
    const text = page.getByLabel("Merge instruction", { exact: true });
    await text.waitFor();
    assert.equal(await text.inputValue(), "Land with land <checkout> <sha>.");
    assert.equal(await page.getByLabel("Merge instruction file").inputValue(), ".claude/commands/worktree-sync.md");
    await page.getByLabel("Merge instruction file").fill("nope/gone.md");
    await page.getByLabel("Merge instruction file").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, `${name}-edit-merge-instruction.png`) });
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByRole("button", { name: "Edit", exact: true }).first().click();
    await page.getByText(/^Merge instruction file: .*was not found/).first().waitFor();
    await page.getByLabel("Merge instruction file").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, `${name}-merge-file-warning.png`) });
    assert.equal((await call("GET", "/api/world")).teams[0].mergeInstructionPath, "nope/gone.md");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `${name}: the page scrolls sideways by ${overflow}px`);
    await call("PATCH", `/api/world/teams/${team.id}`, { mergeInstructionPath: ".claude/commands/worktree-sync.md" });
    await page.close();
  }

  assert.deepEqual(errors, []);
  console.log(`unlanded UI: ok (screenshots in ${shots})`);
} finally {
  await browser?.close();
  await office?.stop();
}
