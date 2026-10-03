// Optional browser regression (no Playwright dependency in the service):
// npm run build && PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs [SHOTS=/dir] node test/back-of-queue.browser.mjs
// Starts its own isolated office, uses headless Chromium, and closes both in finally.
// Back of queue moves an item behind every other waiting one, by button and by `b`, and nothing is sent.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const home = await mkdtemp(join(tmpdir(), "inbox-backqueue-test-"));
const shots = process.env.SHOTS ?? join(home, "shots");
await mkdir(shots, { recursive: true });
const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
assert.notEqual(port, 4870);
const url = `http://localhost:${port}`;
const office = spawn(process.execPath, ["src/server/main.ts"], {
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
  const submit = async (lead, key, item) => (await post("/api/agent/items", {
    session: { harness: "manual", sessionId: lead },
    project: { name: "Lantern", root: join(home, "lantern") }, task: { title: lead, objective: "Prepare the release" },
    item: { key, request: "Tell me what you think.", context: "Checked on desktop.", ...item },
  })).itemId;
  const options = [{ id: "a", label: "Overlay", consequence: "Cover part of the note." }, { id: "b", label: "Docked", consequence: "Keep every control visible." }];
  const ids = {};
  ids.m1 = await submit("Clara", "m1", { type: "milestone", title: "Launch cut one" });
  ids.t1 = await submit("Agnes", "t1", { type: "try", title: "Try notebook one", check: "Search for a note.", preview: { url, viewport: "desktop" } });
  ids.m2 = await submit("Emil", "m2", { type: "milestone", title: "Launch cut two" });
  ids.d1 = await submit("Theo", "d1", { type: "decide", title: "Where should the search panel sit?", options });
  const open = async (id) => (await (await fetch(`${url}/api/items/${id}`)).json());

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const at = () => new URL(page.url().replace("#", "")).searchParams.get("item");
  const on = async (id) => page.waitForFunction((want) => location.hash.endsWith(`item=${want}`), id, { timeout: 5000 });
  const titles = async () => page.locator(".queue .card .card-title").allTextContents();
  const settled = async (want) => {
    for (let i = 0; i < 50; i++) { if (JSON.stringify(await titles()) === JSON.stringify(want)) return; await delay(100); }
    assert.deepEqual(await titles(), want);
  };
  const untouched = async (id) => {
    const { item, replies } = await open(id);
    assert.equal(item.state, "needs_attention");
    assert.deepEqual(replies, []);
    assert.equal(item.snoozedUntil, null);
  };

  // The queue runs d1 (an agent waits), then m1, t1, m2 by age. Start in the list on a milestone.
  await page.goto(`${url}/#/needs?item=${ids.m1}`);
  await page.getByRole("button", { name: "Back of queue", exact: false }).waitFor();
  await settled(["Where should the search panel sit?", "Launch cut one", "Try notebook one", "Launch cut two"]);
  await page.screenshot({ path: join(shots, "1-before-back-of-queue.png") });

  // The button sends the open item behind every other one, even behind the waiting decision, and opens the next.
  await page.getByRole("button", { name: /^Back of queue/ }).click();
  await on(ids.t1);
  await settled(["Where should the search panel sit?", "Try notebook one", "Launch cut two", "Launch cut one"]);
  await untouched(ids.m1);
  assert.ok((await open(ids.m1)).item.backedAt);
  assert.ok((await open(ids.m1)).history.some((e) => e.kind === "item.backqueued"));
  await page.screenshot({ path: join(shots, "2-after-button.png") });

  // The b key does the same for the open item; a later backing goes behind the earlier one.
  await page.keyboard.press("b");
  await on(ids.m2);
  await settled(["Where should the search panel sit?", "Launch cut two", "Launch cut one", "Try notebook one"]);
  await untouched(ids.t1);

  // It is saved by the service, not the page: a reload keeps the order.
  await page.reload();
  await settled(["Where should the search panel sit?", "Launch cut two", "Launch cut one", "Try notebook one"]);
  await page.locator(".queue .card", { hasText: "sent to the back" }).first().waitFor();
  await page.screenshot({ path: join(shots, "3-after-key-and-reload.png") });

  // A refused request leaves the open item where it is, with the error shown.
  await page.route(`**/api/items/${ids.m2}/back-of-queue`, (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "back failed" }) }), { times: 1 });
  await page.getByRole("button", { name: /^Back of queue/ }).click();
  await page.getByRole("alert").getByText("back failed").waitFor();
  assert.equal(at(), ids.m2);

  // In the decision sheet the same button sends the decision behind the rest of the queue.
  await page.goto(`${url}/#/needs?item=${ids.d1}`);
  await page.locator(`[data-decision-id="${ids.d1}"]`).getByRole("button", { name: /^Back of queue/ }).click();
  await untouched(ids.d1);
  assert.ok((await open(ids.d1)).item.backedAt);
  await page.locator(".queue .card, .decision-other button").first().waitFor();
  await page.goto(`${url}/#/needs?item=${ids.m2}`);
  await settled(["Launch cut two", "Launch cut one", "Try notebook one", "Where should the search panel sit?"]);
  await page.screenshot({ path: join(shots, "4-decision-at-back.png") });

  assert.deepEqual(errors, []);
  console.log(`back of queue: ok (screenshots in ${shots})`);
} finally {
  await browser?.close();
  office.kill();
  if (!process.env.SHOTS) await rm(home, { recursive: true, force: true });
  else await rm(join(home, "data"), { recursive: true, force: true });
}
