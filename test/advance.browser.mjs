// Optional browser regression (no Playwright dependency in the service):
// npm run build && PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/advance.browser.mjs
// Starts its own isolated office, uses headless Chromium, and closes both in finally.
// Every successful response to an item opens the next one needing you; a refused one stays put.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const home = await mkdtemp(join(tmpdir(), "inbox-advance-test-"));
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
  ids.d1 = await submit("Theo", "d1", { type: "decide", title: "Where should the search panel sit?", options });
  ids.m2 = await submit("Emil", "m2", { type: "milestone", title: "Launch cut two" });
  ids.t2 = await submit("Nora", "t2", { type: "try", title: "Try notebook two", check: "Open it.", preview: { url, viewport: "desktop" } });
  ids.m3 = await submit("Wren", "m3", { type: "milestone", title: "Launch cut three" });
  ids.t3 = await submit("Ivy", "t3", { type: "try", title: "Try notebook three", check: "Open it.", preview: { url, viewport: "desktop" } });
  const open = async (id) => (await (await fetch(`${url}/api/items/${id}`)).json());
  const action = async (id) => (await open(id)).replies.at(-1)?.action;
  const state = async (id) => (await open(id)).item.state;

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const at = () => new URL(page.url().replace("#", "")).searchParams.get("item");
  const on = async (id) => {
    try { await page.waitForFunction((want) => location.hash.endsWith(`item=${want}`), id, { timeout: 5000 }); }
    catch (e) { throw new Error(`Expected item ${id}, at ${page.url()} (items ${JSON.stringify(ids)})`, { cause: e }); }
  };

  // Decisions an agent waits on come first, so the queue runs d1, m1, t1, m2, t2, m3, t3.
  await page.goto(`${url}/#/needs?item=${ids.d1}`);

  // A decision answered in the sheet carries on to what else needs you.
  await page.locator(`[data-decision-id="${ids.d1}"]`).getByRole("button", { name: /^Docked/ }).click();
  await on(ids.m1);
  assert.equal(await action(ids.d1), "choose");

  // Accept a milestone: the next item opens by itself, in Next's order.
  await page.getByRole("button", { name: "Accept milestone", exact: true }).click();
  await on(ids.t1);
  assert.equal(await action(ids.m1), "accept");

  // Approve a try item with a note.
  await page.getByRole("button", { name: "Approve", exact: true }).waitFor();
  await page.getByRole("textbox", { name: "Optional note" }).fill("Looks good.");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await on(ids.m2);
  assert.equal(await action(ids.t1), "accept");

  // Request changes advances too.
  await page.getByRole("textbox", { name: "Optional note" }).fill("Please redo the intro.");
  await page.getByRole("button", { name: "Request changes", exact: true }).click();
  await on(ids.t2);
  assert.equal(await action(ids.m2), "request_changes");

  // Discuss advances.
  await page.getByRole("button", { name: "Discuss", exact: true }).click();
  await page.locator(".discuss textarea").fill("Why this approach?");
  await page.getByRole("button", { name: "Send to the agent", exact: true }).click();
  await on(ids.m3);
  assert.equal(await action(ids.t2), "discuss");

  // A refused response stays on the item with the error visible, and nothing advances.
  await page.route(`**/api/items/${ids.m3}/replies`, (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "stale: revision changed" }) }), { times: 1 });
  await page.getByRole("button", { name: "Accept milestone", exact: true }).click();
  await page.getByRole("alert").getByText("stale: revision changed").waitFor();
  await delay(300);
  assert.equal(at(), ids.m3);
  assert.equal(await state(ids.m3), "needs_attention");
  // A refused snooze stays too.
  await page.route(`**/api/items/${ids.m3}/snooze`, (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "snooze failed" }) }), { times: 1 });
  await page.getByRole("button", { name: "Later ▾", exact: true }).click();
  await page.getByRole("button", { name: /Snooze 1/ }).click();
  await page.getByRole("alert").getByText("snooze failed").waitFor();
  assert.equal(at(), ids.m3);

  // Snooze moves on once it works.
  await page.getByRole("button", { name: /Snooze 1/ }).click();
  await on(ids.t3);
  assert.equal(await state(ids.m3), "snoozed");

  // The last item needing you: the empty state, not the answered item.
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.waitForFunction(() => !location.hash.includes("item="));
  await page.getByText(/All caught up|Nothing needs you right now/).first().waitFor();
  assert.equal(await action(ids.t3), "accept");
  assert.deepEqual(errors, []);
  console.log("PASS: accept, approve, choose, request changes, discuss and snooze each open the next item; refused requests stay put; the last one shows the empty state.");
} finally {
  await browser?.close();
  office.kill("SIGTERM");
  await new Promise((resolve) => office.exitCode !== null ? resolve() : office.once("exit", resolve));
  await rm(home, { recursive: true, force: true });
}
