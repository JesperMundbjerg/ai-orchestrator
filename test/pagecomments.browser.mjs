// npm run build && PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node test/pagecomments.browser.mjs
// A page on another localhost port embeds the office's comment widget with the loader, picks a
// team and sends; the comment reaches that team's lead as a founder message with the page context.
// The lead asks, the founder answers in the widget; the host page verifies the fix as still wrong
// through the loader; a group is collected and sent from the widget; the office panel verifies a fix.
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
<p><button type="button" id="step">Comment on step 2</button></p><p id="fixed" hidden>Fixed: <a id="fixed-link"></a></p>
<script>window.events=[];window.statuses=[];for(const t of ["office-comment:sent","office-comment:error"])addEventListener(t,(e)=>window.events.push(e.detail));
addEventListener("office-comment:status",(e)=>{window.statuses.push(e.detail);if(e.detail.status==="fixed"){const a=document.getElementById("fixed-link");a.href=e.detail.openUrl;a.textContent=e.detail.openUrl+" ("+e.detail.note+", step "+e.detail.meta.step+")";document.getElementById("fixed").hidden=false;}});
document.getElementById("step").onclick=()=>window.officeComment.open({openUrl:location.origin+"/lessons/orbits?step=2",meta:{lesson:"orbits",step:2},selector:"#chart"});</script>
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
  await call("POST", "/api/agent/items", { session: { harness: "claude", sessionId: "s-lead", cwd: leadCwd }, project: { name: "lessons" }, item: { type: "milestone", fixed: "Fixed.", title: "Lesson ready" } });
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
  const openWidget = async (page, via = "Comment") => {
    await page.getByRole("button", { name: "Comment", exact: true }).waitFor();
    // Select the intro sentence, then open: the loader takes the selection while the button is pressed.
    await page.evaluate(() => { const r = document.createRange(); r.selectNodeContents(document.getElementById("intro")); getSelection().removeAllRanges(); getSelection().addRange(r); });
    await page.getByRole("button", { name: via, exact: true }).click();
    const widget = page.frameLocator('iframe[title="Comment to a team"]');
    await widget.getByLabel("Team").waitFor();
    await widget.getByText(/^On "Orbits lesson"/).waitFor();
    return widget;
  };

  // Desktop: pick Dispatch, comment, send.
  const desk = await visit({ width: 1440, height: 900 });
  let widget = await openWidget(desk, "Comment on step 2");
  await desk.screenshot({ path: join(shots, "01-desktop-open.png") });
  await widget.getByLabel("Team").selectOption({ label: `Dispatch (${lead.name}, offline)` });
  await widget.getByLabel("Comment").fill("The chart needs axis labels; students cannot tell what is plotted.");
  await widget.getByLabel("Kind (optional)").fill("bug");
  await widget.getByRole("button", { name: "Send" }).click();
  await widget.getByText(/^Sent to Dispatch: /).waitFor();
  await desk.screenshot({ path: join(shots, "02-desktop-sent.png") });
  const events = await desk.evaluate(() => window.events);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "office-comment:sent");
  assert.equal(events[0].teamId, dispatch.id);
  const commentId = events[0].id;
  assert.match(commentId, /^pc-[0-9a-f]{10}$/);

  // The message: one founder instruction to Dispatch's lead, with the page context on top.
  const after = await call("GET", "/api/world");
  const sent = after.withFounder.filter((m) => m.teamId === dispatch.id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].fromAgentId, null);
  assert.deepEqual(sent[0].deliveries.map((d) => d.agentId), [lead.id]);
  assert.match(sent[0].text, new RegExp(`^\\[Page comment · bug\\]\\nOn "Orbits lesson" http://localhost:${hostPort}/lessons/orbits#chart\\nAt: element #chart · #chart · viewport 1440x900\\n`));
  assert.match(sent[0].text, new RegExp(`The chart needs axis labels[^]*Open to check: http://localhost:${hostPort}/lessons/orbits\\?step=2[^]*inbox comment fixed ${commentId}`));
  const queued = await call("GET", `/api/page-comments/${commentId}`);
  assert.deepEqual(queued.meta, { lesson: "orbits", step: 2 });
  assert.equal(queued.status, "queued", "the lead is offline, so it waits in the office's queue");

  // The lead asks (as `inbox comment ask` would); the widget shows the question and the founder answers there.
  await call("POST", `/api/page-comments/${commentId}/ask`, { question: "Which axis matters most: time or distance?" });
  await widget.getByText("Which axis matters most: time or distance?").waitFor();
  await desk.screenshot({ path: join(shots, "02a-desktop-question.png") });
  await widget.getByLabel("Answer to Dispatch").fill("Time on x, distance on y.");
  await widget.getByRole("button", { name: "Answer", exact: true }).click();
  for (let i = 0; (await call("GET", `/api/page-comments/${commentId}`)).status !== "working"; i++) { if (i === 50) throw new Error("not answered"); await delay(100); }
  assert.equal((await call("GET", `/api/page-comments/${commentId}`)).answer, "Time on x, distance on y.");
  await widget.getByText("Which axis matters most").waitFor({ state: "detached" });
  const answerMessage = (await call("GET", "/api/world")).withFounder.find((m) => m.teamId === dispatch.id && m.text.includes(`[Page comment ${commentId} answered]`));
  assert.ok(answerMessage, "the answer reaches the lead as a message on the comment");

  // The lead fixes it (as the CLI would); the host page hears "fixed" with the fixer's url and shows it.
  const fixUrl = `http://localhost:${hostPort}/lessons/orbits?step=2#axes`;
  await call("POST", `/api/page-comments/${commentId}/status`, { status: "fixed", url: fixUrl, note: "Labelled both axes", commit: "abc1234" });
  await desk.locator("#fixed").waitFor();
  assert.equal(await desk.locator("#fixed-link").getAttribute("href"), fixUrl);
  const statuses = await desk.evaluate(() => window.statuses);
  assert.deepEqual(statuses.filter((e) => e.id === commentId).map((e) => e.status).slice(-1), ["fixed"]);
  await desk.screenshot({ path: join(shots, "02b-desktop-fixed.png") });

  // The host page checks the fix through the loader: still wrong opens a follow-up that names it.
  const verdict = await desk.evaluate((id) => window.officeComment.verify(id, "still-wrong", "The y label is cut off."), commentId);
  assert.deepEqual(verdict.map((e) => e.id === commentId ? e.verification : e.followsUp), ["still-wrong", commentId]);
  const followUpId = verdict[1].id;
  const refused = await desk.evaluate(() => window.officeComment.verify("pc-0000000000", "verified").then(() => "ok", (e) => e.message));
  assert.match(refused, /no page comment/);

  // The office shows it as from the founder: the team board lists the message.
  const officePage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  officePage.on("pageerror", (e) => errors.push(e.message));
  await officePage.goto(`${url}/#/world`);
  await officePage.locator(".world-top").waitFor();
  await officePage.getByText("Dispatch").first().click().catch(() => {});
  await officePage.getByText("Page comments").waitFor();
  const shownInOffice = await officePage.getByText("The chart needs axis labels", { exact: false }).count();
  assert.ok(shownInOffice >= 2, "in the team's thread and in its page-comment queue");
  assert.ok(await officePage.getByText("fixed: Labelled both axes").count(), "the queue shows its status and note");
  assert.ok(await officePage.getByText("still wrong", { exact: true }).count(), "and the founder's check");
  assert.ok(await officePage.getByText(`follows up ${commentId}`, { exact: false }).count(), "the follow-up names the fixed comment");
  // The follow-up is fixed too; the founder verifies it in the panel.
  await call("POST", `/api/page-comments/${followUpId}/status`, { status: "fixed", note: "Moved the label in" });
  await officePage.getByRole("button", { name: "Verified" }).waitFor();
  await officePage.screenshot({ path: join(shots, "03-office.png") });
  await officePage.getByRole("button", { name: "Verified" }).click();
  for (let i = 0; (await call("GET", `/api/page-comments/${followUpId}`)).verification !== "verified"; i++) { if (i === 50) throw new Error("not verified"); await delay(100); }
  assert.deepEqual((await call("GET", `/api/page-comments?team=${dispatch.id}&verified=true`)).comments.map((c) => c.id), [followUpId]);
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
  // Two comments collected as a group, then sent as one message.
  const before = (await call("GET", "/api/world")).withFounder.filter((m) => m.teamId === dispatch.id).length;
  await widget.getByLabel("Comment").fill("On phones the chart is cut off at the right.");
  await widget.getByRole("button", { name: "Add to group" }).click();
  await widget.getByText("Added to the group for Dispatch.").waitFor();
  await widget.getByLabel("Comment").fill("The caption wraps badly.");
  await widget.getByLabel("Kind (optional)").fill("copy");
  await widget.getByRole("button", { name: "Add to group" }).click();
  await widget.getByRole("button", { name: "Send group (2)" }).waitFor();
  await phone.screenshot({ path: join(shots, "04-phone-open.png") });
  await widget.getByRole("button", { name: "Send group (2)" }).click();
  await widget.getByText("Sent 2 as one group to Dispatch.").waitFor();
  await phone.screenshot({ path: join(shots, "05-phone-sent.png") });
  const grouped = (await call("GET", "/api/world")).withFounder.filter((m) => m.teamId === dispatch.id);
  assert.equal(grouped.length, before + 1, "one message for the group");
  assert.match(grouped.find((m) => m.text.includes("[Page comments: "))?.text ?? "", /\[Page comments: 2 in group pg-[0-9a-f]{10}\][^]*cut off at the right[^]*· copy[^]*wraps badly/);
  await phone.close();

  // A page origin the founder did not allow cannot frame the widget at all.
  await call("PUT", "/api/page-comments/origins", { origins: [`http://localhost:${hostPort}`] });
  const other = await visit({ width: 1440, height: 900 }, `http://127.0.0.1:${hostPort}`);
  await other.getByRole("button", { name: "Comment", exact: true }).click();
  await delay(1500);
  const blocked = await other.frameLocator('iframe[title="Comment to a team"]').getByLabel("Team").count();
  assert.equal(blocked, 0, "frame-ancestors keeps the widget out of a page that is not allowed");
  await other.screenshot({ path: join(shots, "06-not-allowed.png") });
  await other.close();

  // The API itself still refuses that page's origin.
  const cross = await fetch(`${url}/api/page-comments/teams/${dispatch.id}/comments`, { method: "POST", headers: { "content-type": "application/json", origin: `http://localhost:${hostPort}` }, body: JSON.stringify({ text: "direct" }) });
  assert.equal(cross.status, 403);

  // Comment, answer, still-wrong follow-up, group.
  assert.equal((await call("GET", "/api/world")).withFounder.filter((m) => m.teamId === dispatch.id).length, 4);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, shots, shownInOffice }));
} finally {
  await browser?.close();
  await office?.stop();
  await new Promise((resolve) => host.close(resolve));
}
