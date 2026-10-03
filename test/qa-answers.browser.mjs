// Optional browser regression (no Playwright dependency in the service):
// npm run build && PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs [SHOTS=/dir] node test/qa-answers.browser.mjs
// Starts its own isolated office through the scratch launcher (herdr disabled, so every agent is offline), uses headless
// Chromium, and closes both in finally. QA answers: the three-way setting and agent picker, items staying with the founder
// while the QA agent is offline, a QA answer shown as the QA agent's own, and the founder overriding it.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawnScratchOffice } from "../scripts/lib/scratch-office.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const home = await mkdtemp(join(tmpdir(), "inbox-qa-answers-test-"));
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
let browser, page;
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${url}/api/state`)).ok) break; } catch {}
    if (i === 100) throw new Error("Scratch office did not start");
    await delay(100);
  }
  const get = async (path) => (await (await fetch(url + path)).json());
  const post = async (path, body) => {
    const response = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  };
  const project = { name: "Lantern", root: join(home, "lantern") };
  const asker = { harness: "manual", sessionId: "Clara" };
  const qaSession = { harness: "manual", sessionId: "Quinn" };
  // The QA agent becomes an office agent by submitting once, like any agent; its own question stays with the founder.
  await post("/api/agent/items", { session: qaSession, project, task: { title: "QA desk" }, item: { key: "hello", type: "milestone", title: "QA desk ready" } });
  const decision = (await post("/api/agent/items", { session: asker, project, task: { title: "Release" },
    item: { key: "door", type: "decide", title: "Which colour for the door?", request: "I need it for the sign.", options: [{ id: "a", label: "Blue" }, { id: "b", label: "Green" }], recommendation: "Blue" } })).itemId;
  const qaAgent = (await get("/api/world")).agents.find((a) => a.taskIds.length && a.name && a.harness === "manual" && a.identity.includes("Quinn")) ?? (await get("/api/world")).agents.at(0);
  assert.ok(qaAgent, "the QA agent is known to the office");

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await page.getByRole("radiogroup", { name: "Who answers for you" }).waitFor();
  assert.equal(await page.getByRole("radio", { name: "Off" }).getAttribute("aria-checked"), "true");
  await page.screenshot({ path: join(shots, "01-off.png") });

  // QA answers first asks which agent; choosing one turns them on.
  await page.getByRole("radio", { name: "QA answers" }).click();
  const picker = page.getByRole("combobox", { name: "QA agent" });
  await picker.waitFor();
  assert.equal((await get("/api/auto-approve")).mode, "off", "nothing is on until an agent is chosen");
  await page.screenshot({ path: join(shots, "02-choose-agent.png") });
  await picker.selectOption(qaAgent.id);
  const status = page.getByRole("status").filter({ hasText: "with QA agent" });
  await status.waitFor();
  const setting = await get("/api/auto-approve");
  assert.equal(setting.mode, "qa");
  assert.equal(setting.qa.agentId, qaAgent.id);
  // herdr is disabled here, so the QA agent is offline: everything stays with the founder, and nothing was answered.
  assert.match(await status.innerText(), /0 with QA agent · .* is offline: everything is yours · 0 answered · 0 overridden/);
  assert.equal((await get(`/api/items/${decision}`)).replies.length, 0);
  const state = await get("/api/state");
  assert.ok(state.items.every((i) => !i.withQa));
  await page.getByText("Which colour for the door?").first().waitFor();
  await page.screenshot({ path: join(shots, "03-qa-on-offline.png") });

  // The QA agent decides through the office; the founder sees it as the QA agent's own and can override it.
  await post("/api/agent/qa/answer", { session: qaSession, item: decision, revision: 1, action: "choose", choice: "a", reason: "The founder picks the recommended colour for signage." });
  await page.goto(`${url}/#/needs?item=${decision}`);
  // Collapsed, the answer still says whose it is; opening it offers the override.
  await page.getByRole("button", { name: /QA agent answered: Blue/ }).click();
  await page.getByRole("button", { name: "Override QA answer" }).waitFor();
  await page.screenshot({ path: join(shots, "04-qa-answer.png") });
  await page.locator(".decision-details summary").click();
  await page.getByRole("tab", { name: "Conversation", exact: true }).click();
  await page.getByText(/^QA agent · /).waitFor();
  await page.getByText(/QA agent .*, for the founder: The founder picks the recommended colour/).waitFor();
  await page.screenshot({ path: join(shots, "05-qa-answer-history.png") });
  await page.getByRole("button", { name: "Override QA answer" }).click();
  await page.getByText("Your answer overrides the QA agent's for this revision.").waitFor();
  await page.screenshot({ path: join(shots, "06-overriding.png") });
  await page.getByRole("button", { name: /Green/ }).first().click();
  // Answering moves on to the next question; the API and the decision's history both show the override.
  for (let i = 0; (await get(`/api/items/${decision}`)).replies.length < 2; i++) { if (i === 50) break; await delay(100); }
  const detail = await get(`/api/items/${decision}`);
  assert.deepEqual(detail.replies.map((r) => [r.answeredBy, r.overridesQa, r.choice]), [["qa_agent", false, "a"], ["founder", true, "b"]]);
  assert.equal((await get("/api/auto-approve")).qa.overridden, 1);
  await page.goto(`${url}/#/needs?item=${decision}`);
  await page.getByRole("button", { name: /^.*Answered: Green/ }).click();
  await page.locator(".decision-details summary").click();
  await page.getByRole("tab", { name: "Conversation", exact: true }).click();
  await page.getByText("You · overriding the QA agent").first().waitFor();
  await page.screenshot({ path: join(shots, "07-overridden.png") });

  // The office header shows the same setting; at phone width the control stays on screen.
  await page.goto(`${url}/#/world`);
  await page.locator(".world-top").waitFor();
  await page.getByRole("status").filter({ hasText: "with QA agent" }).waitFor();
  await page.screenshot({ path: join(shots, "08-office.png") });
  await page.goto(url);
  await page.setViewportSize({ width: 390, height: 844 });
  const group = page.getByRole("radiogroup", { name: "Who answers for you" });
  await group.waitFor();
  const bounds = await group.boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390, JSON.stringify(bounds));
  for (const part of [page.getByRole("combobox", { name: "QA agent" }), page.getByRole("status").filter({ hasText: "with QA agent" })]) {
    const box = await part.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
  }
  await page.screenshot({ path: join(shots, "09-phone.png") });

  // Off again: the QA agent only predicts (test/qa-predictions.browser.mjs covers that).
  await page.getByRole("radio", { name: "Off" }).click();
  await page.locator('[role="radio"][aria-checked="true"]', { hasText: "Off" }).waitFor();
  assert.equal((await post("/api/agent/qa/next", { session: qaSession })).predicting, true);
  assert.deepEqual(errors, []);
  console.log(`QA answers browser passed: setting, agent picker, offline stays with founder, QA answer marked, override, office header, phone, off predicts. Screenshots: ${shots}`);
} catch (err) {
  await page?.screenshot({ path: join(shots, "failed.png") }).catch(() => {});
  throw err;
} finally {
  await browser?.close();
  await office.stop();
  if (!process.env.SHOTS) await rm(home, { recursive: true, force: true });
}
