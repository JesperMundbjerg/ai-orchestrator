// Optional browser regression (no Playwright dependency in the service):
// npm run build && PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs [SHOTS=/dir] node test/qa-answers.browser.mjs
// Starts its own isolated office through the scratch launcher (herdr disabled; test/qa-agent.fixture.ts fakes the QA agent's
// start, so nothing really starts), uses headless Chromium, and closes both in finally. QA answers: the three-way setting
// and model picker, QA answers waiting for the agent the office starts, a QA answer shown as the QA agent's own, the
// founder overriding it, and items returning to the founder once the QA agent is gone.
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
const office = await spawnScratchOffice(process.execPath, ["test/qa-agent.fixture.ts"], {
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
  const decision = (await post("/api/agent/items", { session: asker, project, task: { title: "Release" },
    item: { key: "door", type: "decide", title: "Which colour for the door?", request: "I need it for the sign.", options: [{ id: "a", label: "Blue" }, { id: "b", label: "Green" }], recommendation: "Blue" } })).itemId;

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await page.getByRole("radiogroup", { name: "Who answers for you" }).waitFor();
  assert.equal(await page.getByRole("radio", { name: "Off" }).getAttribute("aria-checked"), "true");
  await page.screenshot({ path: join(shots, "01-off.png") });

  // QA answers first asks for the QA agent's model; the office starts one on it, and QA answers turn on once it runs.
  await page.getByRole("radio", { name: "QA answers" }).click();
  const picker = page.getByRole("combobox", { name: "QA model" });
  await picker.waitFor();
  assert.equal((await get("/api/auto-approve")).mode, "off", "nothing is on until a model is picked");
  await page.screenshot({ path: join(shots, "02-choose-model.png") });
  await picker.selectOption({ label: "Opus 5.5 · medium (Claude Code)" });
  await page.waitForFunction(() => document.querySelector('[aria-label="QA model"]')?.title.includes("starting"));
  assert.equal(await page.getByRole("status", { name: "QA agent" }).count(), 0, "agent status is not rendered in the header");
  assert.equal((await get("/api/auto-approve")).mode, "off", "QA answers wait for their agent");
  assert.equal(await page.getByRole("radio", { name: "QA answers" }).getAttribute("aria-checked"), "true");
  await page.screenshot({ path: join(shots, "03-starting.png") });
  await page.waitForFunction(() => document.querySelector('[aria-label="QA model"]')?.title.includes("online"), undefined, { timeout: 10_000 });
  const pickerTitle = await picker.getAttribute("title");
  assert.match(pickerTitle, /1 with QA agent · 0 answered · 0 overridden/);
  assert.equal(await page.getByRole("status").filter({ hasText: "with QA agent" }).count(), 0, "QA counts are not rendered in the header");
  const setting = await get("/api/auto-approve");
  assert.equal(setting.mode, "qa");
  assert.equal(setting.qa.agentId, setting.qaAgent.agentId);
  const qaAgent = (await get("/api/world")).agents.find((a) => a.id === setting.qa.agentId);
  assert.ok(qaAgent?.paneId, "the started QA agent is in the office");
  const qaSession = { harness: "claude", sessionId: "qa-fixture", paneId: qaAgent.paneId };
  // It runs, so the decision is with it and out of Needs you; nothing was answered.
  assert.equal((await get(`/api/items/${decision}`)).replies.length, 0);
  assert.deepEqual((await get("/api/state")).items.filter((i) => i.withQa).map((i) => i.id), [decision]);
  await page.screenshot({ path: join(shots, "04-qa-on-online.png") });

  // The QA agent decides through the office; the founder sees it as the QA agent's own and can override it.
  await post("/api/agent/qa/answer", { session: qaSession, item: decision, revision: 1, action: "choose", choice: "a", reason: "The founder picks the recommended colour for signage." });
  await page.goto(`${url}/#/needs?item=${decision}`);
  // Collapsed, the answer still says whose it is; opening it offers the override.
  await page.getByRole("button", { name: /QA agent answered: Blue/ }).click();
  await page.getByRole("button", { name: "Override QA answer" }).waitFor();
  await page.screenshot({ path: join(shots, "05-qa-answer.png") });
  await page.locator(".decision-details summary").click();
  await page.getByRole("tab", { name: "Conversation", exact: true }).click();
  await page.getByText(/^QA agent · /).waitFor();
  await page.getByText(/QA agent .*, for the founder: The founder picks the recommended colour/).waitFor();
  await page.screenshot({ path: join(shots, "06-qa-answer-history.png") });
  await page.getByRole("button", { name: "Override QA answer" }).click();
  await page.getByText("Your answer overrides the QA agent's for this revision.").waitFor();
  await page.screenshot({ path: join(shots, "07-overriding.png") });
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
  await page.screenshot({ path: join(shots, "08-overridden.png") });

  // The office header shows the same setting; at phone width the control stays on screen.
  await page.goto(`${url}/#/world`);
  await page.locator(".world-top").waitFor();
  await page.getByRole("combobox", { name: "QA model" }).waitFor();
  assert.match(await page.getByRole("combobox", { name: "QA model" }).getAttribute("title"), /0 with QA agent · 1 answered · 1 overridden/);
  await page.screenshot({ path: join(shots, "09-office.png") });
  await page.goto(url);
  await page.setViewportSize({ width: 390, height: 844 });
  const group = page.getByRole("radiogroup", { name: "Who answers for you" });
  await group.waitFor();
  const bounds = await group.boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390, JSON.stringify(bounds));
  for (const part of [page.getByRole("combobox", { name: "QA model" })]) {
    const box = await part.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
  }
  await page.screenshot({ path: join(shots, "10-phone.png") });

  // QA answers keep their agent: none is refused while they are on.
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(await page.getByRole("combobox", { name: "QA model" }).locator("option", { hasText: "none" }).evaluate((o) => o.disabled), true);
  const refused = await fetch(`${url}/api/auto-approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "qa", qaModel: null }) });
  assert.equal(refused.status, 400);
  // Off again: the QA agent only predicts (test/qa-predictions.browser.mjs covers that); none then closes it.
  await page.getByRole("radio", { name: "Off" }).click();
  await page.locator('[role="radio"][aria-checked="true"]', { hasText: "Off" }).waitFor();
  assert.equal((await post("/api/agent/qa/next", { session: qaSession })).predicting, true);
  await page.getByRole("combobox", { name: "QA model" }).selectOption("");
  for (let i = 0; (await get("/api/world")).agents.some((a) => a.id === qaAgent.id); i++) { if (i === 50) break; await delay(100); }
  assert.ok(!(await get("/api/world")).agents.some((a) => a.id === qaAgent.id), "the office closed the QA agent it started");
  assert.equal((await get("/api/auto-approve")).qa, null);
  assert.deepEqual(errors, []);
  console.log(`QA answers browser passed: setting, model picker, start then QA answers on, QA answer marked, override, office header, phone, none refused in QA answers, off predicts, none closes it. Screenshots: ${shots}`);
} catch (err) {
  await page?.screenshot({ path: join(shots, "failed.png") }).catch(() => {});
  throw err;
} finally {
  await browser?.close();
  await office.stop();
  if (!process.env.SHOTS) await rm(home, { recursive: true, force: true });
}
