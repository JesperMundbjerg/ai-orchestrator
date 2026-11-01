// npm run build && PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/unlanded-hold.browser.mjs
// `inbox unlanded hold|release|list` against a real scratch service (the CLI, the route, the validation, the founder's
// notice), then the team panel showing a held entry beside a watched one, desktop and phone, headless.
// Scratch office: own free port, temporary HOME/data, no herdr, no integrations. Optional SCREENSHOT_DIR.
// A scratch office has no herdr, so no agent has a pane and the service's own list stays empty: the browser adds the
// entries to /api/world, with the hold exactly as the service answered it. What the service lists is in test/unlanded-hold.test.ts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { spawnScratchOffice } from "../scripts/lib/scratch-office.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const home = await realpath(await mkdtemp(join(tmpdir(), "unlanded-hold-browser-")));
const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
assert.notEqual(port, 4870);
const url = `http://localhost:${port}`;
const shots = process.env.SCREENSHOT_DIR ?? join(home, "screenshots");
await mkdir(shots, { recursive: true });
const inbox = fileURLToPath(new URL("../bin/inbox", import.meta.url));

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const repo = join(home, "repo");
await mkdir(repo);
await writeFile(join(repo, "a.txt"), "a\n");
git(repo, "init", "-q", "-b", "main");
git(repo, "add", ".");
git(repo, "commit", "-qm", "init");
const lane = join(home, "repo-snapshot");
git(repo, "worktree", "add", "-q", "-b", "snapshot", lane);
await writeFile(join(lane, "old.txt"), "an old snapshot\n");

const call = async (method, path, body) => {
  const res = await fetch(url + path, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const out = await res.json();
  if (!res.ok) throw Object.assign(new Error(`${path}: ${out.error}`), { status: res.status, code: out.code });
  return out;
};
/** The real CLI in a worktree as the agent whose session that is. Never the caller's own session or pane. */
const cli = (cwd, session, ...args) => {
  const env = { ...process.env, INBOX_URL: url, CLAUDE_CODE_SESSION_ID: session };
  delete env.HERDR_PANE_ID; delete env.CODEX_THREAD_ID;
  try { return { code: 0, out: execFileSync(inbox, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; }
};

let office, browser;
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
  // The agent of the snapshot worktree, and the first mate of another team that has no business with it.
  await call("POST", "/api/agent/items", { session: { harness: "claude", sessionId: "s-snap", cwd: lane }, project: { name: "snapshot" }, item: { type: "milestone", title: "Ready" } });
  await call("POST", "/api/agent/items", { session: { harness: "claude", sessionId: "s-main", cwd: repo }, project: { name: "main" }, item: { type: "milestone", title: "Ready" } });
  const team = await call("POST", "/api/world/teams", { name: "Snapshot Crew", standing: true, purpose: "Keeps an old snapshot" });
  const other = await call("POST", "/api/world/teams", { name: "Elsewhere", standing: true, purpose: "Another team" });
  const world0 = await call("GET", "/api/world");
  const snap = world0.agents.find((a) => a.cwd === lane);
  const main = world0.agents.find((a) => a.cwd === repo);
  assert.ok(snap && main, "both agents are known to the office");
  await call("PATCH", `/api/world/agents/${snap.id}`, { teamId: team.id, role: "lead" });
  await call("PATCH", `/api/world/agents/${main.id}`, { teamId: other.id, role: "lead" });

  // Refusals first: no reason, someone else's worktree, nothing unlanded in the main checkout.
  assert.match(cli(lane, "s-snap", "unlanded", "hold").out, /needs the reason/);
  const stranger = cli(repo, "s-main", "unlanded", "hold", "not mine", "--path", lane);
  assert.equal(stranger.code, 1);
  assert.match(stranger.out, /is not yours/);
  assert.match(cli(repo, "s-main", "unlanded", "hold", "main", "--path", repo).out, /main checkout/);

  // The hold, from inside the worktree, then again (once only), then another reason.
  const reason = "A snapshot of an old state that must never land: this team's work lands from the main checkout";
  const held = cli(lane, "s-snap", "unlanded", "hold", reason);
  assert.equal(held.code, 0, held.out);
  assert.ok(held.out.includes(lane) && held.out.includes(reason), held.out);
  const notices = async () => (await call("GET", "/api/world")).withFounder.filter((m) => /held unlanded/.test(m.text));
  assert.deepEqual((await notices()).map((m) => m.text), [`Snapshot Crew: ${lane} held unlanded: ${reason}`]);
  assert.equal(cli(lane, "s-snap", "unlanded", "hold", reason).code, 0);
  assert.equal((await notices()).length, 1, "the founder hears the reason once");

  // A new edit is a new state: holding it is a new hold, with its own line to the founder.
  await writeFile(join(lane, "old.txt"), "an old snapshot, edited\n");
  assert.equal(cli(lane, "s-snap", "unlanded", "hold", reason).code, 0);
  assert.equal((await notices()).length, 2);

  // The lead of the team may release from elsewhere; a stranger may not.
  assert.equal(cli(repo, "s-main", "unlanded", "release", "--path", lane).code, 1);
  const released = cli(lane, "s-snap", "unlanded", "release");
  assert.equal(released.code, 0, released.out);
  assert.match(released.out, /Released/);
  assert.match(cli(lane, "s-snap", "unlanded", "release").out, /nothing is on hold/);
  const list = cli(lane, "s-snap", "unlanded");
  assert.equal(list.code, 0, list.out);

  // The team panel: a held entry beside a watched one, with the reason.
  const answer = await call("POST", "/api/agent/unlanded", { session: { harness: "claude", sessionId: "s-snap", cwd: lane }, action: "hold", reason, path: lane });
  assert.equal(answer.held.reason, reason);
  browser = await chromium.launch({ headless: true });
  const errors = [];
  const since = new Date(Date.now() - 23 * 60_000).toISOString();
  const open = async (viewport) => {
    const page = await browser.newPage({ viewport });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route(/\/api\/world$/, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      const t = body.teams.find((x) => x.id === team.id);
      body.unlanded = [
        { agentId: snap.id, agentName: snap.name, teamId: t.id, checkout: lane, branch: "snapshot", landing: "dev", uncommitted: 337, ahead: 1, since, stage: "agent", held: answer.held },
        { agentId: "x2", agentName: "Mach", teamId: t.id, checkout: `${home}/snapshot-crew-einstein`, branch: "lane-einstein", landing: "dev", uncommitted: 0, ahead: 2, since, stage: "lead" },
      ];
      await route.fulfill({ response: res, json: body });
    });
    await page.goto(`${url}/#/world`);
    await page.getByRole("button", { name: "Front door ↗" }).waitFor();
    return page;
  };
  const check = async (page, name) => {
    const group = page.getByRole("group", { name: "Unlanded work" });
    await group.waitFor();
    const text = await group.innerText();
    assert.match(text, /337 uncommitted, 1 ahead of dev/);
    assert.match(text, /held by .*: A snapshot of an old state that must never land/);
    assert.doesNotMatch(text.split("\n").find((l) => /337 uncommitted/.test(l)), /agent told/, "a held entry does not say how far the office told");
    assert.match(text, /lead told/, "the watched one still does");
    await page.screenshot({ path: join(shots, `${name}-team-panel-unlanded-held.png`) });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `${name}: the page scrolls sideways by ${overflow}px`);
  };
  const page = await open({ width: 1440, height: 900 });
  await page.getByRole("button", { name: /Snapshot Crew/ }).first().click();
  await check(page, "desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await check(page, "phone");
  await page.close();
  assert.deepEqual(errors, []);
  console.log(`unlanded hold: ok (screenshots in ${shots})`);
} finally {
  await browser?.close();
  await office?.stop();
}
