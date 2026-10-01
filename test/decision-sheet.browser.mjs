// Optional browser regression (no Playwright dependency in the service):
// npm run build && PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/decision-sheet.browser.mjs
// Starts its own isolated office, uses headless Chromium, and closes both in finally.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const home = await mkdtemp(join(tmpdir(), "inbox-decision-test-"));
const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
assert.notEqual(port, 4870);
const url = `http://localhost:${port}`;
const office = spawn(process.execPath, ["src/server/main.ts"], {
  env: { ...process.env, HOME: home, INBOX_DATA_DIR: join(home, "data"), INBOX_PORT: String(port), HERDR_BIN_PATH: join(home, "no-herdr"), HERDR_SOCKET_PATH: join(home, "no.sock") },
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
  const options = [{ id: "a", label: "Overlay", consequence: "Keep the stage wide; cover the slider." }, { id: "b", label: "Docked", consequence: "Narrow the stage; keep every control visible." }];
  const submissions = [
    { title: "Where should the tutor sit?", lead: "Clara", project: "Fysik Lab", options, recommendation: "Docked, because students need to see the slider." },
    { title: "Should sound start off?", lead: "Clara", project: "Fysik Lab", options: [{ id: "a", label: "Sound off", consequence: "Students choose when to listen." }, { id: "b", label: "Sound on", consequence: "Narration starts immediately." }] },
    { title: "How should uncertain receipts be handled?", lead: "Agnes", project: "Accounts", options },
    { title: "What should the video closing line say?", lead: "Theo", project: "Motion video", options: [] },
  ].map(({ lead, project, ...item }, index) => ({
    session: { harness: "manual", sessionId: lead },
    project: { name: project, root: join(home, project) }, task: { title: lead, objective: "Prepare the release" },
    item: { key: `question-${index}`, type: "decide", request: "Until you answer, I’ll keep the current version.", context: "Both approaches work on desktop and mobile.", ...item },
  }));
  const ids = [];
  for (const submission of submissions) ids.push((await post("/api/agent/items", submission)).itemId);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const requests = [];
  page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/replies")) requests.push(request.postDataJSON()); });
  await page.goto(url);
  const card = (index) => page.locator(`[data-decision-id="${ids[index]}"]`);
  await page.getByText("4 remaining", { exact: true }).waitFor();
  await card(0).getByRole("button", { name: /^Docked/ }).waitFor();
  assert.equal(await page.locator(".decision-card").count(), 4);
  assert.equal(await page.locator(".tabs:visible").count(), 0);
  assert.equal(await page.locator("textarea:visible").count(), 1);
  await card(0).locator("summary").click();
  await card(0).getByText("Both approaches work on desktop and mobile.", { exact: true }).waitFor();
  await card(0).locator("summary").click();
  // A refused answer stays expanded, surfaces the error, and can be retried.
  await page.route(`**/api/items/${ids[0]}/replies`, (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "stale: revision changed" }) }), { times: 1 });
  await card(0).getByRole("button", { name: /^Docked/ }).click();
  await card(0).getByRole("alert").waitFor();
  assert.equal(await card(0).locator(".decision-receipt").count(), 0);
  await card(0).getByRole("button", { name: /^Docked/ }).click();
  await card(0).getByText("Answered: Docked", { exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement?.textContent === "Should sound start off?");
  await page.getByText("3 remaining", { exact: true }).waitFor();
  await card(1).getByRole("button", { name: "Add a note", exact: true }).click();
  await card(1).getByRole("textbox", { name: "Optional note" }).fill("Keep mute visible.");
  await card(1).getByRole("button", { name: /^Sound off/ }).focus();
  await page.keyboard.press("Space");
  await card(1).getByText("Answered: Sound off", { exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement?.textContent === "How should uncertain receipts be handled?");
  await card(2).getByRole("button", { name: "Other / discuss", exact: true }).click();
  await card(2).locator("textarea").fill("Review only the larger receipts.");
  await card(2).getByRole("button", { name: "Send to the agent", exact: true }).click();
  await card(2).getByText("Answered: Review only the larger receipts.", { exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement?.textContent === "What should the video closing line say?");
  const answer = card(3).getByRole("textbox", { name: "Your answer" });
  assert.ok(await card(3).getByRole("button", { name: "Answer", exact: true }).isDisabled());
  await answer.fill("Make room");
  await answer.press("Shift+Enter");
  await answer.press("End");
  await answer.pressSequentially("for discovery.");
  await answer.press("Enter");
  await card(3).getByText("Answered: Make room for discovery.", { exact: true }).waitFor();
  await page.getByText("All caught up", { exact: true }).waitFor();
  assert.deepEqual(requests.map((r) => r.action), ["choose", "choose", "choose", "discuss", "answer"]);
  assert.equal(requests[2].text, "Keep mute visible.");
  assert.equal(requests[4].text, "Make room\nfor discovery.");
  assert.ok(requests.every((r) => r.revision === 1 && r.id && Array.isArray(r.images)));
  // A new revision reopens the receipt. Snooze still calls the existing endpoint.
  await post("/api/agent/items", { ...submissions[0], item: { ...submissions[0].item, context: "New evidence changes the trade-off." } });
  await card(0).getByRole("button", { name: /^Docked/ }).waitFor();
  await page.getByText("1 remaining", { exact: true }).waitFor();
  await card(0).getByRole("button", { name: "Later ▾", exact: true }).click();
  await card(0).getByRole("button", { name: /Snooze 1/ }).click();
  await page.getByText("All caught up", { exact: true }).waitFor();
  const snoozed = await (await fetch(`${url}/api/items/${ids[0]}`)).json();
  assert.equal(snoozed.item.state, "snoozed");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByRole("button", { name: "Navigation", exact: true }).click();
  await page.getByRole("button", { name: /All repositories/ }).waitFor();
  // Non-decision items still open in their original detail views, from the sheet.
  const milestone = await post("/api/agent/items", { ...submissions[0], item: { key: "cut", type: "milestone", title: "The launch cut is ready", context: "Checked both languages." } });
  const preview = await post("/api/agent/items", { ...submissions[0], item: { key: "preview", type: "try", title: "Try the new lesson", check: "Move the slider.", preview: { url, viewport: "desktop" } } });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: /The launch cut is ready/ }).click();
  await page.getByRole("button", { name: "Accept milestone", exact: true }).waitFor();
  assert.equal(await page.locator(".decision-sheet").count(), 0);
  await page.getByRole("tab", { name: "Context", exact: true }).waitFor();
  await page.getByRole("button", { name: "Accept milestone", exact: true }).click();
  await page.getByRole("button", { name: "Add a message", exact: true }).waitFor();
  assert.equal((await (await fetch(`${url}/api/items/${milestone.itemId}`)).json()).replies[0].action, "accept");
  await page.goto(`${url}/#/needs?item=${preview.itemId}`);
  await page.getByRole("button", { name: "Approve", exact: true }).waitFor();
  await page.getByRole("button", { name: "Try it", exact: true }).waitFor();
  assert.ok(await page.getByRole("button", { name: "Needs changes", exact: true }).isDisabled());
  assert.equal(await page.locator(".decision-sheet").count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS: decision sheet, Details, stale refusal, native keyboard choices, optional note, Other, multiline open answer, revision reopening, snooze, mobile navigation, unchanged milestone/try views and reply payloads.");
} finally {
  await browser?.close();
  office.kill("SIGTERM");
  await new Promise((resolve) => office.exitCode !== null ? resolve() : office.once("exit", resolve));
  await rm(home, { recursive: true, force: true });
}
