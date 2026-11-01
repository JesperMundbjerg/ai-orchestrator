// npm run build && PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/leadrole.browser.mjs
// The team's Edit dialog sets its lead role (text and a role file); a missing file is warned about in
// the team's column and in the dialog; the lead's `inbox team` carries the role and the delegation rule.
// Scratch office: own free port, temporary HOME/data, no herdr, no integrations, headless only. Optional SCREENSHOT_DIR.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawnScratchOffice } from "../scripts/lib/scratch-office.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const home = await mkdtemp(join(tmpdir(), "leadrole-browser-"));
const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
assert.notEqual(port, 4870);
const url = `http://localhost:${port}`;
const shots = process.env.SCREENSHOT_DIR ?? join(home, "screenshots");
await mkdir(shots, { recursive: true });

const RULE = "You lead: plan, split and hand every change, however small, to your crew or lanes; never edit, fix or build yourself.";
const repo = join(home, "repo");
await mkdir(join(repo, ".claude/commands"), { recursive: true });
await writeFile(join(repo, ".claude/commands/mission-control.md"), "Own getting queued comments into working lanes. Do not implement.\n");
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
  const team = await call("POST", "/api/world/teams", { name: "Mission Control", standing: true, purpose: "Routes comments to lanes" });
  const lead = (await call("GET", "/api/world")).agents.find((a) => a.cwd === repo);
  await call("PATCH", `/api/world/agents/${lead.id}`, { teamId: team.id, role: "lead" });

  browser = await chromium.launch({ headless: true });
  const errors = [];
  const open = async (viewport) => {
    const page = await browser.newPage({ viewport });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${url}/#/teams`);
    await page.getByRole("button", { name: "Edit", exact: true }).first().waitFor();
    return page;
  };
  const edit = async (page, role, file) => {
    await page.getByRole("button", { name: "Edit", exact: true }).first().click();
    await page.getByLabel("Lead role", { exact: true }).fill(role);
    await page.getByLabel("Lead role file").fill(file);
  };

  // Desktop: set a role text and a role file that does not exist: saved, and warned about where the founder looks.
  const desk = await open({ width: 1440, height: 900 });
  await edit(desk, "Dispatch queued comments; never implement.", ".claude/commands/gone.md");
  await desk.screenshot({ path: join(shots, "01-desktop-edit-dialog.png") });
  await desk.getByRole("button", { name: "Save" }).click();
  await desk.getByText(/^Lead role file: .*was not found/).waitFor();
  await desk.screenshot({ path: join(shots, "02-desktop-missing-file-warning.png") });
  let saved = (await call("GET", "/api/world")).teams.find((t) => t.id === team.id);
  assert.equal(saved.leadRole, "Dispatch queued comments; never implement.");
  assert.equal(saved.leadRolePath, ".claude/commands/gone.md");
  assert.match(saved.leadRoleProblem, /was not found/);
  let brief = (await call("POST", "/api/agent/team", { session })).text;
  assert.ok(brief.includes(RULE) && brief.includes("Dispatch queued comments; never implement."), "the lead's brief has the rule and the text");
  assert.match(brief, /could not give you Mission Control's lead role file \.claude\/commands\/gone\.md/);

  // Point it at the real file: the warning goes and the lead is given the file's content.
  await edit(desk, "Dispatch queued comments; never implement.", ".claude/commands/mission-control.md");
  await desk.getByRole("button", { name: "Save" }).click();
  await desk.getByText(/^Lead role file:/).waitFor({ state: "detached" });
  saved = (await call("GET", "/api/world")).teams.find((t) => t.id === team.id);
  assert.equal(saved.leadRoleProblem, null);
  brief = (await call("POST", "/api/agent/team", { session })).text;
  assert.ok(brief.includes("Own getting queued comments into working lanes. Do not implement."));
  await desk.screenshot({ path: join(shots, "03-desktop-saved.png") });

  // Phone: the dialog fits the screen.
  const phone = await open({ width: 390, height: 844 });
  await phone.getByRole("button", { name: "Edit", exact: true }).first().click();
  await phone.getByLabel("Lead role", { exact: true }).waitFor();
  await phone.getByLabel("Lead role", { exact: true }).scrollIntoViewIfNeeded();
  await phone.screenshot({ path: join(shots, "04-phone-edit-dialog.png") });
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `the phone page scrolls sideways by ${overflow}px`);

  assert.deepEqual(errors, []);
  console.log(`lead role UI: ok (screenshots in ${shots})`);
} finally {
  await browser?.close();
  await office?.stop();
}
