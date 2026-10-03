// Optional browser regression (no Playwright dependency in the service):
// npm run build && PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs [SHOTS=/dir] node test/answer-chat.browser.mjs
// Starts its own isolated office through the scratch launcher, uses headless Chromium, and closes both in finally.
// In the 3D office the answer chat opens the next waiting question by itself (same agent first), shows "n of m",
// closes when none are left, and can be stopped partway with Esc.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawnScratchOffice } from "../scripts/lib/scratch-office.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const home = await mkdtemp(join(tmpdir(), "inbox-answer-chat-test-"));
const shots = process.env.SHOTS ?? join(home, "shots");
await mkdir(shots, { recursive: true });
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
  const post = async (path, body) => {
    const response = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  };
  const submit = async (lead, key, title, type = "decide") => (await post("/api/agent/items", {
    session: { harness: "manual", sessionId: lead },
    project: { name: "Lantern", root: join(home, "lantern") }, task: { title: lead, objective: "Prepare the release" },
    item: { key, type, title, request: "Tell me what you think.", context: "Checked on desktop.", options: [{ id: "a", label: "Yes" }, { id: "b", label: "No" }] },
  })).itemId;
  // Clara's two questions sandwich Agnes's; Clara is first in line, so hers come first, then Agnes's, then Emil's.
  const first = await submit("Clara", "c1", "Which colour for the door?");
  await submit("Agnes", "a1", "Which font for the sign?");
  await submit("Clara", "c2", "Which lamp over the desk?");
  await submit("Emil", "e1", "Which mat at the entrance?");
  const open = async (id) => (await (await fetch(`${url}/api/items/${id}`)).json());

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${url}/#/world`);
  const dialog = page.getByRole("dialog", { name: "Answer" });
  const asking = () => dialog.locator("h2").first().textContent();
  const progress = async () => (await dialog.locator(".panel-head .muted").textContent()).replace("·", "").trim();
  await page.getByRole("button", { name: /in line/ }).click();
  await dialog.waitFor();
  const firstTitle = await asking();
  assert.equal(await progress(), "1 of 4");
  await page.screenshot({ path: join(shots, "1-first-question.png") });

  // Answering opens the next one straight away; Clara's other question comes before the rest of the line.
  const titles = [firstTitle];
  for (const n of [2, 3]) {
    await dialog.getByRole("button", { name: "Yes", exact: true }).click();
    await page.waitForFunction(([want, last]) => document.querySelector('[role="dialog"][aria-label="Answer"] .panel-head .muted')?.textContent.replace("·", "").trim() === `${want} of 4` && document.querySelector('[role="dialog"][aria-label="Answer"] h2')?.textContent !== last, [n, titles.at(-1)], { timeout: 5000 });
    titles.push(await asking());
    if (n === 2) await page.screenshot({ path: join(shots, "2-next-opened-by-itself.png") });
  }
  assert.equal(titles[1].includes("lamp") || titles[0].includes("lamp"), true, `same agent's questions first: ${titles}`);
  assert.deepEqual(new Set(titles).size, 3);

  // Esc stops partway: the chat closes, and the last question is still waiting, answered ones are not.
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  const left = (await (await fetch(`${url}/api/state`)).json()).items.filter((i) => i.state === "needs_attention");
  assert.equal(left.length, 2);

  // Opened again, it starts fresh at the questions still waiting, and closes after the last answer.
  await page.getByRole("button", { name: /in line/ }).click();
  await dialog.waitFor();
  assert.equal(await progress(), "1 of 2");
  await dialog.getByRole("button", { name: "No", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[role="dialog"][aria-label="Answer"] .panel-head .muted')?.textContent.replace("·", "").trim() === "2 of 2", null, { timeout: 5000 });
  await dialog.getByRole("button", { name: "No", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await page.screenshot({ path: join(shots, "3-closed-when-none-left.png") });
  assert.equal(await page.getByRole("button", { name: /in line/ }).count(), 0);
  assert.equal((await open(first)).item.state === "needs_attention", false);

  assert.deepEqual(errors, []);
  console.log(`answer chat: ok (screenshots in ${shots})`);
} finally {
  await browser?.close();
  await office.stop();
  if (!process.env.SHOTS) await rm(home, { recursive: true, force: true });
  else await rm(join(home, "data"), { recursive: true, force: true });
}
