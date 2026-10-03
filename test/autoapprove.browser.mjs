// npm run build && PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node test/autoapprove.browser.mjs
// Own free port, temporary HOME/data and no machine integrations. Optional SCREENSHOT_DIR.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawnScratchOffice } from "../scripts/lib/scratch-office.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const home = await mkdtemp(join(tmpdir(), "approve-all-browser-"));
const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
assert.notEqual(port, 4870);
const url = `http://localhost:${port}`;
const shots = process.env.SCREENSHOT_DIR ?? join(home, "screenshots");
await mkdir(shots, { recursive: true });
let office, browser;
const start = async () => {
  office = await spawnScratchOffice(process.execPath, ["src/server/main.ts"], {
    env: { ...process.env, HOME: home, INBOX_DATA_DIR: join(home, "data"), INBOX_PORT: String(port),
      HERDR_SOCKET_PATH: "/nonexistent", HERDR_BIN_PATH: "/usr/bin/false",
      INBOX_CODEX_ACCOUNT_POLLING: "0", INBOX_PRESENCE_DISCOVERY: "0", INBOX_BROWSER_CLEANUP: "0" }, stdio: "ignore",
  });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${url}/api/state`)).ok) break; } catch {}
    if (i === 100) throw new Error("Scratch office did not start");
    await delay(100);
  }
};
// Cleanup goes through the scratch launcher: its tracked group, reverified before any signal.
const stop = async () => { await office?.stop(); office = undefined; };
const get = async (path) => (await (await fetch(url + path)).json());
const post = async (path, body) => {
  const response = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.ok(response.ok, await response.clone().text()); return response.json();
};
const session = { harness: "manual", sessionId: "scratch-approvals" };
const submit = async (key, item) => (await post("/api/agent/items", {
  session, task: { title: "Release checks" }, project: { name: "Scratch release", root: join(home, "release") }, item: { key, ...item },
})).itemId;
try {
  await start();
  const milestone = await submit("milestone", { type: "milestone", title: "Release is ready", context: "The checks passed; accept this increment." });
  const preview = await submit("try", { type: "try", title: "Try the release", preview: "http://localhost:3000", check: "Check the release preview." });
  const decide = await submit("decision", { type: "decide", title: "Where should search sit?", options: ["Docked: keep the draft visible", "Overlay: keep the width"], recommendation: "Docked, because the draft should stay visible" });
  const manual = await submit("manual", { type: "decide", title: "Which release day?", options: ["Monday", "Friday"] });
  const question = await submit("open", { type: "decide", title: "What should we do next?", request: "There is no safe default here." });
  browser = await chromium.launch({ headless: true });
  let page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  const toggle = page.getByRole("radio", { name: "Approve all" });
  await toggle.waitFor();
  assert.equal(await toggle.getAttribute("aria-checked"), "false");
  await page.screenshot({ path: join(shots, "01-off.png") });
  await toggle.click();
  await page.getByText("3 auto-answered").waitFor();
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  assert.equal((await get(`/api/items/${milestone}`)).replies[0].action, "accept");
  assert.equal((await get(`/api/items/${preview}`)).replies[0].action, "accept");
  assert.equal((await get(`/api/items/${decide}`)).replies[0].choice, "a");
  assert.equal((await get(`/api/items/${manual}`)).replies.length, 0);
  assert.equal((await get(`/api/items/${question}`)).replies.length, 0);
  await page.screenshot({ path: join(shots, "02-on.png") });
  await page.goto(`${url}/#/needs?item=${milestone}`);
  await page.getByRole("tab", { name: "Conversation", exact: true }).click();
  await page.getByText("Auto-approved (approve all).", { exact: true }).waitFor();
  await page.screenshot({ path: join(shots, "03-history.png") });
  await page.goto(`${url}/#/world`);
  await page.locator(".world-top").waitFor();
  await page.getByText("3 auto-answered").waitFor();
  await page.screenshot({ path: join(shots, "04-office.png") });
  await page.goto(url);
  await page.setViewportSize({ width: 390, height: 844 });
  await toggle.waitFor();
  const bounds = await toggle.boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390);
  await page.screenshot({ path: join(shots, "05-phone.png") });
  await page.close(); // New/revised submissions need no UI to be open.
  await submit("milestone", { type: "milestone", title: "Release revised after closing UI" });
  let detail = await get(`/api/items/${milestone}`);
  assert.deepEqual(detail.replies.map((r) => r.state), ["stale", "queued"]);
  await stop();
  await start();
  const { qaModels, ...setting } = await get("/api/auto-approve");
  assert.deepEqual(setting, { enabled: true, count: 4, mode: "approve_all", qa: null, qaAgent: null, qaError: null });
  assert.ok(qaModels.length, "the QA model picker lists the crew catalog");
  const after = await submit("after-restart", { type: "milestone", title: "Ready after restart" });
  assert.equal((await get(`/api/items/${after}`)).replies[0].state, "queued");
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(url);
  await page.getByText("5 auto-answered").waitFor();
  await page.getByRole("radio", { name: "Off" }).click();
  await page.locator('[role="radio"][aria-checked="true"]', { hasText: "Off" }).waitFor();
  const off = await submit("after-off", { type: "milestone", title: "Wait for the founder" });
  assert.equal((await get(`/api/items/${off}`)).replies.length, 0);
  const replies = await post("/api/agent/replies", { session, mode: "pull" });
  assert.ok(replies.length > 0 && replies.every((r) => r.text.includes("approve all")));
  assert.deepEqual(errors, []);
  console.log(`Approve all browser passed: toggle, waiting items, history, office, phone, closed UI, revisions, restart and off. Screenshots: ${shots}`);
} finally {
  await browser?.close(); await stop(); await rm(home, { recursive: true, force: true });
}
