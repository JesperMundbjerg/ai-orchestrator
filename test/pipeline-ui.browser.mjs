// npm run build && PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node test/pipeline-ui.browser.mjs
// PIPELINE_MOCK=1 is only for developing against an unfinished service contract.
// Always starts a separate office: temporary HOME/data/repo, free port, no integrations.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { graphFixture, paletteFixture, teamFixture } from "./pipeline-ui.fixture.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const mock = process.env.PIPELINE_MOCK === "1";
const home = await mkdtemp(join(tmpdir(), "pipeline-ui-browser-"));
const repo = join(home, "repo");
const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
assert.notEqual(port, 4870);
const url = `http://localhost:${port}`;
const shots = process.env.SCREENSHOT_DIR ?? join(home, "screenshots");
await mkdir(shots, { recursive: true });
await mkdir(repo);
for (const definition of paletteFixture.entries.filter((entry) => entry.path)) {
  const file = join(repo, definition.path);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, `---\nname: ${definition.label}\ndescription: ${definition.description}\n---\nScratch-only definition.\n`);
}
await writeFile(join(repo, "orchestrator.json"), JSON.stringify({ project: "scratch-pipeline", pipeline: graphFixture }));
execFileSync("git", ["init", "-q", repo]);
execFileSync("git", ["-C", repo, "add", "."]);
execFileSync("git", ["-C", repo, "-c", "user.name=Scratch", "-c", "user.email=scratch@example.test", "commit", "-qm", "Scratch fixture"]);
let office, browser;
const errors = [];
const requests = [];
let state = structuredClone(teamFixture);
let root;
const request = async (path, method = "GET", body) => {
  const response = await fetch(url + path, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(response.ok, await response.clone().text()); return response.json();
};
const current = () => mock ? Promise.resolve(structuredClone(state)) : request(root);
try {
  office = spawn(process.execPath, ["src/server/main.ts"], {
    env: { ...process.env, HOME: home, INBOX_DATA_DIR: join(home, "data"), INBOX_PORT: String(port), HERDR_SOCKET_PATH: "/nonexistent", HERDR_BIN_PATH: "/usr/bin/false", INBOX_CODEX_ACCOUNT_POLLING: "0", INBOX_PRESENCE_DISCOVERY: "0", INBOX_BROWSER_CLEANUP: "0" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = ""; office.stdout.on("data", (chunk) => output += chunk); office.stderr.on("data", (chunk) => output += chunk);
  for (let i = 0; ; i++) {
    try { if ((await fetch(url + "/api/state")).ok) break; } catch {}
    if (i === 100) throw new Error(`Scratch office failed: ${output}`);
    await delay(100);
  }
  const team = await request("/api/world/teams", "POST", { name: "Garden delivery", standing: true });
  root = `/api/world/teams/${team.id}/pipeline`;
  state.teamId = team.id;
  if (!mock) {
    const initial = await current();
    await request(root, "PUT", { expectedRevision: initial.revision, graph: null, repoRoot: repo });
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1050 }, colorScheme: "light" });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (req) => requests.push(req.url()));
  page.on("dialog", (dialog) => dialog.accept());
  if (mock) await context.route(`**${root}**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().method() === "PUT" ? route.request().postDataJSON() : null;
    if (body) {
      const layout = path.endsWith("/layout");
      if (body.expectedRevision !== (layout ? state.layoutRevision : state.revision)) return route.fulfill({ status: 409, json: { error: "Pipeline changed; reload before saving" } });
      if (layout) { state.layout = body.positions; state.layoutRevision++; }
      else { state.graph = body.graph ?? graphFixture; state.source = body.graph ? "team" : "repo"; state.revision++; }
    }
    return route.fulfill({ json: path.endsWith("/palette") ? paletteFixture : state });
  });
  await page.goto(`${url}/#/teams`);
  const button = page.getByRole("button", { name: "Pipeline for Garden delivery", exact: true });
  await button.waitFor();
  assert.ok(!requests.some((path) => /PipelineEditor-.*\.(js|css)/.test(path)), "canvas is not fetched on the team board");
  await button.click();
  const dialog = page.getByRole("dialog", { name: "Pipeline for Garden delivery", exact: true });
  await dialog.getByText("Inherited from repo", { exact: true }).waitFor();
  await page.locator('.react-flow__node[data-id="review"]').waitFor();
  await delay(500);
  assert.ok(requests.some((path) => /PipelineEditor-.*\.js/.test(path)));
  await page.screenshot({ path: join(shots, "01-inherited-canvas.png") });
  // Drag, save layout only, close/reopen: policy identity and inheritance stay unchanged.
  const before = await current();
  const reviewNode = page.locator('.react-flow__node[data-id="review"]');
  const bounds = await reviewNode.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 30);
  await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width / 2 + 60, bounds.y + 65, { steps: 12 }); await page.mouse.up();
  await dialog.getByRole("button", { name: "Save layout", exact: true }).click();
  await dialog.getByText("Layout saved. Inheritance and evidence are unchanged.").waitFor();
  const moved = await current();
  assert.equal(moved.source, "repo"); assert.equal(moved.policyHash, before.policyHash); assert.equal(moved.revision, before.revision);
  assert.notDeepEqual(moved.layout.review, before.layout.review);
  await dialog.getByRole("button", { name: "Close pipeline" }).click(); await button.click();
  await dialog.getByRole("button", { name: "List & keyboard" }).click();
  await dialog.getByRole("button", { name: /Physics accuracy review.*step/ }).click();
  await dialog.getByLabel("X", { exact: true }).waitFor();
  assert.equal(Number(await dialog.getByLabel("X", { exact: true }).inputValue()), Math.round(moved.layout.review.x));
  // Policy save and required evidence survive reload.
  await dialog.getByLabel("Step name", { exact: true }).fill("Scoped physics review");
  await dialog.getByLabel("artifact", { exact: true }).check();
  await dialog.getByRole("button", { name: "Save team override", exact: true }).click();
  await dialog.getByText("Team override", { exact: true }).waitFor();
  assert.ok((await current()).graph.nodes.find((n) => n.id === "review").evidence.includes("artifact"));
  await page.screenshot({ path: join(shots, "02-inspector-override.png") });
  // Cycle warnings and accessible edge deletion.
  await dialog.getByLabel("Connect to", { exact: true }).selectOption("kind");
  await dialog.getByRole("button", { name: "Add connection", exact: true }).click();
  await dialog.getByText(/Cycle detected/).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Save team override", exact: true }).isDisabled(), true);
  await page.screenshot({ path: join(shots, "03-cycle-warning.png") });
  const connections = dialog.locator(".pipeline-inspector .pipeline-edge");
  await connections.last().getByRole("button").click();
  assert.equal(await dialog.getByText(/Cycle detected/).count(), 0);
  // The canvas uses real handles; selected edges and nodes can be deleted by keyboard.
  await dialog.getByRole("button", { name: "Canvas", exact: true }).click();
  await delay(300);
  const sourceHandle = await page.locator('.react-flow__node[data-id="review"] .react-flow__handle.source').boundingBox();
  const targetHandle = await page.locator('.react-flow__node[data-id="kind"] .react-flow__handle.target').boundingBox();
  await page.mouse.move(sourceHandle.x + sourceHandle.width / 2, sourceHandle.y + sourceHandle.height / 2);
  await page.mouse.down(); await page.mouse.move(targetHandle.x + targetHandle.width / 2, targetHandle.y + targetHandle.height / 2, { steps: 15 }); await page.mouse.up();
  await dialog.getByText(/Cycle detected/).waitFor();
  const newEdge = page.locator('.react-flow__edge').last();
  await newEdge.focus(); await newEdge.press("Enter"); await newEdge.press("Delete");
  await dialog.getByText(/Cycle detected/).waitFor({ state: "hidden" });
  assert.equal(await page.locator('.react-flow__node').count(), 5, "edge deletion does not delete the formerly selected node");
  await dialog.getByRole("button", { name: "List & keyboard" }).click();
  await dialog.getByRole("button", { name: /Scoped physics review.*step/ }).click();
  // A competing policy edit is refused, and the local draft is retained.
  const competing = await current();
  if (mock) state.revision++;
  else await request(root, "PUT", { expectedRevision: competing.revision, graph: competing.graph });
  await dialog.getByLabel("Step name", { exact: true }).fill("My unsaved draft");
  await dialog.getByRole("button", { name: "Save team override", exact: true }).click();
  await dialog.getByText(/Another editor changed this pipeline/).waitFor();
  assert.equal(await dialog.getByLabel("Step name", { exact: true }).inputValue(), "My unsaved draft");
  await page.screenshot({ path: join(shots, "04-conflict-draft-retained.png") });
  await dialog.getByRole("button", { name: "Reload from office" }).click();
  await dialog.getByRole("button", { name: "Reset to repo default" }).click();
  await dialog.getByText("Inherited from repo", { exact: true }).waitFor();
  assert.equal((await current()).source, "repo");
  // Run view uses a snapshot fixture for evidence states, not the live editor graph.
  // In live mode only this GET response is decorated; policy/layout writes above are real.
  if (!mock) await page.route(`**${root}`, async (route) => {
    const response = await route.fetch(); const body = await response.json();
    body.runs = teamFixture.runs; await route.fulfill({ response, json: body });
  });
  await dialog.getByRole("button", { name: /^Runs/ }).click();
  await dialog.getByRole("button", { name: "Refresh evidence" }).click();
  await dialog.locator(".pipeline-state.stale").waitFor();
  assert.ok(await dialog.locator(".pipeline-state.done").count());
  assert.ok(await dialog.locator(".pipeline-state.waiting").count());
  assert.equal(await dialog.getByRole("link", { name: "Open evidence ↗" }).getAttribute("href"), "/files/scratch-report.txt");
  await page.screenshot({ path: join(shots, "05-run-evidence.png") });
  await dialog.getByRole("button", { name: "Canvas", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await delay(400);
  await page.screenshot({ path: join(shots, "06-phone.png") });
  assert.equal(await dialog.evaluate((element) => element.scrollWidth <= window.innerWidth), true);
  await page.setViewportSize({ width: 1600, height: 1050 });
  await page.emulateMedia({ colorScheme: "dark" });
  await delay(400);
  await page.screenshot({ path: join(shots, "07-dark.png") });
  await dialog.getByRole("button", { name: "Close pipeline" }).click();
  await page.goto(`${url}/#/world`);
  await page.locator(".world-panel.teams").waitFor();
  await page.locator(".team-go").filter({ hasText: "Garden delivery" }).click();
  await page.getByRole("button", { name: "Pipeline for Garden delivery", exact: true }).click();
  await page.getByRole("dialog", { name: "Pipeline for Garden delivery", exact: true }).waitFor();
  await page.screenshot({ path: join(shots, "08-office-entry.png") });
  assert.deepEqual(errors, []);
  console.log(`Pipeline browser passed (${mock ? "mock protocol" : "real policy/layout HTTP; fixture run evidence"}): lazy loading, drag/save/reopen, inheritance, inspector, graph save, cycle/delete, concurrent conflict, reset, evidence, phone/dark and office entry. Screenshots: ${shots}`);
} finally {
  await browser?.close();
  if (office && office.exitCode === null) { const exited = new Promise((resolve) => office.once("exit", resolve)); office.kill("SIGTERM"); await exited; }
  await rm(home, { recursive: true, force: true });
}
