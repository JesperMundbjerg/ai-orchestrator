// Optional browser regression (no Playwright dependency in the service):
// npm run build && PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs [SHOTS=/dir] node test/qa-predictions.browser.mjs
// Starts its own isolated office through the scratch launcher (herdr disabled), uses headless Chromium, and closes both in
// finally. Manual mode with a QA agent chosen: its answers are predictions, never sent; the founder sees one only after
// answering, collapsed; the header shows how often it agreed.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawnScratchOffice } from "../scripts/lib/scratch-office.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const home = await mkdtemp(join(tmpdir(), "inbox-qa-predictions-test-"));
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
  await post("/api/agent/items", { session: qaSession, project, task: { title: "QA desk" }, item: { key: "hello", type: "milestone", title: "QA desk ready" } });
  const submit = async (item) => (await post("/api/agent/items", { session: asker, project, task: { title: "Release" }, item })).itemId;
  const decision = await submit({ key: "door", type: "decide", title: "Which colour for the door?", request: "I need it for the sign.", options: [{ id: "a", label: "Blue" }, { id: "b", label: "Green" }], recommendation: "Blue" });
  const milestone = await submit({ key: "sign", type: "milestone", title: "The sign is up" });
  const open = await submit({ key: "font", type: "decide", title: "Which font for the sign?" });
  const world = await get("/api/world");
  const qaAgent = world.agents.find((a) => a.identity.includes("Quinn")) ?? world.agents.at(0);
  assert.ok(qaAgent, "the QA agent is known to the office");
  // Choose the QA agent, then go back to manual mode: it predicts from now on.
  await post("/api/auto-approve", { mode: "qa", agentId: qaAgent.id });
  await post("/api/auto-approve", { mode: "off" });

  // The QA agent predicts all three through the ordinary command path; nothing is sent.
  assert.equal((await post("/api/agent/qa/next", { session: qaSession })).predicting, true);
  const predicted = await post("/api/agent/qa/answer", { session: qaSession, item: decision, revision: 1, action: "choose", choice: "a", reason: "The founder picks the recommendation." });
  assert.equal(predicted.predicted, true);
  await post("/api/agent/qa/answer", { session: qaSession, item: milestone, revision: 1, action: "accept", reason: "Shown as asked." });
  await post("/api/agent/qa/answer", { session: qaSession, item: open, revision: 1, action: "answer", text: "A bold sans serif.", reason: "Signs stay legible." });
  for (const id of [decision, milestone, open]) {
    const detail = await get(`/api/items/${id}`);
    assert.equal(detail.replies.length, 0, "a prediction is never a reply");
    assert.equal(detail.item.state, "needs_attention");
    assert.equal(detail.qaPredictions, undefined, "hidden until the founder answers");
  }

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  const status = page.getByRole("status").filter({ hasText: "QA predicted" });
  await status.waitFor();
  assert.equal(await status.innerText(), "QA predicted 3 · agreed 0 of 0");
  assert.equal(await page.getByRole("radio", { name: "Off" }).getAttribute("aria-checked"), "true");
  await page.getByText("Which colour for the door?").first().waitFor();
  assert.equal(await page.getByText(/QA prediction/).count(), 0, "nothing of the prediction shows before the founder answers");
  await page.screenshot({ path: join(shots, "01-predicted-before-answer.png") });

  // The founder answers the decision differently in the UI: a mismatch, shown only now.
  await page.goto(`${url}/#/needs?item=${decision}`);
  await page.getByRole("button", { name: /Green/ }).first().click();
  for (let i = 0; (await get(`/api/items/${decision}`)).replies.length < 1; i++) { if (i === 50) break; await delay(100); }
  await post(`/api/items/${milestone}/replies`, { revision: 1, action: "accept" });
  await post(`/api/items/${open}/replies`, { revision: 1, action: "answer", text: "A bold sans serif, white on navy." });
  const detail = await get(`/api/items/${decision}`);
  assert.deepEqual(detail.replies.map((r) => [r.answeredBy, r.choice]), [["founder", "b"]]);
  assert.deepEqual(detail.qaPredictions.map((p) => [p.choice, p.verdict]), [["a", "mismatch"]]);
  await page.goto(`${url}/#/needs?item=${decision}`);
  await page.reload(); // the same hash does not navigate
  await page.getByRole("button", { name: /Answered: Green/ }).click();
  await page.locator(".decision-details summary").click();
  await page.getByRole("tab", { name: "Conversation", exact: true }).click();
  const prediction = page.locator("details.qa-prediction");
  await prediction.waitFor();
  assert.equal(await prediction.evaluate((d) => d.open), false, "collapsed");
  assert.equal(await prediction.locator("summary").innerText(), "QA prediction (not sent) · differed from you");
  await page.screenshot({ path: join(shots, "02-history-collapsed.png") });
  await prediction.locator("summary").click();
  await prediction.getByText("Why: The founder picks the recommendation.").waitFor();
  await page.screenshot({ path: join(shots, "03-history-open.png") });

  // The header: one match, one mismatch, one in words still to judge; then the QA agent judges it.
  await page.goto(url);
  await status.filter({ hasText: "to judge" }).waitFor();
  assert.equal(await status.innerText(), "QA predicted 3 · agreed 1 of 2 (50%) · 1 to judge");
  await page.screenshot({ path: join(shots, "04-header-to-judge.png") });
  const feed = await post("/api/agent/qa/answers", { session: qaSession });
  assert.deepEqual(feed.answers.map((a) => a.predicted?.verdict ?? null), ["mismatch", "match", "needs_judging"]);
  await post("/api/agent/qa/judge", { session: qaSession, item: open, revision: 1, agrees: true });
  await page.reload();
  await status.filter({ hasText: "(67%)" }).waitFor();
  assert.equal(await status.innerText(), "QA predicted 3 · agreed 2 of 3 (67%)");
  await page.screenshot({ path: join(shots, "05-header-judged.png") });

  // At phone width the agreement stays on screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await status.waitFor();
  const box = await status.boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
  await page.screenshot({ path: join(shots, "06-phone.png") });
  assert.deepEqual(errors, []);
  console.log(`QA predictions browser passed: predictions never sent, hidden until answered, collapsed in history, header rate, judging, phone. Screenshots: ${shots}`);
} catch (err) {
  await page?.screenshot({ path: join(shots, "failed.png") }).catch(() => {});
  throw err;
} finally {
  await browser?.close();
  await office.stop();
  if (!process.env.SHOTS) await rm(home, { recursive: true, force: true });
}
