// npm run build && PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node test/pagecomments.browser.mjs
// A page on another localhost port embeds the office's comment widget with the loader, picks a
// team and sends; the comment reaches that team's lead as a founder message with the page context.
// Scratch office: own free port, temporary HOME/data, no herdr, no integrations, headless only.
// Optional SCREENSHOT_DIR.
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { createServer as createHttp } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawnScratchOffice } from "../scripts/lib/scratch-office.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const home = await mkdtemp(join(tmpdir(), "pagecomments-browser-"));
const freePort = async () => {
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  assert.notEqual(port, 4870);
  return port;
};
const port = await freePort();
const hostPort = await freePort();
const url = `http://localhost:${port}`;
const shots = process.env.SCREENSHOT_DIR ?? join(home, "screenshots");
await mkdir(shots, { recursive: true });

// The host page: an ordinary page on another origin that includes the office's loader.
const hostPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Orbits lesson</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:24px 28px;background:#fff;color:#1d1d1f;max-width:760px}h1{margin-top:0}.chart{height:180px;border:1px solid #ccd;border-radius:8px;background:linear-gradient(135deg,#eef3ff,#f9fbff);display:grid;place-items:center;color:#556}</style></head>
<body><h1>Orbits</h1><p id="intro">A planet's orbit is an ellipse with the star at one focus.</p><div class="chart" id="chart">Orbit chart</div>
<script>window.events=[];for(const t of ["office-comment:sent","office-comment:error"])addEventListener(t,(e)=>window.events.push(e.detail));</script>
<script src="${url}/embed/loader.js" data-default-team="" async></script></body></html>`;
const host = createHttp((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(hostPage); });
await new Promise((resolve) => host.listen(hostPort, "127.0.0.1", resolve));

let office, browser;
const call = async (method, path, body) => {
  const res = await fetch(url + path, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const out = await res.json();
  if (!res.ok) throw new Error(`${path}: ${out.error}`);
  return out;
};
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
  // A lead for "Dispatch" (an agent that once submitted an item), and a second team to pick from.
  const leadCwd = join(home, "lead");
  await call("POST", "/api/agent/items", { session: { harness: "claude", sessionId: "s-lead", cwd: leadCwd }, project: { name: "lessons" }, item: { type: "milestone", title: "Lesson ready" } });
  const dispatch = await call("POST", "/api/world/teams", { name: "Dispatch", standing: true, purpose: "Routes review comments to the crew" });
  await call("POST", "/api/world/teams", { name: "Atlas", standing: true, purpose: "Maps and charts" });
  const world = await call("GET", "/api/world");
  const lead = world.agents.find((a) => a.cwd === leadCwd);
  await call("PATCH", `/api/world/agents/${lead.id}`, { teamId: dispatch.id, role: "lead" });

  browser = await chromium.launch({ headless: true });
  const errors = [];
  const visit = async (viewport, origin = `http://localhost:${hostPort}`) => {
    const page = await browser.newPage({ viewport });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${origin}/lessons/orbits#chart`);
    return page;
  };
  const openWidget = async (page) => {
    await page.getByRole("button", { name: "Comment" }).waitFor();
    // Select the intro sentence, then open: the loader takes the selection while the button is pressed.
    await page.evaluate(() => { const r = document.createRange(); r.selectNodeContents(document.getElementById("intro")); getSelection().removeAllRanges(); getSelection().addRange(r); });
    await page.getByRole("button", { name: "Comment" }).click();
    const widget = page.frameLocator('iframe[title="Comment to a team"]');
    await widget.getByLabel("Team").waitFor();
    await widget.getByText(/^On "Orbits lesson"/).waitFor();
    return widget;
  };

  // Desktop: pick Dispatch, comment, send.
  const desk = await visit({ width: 1440, height: 900 });
  let widget = await openWidget(desk);
  await desk.screenshot({ path: join(shots, "01-desktop-open.png") });
  await widget.getByLabel("Team").selectOption({ label: `Dispatch (${lead.name}, offline)` });
  await widget.getByLabel("Comment").fill("The chart needs axis labels; students cannot tell what is plotted.");
  await widget.getByRole("button", { name: "Send" }).click();
  await widget.getByText("Sent to Dispatch.").waitFor();
  await desk.screenshot({ path: join(shots, "02-desktop-sent.png") });
  const events = await desk.evaluate(() => window.events);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "office-comment:sent");
  assert.equal(events[0].teamId, dispatch.id);

  // The message: one founder instruction to Dispatch's lead, with the page context on top.
  const after = await call("GET", "/api/world");
  const sent = after.withFounder.filter((m) => m.teamId === dispatch.id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].fromAgentId, null);
  assert.deepEqual(sent[0].deliveries.map((d) => d.agentId), [lead.id]);
  assert.match(sent[0].text, new RegExp(`^\\[Page comment\\]\\nOn "Orbits lesson" http://localhost:${hostPort}/lessons/orbits#chart\\nAt: #chart · viewport 1440x900\\nSelected: "A planet's orbit is an ellipse with the star at one focus\\."\\n\\nThe chart needs axis labels`));

  // The office shows it as from the founder: the team board lists the message.
  const officePage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  officePage.on("pageerror", (e) => errors.push(e.message));
  await officePage.goto(`${url}/#/world`);
  await officePage.locator(".world-top").waitFor();
  await officePage.getByText("Dispatch").first().click().catch(() => {});
  await delay(800);
  const shownInOffice = await officePage.getByText("The chart needs axis labels", { exact: false }).count();
  await officePage.screenshot({ path: join(shots, "03-office.png") });
  await officePage.close();

  // The widget remembers the last team for this page origin.
  await desk.reload();
  widget = await openWidget(desk);
  assert.equal(await widget.getByLabel("Team").inputValue(), dispatch.id);
  await desk.close();

  // Phone width: the button and panel fit; send again.
  const phone = await visit({ width: 390, height: 844 });
  widget = await openWidget(phone);
  assert.equal(await widget.getByLabel("Team").inputValue(), dispatch.id, "with nothing remembered (a fresh browser), the first team with a lead");
  const box = await phone.locator('iframe[title="Comment to a team"]').boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 390, "the panel fits a phone");
  await widget.getByLabel("Comment").fill("On phones the chart is cut off at the right.");
  await phone.screenshot({ path: join(shots, "04-phone-open.png") });
  await widget.getByRole("button", { name: "Send" }).click();
  await widget.getByText("Sent to Dispatch.").waitFor();
  await phone.screenshot({ path: join(shots, "05-phone-sent.png") });
  await phone.close();

  // A page origin the founder did not allow cannot frame the widget at all.
  await call("PUT", "/api/page-comments/origins", { origins: [`http://localhost:${hostPort}`] });
  const other = await visit({ width: 1440, height: 900 }, `http://127.0.0.1:${hostPort}`);
  await other.getByRole("button", { name: "Comment" }).click();
  await delay(1500);
  const blocked = await other.frameLocator('iframe[title="Comment to a team"]').getByLabel("Team").count();
  assert.equal(blocked, 0, "frame-ancestors keeps the widget out of a page that is not allowed");
  await other.screenshot({ path: join(shots, "06-not-allowed.png") });
  await other.close();

  // The API itself still refuses that page's origin.
  const cross = await fetch(`${url}/api/page-comments/teams/${dispatch.id}/comments`, { method: "POST", headers: { "content-type": "application/json", origin: `http://localhost:${hostPort}` }, body: JSON.stringify({ text: "direct" }) });
  assert.equal(cross.status, 403);

  assert.equal((await call("GET", "/api/world")).withFounder.filter((m) => m.teamId === dispatch.id).length, 2);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, shots, shownInOffice }));
} finally {
  await browser?.close();
  await office?.stop();
  await new Promise((resolve) => host.close(resolve));
}
